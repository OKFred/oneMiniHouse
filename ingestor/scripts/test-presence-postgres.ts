import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Queue } from '../src/queue.ts';
import { presenceRaw,observerRaw,presenceEvent,type PresenceDevice,type PresenceWire } from '../src/presence.ts';
import { writePresenceBatch } from '../src/presence-database.ts';

const context='desktop-linux';
const run=(args:string[],input?:string)=>execFileSync('docker',['--context',context,...args],{
  input,encoding:'utf8',timeout:90000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe'],
}).trim();
const metadata=JSON.parse(run(['context','inspect',context]))[0];
if(!/^npipe:\/\/\/\/\.\/pipe\/dockerDesktopLinuxEngine$/.test(metadata.Endpoints?.docker?.Host??'')
  ||run(['info','--format','{{.OperatingSystem}}'])!=='Docker Desktop')throw new Error('Refusing non-local Docker Desktop');
const name='one-minihouse-presence-'+randomUUID().slice(0,8)+'-test';
const label='one-minihouse.disposable-test=presence';let container:string|undefined;
const q=new Queue(':memory:',{maxPending:100,maxRejected:10,rawMirror:true});
try{
  container=run(['run','--detach','--name',name,'--label',label,'--network','none','--memory','256m','--cpus','1',
    '--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17']);
  const state=JSON.parse(run(['inspect',container]))[0];
  if(state.HostConfig.NetworkMode!=='none'||Object.keys(state.HostConfig.PortBindings??{}).length
    ||state.Mounts.some((m:{Type:string})=>m.Type==='bind'||m.Type==='volume'))throw new Error('Isolation guard failed');
  let ready=false;for(let i=0;i<30;i++){try{run(['exec',container,'pg_isready','-U','postgres']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
  if(!ready)throw new Error('Disposable PostgreSQL not ready');
  const sql=(text:string,database='postgres',user='postgres')=>run(['exec','-i',container!,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',database],text);
  sql('CREATE ROLE example_ingestor LOGIN;CREATE ROLE example_grafana LOGIN;CREATE ROLE example_outsider LOGIN;CREATE DATABASE presence_local;CREATE DATABASE presence_cloud;');
  const migration=readFileSync(new URL('../sql/007-device-presence.sql',import.meta.url),'utf8');
  const views=readFileSync(new URL('../sql/008-device-presence-reader.example.sql',import.meta.url),'utf8');
  for(const db of ['presence_local','presence_cloud']){
    sql(`CREATE SCHEMA iot;CREATE TABLE iot.telemetry(id integer);INSERT INTO iot.telemetry VALUES(7);
      CREATE VIEW iot.home_existing_example WITH(security_barrier=true) AS SELECT * FROM iot.telemetry;
      GRANT USAGE ON SCHEMA iot TO example_grafana;GRANT SELECT ON iot.home_existing_example TO example_grafana;`,db);
    const before=sql("SELECT pg_get_viewdef('iot.home_existing_example'::regclass,true);",db);
    for(let i=0;i<2;i++)sql("SET one_min_house.ingestor_role='example_ingestor';"+migration+views,db);
    assert.equal(sql("SELECT pg_get_viewdef('iot.home_existing_example'::regclass,true);",db),before);
  }
  const device:PresenceDevice={id:'example-host',label:'示例主机',topic:'iot/v1/example-home/host/status',siteId:'example-home',gatewayId:'host',deviceId:'physical-host',
    reporterId:'example-host-publisher',kind:'direct',intervalSeconds:60,freshnessSeconds:300};
  const now=Date.now(),session=randomUUID(),observer=randomUUID();
  q.acceptRaw(observerRaw(device.siteId,'example-presence-reader',observer,1,'coverage_start',now),'presence-observer','1');
  const wire:PresenceWire={schema_version:1,event_id:randomUUID(),site_id:device.siteId,gateway_id:device.gatewayId,device_id:device.deviceId,reporter_id:device.reporterId,
    boot_id:'example-boot',session_id:session,sequence:0,event:'online',online:true,reason:'connected',source_time_utc:new Date(now).toISOString(),uptime_ms:0};
  q.acceptPresence(presenceRaw(device,Buffer.from(JSON.stringify(wire)),{observerClientId:'example-presence-reader',observerSessionId:observer,observedAt:now,retained:false,qos:1,duplicate:false,available:true}));
  for(const kind of ['proxy','cached'] as const){
    const child:PresenceDevice={...device,id:'example-'+kind,deviceId:'child-'+kind,topic:device.topic+'/'+kind,parentId:device.id,kind,
      intervalSeconds:kind==='cached'?null:600,freshnessSeconds:kind==='cached'?null:1800};
    q.acceptPresence(presenceRaw(child,Buffer.from(JSON.stringify({...wire,event_id:randomUUID(),device_id:child.deviceId,event:'observation',reason:'read_ok'})),
      {observerClientId:'example-presence-reader',observerSessionId:observer,observedAt:now,retained:false,qos:1,duplicate:false,available:true}));
  }
  const rows=q.nextBatch('local',100);
  const literal=(value:unknown):string=>value===null?'NULL':Array.isArray(value)?'ARRAY['+value.map(literal).join(',')+']':typeof value==='number'?String(value):typeof value==='boolean'?String(value):"'"+String(value).replaceAll("'","''")+"'";
  for(const db of ['presence_local','presence_cloud']){
    const pool={query:async(text:string,values:unknown[])=>{
      const bound=text.replace(/\$(\d+)/g,(_match,index)=>literal(values[Number(index)-1]));
      if(text.startsWith('INSERT')){sql(bound,db,'example_ingestor');return {rows:[]};}
      const found=JSON.parse(sql(`SELECT coalesce(json_agg(t),'[]') FROM(${bound}) t;`,db,'example_ingestor'));
      for(const record of found)for(const [key,value] of Object.entries(record))if(key.endsWith('_utc')&&value!==null)record[key]=new Date(String(value));
      return {rows:found};
    }};
    for(let i=0;i<2;i++)assert.deepEqual(await writePresenceBatch(pool as never,rows),rows.map(r=>r.id));
    assert.equal(sql('SELECT count(*) FROM iot.device_presence_events;',db,'example_ingestor'),'4');
    assert.equal(sql("SELECT freshness_seconds FROM iot.device_presence_events WHERE physical_device_id='example-proxy';",db,'example_ingestor'),'1800');
    assert.equal(sql("SELECT state_after FROM iot.device_presence_events WHERE physical_device_id='example-cached' AND freshness_seconds IS NULL AND valid_until_utc IS NULL;",db,'example_ingestor'),'unknown');
    assert.equal(sql('SELECT count(*) FROM iot.home_device_presence_events;',db,'example_grafana'),'1');
    assert.equal(sql('SELECT count(*) FROM iot.home_presence_observer_coverage;',db,'example_grafana'),'1');
    assert.equal(sql('SELECT id FROM iot.home_existing_example;',db,'example_grafana'),'7');
    assert.throws(()=>sql('SELECT * FROM iot.device_presence_events;',db,'example_grafana'),/permission denied/);
    assert.throws(()=>sql('SELECT * FROM iot.telemetry;',db,'example_grafana'),/permission denied/);
    assert.throws(()=>sql('DELETE FROM iot.device_presence_events;',db,'example_ingestor'),/permission denied/);
    assert.throws(()=>sql('SELECT * FROM iot.home_device_presence_events;',db,'example_outsider'),/permission denied/);
    assert.equal(sql("SELECT relrowsecurity FROM pg_class WHERE oid='iot.device_presence_events'::regclass;",db),'t');
  }
  assert.equal(presenceEvent(rows.find(r=>presenceEvent(r).record_kind==='device')!).state_after,'online');
  console.log(JSON.stringify({ok:true,database:'PostgreSQL 17',dual_sinks:true,actual_runtime_role:true,actual_reader_role:true,repeated_migration:true,
    exact_reader_whitelist:true,old_view_preserved:true,base_and_public_denied:true,production_accessed:false}));
}finally{
  q.close();
  if(container){const state=JSON.parse(run(['inspect',container]))[0];
    if(state.Id!==container||state.Name!==`/${name}`||state.Config.Labels?.['one-minihouse.disposable-test']!=='presence')throw new Error('Refusing cleanup after identity change');
    run(['rm','--force',container]);}
}
