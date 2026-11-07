import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { MqttClient,IClientOptions,IPublishPacket } from 'mqtt';
import { Queue,ConflictError,CapacityError } from '../src/queue.ts';
import { validateConfig,mqttConnectionPlans,type Config,type MqttConnectionPlan } from '../src/config.ts';
import { MqttConnections,receiveConnectionMessage } from '../src/mqtt-connections.ts';
import { presenceValues,writePresenceBatch } from '../src/presence-database.ts';
import { PostgresSink } from '../src/database.ts';
import { PRESENCE_PROCESSOR_ID,decodePresence,presenceRaw,receivePresence,presenceEvent,observerRaw,presenceAt,
  type PresenceDevice,type PresenceReceipt,type PresenceWire,type PresenceEvent } from '../src/presence.ts';

const now=Date.parse('2026-11-08T00:00:00Z');
const device:PresenceDevice={id:'example-host',label:'示例主机',topic:'iot/v1/example-home/host/status',siteId:'example-home',gatewayId:'host',deviceId:'physical-host',reporterId:'host-publisher',kind:'direct',intervalSeconds:60,freshnessSeconds:300};
const observerSession=randomUUID(),session=randomUUID();
const wire=(changes:Partial<PresenceWire>={}):PresenceWire=>({schema_version:1,event_id:randomUUID(),site_id:device.siteId,gateway_id:device.gatewayId,device_id:device.deviceId,
  reporter_id:device.reporterId,boot_id:'example-boot',session_id:session,sequence:0,event:'online',online:true,reason:'connected',source_time_utc:new Date(now).toISOString(),uptime_ms:0,...changes});
const receipt=(changes:Partial<PresenceReceipt>={}):PresenceReceipt=>({observerClientId:'example-presence-reader',observerSessionId:observerSession,observedAt:now,retained:false,qos:1,duplicate:false,available:true,...changes});
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));
const queue=()=>new Queue(':memory:',{maxPending:1000,maxRejected:10,rawMirror:true});
function take(q:Queue){return q.nextBatch('local',1000).map(presenceEvent);}
function add(q:Queue,value=wire(),r=receipt(),d=device){assert.equal(receivePresence(q,d,bytes(value),r),'saved');return take(q).at(-1)!;}
function coverage(q:Queue,event:'coverage_start'|'coverage_heartbeat'|'coverage_end',time=now,sequence=1,sessionId=observerSession){q.acceptRaw(observerRaw(device.siteId,'example-presence-reader',sessionId,sequence,event,time),'presence-observer','1');return take(q).at(-1)!;}

test('presence config is additive and exact: <=10 topics, no duplicate clients/devices/topics or dependency cycles',()=>{
  const baseline=JSON.parse(readFileSync(new URL('../config/ingestor.example.json',import.meta.url),'utf8'));
  const oldPlans=mqttConnectionPlans(validateConfig(baseline));
  const config=()=>({...structuredClone(baseline),presence:{devices:[structuredClone(device)],clients:[{clientId:'example-presence-reader',topics:[device.topic]}]}});
  const valid=validateConfig(config());assert.deepEqual(mqttConnectionPlans(valid).slice(0,oldPlans.length),oldPlans);
  const overflow=config();overflow.presence.devices=Array.from({length:11},(_,i)=>({...device,id:'dev-'+i,topic:device.topic+i}));overflow.presence.clients[0].topics=overflow.presence.devices.map((d:PresenceDevice)=>d.topic);
  assert.throws(()=>validateConfig(overflow));
  for(const change of [
    (c:any)=>{c.presence.clients[0].clientId=c.mqtt.clientId;},
    (c:any)=>{c.presence.clients[0].topics.push(device.topic);},
    (c:any)=>{c.presence.devices.push({...device});},
    (c:any)=>{c.presence.clients[0].topics=['iot/#'];},
    (c:any)=>{c.presence.devices[0].parentId=device.id;},
    (c:any)=>{c.presence.devices[0].parentId='missing';},
    (c:any)=>{c.presence.devices[0].kind='cached';},
    (c:any)=>{c.presence.devices[0].freshnessSeconds=0;},
  ]){const c=config();change(c);assert.throws(()=>validateConfig(c));}
  const mobile=config();mobile.presence.devices[0].topic='mobile/task/presence';mobile.presence.clients[0].topics=['mobile/task/presence'];assert.doesNotThrow(()=>validateConfig(mobile));
});

test('wire validates fixed identity, event semantics, UTF8, duplicate keys, finite counters and compatibility fields',()=>{
  const value=wire();assert.equal(decodePresence(device,bytes(value)).event_id,value.event_id);
  for(const changes of [{...value,extra:true},{...value,device_id:'other'},{...value,sequence:-1},{...value,sequence:0.1},
    {...value,uptime_ms:Infinity},{...value,boot_id:'\ud800'},{...value,source_time_utc:'2026-02-30T00:00:00Z'},{...value,online:false},
    {...value,event:'observation'},{...value,event:'offline',online:false,reason:'lwt'},
    {...value,message_id:randomUUID()},{...value,quality:'arbitrary'},{...value,quality:['ok']},{...value,devices:{test:'ONLINE'}},{...value,devices:{test:['ok']}},
    {...value,frames:{archived:0,pending:0,dropped_pending:0,extra:0}},{...value,timestamp:-1}])assert.throws(()=>decodePresence(device,bytes(changes)));
  for(const bad of [Buffer.from([255]),Buffer.alloc(16385),Buffer.from(JSON.stringify(value).replace('"schema_version":1','"schema_version":1,"schema_\\u0076ersion":1'))])assert.throws(()=>decodePresence(device,bad));
  assert.doesNotThrow(()=>decodePresence(device,bytes({...value,quality:'ok',read_time_utc:null,captured_at:value.source_time_utc,devices:{child:'pending'},
    queued:0,pending:0,dropped:0,frames:{archived:0,pending:0,dropped_pending:0},mqtt_connected:true,message_id:value.event_id,protocolVersion:1,deviceId:'mobile-1',status:'ONLINE',timestamp:0})));
});

