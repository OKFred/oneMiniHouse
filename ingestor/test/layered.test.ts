import { historySource } from './history-fixture.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Queue,ConflictError,CapacityError} from '../src/queue.ts';
import {canonical,hash,parseSample,type Sample,type RawRecord} from '../src/message.ts';
import {receive} from '../src/intake.ts';
import {PostgresSink,resultHash} from '../src/database.ts';
const prefix='iot/v1/example-home/example-gateway',topic=prefix+'/devices/socket-1/telemetry';
function sample():Sample{return {schema_version:1,message_id:randomUUID(),site_id:'example-home',gateway_id:'example-gateway',device_id:'socket-1',captured_at:'2026-09-17T00:00:00.000Z',quality:'ok',metrics:{energy_kwh:402.61,power_w:184.1}};}
function row(v=sample()){return parseSample(topic,Buffer.from(JSON.stringify(v)),[prefix]);}
const q=()=>new Queue(':memory:',{maxPending:10,maxRejected:10,rawMirror:true,frameMirror:true});
function complete(queue:Queue,id:string){queue.next('local');queue.done('local',id);queue.done('supabase',id);}

test('raw UTF-8 whitespace and key order survive; semantic duplicate retains first original bytes',()=>{
  const queue=q(),v=sample(),bytes=Buffer.from(' \n'+JSON.stringify(v,null,2)+'\n');
  assert.equal(receive(queue,topic,bytes,[prefix]),'saved');
  const raw=queue.getRaw(v.message_id)!;
  assert.equal(raw.raw_data,bytes.toString('utf8'));assert.equal(raw.raw_data_sha256,hash(bytes));assert.equal(raw.generate_time_utc,Date.parse(v.captured_at!));
  assert.equal(queue.stats().processing_pending,1);assert.equal(receive(queue,topic,Buffer.from(canonical(v)),[prefix]),'duplicate');
  assert.equal(queue.getRaw(v.message_id)!.raw_data,raw.raw_data);assert.equal(queue.next('local')!.hash,hash(canonical(v)));queue.close();
});

test('both PG deliveries finish without D1; raw remains after all acknowledgments',()=>{
  const queue=q(),r=row();queue.accept(r);complete(queue,r.id);
  assert.equal(queue.stats().queued,0);assert.equal(queue.stats().d1_pending,1);assert.equal(queue.nextRaw()!.raw_id,r.id);
  queue.done('d1',r.id);assert.equal(queue.stats().raw_records,1);assert.equal(queue.getRaw(r.id)!.raw_data,r.payload);queue.close();
});

test('raw and processing/D1 jobs survive restart before processing',()=>{
  const dir=mkdtempSync(join(tmpdir(),'layered-restart-')),file=join(dir,'data.sqlite');let queue:Queue|undefined;
  try{queue=new Queue(file,{maxPending:10,maxRejected:10,rawMirror:true});const r=row();queue.accept(r);queue.close();queue=undefined;
    queue=new Queue(file,{maxPending:10,maxRejected:10,rawMirror:true});assert.equal(queue.stats().processing_pending,1);assert.equal(queue.nextRaw()!.raw_data,r.payload);assert.equal(queue.next('supabase')!.id,r.id);
  }finally{queue?.close();rmSync(dir,{recursive:true,force:true});}
});

test('migration preserves legacy outstanding rows and independent database acknowledgments',()=>{
  const dir=mkdtempSync(join(tmpdir(),'layered-migrate-')),file=join(dir,'data.sqlite'),r=row();let queue:Queue|undefined;
  try{const old=new DatabaseSync(file);old.exec('CREATE TABLE pending(seq INTEGER PRIMARY KEY,id TEXT,topic TEXT,payload TEXT,hash TEXT,received_at TEXT,local_done INTEGER,supabase_done INTEGER)');
    old.prepare('INSERT INTO pending VALUES(1,?,?,?,?,?,1,0)').run(r.id,r.topic,r.payload,r.hash,r.received_at);old.close();
    queue=new Queue(file,{maxPending:10,maxRejected:10,rawMirror:true});assert.equal(queue.stats().legacy_migrated,1);assert.equal(queue.next('local'),undefined);const pending=queue.next('supabase')!;assert.equal(pending.id,r.id);assert.equal(pending.hash,r.hash);assert.equal(pending.lineage!.original_bytes_available,false);assert.equal(queue.getRaw(r.id)!.source_kind,'legacy_inbox');
    queue.close();queue=undefined;queue=new Queue(file,{maxPending:10,maxRejected:10,rawMirror:true});assert.equal(queue.stats().raw_records,1);
  }finally{queue?.close();rmSync(dir,{recursive:true,force:true});}
});

test('retention pins incomplete target deliveries, prunes completed data and leaves PG unaffected',()=>{
  const queue=q(),r=row();queue.accept(r);complete(queue,r.id);const future=Date.now()+181*86400000;
  assert.equal(queue.cleanup(future).raw_pruned,0);assert.equal(queue.stats().raw_records,1);
  queue.done('d1',r.id);assert.equal(queue.cleanup(future).raw_pruned,1);assert.equal(queue.stats().raw_records,0);queue.close();
});

