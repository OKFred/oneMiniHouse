import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validateConfig} from '../src/config.ts';
import {PostgresSink,deliverOne,permanentDeliveryError,retentionTime,resultHash} from '../src/database.ts';
import {Queue} from '../src/queue.ts';
import {hash,parseSample,type RecordRow,type Sample} from '../src/message.ts';

const now=Date.parse('2026-09-19T13:00:00.000Z'),cutoff=now-30*86400000;
const prefix='iot/v1/example-home/example-gateway',topic=prefix+'/devices/socket-1/telemetry';
function row(time:number):RecordRow {
  const sample:Sample={schema_version:1,message_id:randomUUID(),site_id:'example-home',gateway_id:'example-gateway',device_id:'socket-1',captured_at:new Date(time).toISOString(),quality:'ok',metrics:{energy_kwh:405.6}};
  return parseSample(topic,Buffer.from(JSON.stringify(sample)),[prefix],new Date(now));
}
function fakeSink(retentionDays:number|undefined,query:(sql:string,values?:unknown[])=>Promise<unknown>):PostgresSink {
  return Object.assign(Object.create(PostgresSink.prototype) as PostgresSink,{retentionDays,now:()=>now,pool:{query}});
}

test('retention is optional, accepts Supabase whole days, and cannot silently expire local PG',()=>{
  const config=JSON.parse(readFileSync(new URL('../config/ingestor.example.json',import.meta.url),'utf8'));
  config.targets[1].retentionDays=30;assert.equal(validateConfig(config).targets[1].retentionDays,30);
  delete config.targets[1].retentionDays;assert.equal(validateConfig(config).targets[1].retentionDays,undefined);
  for(const invalid of [0,-1,1.5,'30',3651])assert.throws(()=>validateConfig({...config,targets:[config.targets[0],{...config.targets[1],retentionDays:invalid}]}),/retentionDays/);
  assert.throws(()=>validateConfig({...config,targets:[{...config.targets[0],retentionDays:30},config.targets[1]]}),/Supabase/);
});

test('Supabase excludes older than rolling 30 days, retaining the exact millisecond boundary',async()=>{
  const inserted:string[]=[];
  const sink=fakeSink(30,async(_sql,values)=>{inserted.push(values![0] as string);return {rowCount:1,rows:[]};});
  const old=row(cutoff-1),boundary=row(cutoff),recent=row(cutoff+1);
  assert.equal(await sink.write(old),'expired');
  assert.equal(await sink.write(boundary),'confirmed');assert.equal(await sink.write(recent),'confirmed');
  assert.deepEqual(inserted,[boundary.id,recent.id]);
});

test('expiry uses real sample time then historical source receive then local receive, never invented time',()=>{
  const original=row(now),change=(fields:object)=>({...original,payload:JSON.stringify({...JSON.parse(original.payload),captured_at:undefined,schema_version:2,sample_time_utc:null,...fields})});
  assert.equal(retentionTime(change({sample_time_utc:new Date(cutoff-1).toISOString(),source_receive_time_utc:new Date(now).toISOString()})),cutoff-1);
  assert.equal(retentionTime(change({source_receive_time_utc:new Date(cutoff-2).toISOString()})),cutoff-2);
  assert.equal(retentionTime(change({})),Date.parse(original.received_at));
  assert.throws(()=>retentionTime(change({sample_time_utc:'invalid',source_receive_time_utc:new Date(now).toISOString()})),permanentDeliveryError);
});

test('Supabase expiry resolves only its task and preserves raw bytes and local historical delivery',async()=>{
  const queue=new Queue(':memory:',{maxPending:10,maxRejected:10}),old=row(cutoff-1);
  queue.accept(old);let cloudCalls=0,localCalls=0;
  const cloud=fakeSink(30,async()=>{cloudCalls++;throw new Error('cloud unavailable');});
  const local=fakeSink(undefined,async()=>{localCalls++;return {rowCount:1,rows:[]};});
  try{
    assert.equal(await deliverOne(queue,'supabase',r=>cloud.write(r)),true);
    assert.equal(cloudCalls,0);assert.equal(queue.next('supabase'),undefined);
    assert.equal(queue.stats().supabase_retention_skipped,1);assert.equal(queue.stats().local_pending,1);
    assert.equal(queue.getRaw(old.id)!.raw_data,old.payload);
    assert.equal(await deliverOne(queue,'local',r=>local.write(r)),true);assert.equal(localCalls,1);
    assert.equal(queue.stats().queued,0);assert.equal(queue.stats().raw_records,1);
    assert.equal(queue.getRaw(old.id)!.raw_data_sha256,hash(Buffer.from(old.payload)));
  }finally{queue.close();}
});