test('proxy cadence is explicit and TTL uses max300 or three real intervals; unknown cadence is cached without online expiry',()=>{
  const baseline=JSON.parse(readFileSync(new URL('../config/ingestor.example.json',import.meta.url),'utf8'));
  const config=(interval:number|null,freshness:number|null,kind:'proxy'|'cached'='proxy')=>({...structuredClone(baseline),presence:{
    devices:[device,{...device,id:'child',topic:device.topic+'/child',deviceId:'child',kind,parentId:device.id,intervalSeconds:interval,freshnessSeconds:freshness}],
    clients:[{clientId:'example-presence-reader',topics:[device.topic,device.topic+'/child']}],
  }});
  for(const [interval,freshness] of [[1,300],[15,300],[60,300],[100,300],[101,303],[600,1800],[86400,259200]]){
    const valid=validateConfig(config(interval,freshness));const child=valid.presence!.devices[1],q=queue();
    try{const event=add(q,wire({device_id:'child',event:'observation',reason:'read_ok'}),receipt(),child);
      assert.equal(event.applied,true);assert.equal(event.freshness_seconds,freshness);assert.equal(Date.parse(event.valid_until_utc!),now+freshness*1000);
      assert.ok(Buffer.byteLength(q.nextRaw()!.source_id)<=2048);
    }finally{q.close();}
  }
  for(const [interval,freshness] of [[0,300],[-1,300],[1.5,300],[86401,259203],[600,300],[15,45],[null,null],[600,null]])assert.throws(()=>validateConfig(config(interval,freshness)));
  const badDirect=config(600,1800);badDirect.presence.devices[0]={...device,intervalSeconds:600,freshnessSeconds:1800};assert.throws(()=>validateConfig(badDirect));
  const unknown=validateConfig(config(null,null,'cached')).presence!.devices[1],q=queue();
  try{const event=add(q,wire({device_id:'child',event:'observation',reason:'read_ok'}),receipt(),unknown);
    assert.equal(event.state_after,'unknown');assert.equal(event.valid_until_utc,null);assert.equal(event.freshness_seconds,null);
  }finally{q.close();}
});

test('hidden logical reporter is a parent dependency but never a displayed physical device',()=>{
  const q=queue(),hidden={...device,visible:false},child:PresenceDevice={...device,id:'physical-sensor',label:'示例传感器',topic:device.topic+'/sensor',deviceId:'sensor',kind:'proxy',parentId:device.id};
  try{
    coverage(q,'coverage_start');add(q,wire(),receipt(),hidden);
    add(q,wire({device_id:'sensor',event:'observation',reason:'read_ok'}),receipt(),child);
    assert.deepEqual(presenceAt([hidden,child],take(q),now),{[child.id]:'online'});
    const ended=wire({event:'offline',online:false,reason:'lwt',sequence:null,source_time_utc:null,uptime_ms:null});
    add(q,ended,receipt({observedAt:now+1000}),hidden);
    assert.deepEqual(presenceAt([hidden,child],take(q),now+1000),{[child.id]:'unknown'});
    add(q,wire({session_id:randomUUID(),source_time_utc:new Date(now+2000).toISOString()}),receipt({observedAt:now+2000}),hidden);
    assert.deepEqual(presenceAt([hidden,child],take(q),now+2000),{[child.id]:'unknown'}); // Old child session cannot revive with a new parent birth.
    assert.equal(take(q).find(e=>e.physical_device_id===hidden.id)!.visible,false);
  }finally{q.close();}
});

test('retained snapshots, old source timestamps and future clocks are archived without opening online',()=>{
  const q=queue();try{
    assert.equal(add(q,wire(),receipt({retained:true})).decision,'retained_snapshot');
    assert.equal(add(q,wire({source_time_utc:new Date(now-301000).toISOString()})).decision,'delayed_source_event');
    assert.equal(add(q,wire({source_time_utc:new Date(now+501).toISOString()})).decision,'future_source_time');
    assert.equal(add(q,wire({source_time_utc:null})).decision,'source_clock_unknown');
    assert.equal(add(q,wire(),receipt({available:false})).decision,'observer_unavailable');
    assert.equal(q.stats().raw_records,5);assert.ok(take(q).every(e=>!e.applied));
  }finally{q.close();}
});

test('clock allowance includes plus/minus499 and500ms;501ms future is archived and TTL never starts in the future',()=>{
  for(const offset of [-501,-500,-499,499,500,501]){
    const q=queue();try{
      const event=add(q,wire({source_time_utc:new Date(now+offset).toISOString()}));
      assert.equal(event.applied,offset<=500);assert.equal(event.source_time_utc,new Date(now+offset).toISOString());
      if(offset<=500)assert.equal(Date.parse(event.valid_until_utc!),Math.min(now,now+offset)+300000);
      else assert.equal(event.decision,'future_source_time');
    }finally{q.close();}
  }
});