test('per-job backoff and permanent conflict do not block later rows',()=>{
  const queue=q(),a=row(),b=row();queue.accept(a);queue.accept(b);assert.equal(queue.next('local')!.id,a.id);
  queue.failed('local',a.id,'OFFLINE',false,Date.now());assert.equal(queue.next('local')!.id,b.id);
  queue.done('local',b.id);assert.equal(queue.next('local'),undefined);assert.equal(queue.next('local',Date.now()+61000)!.id,a.id);
  queue.failed('local',a.id,'PAYLOAD_CONFLICT',true);assert.equal(queue.next('local',Date.now()+61000),undefined);assert.equal(queue.stats().delivery_failed,1);
  queue.retry('local',a.id);assert.equal(queue.next('local')!.id,a.id);queue.close();
});

test('invalid business text is durable raw with failed processing and D1 delivery',()=>{
  const queue=q();assert.equal(receive(queue,topic,Buffer.from(' {broken '),[prefix]),'rejected');
  assert.equal(queue.stats().processing_failed,1);assert.equal(queue.stats().queued,0);const raw=queue.nextRaw()!;assert.equal(raw.raw_data,' {broken ');
  queue.replay(raw.raw_id);assert.equal(queue.processOne(),true);assert.equal(queue.stats().processing_failed,1);queue.close();
});

test('protocol frames have separate retention/SLS delivery and never enter D1 or PG',()=>{
  const queue=q(),frame={schema_version:1,frame_id:randomUUID(),collection_id:randomUUID(),site_id:'example-home',gateway_id:'example-gateway',device_id:'socket-1',direction:'rx',protocol:'modbus-rtu',frame_time_utc:new Date().toISOString(),wire_hex:'58030401020304',crc_valid:true};
  const frameTopic=prefix+'/devices/socket-1/frames';assert.equal(receive(queue,frameTopic,Buffer.from(JSON.stringify(frame)),[prefix]),'saved');
  assert.equal(queue.nextRaw(),undefined);assert.equal(queue.next('local'),undefined);assert.equal(queue.nextFrame()!.frame_id,frame.frame_id);
  assert.equal(queue.cleanup(Date.now()+31*86400000).frames_pruned,0);queue.done('sls',frame.frame_id);assert.equal(queue.cleanup(Date.now()+31*86400000).frames_pruned,1);
  assert.equal(receive(queue,frameTopic,Buffer.from('broken'),[prefix]),'rejected');assert.equal(queue.nextRaw(),undefined);queue.close();
});

test('completed raw history does not occupy pending capacity; unacknowledged D1 does',()=>{
  const queue=new Queue(':memory:',{maxPending:1,maxRejected:10,rawMirror:true}),a=row();queue.accept(a);complete(queue,a.id);
  assert.throws(()=>queue.accept(row()),CapacityError);queue.done('d1',a.id);assert.equal(queue.accept(row()),'saved');queue.close();
});

test('enabling D1 later backfills retained raw records with stable IDs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'layered-backfill-')),file=join(dir,'data.sqlite');let queue:Queue|undefined;
  try{queue=new Queue(file,{maxPending:10,maxRejected:10});const r=row();queue.accept(r);complete(queue,r.id);queue.close();queue=undefined;
    queue=new Queue(file,{maxPending:10,maxRejected:10,rawMirror:true});assert.equal(queue.nextRaw()!.raw_id,r.id);assert.equal(queue.stats().local_pending,0);
  }finally{queue?.close();rmSync(dir,{recursive:true,force:true});}
});

test('PG bulk insert verifies every committed hash and omits full raw payload',async()=>{
  const rows=[row(),row()],sink=Object.create(PostgresSink.prototype) as PostgresSink;let sqlText='';
  Object.assign(sink,{pool:{query:async(sql:string)=>{if(sql.startsWith('INSERT')){sqlText=sql;return {rows:[],rowCount:2};}return {rows:rows.map(r=>({message_id:r.id,payload_sha256:r.hash,result_sha256:resultHash(r)}))};}}});
  await sink.writeBatch(rows);assert.ok(sqlText.includes('sample_time_utc'));assert.ok(!sqlText.includes(',payload,'));
  Object.assign(sink,{pool:{query:async(sql:string)=>sql.startsWith('INSERT')?{rows:[]}:{rows:rows.map(r=>({message_id:r.id,payload_sha256:r.hash,result_sha256:'wrong'}))}}});
  await assert.rejects(sink.writeBatch(rows),ConflictError);
});

