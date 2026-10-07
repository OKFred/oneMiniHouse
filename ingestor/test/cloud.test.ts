import { historySource } from './history-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,createHmac } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createCloudRawSink,createFrameSink,slsLogGroup } from '../src/cloud.ts';
import { convertHistory } from '../src/history.ts';
import { parseFrame } from '../src/message.ts';

test('raw mirror chunks by serialized bytes and requires matching durable ACK', async () => {
  const dir=mkdtempSync(join(tmpdir(),'iot-cloud-test-')),previous=globalThis.fetch;
  try {
    const token=join(dir,'token');writeFileSync(token,'test-only-token');
    const batches:number[]=[];
    globalThis.fetch=async(_url,init)=>{
      const body=String(init!.body);assert.ok(Buffer.byteLength(body)<=1024*1024);
      const parsed=JSON.parse(body);batches.push(parsed.records.length);
      return Response.json({accepted:parsed.records.map((r:{raw_id:string;raw_data_sha256:string})=>({raw_id:r.raw_id,raw_data_sha256:r.raw_data_sha256}))});
    };
    const records=Array.from({length:33},(_,i)=>convertHistory('electricity_energy',{id:i+1,owner_id:1,create_time_utc:1,consumed_energy:i+1},historySource).raw);
    const sink=createCloudRawSink({url:'https://example.test/v1/raw/batch',tokenFile:token})!;
    await sink.writeBatch(records);assert.deepEqual(batches,[32,1]);
    batches.length=0;
    await sink.writeBatch(records.slice(0,16).map(r=>({...r,raw_data:'"'.repeat(64000)})));
    assert.ok(batches.length>=2);
    globalThis.fetch=async()=>Response.json({accepted:[]});await assert.rejects(sink.write(records[0]),/acknowledgment mismatch/);
    globalThis.fetch=async()=>new Response('x'.repeat(20000));await assert.rejects(sink.write(records[0]),/exceeds limit/);
    for(const [status,code] of [[400,'RAW_INVALID'],[409,'RAW_CONFLICT'],[429,'RAW_HTTP_429'],[503,'RAW_HTTP_503']] as const){
      globalThis.fetch=async()=>new Response('',{status});await assert.rejects(sink.write(records[0]),(error:unknown)=>(error as {code:string}).code===code);
    }
  } finally {globalThis.fetch=previous;rmSync(dir,{recursive:true,force:true});}
});
test('SLS documented protobuf/gzip/signature is HTTPS and rejects non-200 delivery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'iot-sls-test-')),previous=globalThis.fetch;
  try{
    const idFile=join(dir,'id'),keyFile=join(dir,'key');writeFileSync(idFile,'test-id');writeFileSync(keyFile,'test-secret');
    const wire=slsLogGroup({test:'hello'},1690254376).toString('hex');
    assert.equal(wire,'0a1508a8f8fca506120d0a0474657374120568656c6c6f1a13696f745f70726f746f636f6c5f6672616d6573220c6f6e654d696e69486f757365');
    let status=200;
    globalThis.fetch=async(url,init)=>{
      assert.equal(String(url),'https://iot-project.cn-hangzhou.log.aliyuncs.com/logstores/protocol-frames/shards/lb');
      assert.equal(init?.redirect,'error');
      const headers=init!.headers as Record<string,string>,body=Buffer.from(init!.body as Uint8Array),raw=gunzipSync(body);
      assert.equal(raw.length,Number(headers['x-log-bodyrawsize']));
      assert.equal(headers['content-md5'],createHash('md5').update(body).digest('hex').toUpperCase());
      const canonical=`x-log-apiversion:0.6.0\nx-log-bodyrawsize:${raw.length}\nx-log-compresstype:gzip\nx-log-signaturemethod:hmac-sha1\n`;
      const value=`POST\n${headers['content-md5']}\napplication/x-protobuf\n${headers.date}\n${canonical}/logstores/protocol-frames/shards/lb`;
      assert.equal(headers.authorization,`LOG test-id:${createHmac('sha1','test-secret').update(value).digest('base64')}`);
      assert.ok(raw.includes(Buffer.from('frame_time_utc')));
      return new Response('',{status});
    };
    const frame=parseFrame('iot/v1/example-home/gateway/devices/socket/frames',Buffer.from(JSON.stringify({schema_version:1,frame_id:'5b165df5-1815-5bda-aafc-c21df0bcfe10',collection_id:'3a165df5-1815-5bda-aafc-c21df0bcfe10',site_id:'example-home',gateway_id:'gateway',device_id:'socket',direction:'rx',protocol:'modbus-rtu',wire_hex:'58030400000000',frame_time_utc:new Date().toISOString()})),['iot/v1/example-home/gateway']);
    const sink=createFrameSink({endpoint:'cn-hangzhou.log.aliyuncs.com',project:'iot-project',logstore:'protocol-frames',accessKeyIdFile:idFile,accessKeySecretFile:keyFile})!;
    await sink.write(frame);status=503;await assert.rejects(sink.write(frame),/SLS HTTP 503/);
  }finally{globalThis.fetch=previous;rmSync(dir,{recursive:true,force:true});}
});