test('new sessions close older sessions; old wills and out-of-order events never reopen a closed session',()=>{
  const q=queue();try{
    assert.equal(add(q).state_after,'online');
    const session2=randomUUID();
    assert.equal(add(q,wire({session_id:session2,source_time_utc:new Date(now+1000).toISOString()}),receipt({observedAt:now+1000})).state_after,'online');
    const oldWill=wire({event:'offline',online:false,reason:'lwt',sequence:null,source_time_utc:null,uptime_ms:null});
    assert.equal(add(q,oldWill,receipt({observedAt:now+2000})).applied,false);
    assert.equal(add(q,wire({session_id:session2,event:'heartbeat',reason:'heartbeat',sequence:0,source_time_utc:new Date(now+2000).toISOString()}),receipt({observedAt:now+2000})).decision,'old_sequence');
    const ended=add(q,{...oldWill,event_id:randomUUID(),session_id:session2},receipt({observedAt:now+3000}));
    assert.equal(ended.state_after,'offline');assert.equal(ended.observed_time_utc,new Date(now+3000).toISOString());assert.equal(ended.source_time_utc,null);
    assert.equal(add(q,wire({session_id:session2,event:'heartbeat',reason:'heartbeat',sequence:5,source_time_utc:new Date(now+4000).toISOString()}),receipt({observedAt:now+4000})).decision,'closed_reporter_session');
  }finally{q.close();}
});

test('first unknown heartbeats only seed candidates and wills never establish online state',()=>{
  const q=queue();try{
    coverage(q,'coverage_start');
    const heartbeat=wire({event:'heartbeat',reason:'heartbeat',sequence:1});
    assert.equal(add(q,heartbeat).decision,'unobserved_reporter_session');
    assert.equal(presenceAt([device],take(q),now)[device.id],'unknown');
    assert.equal(add(q,wire(),receipt({retained:true})).decision,'retained_snapshot');
    assert.equal(add(q,{...heartbeat,event_id:randomUUID(),sequence:2}).decision,'pending_candidate_session');
    assert.equal(add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:3,uptime_ms:1000,source_time_utc:new Date(now+1000).toISOString()}),receipt({observedAt:now+1000})).state_after,'online');
    const other=randomUUID(),later=new Date(now+2000).toISOString();
    assert.equal(add(q,wire({session_id:other,event:'heartbeat',reason:'heartbeat',sequence:20,source_time_utc:later}),receipt({observedAt:now+2000})).decision,'unobserved_reporter_session');
    assert.equal(add(q,wire({session_id:other,event:'offline',online:false,reason:'lwt',sequence:null,source_time_utc:null,uptime_ms:null}),receipt({observedAt:now+2000})).decision,'unobserved_reporter_session');
    assert.equal(add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:4,source_time_utc:later,uptime_ms:2000}),receipt({observedAt:now+2000})).state_after,'online');
  }finally{q.close();}
});

test('observer recovery seeds only a retained candidate and the next genuinely live heartbeat restores a missed session',()=>{
  for(const retainedEvent of ['online','heartbeat'] as const){
    const q=queue();try{
      coverage(q,'coverage_start');add(q);coverage(q,'coverage_end',now+1000,2);
      const observer2=randomUUID(),session2=randomUUID();
      const snapshot=wire({session_id:session2,event:retainedEvent,reason:retainedEvent==='online'?'connected':'heartbeat',sequence:2,
        source_time_utc:new Date(now+60000).toISOString(),uptime_ms:60000});
      assert.equal(add(q,snapshot,receipt({observerSessionId:observer2,observedAt:now+90000,retained:true,available:false})).applied,false);
      coverage(q,'coverage_start',now+91000,1,observer2);
      assert.equal(presenceAt([device],take(q),now+91000)[device.id],'unknown');
      const liveReceipt=(at:number)=>receipt({observerSessionId:observer2,observedAt:now+at,observerCoverageStartAt:now+91000});
      const heartbeat=(at:number,sequence:number)=>wire({session_id:session2,event:'heartbeat',reason:'heartbeat',sequence,uptime_ms:at,source_time_utc:new Date(now+at).toISOString()});
      assert.equal(add(q,heartbeat(85000,3),liveReceipt(92000)).decision,'pending_candidate_session');
      assert.equal(presenceAt([device],take(q),now+92000)[device.id],'unknown');
      assert.equal(add(q,heartbeat(120000,4),liveReceipt(120000)).state_after,'online');
      assert.equal(presenceAt([device],take(q),now+120000)[device.id],'online');
      assert.equal(add(q,wire({event:'offline',online:false,reason:'lwt',sequence:null,source_time_utc:null,uptime_ms:null}),liveReceipt(121000)).decision,'closed_reporter_session');
    }finally{q.close();}
  }
});