test('historical imports retain source row and unknown measurement time',()=>{
  const queue=q(),r=row();const v=JSON.parse(r.payload);v.schema_version=2;v.quality='historical';delete v.captured_at;v.sample_time_utc=null;v.source_receive_time_utc='2022-11-03T00:00:00.000Z';
  r.payload=canonical(v);r.hash=hash(r.payload);r.processor_id='legacy-ddsu666';
  const now=Date.now(),raw:RawRecord={raw_id:r.id,topic,source_kind:'legacy_d1',source_id:'electricity_energy/1',source_message_id:null,source_site_id:v.site_id,source_gateway_id:v.gateway_id,source_device_id:v.device_id,data_kind:'inline',content_type:'application/json',raw_data:'{"id":1}',raw_data_sha256:hash('{"id":1}'),generate_time_utc:null,receive_time_utc:now,store_time_utc:now,expire_time_utc:now+180*86400000};
  assert.equal(queue.importHistorical(raw,r),'saved');assert.equal(queue.importHistorical(raw,r),'duplicate');assert.equal(queue.getRaw(r.id)!.raw_data,raw.raw_data);assert.equal(JSON.parse(queue.next('local')!.payload).sample_time_utc,null);queue.close();
});

test('BOM-prefixed JSON keeps byte-exact original in raw archive',()=>{
  const queue=q(),v=sample(),bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify(v))]);
  assert.equal(receive(queue,topic,bytes,[prefix]),'saved');assert.deepEqual(Buffer.from(queue.getRaw(v.message_id)!.raw_data),bytes);
  assert.equal(queue.next('local')!.id,v.message_id);queue.close();
});

test('diagnostic frame cap evicts oldest with an explicit counter and does not block telemetry',()=>{
  const queue=new Queue(':memory:',{maxPending:10,maxRejected:10,maxProtocolFrames:1,frameMirror:true}),frameTopic=prefix+'/devices/socket-1/frames';
  const frame=()=>({schema_version:1,frame_id:randomUUID(),collection_id:randomUUID(),site_id:'example-home',gateway_id:'example-gateway',device_id:'socket-1',direction:'rx',protocol:'modbus-rtu',frame_time_utc:new Date().toISOString(),wire_hex:'58030401'});
  const a=frame(),b=frame();receive(queue,frameTopic,Buffer.from(JSON.stringify(a)),[prefix]);receive(queue,frameTopic,Buffer.from(JSON.stringify(b)),[prefix]);
  assert.equal(queue.stats().frames_dropped_capacity,1);assert.equal(queue.stats().frame_records,1);assert.equal(queue.nextFrame()!.frame_id,b.frame_id);assert.equal(queue.accept(row()),'saved');queue.close();
});

test('new processor version produces an independent deterministic result and retains source message ID',()=>{
  const queue=q(),r=row();queue.accept(r);const first=queue.next('local')!;complete(queue,r.id);
  queue.registerProcessor({id:'iot-telemetry',version:'2',process:raw=>{const parsed=parseSample(raw.topic,Buffer.from(raw.raw_data),[prefix]);const v=JSON.parse(parsed.payload);v.metrics.power_w=200;parsed.payload=canonical(v);parsed.hash=hash(parsed.payload);return parsed;}});
  queue.replay(r.id,'iot-telemetry','2');const second=queue.next('local')!;
  assert.notEqual(second.id,first.id);assert.equal(second.raw_id,first.raw_id);assert.equal(second.processor_version,'2');assert.equal(second.lineage!.source_message_id,r.id);
  queue.done('local',second.id);queue.replay(r.id,'iot-telemetry','2');assert.equal(queue.next('local'),undefined);assert.equal(queue.next('supabase')!.id,second.id);queue.close();
});

test('historical batch capacity failure rolls back raw, results, jobs and capacity counter together',()=>{
  const source=q(),a=row(),b=row();source.accept(a);source.accept(b);const records=[a,b].map(result=>({result,raw:source.getRaw(result.id)!}));source.close();
  const queue=new Queue(':memory:',{maxPending:1,maxRejected:2,rawMirror:true});
  assert.throws(()=>queue.importHistoricalBatch(records),CapacityError);assert.equal(queue.stats().raw_records,0);assert.equal(queue.stats().outstanding_raw,0);
  assert.deepEqual(queue.importHistoricalBatch([records[0]]),{saved:1,duplicates:0});assert.equal(queue.stats().outstanding_raw,1);
  complete(queue,a.id);queue.done('d1',a.id);assert.equal(queue.stats().outstanding_raw,0);queue.done('d1',a.id);assert.equal(queue.stats().outstanding_raw,0);queue.close();
});

test('retained historical raw can be replayed with the registered legacy processor without duplicate outputs',async()=>{
  const {convertHistory}=await import('../src/history.ts');const converted=convertHistory('electricity_energy',{id:71,owner_id:1,create_time_utc:1668000000000,consumed_energy:71.25},historySource);
  const queue=q();queue.importHistorical(converted.raw,converted.result);complete(queue,converted.result.id);
  queue.replay(converted.raw.raw_id,'legacy-ddsu666','1');assert.equal(queue.processOne(),true);assert.equal(queue.stats().processing_failed,0);assert.equal(queue.next('local'),undefined);assert.equal(queue.stats().raw_records,1);queue.close();
});
