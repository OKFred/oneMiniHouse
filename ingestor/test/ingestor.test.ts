import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Queue, CapacityError, ConflictError } from '../src/queue.ts';
import { parseSample, canonical, type RecordRow } from '../src/message.ts';
import { deliverOne, PostgresSink } from '../src/database.ts';
import { receive } from '../src/intake.ts';
import { validateConfig } from '../src/config.ts';

const prefix = 'iot/v1/example-home/example-gateway';
const topic = prefix + '/devices/socket-1/telemetry';
const sample = () => ({ schema_version:1,message_id:randomUUID(),site_id:'example-home',gateway_id:'example-gateway',device_id:'socket-1',captured_at:'2026-09-17T00:00:00.000Z',quality:'ok',metrics:{energy_kwh:402.61,power_w:184.1},source:{driver:'yunmu-v5'} });
const row = (v = sample()) => parseSample(topic,Buffer.from(JSON.stringify(v)),[prefix]);
const memory = (maxPending=10) => new Queue(':memory:',{maxPending,maxRejected:2});
test('configuration requires two destinations, verified Supabase TLS and exact topic scopes', () => {
  const c = JSON.parse(readFileSync(new URL('../config/ingestor.example.json',import.meta.url),'utf8'));
  assert.equal(validateConfig(c).targets.length,2);
  assert.throws(() => validateConfig({...c,targets:[c.targets[0]]}));
  assert.throws(() => validateConfig({...c,targets:[c.targets[0],{...c.targets[1],tls:false}]}));
  assert.throws(() => validateConfig({...c,mqtt:{...c.mqtt,topicPrefixes:['iot/#']}}));
});
test('telemetry preserves units, rejects wrong topic, invalid time and bogus zero/error readings', () => {
  assert.equal(JSON.parse(row().payload).metrics.energy_kwh,402.61);
  assert.throws(() => parseSample(topic.replace('socket-1','socket-2'),Buffer.from(JSON.stringify(sample())),[prefix]));
  assert.throws(() => row({...sample(),quality:'error'}));
  assert.throws(() => row({...sample(),captured_at:'not a date'}));
  assert.throws(() => row({...sample(),metrics:{energy_kwh:Infinity,power_w:0}}));
});
test('canonical JSON makes key order irrelevant to idempotency', () => {
  assert.equal(canonical({b:2,a:{d:4,c:3}}),canonical({a:{c:3,d:4},b:2}));
});
test('both confirmations are required; one successful database never erases the other pending write', async () => {
  const q = memory(); const r = row(); q.accept(r);
  await deliverOne(q,'local',async () => {});
  assert.equal(q.next('local'),undefined); assert.equal(q.next('supabase')!.id,r.id);
  await assert.rejects(deliverOne(q,'supabase',async () => {throw new Error('offline')}));
  assert.equal(q.stats().queued,1);
  await deliverOne(q,'supabase',async () => {});
  assert.equal(q.stats().queued,0); q.close();
});
test('cloud can continue independently while local database is offline', async () => {
  const q=memory(); q.accept(row()); q.accept(row());
  await assert.rejects(deliverOne(q,'local',async () => {throw new Error('offline')}));
  await deliverOne(q,'supabase',async () => {}); await deliverOne(q,'supabase',async () => {});
  assert.equal(q.stats().local_pending,2); assert.equal(q.stats().supabase_pending,0); q.close();
});
test('pending writes and per-target progress survive process restart', () => {
  const dir=mkdtempSync(join(tmpdir(),'minihouse-ingestor-')); const path=join(dir,'inbox.sqlite'); const r=row();
  try {
    let q=new Queue(path,{maxPending:10,maxRejected:2}); q.accept(r); q.done('local',r.id); q.close();
    q=new Queue(path,{maxPending:10,maxRejected:2}); assert.equal(q.next('local'),undefined);
    assert.equal(q.next('supabase')!.id,r.id); q.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('duplicate delivery retains the first receive time; conflicting payload is not substituted', () => {
  const q=memory(); const r=row(); q.accept(r);
  assert.equal(q.accept({...r,received_at:'2026-09-18T00:00:00Z'}),'duplicate');
  assert.equal(q.next('local')!.received_at,r.received_at);
  assert.throws(() => q.accept({...r,hash:'different'}),ConflictError); q.close();
});
test('queue saturation refuses new intake without deleting unsent records', () => {
  const q=memory(1); const r=row(); q.accept(r);
  assert.throws(() => q.accept(row()),CapacityError);
  assert.equal(q.next('local')!.id,r.id); assert.equal(q.accept(r),'duplicate'); q.close();
});
test('invalid input is quarantined and never sent to either database', () => {
  const q=memory(); assert.equal(receive(q,topic,Buffer.from('broken'),[prefix]),'rejected');
  assert.equal(q.stats().queued,0); assert.equal(q.next('supabase'),undefined); q.close();
});
test('lost database commit response is retried with stable ID, without duplicate history', async () => {
  const q=memory(); const r=row(); q.accept(r); const persisted=new Map<string,string>(); let attempts=0;
  const write = async (v:RecordRow) => { persisted.set(v.id,v.payload); if (++attempts === 1) throw new Error('response lost after commit'); };
  await assert.rejects(deliverOne(q,'local',write)); assert.equal(q.stats().local_pending,1);
  await deliverOne(q,'local',write); assert.equal(persisted.size,1); assert.equal(q.stats().local_pending,0); q.close();
});
test('each destination preserves receipt ordering during replay', async () => {
  const q=memory(); const rows=[row(),row(),row()]; rows.forEach(r => q.accept(r)); const ids:string[]=[];
  while(await deliverOne(q,'supabase',async r => {ids.push(r.id)})) {}
  assert.deepEqual(ids,rows.map(r => r.id)); assert.equal(q.stats().local_pending,3); q.close();
});
test('Postgres duplicate write checks payload hash instead of silently accepting a collision', async () => {
  const r=row(); const sink=Object.create(PostgresSink.prototype) as PostgresSink;
  Object.assign(sink,{pool:{query:async (sql:string) => sql.startsWith('INSERT') ? {rowCount:0,rows:[]} : {rows:[{payload_sha256:r.hash}]}}});
  await sink.write(r);
  Object.assign(sink,{pool:{query:async (sql:string) => sql.startsWith('INSERT') ? {rowCount:0,rows:[]} : {rows:[{payload_sha256:'different'}]}}});
  await assert.rejects(sink.write(r),ConflictError);
});