test('retained candidates survive restart without rewriting first receipt and a later observer has its own coverage watermark',()=>{
  const dir=mkdtempSync(join(tmpdir(),'presence-retained-')),path=join(dir,'inbox.sqlite');let q=new Queue(path,{maxPending:100,maxRejected:10,rawMirror:true});
  const value=wire({event:'heartbeat',reason:'heartbeat',sequence:1,source_time_utc:new Date(now-600000).toISOString()});
  try{
    assert.equal(add(q,value,receipt({retained:true})).applied,false);const first=q.next('local')!;
    q.close();q=new Queue(path,{maxPending:100,maxRejected:10,rawMirror:true});
    const observer2=randomUUID(),received=receipt({observerSessionId:observer2,observedAt:now+20000,retained:true,observerCoverageStartAt:now+20000});
    coverage(q,'coverage_start',now+20000,1,observer2);
    assert.equal(receivePresence(q,device,bytes(value),received),'duplicate');
    assert.equal(receivePresence(q,device,bytes(value),{...received,observedAt:now+60000}),'duplicate');
    q.replay(first.raw_id!,PRESENCE_PROCESSOR_ID,'1');q.processOne();
    assert.deepEqual(q.next('local'),first);assert.equal(presenceEvent(first).observed_time_utc,new Date(now).toISOString());
    const delayed=add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:2,uptime_ms:15000,source_time_utc:new Date(now+15000).toISOString()}),receipt({observerSessionId:observer2,observedAt:now+61000,observerCoverageStartAt:now+20000}));
    assert.equal(delayed.applied,false);assert.equal(delayed.decision,'pending_candidate_session');
    assert.equal(add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:2,uptime_ms:20500,source_time_utc:new Date(now+20500).toISOString()}),receipt({observerSessionId:observer2,observedAt:now+61000,observerCoverageStartAt:now+20000})).decision,'pending_candidate_session');
    const live=add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:3,uptime_ms:30000,source_time_utc:new Date(now+30000).toISOString()}),receipt({observerSessionId:observer2,observedAt:now+62000,observerCoverageStartAt:now+20000}));
    assert.equal(live.state_after,'online');assert.equal(presenceAt([device],take(q),now+62000)[device.id],'online');
  }finally{q.close();rmSync(dir,{recursive:true,force:true});}
});

test('closed, older and offline snapshots cannot seed candidates, and a candidate Will closes only that candidate',()=>{
  const q=queue();try{
    add(q);add(q,wire({event:'offline',online:false,reason:'lwt',sequence:null,source_time_utc:null,uptime_ms:null}),receipt({observedAt:now+1000}));
    add(q,wire({source_time_utc:new Date(now+2000).toISOString()}),receipt({observedAt:now+2000,retained:true}));
    assert.equal(add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:2,source_time_utc:new Date(now+3000).toISOString()}),receipt({observedAt:now+3000})).decision,'closed_reporter_session');
    for(const offline of [false,true]){
      const candidate=randomUUID(),snapshot=offline?wire({session_id:candidate,event:'offline',online:false,reason:'lwt',sequence:null,source_time_utc:null,uptime_ms:null})
        :wire({session_id:candidate,source_time_utc:new Date(now-1).toISOString()});
      add(q,snapshot,receipt({observedAt:now+4000,retained:true}));
      assert.equal(add(q,wire({session_id:candidate,event:'heartbeat',reason:'heartbeat',sequence:2,source_time_utc:new Date(now+5000).toISOString()}),receipt({observedAt:now+5000})).decision,'unobserved_reporter_session');
    }
    const candidate=randomUUID();add(q,wire({session_id:candidate,source_time_utc:new Date(now+6000).toISOString()}),receipt({observedAt:now+6000,retained:true}));
    assert.equal(add(q,wire({session_id:candidate,event:'offline',online:false,reason:'lwt',sequence:null,source_time_utc:null,uptime_ms:null}),receipt({observedAt:now+7000})).applied,false);
    assert.equal(add(q,wire({session_id:candidate,event:'heartbeat',reason:'heartbeat',sequence:2,source_time_utc:new Date(now+8000).toISOString()}),receipt({observedAt:now+8000})).decision,'closed_reporter_session');
  }finally{q.close();}
});

test('birthless, pre-SUBACK and corrected-clock candidates require a future-generated heartbeat plus advancing counters',()=>{
  const seeds:[Partial<PresenceWire>,Partial<PresenceReceipt>][]=[
    [{event:'heartbeat',reason:'heartbeat'},{}],
    [{},{available:false}],
    [{event:'heartbeat',reason:'heartbeat'},{available:false}],
    [{source_time_utc:new Date(now+3600000).toISOString()},{}],
    [{event:'heartbeat',reason:'heartbeat',source_time_utc:new Date(now+3600000).toISOString()},{}],
    [{source_time_utc:new Date(now-3600000).toISOString()},{}],
    [{source_time_utc:null},{}],
  ];
  for(const [changes,received] of seeds){
    const q=queue();try{
      coverage(q,'coverage_start');
      const first=wire({sequence:1,uptime_ms:1000,...changes});
      assert.equal(add(q,first,receipt(received)).applied,false);
      const hb=(source:number,sequence:number,uptime:number)=>wire({event:'heartbeat',reason:'heartbeat',sequence,uptime_ms:uptime,source_time_utc:new Date(now+source).toISOString()});
      assert.equal(add(q,hb(500,2,1001),receipt({observedAt:now+1000})).decision,'pending_candidate_session');
      assert.equal(add(q,hb(501,1,1001),receipt({observedAt:now+1000})).decision,'pending_candidate_session');
      assert.equal(add(q,hb(501,2,1000),receipt({observedAt:now+1000})).decision,'pending_candidate_session');
      assert.equal(add(q,hb(501,3,999),receipt({observedAt:now+1000})).decision,'pending_candidate_session');
      const live=add(q,hb(501,2,1001),receipt({observedAt:now+1000}));
      assert.equal(live.applied,true);assert.equal(live.state_after,'online');
      assert.equal(presenceAt([device],take(q),now+1000)[device.id],'online');
      assert.equal(receivePresence(q,device,bytes(first),receipt({observedAt:now+10000,retained:true,duplicate:true})),'duplicate');
      assert.equal(presenceAt([device],take(q),now+10000)[device.id],'online');
    }finally{q.close();}
  }
});

