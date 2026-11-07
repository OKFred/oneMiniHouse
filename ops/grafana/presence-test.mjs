import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Queue } from '../../ingestor/src/queue.ts';
import { observerRaw,presenceRaw,presenceEvent,presenceAt } from '../../ingestor/src/presence.ts';
import { writePresenceBatch } from '../../ingestor/src/presence-database.ts';

// Only a new local, network-isolated fixture. Never accept a runtime DB/container from arguments.
const context='desktop-linux';
const scale=process.argv.includes('--scale');
const run=(args,input)=>execFileSync('docker',['--context',context,...args],{input,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
const meta=JSON.parse(run(['context','inspect',context]))[0];
if(!/^npipe:\/\/\/\/\.\/pipe\/dockerDesktopLinuxEngine$/.test(meta.Endpoints?.docker?.Host??'')||run(['info','--format','{{.OperatingSystem}}'])!=='Docker Desktop')throw new Error('Refusing non-local Docker Desktop');
const name='one-minihouse-presence-timeline-'+randomUUID().slice(0,8)+'-test';let container;
const q=new Queue(':memory:',{maxPending:1000,maxRejected:10,rawMirror:true});
const epoch=Date.parse('2026-11-08T00:00:00Z'),time=seconds=>epoch+seconds*1000,iso=seconds=>new Date(time(seconds)).toISOString();
const base={id:'example-host',label:'示例主机',topic:'iot/v1/example-home/host/status',siteId:'example-home',gatewayId:'host',deviceId:'physical-host',reporterId:'example-host-publisher',kind:'direct',intervalSeconds:60,freshnessSeconds:300};
const reporter={...base,id:'example-reporter',label:'示例逻辑报告器',deviceId:'reporter',reporterId:'gateway-publisher',topic:'iot/v1/example-home/gateway/status',parentId:base.id,visible:false};
const sensor={...base,id:'example-sensor',label:'示例直接传感器',deviceId:'sensor',reporterId:reporter.reporterId,topic:reporter.topic+'/sensor',kind:'proxy',parentId:reporter.id};
const cached={...sensor,id:'example-cache',label:'示例缓存传感器',deviceId:'cache',topic:reporter.topic+'/cache',kind:'cached',intervalSeconds:null,freshnessSeconds:null};
const unseen={...base,id:'example-unseen',label:'示例未上报设备',topic:base.topic+'/unseen',deviceId:'unseen'};
const devices=[base,reporter,sensor,cached,unseen],observer1=randomUUID(),observer2=randomUUID(),observer3=randomUUID(),host1=randomUUID(),host2=randomUUID(),host3=randomUUID(),gateway1=randomUUID(),gateway2=randomUUID();
const actions=[];let insertion=0;
const schedule=(at,run)=>actions.push({at,run,insertion:insertion++});
function cover(at,observer,sequence,event='coverage_heartbeat'){schedule(at,()=>q.acceptRaw(observerRaw(base.siteId,'example-presence-reader',observer,sequence,event,time(at)),'presence-observer','1'));}
function event(at,device,session,sequence,event='heartbeat',online=true,reason='heartbeat',observer=observer1,extras={}){
  schedule(at,()=>{
    const value={schema_version:1,event_id:randomUUID(),site_id:device.siteId,gateway_id:device.gatewayId,device_id:device.deviceId,reporter_id:device.reporterId,
      boot_id:session,session_id:session,sequence,event,online,reason,source_time_utc:iso(at),uptime_ms:at*1000,...extras};
    q.acceptPresence(presenceRaw(device,Buffer.from(JSON.stringify(value)),{observerClientId:'example-presence-reader',observerSessionId:observer,observedAt:time(at),retained:false,qos:1,duplicate:false,available:true}));
  });
}
function will(at,device,session,observer=observer1){event(at,device,session,null,'offline',false,'lwt',observer,{source_time_utc:null,uptime_ms:null});}
cover(0,observer1,1,'coverage_start');for(let at=30;at<=330;at+=30)cover(at,observer1,at/30+1);
event(0,base,host1,0,'online',true,'connected');
// Retained wire.online=true and an old sequence are not state events.
schedule(1,()=>{
  const value={schema_version:1,event_id:randomUUID(),site_id:base.siteId,gateway_id:base.gatewayId,device_id:base.deviceId,reporter_id:base.reporterId,
    boot_id:host1,session_id:host1,sequence:0,event:'online',online:true,reason:'connected',source_time_utc:iso(0),uptime_ms:0};
  q.acceptPresence(presenceRaw(base,Buffer.from(JSON.stringify(value)),{observerClientId:'example-presence-reader',observerSessionId:observer1,observedAt:time(1),retained:true,qos:1,duplicate:false,available:true}));
});
event(20,base,host1,0);event(10,reporter,gateway1,0,'online',true,'connected');
event(70,reporter,gateway1,1);event(130,reporter,gateway1,2);
event(20,sensor,gateway1,1,'observation',true,'read_ok');event(30,cached,gateway1,2,'observation',true,'read_ok');
event(100,sensor,gateway1,3,'observation',false,'read_failed');event(120,sensor,gateway1,4,'observation',true,'read_ok');
event(160,sensor,gateway1,5,'observation',true,'read_ok');event(220,sensor,gateway1,6,'observation',true,'read_ok');
// A later heartbeat in one publisher instance must preserve the earlier 300..350 TTL hole.
event(350,base,host1,1);
// The last pulse at330 expires at420; a later pulse at500 cannot bridge that gap.
cover(500,observer2,1,'coverage_start');for(let at=530;at<=680;at+=30)cover(at,observer2,(at-500)/30+1);
event(520,base,host1,2,'heartbeat',true,'heartbeat',observer2);event(580,base,host1,3,'heartbeat',true,'heartbeat',observer2);
event(550,reporter,gateway1,10,'heartbeat',true,'heartbeat',observer2);
event(560,sensor,gateway1,11,'observation',true,'read_ok',observer2);event(570,cached,gateway1,12,'observation',true,'read_ok',observer2);
will(600,reporter,gateway1,observer2);event(630,reporter,gateway2,0,'online',true,'connected',observer2);
event(640,sensor,gateway2,1,'observation',true,'read_ok',observer2);event(650,base,host2,0,'online',true,'connected',observer2);
will(680,base,host1,observer2);
// Same-millisecond end/start and Will/new birth require durable first-intake order.
cover(700,observer2,20,'coverage_end');cover(700,observer3,1,'coverage_start');for(let at=730;at<=900;at+=30)cover(at,observer3,(at-700)/30+1);
event(710,base,host2,1,'heartbeat',true,'heartbeat',observer3);event(720,reporter,gateway2,10,'heartbeat',true,'heartbeat',observer3);
event(730,sensor,gateway2,11,'observation',true,'read_ok',observer3);
will(750,base,host2,observer3);event(750,base,host3,0,'online',true,'connected',observer3);will(750,base,host2,observer3);will(800,base,host3,observer3);
actions.sort((a,b)=>a.at-b.at||a.insertion-b.insertion).forEach(action=>action.run());
const rows=q.nextBatch('local',1000),all=rows.map(presenceEvent);
const literal=value=>value===null?'NULL':Array.isArray(value)?'ARRAY['+value.map(literal).join(',')+']':typeof value==='number'||typeof value==='boolean'?String(value):"'"+String(value).replaceAll("'","''")+"'";
try{
  container=run(['run','--detach','--name',name,'--label','one-minihouse.disposable-test=presence-timeline','--network','none','--memory',scale?'768m':'256m','--cpus','1',
    '--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17']);
  const state=JSON.parse(run(['inspect',container]))[0];if(state.HostConfig.NetworkMode!=='none'||Object.keys(state.HostConfig.PortBindings??{}).length||state.Mounts.some(m=>m.Type==='bind'||m.Type==='volume'))throw new Error('Isolation guard failed');
  let ready=false;for(let i=0;i<30;i++){try{run(['exec',container,'pg_isready','-U','postgres']);ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}}if(!ready)throw new Error('Disposable PostgreSQL not ready');
  const sql=(text,database='postgres',user='postgres')=>run(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',database],text);
  sql('CREATE ROLE example_ingestor LOGIN;CREATE ROLE example_grafana LOGIN;CREATE ROLE example_outsider LOGIN;CREATE DATABASE timeline_local;CREATE DATABASE timeline_cloud;');
  const migration=readFileSync(new URL('../../ingestor/sql/007-device-presence.sql',import.meta.url),'utf8');
  const registry=readFileSync(new URL('presence-registry.example.sql',import.meta.url),'utf8'),views=readFileSync(new URL('presence-reader-views.sql',import.meta.url),'utf8'),timeline=readFileSync(new URL('presence-timeline.sql',import.meta.url),'utf8');
  for(const db of ['timeline_local','timeline_cloud']){
    sql('CREATE SCHEMA iot;',db);
    for(let i=0;i<2;i++)sql("SET one_min_house.ingestor_role='example_ingestor';SET one_min_house.grafana_role='example_grafana';"+migration+registry+views+timeline,db);
    const pool={query:async(text,values)=>{
      const bound=text.replace(/\$(\d+)/g,(_match,index)=>literal(values[Number(index)-1]));
      if(text.startsWith('INSERT')){sql(bound,db,'example_ingestor');return{rows:[]};}
      const found=JSON.parse(sql(`SELECT coalesce(json_agg(t),'[]') FROM(${bound})t;`,db,'example_ingestor'));
      for(const record of found)for(const[key,value]of Object.entries(record))if(key.endsWith('_utc')&&value!==null)record[key]=new Date(value);
      return{rows:found};
    }};
    await writePresenceBatch(pool,rows);await writePresenceBatch(pool,rows);
    if(db==='timeline_cloud')sql(`DELETE FROM iot.device_presence_events WHERE observed_time_utc<${literal(iso(500+48*3600))}::timestamptz-interval '48 hours';`,db);
  }
  const scenarios=[{db:'timeline_local',events:all},{db:'timeline_cloud',events:all.filter(e=>Date.parse(e.observed_time_utc)>=time(500))}];
  let comparisons=0;
  for(const scenario of scenarios){
    for(const [from,to]of [[-120,900],[450,780],[615,780],[500,501],[700,701],[750,751]]){
      const intervals=JSON.parse(sql(`SELECT coalesce(json_agg(t ORDER BY physical_device_id,start_time_utc),'[]') FROM iot.home_presence_timeline(${literal(iso(from))},${literal(iso(to))})t;`,scenario.db,'example_grafana'));
      for(const d of devices.filter(d=>d.visible!==false)){
        const segments=intervals.filter(s=>s.physical_device_id===d.id);assert.ok(segments.length,d.id+' missing registry row');
        assert.equal(Date.parse(segments[0].start_time_utc),time(from));assert.equal(Date.parse(segments.at(-1).end_time_utc),time(to));
        for(let i=0;i<segments.length;i++){assert.ok(Date.parse(segments[i].start_time_utc)<Date.parse(segments[i].end_time_utc));if(i)assert.equal(segments[i].start_time_utc,segments[i-1].end_time_utc);}
      }
      assert.ok(!intervals.some(s=>s.physical_device_id===reporter.id));
      const points=new Set([time(from),time(to)-1]);
      for(const e of scenario.events)for(const field of ['observed_time_utc','valid_until_utc','coverage_until_utc'])if(e[field])for(const offset of [-1,0,1]){const point=Date.parse(e[field])+offset;if(point>=time(from)&&point<time(to))points.add(point);}
      for(const point of points){
        const expected=presenceAt(devices,scenario.events,point);
        for(const[id,state]of Object.entries(expected)){
          const segment=intervals.find(s=>s.physical_device_id===id&&Date.parse(s.start_time_utc)<=point&&Date.parse(s.end_time_utc)>point);
          assert.ok(segment,`${scenario.db}/${id}/${point}: no interval`);assert.equal(segment.state,state,`${scenario.db}/${id}/${new Date(point).toISOString()}`);comparisons++;
        }
      }
      for(const segment of intervals)if(segment.last_heartbeat_time_utc)assert.ok(Date.parse(segment.last_heartbeat_time_utc)<=Date.parse(segment.end_time_utc));
    }
    assert.throws(()=>sql('SELECT * FROM iot.device_presence_events;',scenario.db,'example_grafana'),/permission denied/);
    assert.throws(()=>sql(`SELECT * FROM iot.home_presence_timeline(${literal(iso(0))},${literal(iso(1))});`,scenario.db,'example_outsider'),/permission denied/);
    assert.throws(()=>sql(`SELECT * FROM iot.home_presence_timeline(${literal(iso(1))},${literal(iso(0))});`,scenario.db,'example_grafana'),/increasing UTC range/);
  }
  const local=JSON.parse(sql(`SELECT coalesce(json_agg(t),'[]') FROM iot.home_presence_timeline(${literal(iso(-120))},${literal(iso(900))})t;`,'timeline_local','example_grafana'));
  const at=(id,seconds)=>local.find(s=>s.physical_device_id===id&&Date.parse(s.start_time_utc)<=time(seconds)&&Date.parse(s.end_time_utc)>time(seconds));
  assert.equal(at(base.id,299).state,'online');assert.equal(at(base.id,300).state,'offline');assert.equal(at(base.id,420).state,'unknown');assert.equal(at(base.id,500).state,'unknown');assert.equal(at(base.id,520).state,'online');
  assert.equal(at(base.id,349).state,'offline');assert.equal(at(base.id,350).state,'online');
  assert.equal(Date.parse(at(sensor.id,250).last_heartbeat_time_utc),time(220));
  assert.equal(Date.parse(at(base.id,600).last_heartbeat_time_utc),time(580));
  assert.equal(Date.parse(at(base.id,299).start_time_utc),time(0));assert.equal(Date.parse(at(base.id,299).end_time_utc),time(300));
  assert.equal(local.filter(s=>s.physical_device_id===unseen.id).length,1);
  assert.equal(at(sensor.id,600).state,'unknown');assert.equal(at(sensor.id,630).state,'unknown');assert.equal(at(sensor.id,640).state,'online');
  assert.equal(at(base.id,700).state,'unknown');assert.equal(at(base.id,710).state,'online');assert.equal(at(base.id,750).state,'online');assert.equal(at(base.id,800).state,'offline');
  assert.ok(local.filter(s=>s.physical_device_id===cached.id||s.physical_device_id===unseen.id).every(s=>s.state==='unknown'));
  let scaleResult;
  if(scale){
  // Synthetic, normalized events isolate timeline query cost from receiver validation.
  const deviceTemplate=JSON.parse(sql(`SELECT row_to_json(e) FROM iot.device_presence_events e WHERE record_kind='device' AND applied AND state_after='online' LIMIT 1;`,'timeline_local'));
  const observerTemplate=JSON.parse(sql(`SELECT row_to_json(e) FROM iot.device_presence_events e WHERE record_kind='observer' LIMIT 1;`,'timeline_local'));
  sql(`TRUNCATE iot.device_presence_events;
    CREATE OR REPLACE VIEW iot.home_presence_registry WITH(security_barrier=true,security_invoker=false) AS
    SELECT 'scale-device-'||n AS physical_device_id,'Scale device '||n AS device_name,'example-home'::text AS site_id,
      'direct'::text AS kind,NULL::text AS parent_id,true AS visible,'example-presence-reader'::text AS observer_client_id,300 AS freshness_seconds
    FROM generate_series(0,9)n;`,'timeline_local');
  const deviceJson=JSON.stringify(deviceTemplate),observerJson=JSON.stringify(observerTemplate);
  sql(`INSERT INTO iot.device_presence_events SELECT p.* FROM generate_series(0,9)n CROSS JOIN generate_series(0,10079)s
    CROSS JOIN LATERAL jsonb_populate_record(NULL::iot.device_presence_events,
    ${literal(deviceJson)}::jsonb||jsonb_build_object(
      'result_id',md5('device-result-'||n||'-'||s)::uuid,'raw_id',md5('device-raw-'||n||'-'||s)::uuid,'event_id',md5('device-event-'||n||'-'||s)::uuid,
      'physical_device_id','scale-device-'||n,'device_name','Scale device '||n,
      'reporter_id','scale-publisher-'||n,'boot_id','scale-boot-'||n,'session_id',md5('scale-session-'||n)::uuid,
      'observer_client_id','example-presence-reader','observer_session_id',${literal(observer1)}::uuid,
      'observed_time_utc',${literal(iso(0))}::timestamptz+make_interval(secs=>s*60+n),
      'source_time_utc',${literal(iso(0))}::timestamptz+make_interval(secs=>s*60+n),
      'valid_until_utc',${literal(iso(300))}::timestamptz+make_interval(secs=>s*60+n),
      'observation_order',s::bigint*100+n+1,'sequence',s,'event',CASE WHEN s=0 THEN 'online' ELSE 'heartbeat' END,
      'reason',CASE WHEN s=0 THEN 'connected' ELSE 'heartbeat' END,'uptime_ms',(s::bigint*60+n)*1000
    )) p;
    INSERT INTO iot.device_presence_events SELECT p.* FROM generate_series(0,20159)s
    CROSS JOIN LATERAL jsonb_populate_record(NULL::iot.device_presence_events,
      ${literal(observerJson)}::jsonb||jsonb_build_object(
      'result_id',md5('coverage-result-'||s)::uuid,'raw_id',md5('coverage-raw-'||s)::uuid,'event_id',md5('coverage-event-'||s)::uuid,
      'observer_client_id','example-presence-reader','observer_session_id',${literal(observer1)}::uuid,
      'observed_time_utc',${literal(iso(0))}::timestamptz+make_interval(secs=>s*30),
      'coverage_until_utc',${literal(iso(90))}::timestamptz+make_interval(secs=>s*30),
      'observation_order',s::bigint*100+90,'sequence',s,'event',CASE WHEN s=0 THEN 'coverage_start' ELSE 'coverage_heartbeat' END
    )) p;
    ANALYZE iot.device_presence_events;`,'timeline_local');
  const started=performance.now();
  const plan=JSON.parse(sql(`SET statement_timeout='15s';EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)
    SELECT count(*) FROM iot.home_presence_timeline(${literal(iso(0))},${literal(iso(7*86400))});`,'timeline_local','example_grafana'));
  scaleResult={physical_devices:10,days:7,device_events:100800,coverage_events:20160,execution_ms:plan[0]['Execution Time'],wall_ms:performance.now()-started,intervals:plan[0].Plan.Plans[0]['Actual Rows']};
  assert.equal(scaleResult.intervals,19);assert.ok(scaleResult.execution_ms<5000,'Seven-day presence query must finish within five seconds');

  }
  console.log(JSON.stringify({ok:true,scale:scaleResult,database:'PostgreSQL17',comparisons,devices:devices.filter(d=>d.visible!==false).length,
    interval_boundaries:true,reference_reducer:true,green300_red_unknown:true,coverage90_and_gap:true,same_millisecond_order:true,
    hidden_parent:true,parent_session_match:true,retained_and_old_will_ignored:true,registry_unseen:true,cloud48h_boundary:true,
    actual_reader_role:true,base_public_denied:true,repeated_migration:true,production_accessed:false}));
}finally{
  q.close();if(container){const state=JSON.parse(run(['inspect',container]))[0];if(state.Id!==container||state.Name!==`/${name}`||state.Config.Labels?.['one-minihouse.disposable-test']!=='presence-timeline')throw new Error('Refusing cleanup after identity change');run(['rm','--force',container]);}
}
