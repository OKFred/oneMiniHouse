import { mkdirSync,writeFileSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig,secret } from './config.ts';
import { MqttConnections, receiveConnectionMessage } from './mqtt-connections.ts';
import { Queue,CapacityError,type DeliveryTarget } from './queue.ts';
import { PostgresSink,errorCode,permanentDeliveryError } from './database.ts';
import { createCloudRawSink,createFrameSink } from './cloud.ts';
import { parseJson, type Sample } from './message.ts';
import { CpuCoreAlerts, validateFeishuWebhook } from './cpu-core-alert.ts';

const config=loadConfig(),dir=process.env.DATA_DIR??'/app/data';
mkdirSync(dir,{recursive:true});
const rawSink=createCloudRawSink(config.archive?.rawMirror),frameSink=createFrameSink(config.archive?.frames);
const queue=new Queue(join(dir,'inbox.sqlite'),{...config.queue,rawMirror:!!rawSink,frameMirror:!!frameSink});
const cpuAlerts=config.cpuCoreAlerts?new CpuCoreAlerts(join(dir,'cpu-core-alerts.sqlite'),config.cpuCoreAlerts):undefined;
const cpuAlertWebhook=config.cpuCoreAlerts?secret(config.cpuCoreAlerts.webhookFile):undefined;
if(cpuAlertWebhook)validateFeishuWebhook(cpuAlertWebhook);
const log=(event:string,fields:object={})=>console.log(JSON.stringify({event_time_utc:new Date().toISOString(),event,...fields}));
const abort=new AbortController();const stop=()=>abort.abort();
process.once('SIGTERM',stop);process.once('SIGINT',stop);
const configuredTargets:DeliveryTarget[]=[...config.targets.map(t=>t.id),...(rawSink?['d1' as const]:[]),...(frameSink?['sls' as const]:[])];
const targetHealth:Record<string,{error:string|null;last_success_time_utc:string|null;last_retention_skip_time_utc:string|null}>=Object.fromEntries(configuredTargets.map(id=>[id,{error:'NOT_CHECKED',last_success_time_utc:null,last_retention_skip_time_utc:null}]));
const mqttConnections=new MqttConnections(config,secret(config.mqtt.passwordFile),(packet,plan)=>{
  try{
    const bytes=Buffer.from(packet.payload);
    const result=receiveConnectionMessage(queue,config,plan,packet);
    // Both commits finish before this connection releases PUBACK. Raw samples
    // and idempotent alert state are shared by every MQTT connection.
    if(cpuAlerts&&result!=='rejected'&&packet.topic.endsWith('/telemetry'))cpuAlerts.observe(parseJson(bytes.toString('utf8')) as Sample);
    log('message_'+result,{client_id:plan.clientId,topic:packet.topic});
  }catch(e){
    log('intake_paused',{client_id:plan.clientId,reason:e instanceof CapacityError?'QUEUE_FULL':'STORAGE_ERROR',...queue.stats()});
    throw e;
  }
},log);
const sinks=config.targets.map(t=>({target:t.id,sink:new PostgresSink(t)}));
let lastCleanup=0;
const heartbeat=setInterval(()=>{
  try{
    const stats=queue.stats(),cpuAlertStats=cpuAlerts?.stats(),mqttHealth=mqttConnections.snapshot();
    const state={heartbeat_time_utc:new Date().toISOString(),...mqttHealth,
      quality:mqttHealth.subscribed&&!mqttHealth.intake_paused&&!stats.delivery_failed&&!stats.processing_failed&&!Object.values(targetHealth).some(h=>h.error)&&!cpuAlertStats?.notification_error?'ok':'degraded',
      archive:{raw_mirror_configured:!!rawSink,frame_mirror_configured:!!frameSink},targets:targetHealth,...stats,
      ...(cpuAlertStats?{cpu_core_alerts:cpuAlertStats}: {})};
    writeFileSync(join(dir,'health.tmp'),JSON.stringify(state));renameSync(join(dir,'health.tmp'),join(dir,'health.json'));
  }catch{log('fatal',{reason:'HEARTBEAT_STORAGE_FAILED'});process.exitCode=1;stop();}
},5000);
async function targetLoop(target:DeliveryTarget){
  while(!abort.signal.aborted){
    let ids:string[]=[],delay=500;
    const expired=(skipped:string[])=>{
      if(!skipped.length)return;
      queue.doneBatch(target,skipped,'expired');delay=0;
      targetHealth[target].last_retention_skip_time_utc=new Date().toISOString();
      log('retention_skipped',{target,count:skipped.length,retention_days:sinks.find(s=>s.target===target)?.sink.retentionDays});
    };
    try{
      if(target==='local'||target==='supabase'){
        let rows=queue.nextBatch(target);const sink=sinks.find(s=>s.target===target)!.sink;
        ids=rows.map(r=>r.id);
        if(rows.length)try{
          // Resolve expiry before any network request: a cloud outage cannot pin old history.
          const partition=sink.partitionForRetention(rows);expired(partition.expired);
          rows=partition.eligible;ids=rows.map(r=>r.id);
          const outcome=await sink.writeBatch(rows);expired(outcome.expired);ids=outcome.confirmed;
        }catch(e){
          if(!permanentDeliveryError(e)||rows.length===1)throw e;
          // Isolate a bad row instead of quarantining every row in its batch.
          const successful:string[]=[];
          for(const row of rows)try{if(await sink.write(row)==='expired')expired([row.id]);else successful.push(row.id);}catch(one){queue.failed(target,row.id,errorCode(one),permanentDeliveryError(one));targetHealth[target].error=errorCode(one);}
          ids=successful;
        }
      }else if(target==='d1'){
        const rows=queue.nextRawBatch(32);ids=rows.map(r=>r.raw_id);
        if(rows.length)try{await rawSink!.writeBatch(rows);}catch(e){
          if(!permanentDeliveryError(e)||rows.length===1)throw e;
          const successful:string[]=[];
          for(const raw of rows)try{await rawSink!.write(raw);successful.push(raw.raw_id);}catch(one){queue.failed(target,raw.raw_id,errorCode(one),permanentDeliveryError(one));targetHealth[target].error=errorCode(one);}
          ids=successful;
        }
      }else{
        const frame=queue.nextFrame();if(frame){ids=[frame.frame_id];await frameSink!.write(frame);}
      }
      if(ids.length){queue.doneBatch(target,ids);targetHealth[target].error=null;targetHealth[target].last_success_time_utc=new Date().toISOString();delay=0;log('artifacts_confirmed',{target,count:ids.length});}
    }catch(e){
      targetHealth[target].error=errorCode(e);
      for(const id of ids)queue.failed(target,id,errorCode(e),permanentDeliveryError(e));
      log('delivery_retry',{target,count:ids.length,code:errorCode(e)});
      // Each job has its own backoff: a malformed record cannot hold later jobs indefinitely.
      delay=250;
    }
    try{await sleep(delay,undefined,{signal:abort.signal});}catch{break;}
  }
}
async function retentionLoop(){
  while(!abort.signal.aborted){
    try{
      if(Date.now()-lastCleanup>=86400000){
        const now=Date.now();let raw=0,frames=0;
        for(;;){const batch=queue.cleanup(now);raw+=batch.raw_pruned;frames+=batch.frames_pruned;if(batch.raw_pruned<1000&&batch.frames_pruned<1000)break;await sleep(10,undefined,{signal:abort.signal});}
        lastCleanup=now;log('retention_cleanup',{raw_pruned:raw,frames_pruned:frames});
      }
      await sleep(1000,undefined,{signal:abort.signal});
    }catch(e){if(abort.signal.aborted)break;log('fatal',{reason:'RETENTION_STORAGE_FAILED'});process.exitCode=1;stop();}
  }
}
async function cpuAlertLoop(){
  if(!cpuAlerts||!cpuAlertWebhook)return;
  while(!abort.signal.aborted){
    try{
      const result=await cpuAlerts.deliverOne(cpuAlertWebhook,{signal:abort.signal});
      if(result.status!=='idle')log('cpu_core_alert_delivery',result);
      await sleep(1000,undefined,{signal:abort.signal});
    }catch{
      if(abort.signal.aborted)break;
      log('fatal',{reason:'CPU_ALERT_STORAGE_FAILED'});process.exitCode=1;stop();
    }
  }
}
log('ingestor_started',{targets:configuredTargets,target_retention_days:Object.fromEntries(sinks.map(({target,sink})=>[target,sink.retentionDays??null])),...queue.stats()});
await Promise.all([...configuredTargets.map(targetLoop),retentionLoop(),cpuAlertLoop()]);
clearInterval(heartbeat);await mqttConnections.stop();await Promise.allSettled(sinks.map(s=>s.sink.close()));cpuAlerts?.close();queue.close();log('ingestor_stopped');