test('an older unknown source cannot seed over known progress but later corrected live heartbeats self-recover',()=>{
  const q=queue();try{
    add(q);const nextSession=randomUUID();
    const hb=(source:number,sequence:number,uptime:number)=>wire({session_id:nextSession,event:'heartbeat',reason:'heartbeat',sequence,uptime_ms:uptime,source_time_utc:new Date(now+source).toISOString()});
    assert.equal(add(q,hb(-1,1,1000),receipt({observedAt:now+1000})).applied,false);
    assert.equal(add(q,hb(1000,2,2000),receipt({observedAt:now+1000})).decision,'unobserved_reporter_session');
    assert.equal(add(q,hb(1500,3,2001),receipt({observedAt:now+1500})).decision,'pending_candidate_session');
    assert.equal(add(q,hb(1501,3,2001),receipt({observedAt:now+1501})).state_after,'online');
  }finally{q.close();}
});

test('an accepted different-session birth retires an older candidate even within the 500ms clock allowance',()=>{
  const q=queue();try{
    coverage(q,'coverage_start');
    add(q,wire({sequence:1,uptime_ms:1000}),receipt({retained:true}));
    const current=randomUUID();
    const birth=add(q,wire({session_id:current,source_time_utc:new Date(now+10).toISOString()}),receipt({observedAt:now+10}));
    assert.equal(birth.state_after,'online');
    const old=add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:2,uptime_ms:2000,source_time_utc:new Date(now+700).toISOString()}),receipt({observedAt:now+700}));
    assert.equal(old.applied,false);assert.equal(old.decision,'closed_reporter_session');
    assert.equal(presenceAt([device],take(q),now+700)[device.id],'online');
    assert.equal(add(q,wire({session_id:current,event:'heartbeat',reason:'heartbeat',sequence:1,uptime_ms:1000,source_time_utc:new Date(now+1000).toISOString()}),receipt({observedAt:now+1000})).state_after,'online');
  }finally{q.close();}
});

test('a retained candidate never evicts a live known session; new coverage rejects delayed known-session heartbeats',()=>{
  const q=queue();try{
    coverage(q,'coverage_start');add(q);
    const observer2=randomUUID();coverage(q,'coverage_start',now+20000,1,observer2);
    const r=(at:number)=>receipt({observerSessionId:observer2,observedAt:now+at,observerCoverageStartAt:now+20000});
    const hb=(at:number,sequence:number,uptime=at)=>wire({event:'heartbeat',reason:'heartbeat',sequence,uptime_ms:uptime,source_time_utc:new Date(now+at).toISOString()});
    const candidate=randomUUID();add(q,wire({session_id:candidate,source_time_utc:new Date(now+10000).toISOString()}),{...r(20000),retained:true});
    assert.equal(add(q,hb(15000,1),r(21000)).decision,'before_observer_coverage');
    assert.equal(presenceAt([device],take(q),now+21000)[device.id],'unknown');
    assert.equal(add(q,hb(30501,1),r(30000)).decision,'future_source_time');
    assert.equal(add(q,hb(30500,2,30502),r(30000)).state_after,'online');
    assert.equal(add(q,hb(40000,2),r(40000)).decision,'old_sequence');
    assert.equal(add(q,hb(40000,3,10),r(40000)).decision,'regressed_reporter_clock');
    assert.equal(add(q,wire({session_id:candidate,event:'heartbeat',reason:'heartbeat',sequence:2,uptime_ms:50000,source_time_utc:new Date(now+50000).toISOString()}),r(50000)).decision,'unobserved_reporter_session');
  }finally{q.close();}
});

test('a coarse-clock live birth at the coverage boundary stays pending and self-recovers on its next heartbeat',()=>{
  const q=queue();try{
    coverage(q,'coverage_start',now+100);
    const first=add(q,wire(),receipt({observedAt:now+200,observerCoverageStartAt:now+100}));
    assert.equal(first.applied,false);assert.equal(first.state_after,'unknown');assert.equal(first.decision,'before_observer_coverage');
    assert.equal(presenceAt([device],take(q),now+200)[device.id],'unknown');
    const next=add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:1,uptime_ms:60000,source_time_utc:new Date(now+60000).toISOString()}),receipt({observedAt:now+60000,observerCoverageStartAt:now+100}));
    assert.equal(next.state_after,'online');assert.equal(presenceAt([device],take(q),now+60000)[device.id],'online');
  }finally{q.close();}
});

