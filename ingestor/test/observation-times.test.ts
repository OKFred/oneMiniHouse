import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonical, hash, observationTimes, parseSample, type Sample } from '../src/message.ts';
import { PostgresSink, resultHash, retentionTime } from '../src/database.ts';
import { Queue } from '../src/queue.ts';

const prefix='iot/v1/example-home/example-gateway',topic=prefix+'/devices/temperature-room/telemetry';
const read='2026-09-27T12:00:00.000Z';
const sample:Sample={schema_version:2,message_id:randomUUID(),site_id:'example-home',gateway_id:'example-gateway',
  device_id:'temperature-room',sample_time_utc:null,read_time_utc:read,
  observation_kind:'gateway_cached_state',quality:'ok',metrics:{temperature_c:29.24,humidity_pct:83.96},
  source:{driver:'xiaomi-gateway-v3-temperature',observation_kind:'gateway_cached_state'}};
const parse=(value:unknown)=>parseSample(topic,Buffer.from(JSON.stringify(value)),[prefix],new Date(read));

test('cached state preserves unknown sensor timestamp, explicit read time and original bytes through raw queue',()=>{
  const row=parse(sample),queue=new Queue(':memory:',{maxPending:10,maxRejected:10});
  try {
    queue.accept(row); const processed=queue.next('local')!;
    assert.equal(queue.getRaw(row.id)!.raw_data,row.payload);
    assert.equal(queue.getRaw(row.id)!.generate_time_utc,Date.parse(read));
    assert.equal((processed.lineage!.source as any).observation_kind,'gateway_cached_state');
    assert.deepEqual(observationTimes(JSON.parse(processed.payload)),{sample_time_utc:null,read_time_utc:read,
      observation_kind:'gateway_cached_state',time_basis:'gateway_state_read_time'});
  } finally { queue.close(); }
});

test('v2 cannot omit time semantics, invent a future measurement, or mix captured_at with read_time',()=>{
  for(const changes of [{read_time_utc:undefined},{sample_time_utc:undefined},{observation_kind:undefined},
    {captured_at:read},{read_time_utc:'invalid'}, {sample_time_utc:'2026-09-27T12:00:01Z'}])
    assert.throws(()=>parse({...sample,...changes}));
  const known={...sample,sample_time_utc:'2026-09-27T11:00:00Z'};
  assert.equal(observationTimes(JSON.parse(parse(known).payload)).time_basis,'device_sample_time');
  assert.equal(retentionTime(parse(known)),Date.parse(known.sample_time_utc));
  assert.equal(retentionTime(parse(sample)),Date.parse(read));
});

test('legacy wire/hash identity is frozen while its collector timestamp projects to read_time',()=>{
  const v1:Sample={...sample,schema_version:1,captured_at:read};
  delete v1.sample_time_utc;delete v1.read_time_utc;delete v1.observation_kind;
  const row=parse(v1),oldHash=hash(canonical({message_id:row.id,raw_id:row.id,processor_id:'iot-telemetry',
    processor_version:'1',output_key:'telemetry',site_id:v1.site_id,gateway_id:v1.gateway_id,
    device_id:v1.device_id,sample_time_utc:read,source_receive_time_utc:null,quality:v1.quality,metrics:v1.metrics}));
  assert.equal(resultHash(row),oldHash);
  assert.equal(observationTimes(v1).sample_time_utc,null);
  assert.equal(observationTimes(v1).read_time_utc,read);
  assert.equal(observationTimes(v1).observation_kind,'gateway_cached_state');
});

test('both PG single and batch writes contain actual time columns without substituting the read for measurement',async()=>{
  const row=parse(sample),second=parse({...sample,message_id:randomUUID()});
  const queries:{sql:string;values:any[]}[]=[];
  const sink=Object.assign(Object.create(PostgresSink.prototype),{pool:{query:async(sql:string,values:any[])=>{
    queries.push({sql,values});return sql.startsWith('INSERT')?{rowCount:1,rows:[]}:
      {rows:[row,second].map(r=>({message_id:r.id,payload_sha256:r.hash,result_sha256:resultHash(r)}))};
  }}}) as PostgresSink;
  await sink.write(row);await sink.writeBatch([row,second]);
  for(const q of queries.filter(q=>q.sql.startsWith('INSERT'))) {
    const cols=q.sql.slice(q.sql.indexOf('(')+1,q.sql.indexOf(')')).split(',');
    for(let offset=0;offset<q.values.length;offset+=cols.length) {
      assert.equal(q.values[offset+cols.indexOf('sample_time_utc')],null);
      assert.equal(q.values[offset+cols.indexOf('read_time_utc')],read);
      assert.equal(q.values[offset+cols.indexOf('time_basis')],'gateway_state_read_time');
    }
  }
});
