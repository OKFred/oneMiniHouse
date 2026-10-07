import pg from 'pg';
import { readFileSync } from 'node:fs';
import { secret, type TargetConfig } from './config.ts';
import { canonical,hash,parseJson,observationTimes,PROCESSOR_ID,PROCESSOR_VERSION,type RecordRow,type Sample } from './message.ts';
import { ConflictError,type DeliveryOutcome,type Queue,type Target } from './queue.ts';
import { XIAOMI_QUALITY_PROCESSOR_ID } from './xiaomi-quality.ts';
import { projectMetricsForPostgres, type PostgresMetricProjection } from './pg-metric-projection.ts';

export interface BatchWriteOutcome { confirmed:string[];expired:string[] }
export function retentionTime(row:RecordRow):number {
  const v=parseJson(row.payload) as Sample;
  const times=observationTimes(v);
  const value=times.sample_time_utc??times.read_time_utc??v.source_receive_time_utc??row.received_at;
  const time=Date.parse(value);
  if(!Number.isFinite(time))throw Object.assign(new Error('Invalid retention timestamp'),{code:'22007'});
  return time;
}

export function databaseOptions(t:TargetConfig):pg.PoolConfig {
  return {host:t.host,port:t.port,database:t.database,user:t.user,password:secret(t.passwordFile),
    ssl:t.tls?{rejectUnauthorized:true,...(t.caFile?{ca:readFileSync(t.caFile)}:{})}:false,
    max:1,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,
    statement_timeout:15000,query_timeout:20000,application_name:`one-minihouse-ingestor-${t.id}`};
}
export function sourceResultHash(row:RecordRow):string {
  const v=parseJson(row.payload) as Sample;
  if(row.processor_id===XIAOMI_QUALITY_PROCESSOR_ID && !row.lineage?.metric_quality)throw new Error('Missing metric quality assessment');
  // Freeze the V1 hash contract so pre-upgrade queue retries still match both PGs.
  // The original wire timestamp remains covered; V2 additionally hashes its explicit time contract.
  return hash(canonical({message_id:row.id,raw_id:row.raw_id??row.id,processor_id:row.processor_id??PROCESSOR_ID,processor_version:row.processor_version??PROCESSOR_VERSION,output_key:row.output_key??'telemetry',site_id:v.site_id,gateway_id:v.gateway_id,device_id:v.device_id,sample_time_utc:v.sample_time_utc??v.captured_at??null,source_receive_time_utc:v.source_receive_time_utc??null,quality:v.quality,metrics:v.metrics,...(v.schema_version===2&&v.quality==='ok'?observationTimes(v):{}),...(row.processor_id===XIAOMI_QUALITY_PROCESSOR_ID?{metric_quality:row.lineage!.metric_quality}:{})}));
}
export function postgresProjection(row:RecordRow):PostgresMetricProjection {
  const v=parseJson(row.payload) as Sample;
  return projectMetricsForPostgres(v.metrics,sourceResultHash(row),row.lineage??{});
}
export function resultHash(row:RecordRow):string { return postgresProjection(row).resultHash; }
function committedResultMatches(row:RecordRow,projection:PostgresMetricProjection,existing:pg.QueryResultRow|undefined):boolean {
  if(existing?.payload_sha256!==row.hash)return false;
  if(!projection.removedMetrics.length)return existing.result_sha256==null||existing.result_sha256===projection.resultHash;
  // Projected rows must still contain the actual metrics and lineage their hash describes.
  if(existing.result_sha256===projection.resultHash)return canonical(existing.metrics??null)===canonical(projection.metrics)
    &&canonical(existing.lineage??null)===canonical(projection.lineage);
  // During an owner-run history cleanup, an old pending retry may meet an untouched legacy row.
  // A matching original result hash is not sufficient: verify its complete original metrics and
  // lineage too. This confirms the existing write without granting UPDATE or retaining new cores.
  // Null hashes and partially cleaned rows fail closed; final history acceptance requires zero cores.
  const v=parseJson(row.payload) as Sample;
  return existing.result_sha256===sourceResultHash(row)
    &&canonical(existing.metrics??null)===canonical(v.metrics)
    &&canonical(existing.lineage??null)===canonical(row.lineage??{});
}
const columns='message_id,schema_version,site_id,gateway_id,device_id,sample_time_utc,receive_time_utc,quality,metrics,payload_sha256,raw_id,processor_id,processor_version,output_key,lineage,result_sha256,source_receive_time_utc,read_time_utc,observation_kind,time_basis';
function databaseValues(row:RecordRow,projection:PostgresMetricProjection):unknown[] {
  const v=parseJson(row.payload) as Sample,t=observationTimes(v);
  return [row.id,v.schema_version,v.site_id,v.gateway_id,v.device_id,t.sample_time_utc,row.received_at,v.quality,JSON.stringify(projection.metrics),row.hash,row.raw_id??row.id,row.processor_id??PROCESSOR_ID,row.processor_version??PROCESSOR_VERSION,row.output_key??'telemetry',JSON.stringify(projection.lineage),projection.resultHash,v.source_receive_time_utc??null,t.read_time_utc,t.observation_kind,t.time_basis];
}
export class PostgresSink {
  readonly pool:pg.Pool;
  readonly retentionDays?:number;
  readonly now:()=>number;
  constructor(t:TargetConfig,now:()=>number=Date.now){this.retentionDays=t.id==='supabase'?t.retentionDays:undefined;this.now=now;this.pool=new pg.Pool(databaseOptions(t));this.pool.on('error',()=>{});}
  partitionForRetention(rows:RecordRow[]):{eligible:RecordRow[];expired:string[]} {
    if(this.retentionDays===undefined)return {eligible:rows,expired:[]};
    const cutoff=(this.now?.()??Date.now())-this.retentionDays*86400000,eligible:RecordRow[]=[],expired:string[]=[];
    for(const row of rows){if(retentionTime(row)<cutoff)expired.push(row.id);else eligible.push(row);}
    return {eligible,expired};
  }
  async write(row:RecordRow):Promise<DeliveryOutcome> {
    if(this.partitionForRetention([row]).expired.length)return 'expired';
    const projection=postgresProjection(row);
    // No raw payload in new PG rows. Legacy payload/hash are retained in place by the migration.
    const result=await this.pool.query(`INSERT INTO iot.telemetry (${columns})
      VALUES (${Array.from({length:20},(_,i)=>'$'+(i+1)).join(',')})
      ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,databaseValues(row,projection));
    if(!result.rowCount) {
      const found=await this.pool.query('SELECT payload_sha256,result_sha256,metrics,lineage FROM iot.telemetry WHERE message_id=$1',[row.id]);
      const existing=found.rows[0];
      if(!committedResultMatches(row,projection,existing))throw new ConflictError('Database message ID hash conflict');
    }
    return 'confirmed';
  }
  async writeBatch(input:RecordRow[]):Promise<BatchWriteOutcome> {
    const {eligible:rows,expired}=this.partitionForRetention(input);
    if(!rows.length)return {confirmed:[],expired};
    if(rows.length===1){const outcome=await this.write(rows[0]);return outcome==='expired'?{confirmed:[],expired:[...expired,rows[0].id]}:{confirmed:[rows[0].id],expired};}
    const values:unknown[]=[],expected=new Map<string,{row:RecordRow;projection:PostgresMetricProjection}>();
    const tuples=rows.map(row=>{
      const projection=postgresProjection(row),start=values.length;
      expected.set(row.id,{row,projection});
      values.push(...databaseValues(row,projection));
      return '('+Array.from({length:20},(_,i)=>'$'+(start+i+1)).join(',')+')';
    });
    await this.pool.query(`INSERT INTO iot.telemetry (${columns}) VALUES ${tuples.join(',')} ON CONFLICT(message_id) DO NOTHING`,values);
    const persisted=await this.pool.query('SELECT message_id,payload_sha256,result_sha256,metrics,lineage FROM iot.telemetry WHERE message_id=ANY($1::uuid[])',[rows.map(r=>r.id)]);
    if(persisted.rows.length!==expected.size)throw new ConflictError('Database batch missing committed IDs');
    for(const r of persisted.rows){const e=expected.get(r.message_id);if(!e||!committedResultMatches(e.row,e.projection,r))throw new ConflictError('Database batch message ID hash conflict');}
    return {confirmed:rows.map(row=>row.id),expired};
  }
  close(){return this.pool.end();}
}
export async function deliverOne(queue:Queue,target:Target,write:(row:RecordRow)=>Promise<DeliveryOutcome|void>):Promise<boolean> {
  const row=queue.next(target);if(!row)return false;
  const outcome=await write(row);queue.done(target,row.id,outcome??'confirmed');return true;
}
export function errorCode(error:unknown):string {
  const code=(error as {code?:string})?.code;
  return typeof code==='string'&&/^[A-Z0-9_]{1,64}$/i.test(code)?code:error instanceof ConflictError?'PAYLOAD_CONFLICT':'CONNECTION_OR_QUERY_FAILED';
}
export function permanentDeliveryError(error:unknown):boolean {
  const code=errorCode(error);
  return error instanceof ConflictError||['23502','23505','23514','22P02','22003','22007','RAW_INVALID','RAW_CONFLICT','RAW_TOO_LARGE'].includes(code);
}