test('same-second connected births are live only with advancing same-boot uptime or a closed predecessor',()=>{
  for(const priorClosed of [false,true]){
    const q=queue();try{
      add(q,wire({uptime_ms:1000}));
      if(priorClosed)add(q,wire({event:'offline',online:false,reason:'lwt',sequence:null,source_time_utc:null,uptime_ms:null}),receipt({observedAt:now+100}));
      const nextSession=randomUUID();
      const birth=add(q,wire({session_id:nextSession,boot_id:priorClosed?'next-boot':'example-boot',uptime_ms:priorClosed?0:1300}),receipt({observedAt:now+300}));
      assert.equal(birth.applied,true);assert.equal(birth.state_after,'online');
      assert.equal(add(q,wire({event:'offline',online:false,reason:'lwt',sequence:null,source_time_utc:null,uptime_ms:null}),receipt({observedAt:now+400})).decision,'closed_reporter_session');
    }finally{q.close();}
  }
});

test('ambiguous same-second births stay unknown across restart until their own later fresh heartbeat',()=>{
  for(const bootId of ['next-boot',null,'example-boot']){
    const dir=mkdtempSync(join(tmpdir(),'presence-pending-')),path=join(dir,'inbox.sqlite');
    let q=new Queue(path,{maxPending:100,maxRejected:10,rawMirror:true});
    try{
      coverage(q,'coverage_start');add(q,wire({uptime_ms:1000}));
      const nextSession=randomUUID();
      const birth=add(q,wire({session_id:nextSession,boot_id:bootId,uptime_ms:0}),receipt({observedAt:now+100}));
      assert.equal(birth.applied,true);assert.equal(birth.decision,'pending_reporter_session');
      assert.equal(birth.state_after,'unknown');assert.equal(birth.valid_until_utc,null);
      assert.equal(presenceAt([device],take(q),now+100)[device.id],'unknown');
      q.close();q=new Queue(path,{maxPending:100,maxRejected:10,rawMirror:true});
      const sameSecond=add(q,wire({session_id:nextSession,boot_id:bootId,event:'heartbeat',reason:'heartbeat',sequence:1,uptime_ms:200}),receipt({observedAt:now+300}));
      assert.equal(sameSecond.applied,true);assert.equal(sameSecond.decision,'pending_reporter_session');
      assert.equal(add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:2,uptime_ms:1100,source_time_utc:new Date(now+1000).toISOString()}),receipt({observedAt:now+1000})).decision,'closed_reporter_session');
      const nextObserver=randomUUID();coverage(q,'coverage_start',now+60000,1,nextObserver);
      const live=add(q,wire({session_id:nextSession,boot_id:bootId,event:'heartbeat',reason:'heartbeat',sequence:2,uptime_ms:60000,source_time_utc:new Date(now+60000).toISOString()}),receipt({observerSessionId:nextObserver,observedAt:now+60000}));
      assert.equal(live.state_after,'online');assert.equal(live.decision,'heartbeat');
      assert.equal(presenceAt([device],take(q),now+60000)[device.id],'online');
    }finally{q.close();rmSync(dir,{recursive:true,force:true});}
  }
});

test('QoS duplicates retain first receipt, cursor, source metadata and exact independent queue outcomes across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'presence-')),path=join(dir,'inbox.sqlite'),value=wire();let q=new Queue(path,{maxPending:10,maxRejected:10,rawMirror:true});
  try{
    receivePresence(q,device,bytes(value),receipt());const row=q.next('local')!;q.done('local',row.id);q.close();
    q=new Queue(path,{maxPending:10,maxRejected:10,rawMirror:true});
    assert.equal(receivePresence(q,device,bytes(value),receipt({observedAt:now+60000,retained:true,duplicate:true})),'duplicate');
    assert.equal(q.next('local'),undefined);assert.deepEqual(q.next('supabase'),row);assert.equal(presenceEvent(row).observed_time_utc,new Date(now).toISOString());
    q.replay(row.raw_id!,PRESENCE_PROCESSOR_ID,'1');q.processOne();assert.deepEqual(q.next('supabase'),row);
    assert.equal(receivePresence(q,device,bytes({...value,uptime_ms:1}),receipt()),'rejected');
    const after=add(q,wire({sequence:1,event:'heartbeat',reason:'heartbeat',source_time_utc:new Date(now+1000).toISOString(),uptime_ms:1000}),receipt({observedAt:now+1000}));assert.equal(after.applied,true);
    assert.equal(q.stats().processing_failed,1); // Conflicting source is durably quarantined rather than retried forever.
  }finally{q.close();rmSync(dir,{recursive:true,force:true});}
});

test('queue saturation does not acknowledge or advance cursor before durable intake succeeds',()=>{
  const q=new Queue(':memory:',{maxPending:1,maxRejected:10});try{
    const value=wire();receivePresence(q,device,bytes(value),receipt());
    const next=wire({sequence:1,event:'heartbeat',reason:'heartbeat',source_time_utc:new Date(now+1000).toISOString()});
    assert.throws(()=>receivePresence(q,device,bytes(next),receipt({observedAt:now+1000})),CapacityError);
    const row=q.next('local')!;q.done('local',row.id);q.done('supabase',row.id);
    assert.equal(receivePresence(q,device,bytes(next),receipt({observedAt:now+1000})),'saved');assert.equal(presenceEvent(q.next('local')!).applied,true);
  }finally{q.close();}
});