test('mixed batches retain message IDs and hashes, excluding expired records from SQL',async()=>{
  const old=row(cutoff-1),recent=[row(now-1000),row(now)],queries:{sql:string;values?:unknown[]}[]=[];
  const sink=fakeSink(30,async(sql,values)=>{
    queries.push({sql,values});return sql.startsWith('INSERT')?{rowCount:2,rows:[]}:{rows:recent.map(r=>({message_id:r.id,payload_sha256:r.hash,result_sha256:resultHash(r)}))};
  });
  assert.deepEqual(await sink.writeBatch([old,...recent]),{confirmed:recent.map(r=>r.id),expired:[old.id]});
  assert.equal(queries.length,2);assert.ok(!queries[0].values!.includes(old.id));
  assert.deepEqual(queries[1].values,[recent.map(r=>r.id)]);
  queries.length=0;assert.deepEqual(await sink.writeBatch([old]),{confirmed:[],expired:[old.id]});assert.equal(queries.length,0);
});

test('expired jobs resolve before a mixed batch network failure and do not retry with eligible rows',async()=>{
  const queue=new Queue(':memory:',{maxPending:10,maxRejected:10}),old=row(cutoff-1),recent=row(now);
  queue.accept(old);queue.accept(recent);const sink=fakeSink(30,async()=>{throw new Error('offline');});
  try{
    const partition=sink.partitionForRetention(queue.nextBatch('supabase'));
    queue.doneBatch('supabase',partition.expired,'expired');
    await assert.rejects(sink.writeBatch(partition.eligible),/offline/);
    assert.equal(queue.stats().supabase_pending,1);assert.equal(queue.next('supabase')!.id,recent.id);
    assert.equal(queue.stats().local_pending,2);assert.equal(queue.stats().supabase_retention_skipped,1);
  }finally{queue.close();}
});

test('expired outcome survives SQLite restart; duplicate completion does not recount and replay skips again',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'minihouse-retention-')),path=join(dir,'inbox.sqlite'),old=row(cutoff-1);
  let queue:Queue|undefined;
  try{
    queue=new Queue(path,{maxPending:10,maxRejected:10});queue.accept(old);queue.next('supabase');
    queue.done('supabase',old.id,'expired');queue.done('supabase',old.id,'expired');queue.close();queue=undefined;
    const db=new DatabaseSync(path);assert.deepEqual({...db.prepare("SELECT status,outcome FROM delivery_job WHERE artifact_id=? AND target_id='supabase'").get(old.id)},{status:'done',outcome:'expired'});db.close();
    queue=new Queue(path,{maxPending:10,maxRejected:10});assert.equal(queue.stats().supabase_retention_skipped,1);assert.equal(queue.next('supabase'),undefined);
    queue.retry('supabase',old.id);const sink=fakeSink(30,async()=>{throw new Error('must not contact cloud');});
    await deliverOne(queue,'supabase',r=>sink.write(r));assert.equal(queue.next('supabase'),undefined);assert.equal(queue.stats().local_pending,1);
    assert.equal(queue.getRaw(old.id)!.raw_data,old.payload);
  }finally{queue?.close();rmSync(dir,{recursive:true,force:true});}
});

test('older layered SQLite upgrades its delivery schema without losing pending or confirmed jobs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'minihouse-retention-upgrade-')),path=join(dir,'inbox.sqlite'),sample=row(now);let queue:Queue|undefined;
  try{
    queue=new Queue(path,{maxPending:10,maxRejected:10});queue.accept(sample);queue.done('local',sample.id);queue.close();queue=undefined;
    const db=new DatabaseSync(path);db.exec('ALTER TABLE delivery_job DROP COLUMN outcome');db.close();
    queue=new Queue(path,{maxPending:10,maxRejected:10});assert.equal(queue.next('local'),undefined);assert.equal(queue.next('supabase')!.id,sample.id);
    queue.done('supabase',sample.id);assert.equal(queue.stats().queued,0);
  }finally{queue?.close();rmSync(dir,{recursive:true,force:true});}
});
