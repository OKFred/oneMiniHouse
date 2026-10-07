import mqtt from 'mqtt';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSample,hash } from '../src/message.ts';
import { Queue } from '../src/queue.ts';
import { createCloudRawSink } from '../src/cloud.ts';

function required(name:string):string { const value=process.env[name]?.trim(); if(!value)throw new Error(`${name} is required for live verification`);return value; }
const prefix=required('MQTT_TOPIC_PREFIX');
const broker=required('MQTT_URL');
const username=required('MQTT_USERNAME');
if(!/^iot\/v1\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(prefix)||new URL(broker).protocol!=='mqtts:')throw new Error('Invalid MQTT verification configuration');
const dir=join(process.env.DATA_DIR??'data','evidence','cloud-live');
mkdirSync(dir,{recursive:true});
const endpoint=required('RAW_ARCHIVE_URL');
const tokenFile=process.env.RAW_ARCHIVE_TOKEN_FILE??'secrets/raw_archive_token';
const queue=new Queue(join(dir,'inbox.sqlite'),{maxPending:100,maxRejected:10,rawMirror:true});
const client=mqtt.connect(broker,{
  protocolVersion:5,clean:true,clientId:'one-minihouse-cloud-check-'+randomUUID().slice(0,8),
  username,password:readFileSync(process.env.MQTT_PASSWORD_FILE??'secrets/mqtt_password','utf8').trim(),
  rejectUnauthorized:true,reconnectPeriod:0,connectTimeout:15000,
});
try {
  const sample=await new Promise<ReturnType<typeof parseSample>>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('No real telemetry within 90 seconds')),90000);
    const fail=(e:Error)=>{clearTimeout(timeout);reject(e);};
    client.on('error',fail);
    client.on('connect',()=>client.subscribe(prefix+'/devices/+/telemetry',{qos:1,rh:2},(error,granted)=>{
      if(error||!granted?.every(g=>g.qos===1))fail(error??new Error('Subscription denied'));
    }));
    client.on('message',(topic,bytes)=>{
      try{const row=parseSample(topic,bytes,[prefix]);clearTimeout(timeout);resolve(row);}catch(e){fail(e as Error);}
    });
  });
  queue.accept(sample);
  const raw=queue.getRaw(sample.id)!;
  const sink=createCloudRawSink({url:endpoint,tokenFile})!;
  await sink.write(raw);
  await sink.write(raw);
  const token=readFileSync(tokenFile,'utf8').trim();
  const changed={...raw,raw_data:raw.raw_data+'\n',raw_data_sha256:hash(raw.raw_data+'\n')};
  const conflict=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({schema_version:1,records:[changed]}),signal:AbortSignal.timeout(15000)});
  await conflict.body?.cancel();
  const denied=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
  await denied.body?.cancel();
  if(conflict.status!==409||denied.status!==401)throw new Error('Live archive conflict/authentication checks failed');
  const result={check_time_utc:new Date().toISOString(),raw_id:raw.raw_id,raw_data_sha256:raw.raw_data_sha256,bytes:Buffer.byteLength(raw.raw_data),source_topic:raw.topic,sample_time_utc:JSON.parse(sample.payload).sample_time_utc ?? null,sqlite_original_bytes_preserved:raw.raw_data===sample.payload,d1_committed:true,duplicate_accepted:true,conflict_status:conflict.status,unauthenticated_status:denied.status};
  writeFileSync(join(dir,'verification.json'),JSON.stringify(result,null,2));
  writeFileSync(join(dir,'raw.json'),JSON.stringify(raw));
  console.log(JSON.stringify(result));
} finally {await client.endAsync(true);queue.close();}