test('malformed legacy-topic presence remains site-scoped raw archive instead of poisoning D1 delivery',()=>{
  const q=queue();try{
    const legacy={...device,topic:'autojs6/v2/devices/example-mobile/presence'};
    assert.equal(receivePresence(q,legacy,Buffer.from('{broken'),receipt()),'rejected');
    const raw=q.nextRaw()!;assert.equal(raw.source_kind,'mqtt_presence');assert.equal(raw.source_site_id,device.siteId);assert.equal(raw.topic,legacy.topic);
    assert.equal(q.stats().d1_pending,1);assert.equal(q.stats().local_pending,0);
  }finally{q.close();}
});

test('pre-epoch source clocks retain original bytes in quarantine with a nullable archive timestamp',()=>{
  assert.doesNotThrow(()=>decodePresence(device,bytes(wire({source_time_utc:'1970-01-01T00:00:00Z'}))));
  const q=queue();try{
    const payload=bytes(wire({source_time_utc:'1969-12-31T23:59:59.999Z'}));
    assert.equal(receivePresence(q,device,payload,receipt()),'rejected');
    const raw=q.nextRaw()!;
    assert.equal(raw.raw_data,payload.toString());assert.equal(raw.generate_time_utc,null);
    assert.equal(raw.source_kind,'mqtt_presence');assert.equal(raw.source_site_id,device.siteId);
    assert.equal(q.stats().d1_pending,1);assert.equal(q.stats().local_pending,0);
  }finally{q.close();}
});

test('coverage gaps and crash expiry produce unknown; reconnect requires new device evidence and parent failures gate children',()=>{
  const q=queue();try{
    coverage(q,'coverage_start');add(q);
    const child:PresenceDevice={...device,id:'child',deviceId:'child',topic:device.topic+'/child',kind:'proxy',parentId:device.id};
    const cached:PresenceDevice={...child,id:'cache',deviceId:'cache',topic:device.topic+'/cache',kind:'cached'};
    add(q,wire({device_id:'child',event:'observation',reason:'read_ok'}),receipt(),child);
    add(q,wire({device_id:'cache',event:'observation',reason:'read_ok'}),receipt(),cached);
    const devices=[device,child,cached];let events=take(q);
    assert.deepEqual({...presenceAt(devices,events,now+1000)},{[device.id]:'online',child:'online',cache:'unknown'});
    assert.equal(presenceAt(devices,events,now+90000)[device.id],'unknown');
    coverage(q,'coverage_end',now+2000,2);assert.equal(presenceAt(devices,take(q),now+2000).child,'unknown');
    const observer2=randomUUID();coverage(q,'coverage_start',now+3000,1,observer2);
    assert.equal(presenceAt(devices,take(q),now+3000)[device.id],'unknown');
    add(q,wire({event:'heartbeat',reason:'heartbeat',sequence:1,uptime_ms:4000,source_time_utc:new Date(now+4000).toISOString()}),receipt({observerSessionId:observer2,observedAt:now+4000}));
    assert.equal(presenceAt(devices,take(q),now+4000)[device.id],'online');assert.equal(presenceAt(devices,take(q),now+4000).child,'unknown');
    events=take(q);const stale=events.filter(e=>e.record_kind!=='observer');assert.equal(presenceAt(devices,stale,now+4000)[device.id],'unknown');
  }finally{q.close();}
});

test('presence database route confirms all fields, independent sinks and old cloud expiry without touching telemetry',async()=>{
  const q=queue();try{
    add(q);const row=q.next('local')!,values=presenceValues(row);const saved=new Map<string,unknown>();let inserts=0;
    const fake={query:async(sql:string,args:unknown[])=>{
      assert.ok(sql.includes('iot.device_presence_events'));assert.ok(!sql.includes('iot.telemetry'));
      const columns=sql.startsWith('INSERT')?sql.match(/\((.*?)\) VALUES/)![1].split(','):sql.slice(7,sql.indexOf(' FROM')).split(',');
      if(sql.startsWith('INSERT')){inserts++;if(!saved.size)columns.forEach((column,i)=>saved.set(column,args[i]));return {rows:[]};}
      return {rows:[Object.fromEntries(saved)]};
    }};
    for(let i=0;i<2;i++)assert.deepEqual(await writePresenceBatch(fake as any,[row]),[row.id]);assert.equal(inserts,2);assert.ok(values.length>20);
    const liveSink=Object.assign(Object.create(PostgresSink.prototype),{pool:fake,now:()=>now});
    assert.equal(await liveSink.write(row),'confirmed');assert.deepEqual(await liveSink.writeBatch([row]),{confirmed:[row.id],expired:[]});
    saved.set('state_after','offline');await assert.rejects(writePresenceBatch(fake as any,[row]),ConflictError);
    const sink=Object.assign(Object.create(PostgresSink.prototype),{retentionDays:2,now:()=>now+3*86400000});
    assert.deepEqual(sink.partitionForRetention([row]),{eligible:[],expired:[row.id]});
    assert.equal(q.stats().local_pending,1);assert.equal(q.stats().supabase_pending,1);assert.equal(q.stats().d1_pending,1);
    q.done('supabase',row.id,'expired');assert.equal(q.stats().local_pending,1);assert.equal(q.stats().supabase_retention_skipped,1);
  }finally{q.close();}
});

test('presence sessions are ephemeral, retained delivery is explicit, and durable coverage precedes ACK',async()=>{
  const baseline=JSON.parse(readFileSync(new URL('../config/ingestor.example.json',import.meta.url),'utf8'));
  const cfg:Config=validateConfig({...baseline,presence:{devices:[device],clients:[{clientId:'example-presence-reader',topics:[device.topic]}]}});
  const q=queue(),seen:IClientOptions[]=[],clients:any[]=[],coverageEvents:string[]=[];let at=now;
  let activePlan:MqttConnectionPlan|undefined;
  class Client extends EventEmitter{
    connected=false;handleMessage:any;stream={destroy:()=>{this.connected=false;this.emit('close');}};
    defer=false;pendingSuback?:()=>void;
    subscribe(topics:string[],options:any,done:any){if(topics.includes(device.topic))assert.deepEqual(options,{qos:1,rh:0});
      const finish=()=>done(null,topics.map(topic=>({topic,qos:1})));
      if(this.defer)this.pendingSuback=finish;else finish();}
    unsubscribe(topics:string[],done:any){done(null,{cmd:'unsuback',granted:topics.map(()=>17)});}
    async endAsync(){this.connected=false;}
  }
  const con=new MqttConnections(cfg,'synthetic',(packet,plan)=>{receiveConnectionMessage(q,cfg,plan,packet);},()=>{},{
    now:()=>at,connect:(_url,options)=>{seen.push(options);const c=new Client();clients.push(c);return c as unknown as MqttClient;},
    coverage:(plan,event,sequence,time)=>{activePlan=plan;if(event==='coverage_start')assert.equal(plan.presenceCoverageStartAt,undefined);
      coverageEvents.push(event);q.acceptRaw(observerRaw(device.siteId,plan.clientId,plan.presenceSessionId!,sequence,event,time),'presence-observer','1');},
  });
  try{
    assert.equal(seen.at(-1)!.clean,true);assert.equal(seen.at(-1)!.properties!.sessionExpiryInterval,0);assert.equal(seen[0].clean,false);
    const client=clients.at(-1);client.connected=true;client.emit('connect',{sessionPresent:false});assert.deepEqual(coverageEvents,['coverage_start']);
    assert.equal(activePlan!.presenceCoverageStartAt,now);
    at+=30000;con.pulsePresenceCoverage();assert.deepEqual(coverageEvents,['coverage_start','coverage_heartbeat']);
    assert.equal(activePlan!.presenceCoverageStartAt,now); // The coverage start is not the renewable coverage lease.
    client.handleMessage({cmd:'publish',topic:device.topic,qos:1,retain:false,dup:false,payload:bytes(wire({source_time_utc:new Date(Date.now()).toISOString()}))} as IPublishPacket,(error:unknown)=>{assert.ifError(error);assert.equal(q.stats().raw_records,3);});
    const row=q.nextBatch('local',10).find(row=>presenceEvent(row).record_kind==='device')!;
    assert.equal(JSON.parse(q.getRaw(row.raw_id!)!.source_id).receipt.observerCoverageStartAt,now);
    const firstSession=activePlan!.presenceSessionId;
    client.stream.destroy();assert.equal(coverageEvents.at(-1),'coverage_end');
    assert.equal(activePlan!.presenceCoverageStartAt,undefined);
    at+=1000;client.defer=true;client.connected=true;client.emit('connect',{sessionPresent:false});
    assert.notEqual(activePlan!.presenceSessionId,firstSession);assert.equal(activePlan!.presenceCoverageStartAt,undefined);
    assert.equal(activePlan!.presenceAvailable,false);
    at+=1000;client.pendingSuback!();assert.equal(activePlan!.presenceCoverageStartAt,at);
    at+=30000;con.pulsePresenceCoverage();assert.equal(activePlan!.presenceCoverageStartAt,now+32000);
  }finally{await con.stop();q.close();}
});

test('a failed durable coverage start cannot expose a coverage watermark or available observer',async()=>{
  const baseline=JSON.parse(readFileSync(new URL('../config/ingestor.example.json',import.meta.url),'utf8'));
  const cfg=validateConfig({...baseline,presence:{devices:[device],clients:[{clientId:'example-presence-reader',topics:[device.topic]}]}});
  let activePlan:MqttConnectionPlan|undefined;const clients:any[]=[];
  class Client extends EventEmitter{
    connected=false;handleMessage:any;stream={destroy:()=>{this.connected=false;this.emit('close');}};
    subscribe(topics:string[],_options:any,done:any){done(null,topics.map(topic=>({topic,qos:1})));}
    unsubscribe(topics:string[],done:any){done(null,{cmd:'unsuback',granted:topics.map(()=>17)});}
    async endAsync(){this.connected=false;}
  }
  const con=new MqttConnections(cfg,'synthetic',()=>{},()=>{},{now:()=>now,connect:()=>{const client=new Client();clients.push(client);return client as unknown as MqttClient;},
    coverage:(plan,event)=>{activePlan=plan;if(event==='coverage_start')throw new Error('synthetic durable storage unavailable');}});
  try{
    const client=clients.at(-1);client.connected=true;client.emit('connect',{sessionPresent:false});
    assert.equal(activePlan!.presenceAvailable,false);assert.equal(activePlan!.presenceCoverageStartAt,undefined);
    assert.equal(client.connected,false);assert.equal(con.snapshot().mqtt_connections.at(-1)!.subscribed,false);
  }finally{await con.stop();}
});
