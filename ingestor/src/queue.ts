import { DatabaseSync } from 'node:sqlite';
import { hash, canonical, parseJson, parseSample, stableUuid, PROCESSOR_ID, PROCESSOR_VERSION, type RecordRow, type RawRecord, type FrameRecord, type Sample } from './message.ts';
import {convertHistory,LEGACY_TABLES,type LegacyTable,type LegacyRow} from './history.ts';
import { collectdTemperatureProcessor } from './collectd.ts';
import { isXiaomiTemperature, xiaomiQualityProcessor, XIAOMI_QUALITY_PROCESSOR_ID } from './xiaomi-quality.ts';
export type Target = 'local' | 'supabase';
export type DeliveryTarget = Target | 'd1' | 'sls';
export type DeliveryOutcome = 'confirmed' | 'expired';
export class CapacityError extends Error {}
export class ConflictError extends Error {}
export interface QueueOptions {
  maxPending: number; maxRejected: number; rawRetentionDays?: number; frameRetentionDays?: number;
  maxProtocolFrames?: number; rawMirror?: boolean; frameMirror?: boolean;
}
export interface Processor { id:string;version:string;process:(raw:RawRecord)=>RecordRow }
const DAY = 86400000;
const rawColumns = ['raw_id','topic','source_kind','source_id','source_message_id','source_site_id','source_gateway_id','source_device_id','data_kind','content_type','raw_data','raw_data_sha256','generate_time_utc','receive_time_utc','store_time_utc','expire_time_utc'] as const;
export class Queue {
  private db: DatabaseSync;
  private transaction = false;
  private processors = new Map<string,Processor>();
  readonly options: Required<QueueOptions>;
  constructor(path: string, options: QueueOptions, processors:Processor[] = []) {
    this.registerProcessor(collectdTemperatureProcessor);
    this.registerProcessor(xiaomiQualityProcessor);
    this.registerProcessor({id:PROCESSOR_ID,version:PROCESSOR_VERSION,process:raw=>{
      const prefix=raw.topic.split('/').slice(0,4).join('/');
      return parseSample(raw.topic,Buffer.from(raw.raw_data),[prefix],new Date(Math.max(Date.now(),raw.receive_time_utc)));
    }});
    this.registerProcessor({id:'legacy-ddsu666',version:'1',process:raw=>{
      const [databaseId,table,rowId,...extra]=raw.source_id.split('/');
      const row=parseJson(raw.raw_data) as LegacyRow;
      if(raw.source_kind!=='legacy_d1'||extra.length||String(row.id)!==rowId||!LEGACY_TABLES.includes(table as LegacyTable))throw new Error('Unsupported historical source');
      // Reuse stored provenance, including the database ID, so pre-existing queues
      // replay with exactly the same IDs and hashes after configuration cleanup.
      const converted=convertHistory(table as LegacyTable,row,{databaseId:databaseId!,ownerId:row.owner_id,siteId:raw.source_site_id!,gatewayId:raw.source_gateway_id!,deviceId:raw.source_device_id!},Math.max(Date.now(),raw.store_time_utc));
      if(converted.raw.raw_id!==raw.raw_id||converted.raw.topic!==raw.topic)throw new Error('Historical provenance mismatch');
      return converted.result;
    }});
    for(const processor of processors)this.registerProcessor(processor);
    this.options = {rawRetentionDays:180,frameRetentionDays:30,maxProtocolFrames:250000,rawMirror:false,frameMirror:false,...options};
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counts (name TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO counts VALUES ('received',0),('completed',0),('duplicates',0),('rejected',0),('rejected_pruned',0),('raw_pruned',0),('frames_pruned',0),('frames_dropped_capacity',0),('frame_received',0),('legacy_migrated',0),('outstanding_raw',0),('supabase_retention_skipped',0);
      CREATE TABLE IF NOT EXISTS raw_message (
        raw_id TEXT PRIMARY KEY,topic TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,
        source_message_id TEXT,source_site_id TEXT,source_gateway_id TEXT,source_device_id TEXT,
        data_kind TEXT NOT NULL CHECK(data_kind IN ('inline','object_ref')),content_type TEXT NOT NULL,raw_data TEXT NOT NULL,raw_data_sha256 TEXT NOT NULL,
        generate_time_utc INTEGER,receive_time_utc INTEGER NOT NULL,store_time_utc INTEGER NOT NULL,expire_time_utc INTEGER NOT NULL,semantic_hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS raw_expiry ON raw_message(expire_time_utc);
      CREATE TABLE IF NOT EXISTS processing_job (
        raw_id TEXT NOT NULL REFERENCES raw_message(raw_id) ON DELETE CASCADE,processor_id TEXT NOT NULL,processor_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','done','failed')),attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
        create_time_utc INTEGER NOT NULL,update_time_utc INTEGER NOT NULL,
        PRIMARY KEY(raw_id,processor_id,processor_version));
      CREATE INDEX IF NOT EXISTS processing_status ON processing_job(status,create_time_utc);
      CREATE TABLE IF NOT EXISTS processed_result (
        id TEXT PRIMARY KEY,raw_id TEXT NOT NULL REFERENCES raw_message(raw_id) ON DELETE CASCADE,processor_id TEXT NOT NULL,processor_version TEXT NOT NULL,output_key TEXT NOT NULL,
        row_json TEXT NOT NULL,create_time_utc INTEGER NOT NULL,UNIQUE(raw_id,processor_id,processor_version,output_key));
      CREATE TABLE IF NOT EXISTS protocol_frame (
        frame_id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,frame_json TEXT NOT NULL,raw_data_sha256 TEXT NOT NULL,
        frame_time_utc INTEGER NOT NULL,receive_time_utc INTEGER NOT NULL,store_time_utc INTEGER NOT NULL,expire_time_utc INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS frame_expiry ON protocol_frame(expire_time_utc);
      CREATE TABLE IF NOT EXISTS delivery_job (
        artifact_id TEXT NOT NULL,artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('raw','processed','frame')),raw_id TEXT,
        target_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','done','failed')),attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
        next_attempt_time_utc INTEGER NOT NULL DEFAULT 0,create_time_utc INTEGER NOT NULL,update_time_utc INTEGER NOT NULL,
        PRIMARY KEY(artifact_id,target_id));
      CREATE INDEX IF NOT EXISTS delivery_next ON delivery_job(target_id,status,next_attempt_time_utc,create_time_utc);
      CREATE INDEX IF NOT EXISTS delivery_raw ON delivery_job(raw_id,status);
      CREATE TABLE IF NOT EXISTS quarantine_message (
        id TEXT PRIMARY KEY,raw_id TEXT,topic TEXT NOT NULL,payload_base64 TEXT NOT NULL,reason TEXT NOT NULL,
        receive_time_utc INTEGER NOT NULL,replay_time_utc INTEGER,replay_status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS pending_raw(raw_id TEXT PRIMARY KEY REFERENCES raw_message(raw_id) ON DELETE CASCADE);
      CREATE TRIGGER IF NOT EXISTS pending_raw_add AFTER INSERT ON pending_raw BEGIN UPDATE counts SET value=value+1 WHERE name='outstanding_raw'; END;
      CREATE TRIGGER IF NOT EXISTS pending_raw_remove AFTER DELETE ON pending_raw BEGIN UPDATE counts SET value=value-1 WHERE name='outstanding_raw'; END;
      CREATE TRIGGER IF NOT EXISTS delivery_pending_insert AFTER INSERT ON delivery_job WHEN NEW.raw_id IS NOT NULL AND NEW.status!='done' BEGIN INSERT OR IGNORE INTO pending_raw VALUES(NEW.raw_id); END;
      CREATE TRIGGER IF NOT EXISTS delivery_pending_update AFTER UPDATE OF status ON delivery_job WHEN NEW.raw_id IS NOT NULL BEGIN
        INSERT OR IGNORE INTO pending_raw SELECT NEW.raw_id WHERE NEW.status!='done';
        DELETE FROM pending_raw WHERE raw_id=NEW.raw_id AND NOT EXISTS(SELECT 1 FROM processing_job WHERE raw_id=NEW.raw_id AND status='pending') AND NOT EXISTS(SELECT 1 FROM delivery_job WHERE raw_id=NEW.raw_id AND status!='done');
      END;
      CREATE TRIGGER IF NOT EXISTS processing_pending_insert AFTER INSERT ON processing_job WHEN NEW.status='pending' BEGIN INSERT OR IGNORE INTO pending_raw VALUES(NEW.raw_id); END;
      CREATE TRIGGER IF NOT EXISTS processing_pending_update AFTER UPDATE OF status ON processing_job BEGIN
        INSERT OR IGNORE INTO pending_raw SELECT NEW.raw_id WHERE NEW.status='pending';
        DELETE FROM pending_raw WHERE raw_id=NEW.raw_id AND NOT EXISTS(SELECT 1 FROM processing_job WHERE raw_id=NEW.raw_id AND status='pending') AND NOT EXISTS(SELECT 1 FROM delivery_job WHERE raw_id=NEW.raw_id AND status!='done');
      END;`);
    this.tx(()=>{
      if(!this.db.prepare('PRAGMA table_info(delivery_job)').all().some(column=>column.name==='outcome')){
        this.db.exec("ALTER TABLE delivery_job ADD COLUMN outcome TEXT CHECK(outcome IS NULL OR outcome IN ('confirmed','expired'))");
      }
    });
    this.migrateLegacy();
    this.tx(()=>{
      // Enabling a mirror later also schedules the still-retained local archive.
      const now=Date.now();
      if(this.options.rawMirror)this.db.prepare(`INSERT OR IGNORE INTO delivery_job(artifact_id,artifact_kind,raw_id,target_id,status,create_time_utc,update_time_utc) SELECT raw_id,'raw',raw_id,'d1','pending',store_time_utc,? FROM raw_message WHERE expire_time_utc>?`).run(now,now);
      if(this.options.frameMirror)this.db.prepare(`INSERT OR IGNORE INTO delivery_job(artifact_id,artifact_kind,raw_id,target_id,status,create_time_utc,update_time_utc) SELECT frame_id,'frame',NULL,'sls','pending',store_time_utc,? FROM protocol_frame WHERE expire_time_utc>?`).run(now,now);
      this.db.exec(`INSERT OR IGNORE INTO pending_raw SELECT raw_id FROM processing_job WHERE status='pending';
        INSERT OR IGNORE INTO pending_raw SELECT raw_id FROM delivery_job WHERE raw_id IS NOT NULL AND status!='done';
        UPDATE counts SET value=(SELECT count(*) FROM pending_raw) WHERE name='outstanding_raw';`);
    });
  }
  private tx<T>(action:()=>T):T {
    if (this.transaction) return action();
    this.db.exec('BEGIN IMMEDIATE'); this.transaction=true;
    try { const result=action(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.transaction=false; }
  }
  private inc(name:string,n=1) { this.db.prepare('UPDATE counts SET value=value+? WHERE name=?').run(n,name); }
  private job(id:string,kind:'raw'|'processed'|'frame',target:DeliveryTarget,rawId:string|null,now:number) {
    this.db.prepare(`INSERT OR IGNORE INTO delivery_job(artifact_id,artifact_kind,raw_id,target_id,status,create_time_utc,update_time_utc) VALUES(?,?,?,?,'pending',?,?)`).run(id,kind,rawId,target,now,now);
  }
  private pendingCount():number {
    return Number(this.db.prepare(`SELECT value FROM counts WHERE name='outstanding_raw'`).get()!.value);
  }
  private capacity() { if(this.pendingCount()>=this.options.maxPending) throw new CapacityError('Pending capacity reached; unsent records preserved'); }
  private saveRaw(raw:RawRecord,semanticHash:string) {
    this.db.prepare(`INSERT INTO raw_message(${rawColumns.join(',')},semantic_hash) VALUES(${rawColumns.map(()=>'?').join(',')},?)`).run(...rawColumns.map(k=>raw[k]),semanticHash);
    if(this.options.rawMirror) this.job(raw.raw_id,'raw','d1',raw.raw_id,raw.store_time_utc);
  }
  private makeRaw(row:RecordRow):RawRecord {
    const v=parseJson(row.payload) as Sample,now=Date.now();
    return {raw_id:row.raw_id??row.id,topic:row.topic,source_kind:row.source_kind??'mqtt',source_id:row.source_id??row.topic,
      source_message_id:row.id,source_site_id:v.site_id,source_gateway_id:v.gateway_id,source_device_id:v.device_id,
      data_kind:'inline',content_type:'application/json',raw_data:row.payload,raw_data_sha256:hash(row.payload),
      generate_time_utc:v.read_time_utc||v.sample_time_utc||v.captured_at?Date.parse(v.read_time_utc??v.sample_time_utc??v.captured_at!):null,
      receive_time_utc:Date.parse(row.received_at),store_time_utc:now,expire_time_utc:now+this.options.rawRetentionDays*DAY};
  }
  accept(row:RecordRow):'saved'|'duplicate' {
    return this.tx(()=>{
      const rawId=row.raw_id??row.id;
      const old=this.db.prepare('SELECT semantic_hash FROM raw_message WHERE raw_id=?').get(rawId);
      if(old) { if(old.semantic_hash!==row.hash) throw new ConflictError('Message ID reused with different payload'); this.inc('duplicates'); return 'duplicate'; }
      this.capacity(); const raw=this.makeRaw(row); this.saveRaw(raw,row.hash);
      const processor = isXiaomiTemperature(parseJson(row.payload) as Sample)
        ? xiaomiQualityProcessor : { id: PROCESSOR_ID, version: PROCESSOR_VERSION };
      this.db.prepare(`INSERT INTO processing_job VALUES(?,?,?,'pending',0,NULL,?,?)`).run(rawId,processor.id,processor.version,raw.store_time_utc,raw.store_time_utc);
      this.inc('received'); return 'saved';
    });
  }
  acceptRaw(raw:RawRecord,processorId:string,version:string):'saved'|'duplicate' {
    if (!this.processors.has(processorId+'\n'+version) || hash(raw.raw_data)!==raw.raw_data_sha256) throw new Error('Invalid raw processing input');
    return this.tx(()=>{
      const old=this.getRaw(raw.raw_id);
      if(old){
        if(old.raw_data_sha256!==raw.raw_data_sha256 || old.topic!==raw.topic || old.source_id!==raw.source_id
          || old.source_device_id!==raw.source_device_id) throw new ConflictError('Raw ID reused with different payload or routing');
        this.inc('duplicates');return 'duplicate';
      }
      this.capacity();this.saveRaw(raw,raw.raw_data_sha256);
      this.db.prepare(`INSERT INTO processing_job VALUES(?,?,?,'pending',0,NULL,?,?)`).run(raw.raw_id,processorId,version,raw.store_time_utc,raw.store_time_utc);
      this.inc('received');return 'saved';
    });
  }
  importHistorical(raw:RawRecord,row:RecordRow):'saved'|'duplicate' {
    return this.tx(()=>{
      if(hash(raw.raw_data)!==raw.raw_data_sha256)throw new ConflictError('Historical raw hash mismatch');
      const old=this.db.prepare('SELECT semantic_hash,raw_data_sha256 FROM raw_message WHERE raw_id=?').get(raw.raw_id);
      if(old) { if(old.semantic_hash!==row.hash||old.raw_data_sha256!==raw.raw_data_sha256) throw new ConflictError('Historical source ID conflict'); this.inc('duplicates'); return 'duplicate'; }
      this.capacity(); this.saveRaw(raw,row.hash);
      const result={...row,raw_id:raw.raw_id,processor_id:row.processor_id??'legacy-d1',processor_version:row.processor_version??'1',output_key:row.output_key??'telemetry'};
      this.db.prepare(`INSERT INTO processing_job VALUES(?,?,?,'done',1,NULL,?,?)`).run(raw.raw_id,result.processor_id,result.processor_version,raw.store_time_utc,Date.now());
      this.saveResult(result); this.inc('received'); return 'saved';
    });
  }
  importHistoricalBatch(records:{raw:RawRecord;result:RecordRow}[]):{saved:number;duplicates:number}{
    if(records.length>500)throw new Error('Historical import batch exceeds 500');
    return this.tx(()=>{let saved=0,duplicates=0;for(const {raw,result} of records){if(this.importHistorical(raw,result)==='saved')saved++;else duplicates++;}return {saved,duplicates};});
  }
  private saveResult(row:RecordRow) {
    const existing=this.db.prepare('SELECT row_json FROM processed_result WHERE id=?').get(row.id);
    if(existing){
      const old=JSON.parse(String(existing.row_json)) as RecordRow;
      if(old.hash!==row.hash||canonical(parseJson(old.payload))!==canonical(parseJson(row.payload)))throw new ConflictError('Processor changed output without a version change');
      if(row.processor_id===XIAOMI_QUALITY_PROCESSOR_ID
        &&canonical(old.lineage?.metric_quality??null)!==canonical(row.lineage?.metric_quality??null))throw new ConflictError('Metric quality changed without a version change');
    }else this.db.prepare('INSERT INTO processed_result VALUES(?,?,?,?,?,?,?)').run(row.id,row.raw_id!,row.processor_id!,row.processor_version!,row.output_key!,JSON.stringify(row),Date.now());
    for(const target of ['local','supabase'] as const) this.job(row.id,'processed',target,row.raw_id!,Date.now());
  }
  processOne():boolean {
    const registered=[...this.processors.values()];
    const job=this.db.prepare(`SELECT r.*,p.processor_id AS job_processor_id,p.processor_version AS job_processor_version FROM processing_job p JOIN raw_message r ON r.raw_id=p.raw_id WHERE p.status='pending' AND (${registered.map(()=>'(p.processor_id=? AND p.processor_version=?)').join(' OR ')}) ORDER BY p.create_time_utc,p.rowid LIMIT 1`).get(...registered.flatMap(p=>[p.id,p.version]));
    if(!job) return false;
    const processorId=String(job.job_processor_id),version=String(job.job_processor_version);
    let row:RecordRow;
    try {
        const raw=job as unknown as RawRecord;
        row=this.processors.get(processorId+'\n'+version)!.process(raw);
        row.received_at=new Date(raw.receive_time_utc).toISOString();row.raw_id=raw.raw_id;row.processor_id=processorId;row.processor_version=version;row.output_key??='telemetry';
        // v1 retains existing producer IDs; new processors/versions receive independent deterministic output IDs.
        const legacyId=version==='1'&&(processorId===PROCESSOR_ID||processorId==='legacy-ddsu666');
        row.id=legacyId?raw.source_message_id??row.id:stableUuid(`${raw.raw_id}\n${processorId}\n${version}\n${row.output_key}`);
        const v=parseJson(row.payload) as Sample;
        row.lineage={source_kind:raw.source_kind,source_id:raw.source_id,source_message_id:raw.source_message_id,...(v.collection_id?{collection_id:v.collection_id}:{}),...row.lineage};
    } catch {
        // Poison input is visible and replayable; it does not stop later records.
        this.db.prepare(`UPDATE processing_job SET status='failed',attempts=attempts+1,last_error='PROCESSING_FAILED',update_time_utc=? WHERE raw_id=? AND processor_id=? AND processor_version=?`).run(Date.now(),String(job.raw_id),processorId,version);
        this.db.prepare(`UPDATE quarantine_message SET replay_status='failed' WHERE raw_id=? AND replay_status='requested'`).run(String(job.raw_id));
        return true;
    }
    return this.tx(()=>{
      try{this.saveResult(row);}catch(e){
        if(!(e instanceof ConflictError))throw e;
        this.db.prepare(`UPDATE processing_job SET status='failed',attempts=attempts+1,last_error='PROCESSOR_OUTPUT_CONFLICT',update_time_utc=? WHERE raw_id=? AND processor_id=? AND processor_version=?`).run(Date.now(),String(job.raw_id),processorId,version);return true;
      }
      this.db.prepare(`UPDATE processing_job SET status='done',attempts=attempts+1,last_error=NULL,update_time_utc=? WHERE raw_id=? AND processor_id=? AND processor_version=?`).run(Date.now(),String(job.raw_id),processorId,version);
      this.db.prepare(`UPDATE quarantine_message SET replay_status='done' WHERE raw_id=? AND replay_status='requested'`).run(String(job.raw_id));
      return true;
    });
  }
  reject(topic:string,payload:Buffer,reason:string) {
    this.tx(()=>{
      const now=Date.now(),id=stableUuid(topic+'\n'+payload.toString('base64')); let rawId:string|null=null;
      // Preserve invalid UTF-8 JSON/text as received; unsupported binary stays in quarantine as base64.
      if(payload.length<=65536 && !topic.endsWith('/frames')) try {
        const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(payload);rawId=id;
        if(!this.db.prepare('SELECT 1 FROM raw_message WHERE raw_id=?').get(id)) {
          this.capacity();
          this.saveRaw({raw_id:id,topic,source_kind:'mqtt',source_id:topic,source_message_id:null,source_site_id:null,source_gateway_id:null,source_device_id:null,data_kind:'inline',content_type:'text/plain',raw_data:text,raw_data_sha256:hash(text),generate_time_utc:null,receive_time_utc:now,store_time_utc:now,expire_time_utc:now+this.options.rawRetentionDays*DAY},hash(text));
          this.db.prepare(`INSERT INTO processing_job VALUES(?,?,?,'failed',1,?,?,?)`).run(id,PROCESSOR_ID,PROCESSOR_VERSION,reason,now,now);
        }
      } catch(e) { if(!(e instanceof TypeError)) throw e; }
      this.db.prepare('INSERT OR IGNORE INTO quarantine_message(id,raw_id,topic,payload_base64,reason,receive_time_utc) VALUES(?,?,?,?,?,?)').run(id,rawId,topic,payload.subarray(0,1048576).toString('base64'),reason,now);
      this.inc('rejected');
      const n=Number(this.db.prepare('DELETE FROM quarantine_message WHERE rowid IN (SELECT rowid FROM quarantine_message ORDER BY rowid DESC LIMIT -1 OFFSET ?)').run(this.options.maxRejected).changes);this.inc('rejected_pruned',n);
    });
  }
  acceptFrame(frame:FrameRecord):'saved'|'duplicate' {
    return this.tx(()=>{
      const old=this.db.prepare('SELECT raw_data_sha256 FROM protocol_frame WHERE frame_id=?').get(frame.frame_id);
      if(old) {if(old.raw_data_sha256!==frame.raw_data_sha256) throw new ConflictError('Frame ID conflict');this.inc('duplicates');return 'duplicate';}
      if(Number(this.db.prepare('SELECT count(*) n FROM protocol_frame').get()!.n)>=this.options.maxProtocolFrames){
        // Diagnostic limits never stop business telemetry on the shared MQTT connection.
        const oldest=this.db.prepare('SELECT frame_id FROM protocol_frame ORDER BY store_time_utc,rowid LIMIT 1').get()!;
        this.db.prepare('DELETE FROM delivery_job WHERE artifact_id=? AND artifact_kind=\'frame\'').run(oldest.frame_id);
        this.db.prepare('DELETE FROM protocol_frame WHERE frame_id=?').run(oldest.frame_id);this.inc('frames_dropped_capacity');
      }
      this.db.prepare('INSERT INTO protocol_frame VALUES(?,?,?,?,?,?,?,?)').run(frame.frame_id,frame.collection_id,JSON.stringify(frame),frame.raw_data_sha256,frame.frame_time_utc,frame.receive_time_utc,frame.store_time_utc,frame.expire_time_utc);
      if(this.options.frameMirror) this.job(frame.frame_id,'frame','sls',null,frame.store_time_utc);
      this.inc('frame_received');return 'saved';
    });
  }
  next(target:Target,now=Date.now()):RecordRow|undefined {
    // Processing never depends on cloud reachability. Also keeps the old Queue API usable by imports/tests.
    this.processOne();
    const r=this.db.prepare(`SELECT r.row_json FROM delivery_job d JOIN processed_result r ON r.id=d.artifact_id WHERE d.target_id=? AND d.status='pending' AND d.next_attempt_time_utc<=? ORDER BY d.create_time_utc,d.rowid LIMIT 1`).get(target,now);
    return r?JSON.parse(String(r.row_json)):undefined;
  }
  nextBatch(target:Target,limit=100,now=Date.now()):RecordRow[] {
    for(let i=0;i<limit;i++)if(!this.processOne())break;
    return this.db.prepare(`SELECT r.row_json FROM delivery_job d JOIN processed_result r ON r.id=d.artifact_id WHERE d.target_id=? AND d.status='pending' AND d.next_attempt_time_utc<=? ORDER BY d.create_time_utc,d.rowid LIMIT ?`).all(target,now,limit).map(r=>JSON.parse(String(r.row_json)));
  }
  nextRaw(now=Date.now()):RawRecord|undefined {
    return this.db.prepare(`SELECT ${rawColumns.map(c=>'r.'+c).join(',')} FROM delivery_job d JOIN raw_message r ON r.raw_id=d.artifact_id WHERE d.target_id='d1' AND d.status='pending' AND d.next_attempt_time_utc<=? ORDER BY d.create_time_utc,d.rowid LIMIT 1`).get(now) as unknown as RawRecord|undefined;
  }
  nextRawBatch(limit=8,now=Date.now()):RawRecord[] {
    return this.db.prepare(`SELECT ${rawColumns.map(c=>'r.'+c).join(',')} FROM delivery_job d JOIN raw_message r ON r.raw_id=d.artifact_id WHERE d.target_id='d1' AND d.status='pending' AND d.next_attempt_time_utc<=? ORDER BY d.create_time_utc,d.rowid LIMIT ?`).all(now,limit) as unknown as RawRecord[];
  }
  nextFrame(now=Date.now()):FrameRecord|undefined {
    const r=this.db.prepare(`SELECT f.frame_json FROM delivery_job d JOIN protocol_frame f ON f.frame_id=d.artifact_id WHERE d.target_id='sls' AND d.status='pending' AND d.next_attempt_time_utc<=? ORDER BY d.create_time_utc,d.rowid LIMIT 1`).get(now);
    return r?JSON.parse(String(r.frame_json)):undefined;
  }
  done(target:DeliveryTarget,id:string,outcome:DeliveryOutcome='confirmed') {
    if(outcome==='expired'&&target!=='supabase')throw new Error('Retention expiry is only supported for Supabase');
    if((target==='local'||target==='supabase')&&!this.db.prepare('SELECT 1 FROM delivery_job WHERE artifact_id=? AND target_id=?').get(id,target)){
      while(this.db.prepare(`SELECT 1 FROM processing_job WHERE raw_id=? AND status='pending'`).get(id)){if(!this.processOne())break;}
    }
    this.tx(()=>{
      const previous=this.db.prepare('SELECT status FROM delivery_job WHERE artifact_id=? AND target_id=?').get(id,target);
      if(!previous||previous.status==='done')return;
      this.db.prepare(`UPDATE delivery_job SET status='done',outcome=?,last_error=NULL,update_time_utc=? WHERE artifact_id=? AND target_id=?`).run(outcome,Date.now(),id,target);
      if(outcome==='expired')this.inc('supabase_retention_skipped');
      if(target==='local'||target==='supabase') {
        const r=this.db.prepare(`SELECT count(*) n FROM delivery_job WHERE artifact_id=? AND target_id IN ('local','supabase') AND status!='done'`).get(id);
        if(Number(r!.n)===0) this.inc('completed');
      }
    });
  }
  doneBatch(target:DeliveryTarget,ids:string[],outcome:DeliveryOutcome='confirmed'){this.tx(()=>{for(const id of ids)this.done(target,id,outcome);});}
  failed(target:DeliveryTarget,id:string,code:string,permanent=false,now=Date.now()) {
    const r=this.db.prepare('SELECT attempts FROM delivery_job WHERE artifact_id=? AND target_id=?').get(id,target);
    const delay=Math.min(60000,1000*2**Math.min(Number(r?.attempts??0),6));
    this.db.prepare(`UPDATE delivery_job SET status=?,outcome=NULL,attempts=attempts+1,last_error=?,next_attempt_time_utc=?,update_time_utc=? WHERE artifact_id=? AND target_id=?`).run(permanent?'failed':'pending',code,now+delay,now,id,target);
  }
  retry(target:DeliveryTarget,id:string) {
    const changed=this.db.prepare(`UPDATE delivery_job SET status='pending',outcome=NULL,last_error=NULL,next_attempt_time_utc=0,update_time_utc=? WHERE artifact_id=? AND target_id=?`).run(Date.now(),id,target);
    if(!changed.changes)throw new Error('Delivery artifact does not exist or is outside retention');
  }
  registerProcessor(processor:Processor){
    if(!/^[a-z0-9_-]+$/i.test(processor.id)||!/^\d+(?:\.\d+)*$/.test(processor.version))throw new Error('Invalid processor identity');
    this.processors.set(processor.id+'\n'+processor.version,processor);
  }
  replay(rawId:string,processorId=PROCESSOR_ID,version=PROCESSOR_VERSION) {
    if(!this.processors.has(processorId+'\n'+version))throw new Error('Processor version is not registered');
    if(!this.getRaw(rawId))throw new Error('Raw record not found or outside retention');
    const now=Date.now();
    this.tx(()=>{
      if(this.db.prepare('SELECT 1 FROM processing_job WHERE raw_id=? AND processor_id=? AND processor_version=?').get(rawId,processorId,version)){
        this.db.prepare(`UPDATE processing_job SET status='pending',last_error=NULL,update_time_utc=? WHERE raw_id=? AND processor_id=? AND processor_version=?`).run(now,rawId,processorId,version);
      }else this.db.prepare(`INSERT INTO processing_job VALUES(?,?,?,'pending',0,NULL,?,?)`).run(rawId,processorId,version,now,now);
      this.db.prepare(`UPDATE quarantine_message SET replay_status='requested',replay_time_utc=? WHERE raw_id=?`).run(now,rawId);
    });
  }
  getRaw(rawId:string):RawRecord|undefined {return this.db.prepare(`SELECT ${rawColumns.join(',')} FROM raw_message WHERE raw_id=?`).get(rawId) as unknown as RawRecord|undefined;}
  cleanup(now=Date.now(),batch=1000) {
    return this.tx(()=>{
      // Pending/failed delivery pins data until retried or explicitly resolved. Failed processing remains replayable for the normal retention window.
      const ids=this.db.prepare(`SELECT r.raw_id FROM raw_message r WHERE r.expire_time_utc<=? AND NOT EXISTS(SELECT 1 FROM processing_job p WHERE p.raw_id=r.raw_id AND p.status='pending') AND NOT EXISTS(SELECT 1 FROM delivery_job d WHERE d.raw_id=r.raw_id AND d.status!='done') ORDER BY r.expire_time_utc LIMIT ?`).all(now,batch).map(r=>String(r.raw_id));
      for(const id of ids) {this.db.prepare('DELETE FROM delivery_job WHERE raw_id=?').run(id);this.db.prepare('DELETE FROM quarantine_message WHERE raw_id=?').run(id);this.db.prepare('DELETE FROM raw_message WHERE raw_id=?').run(id);}
      const frames=this.db.prepare(`SELECT f.frame_id FROM protocol_frame f WHERE f.expire_time_utc<=? AND NOT EXISTS(SELECT 1 FROM delivery_job d WHERE d.artifact_id=f.frame_id AND d.status!='done') ORDER BY f.expire_time_utc LIMIT ?`).all(now,batch).map(r=>String(r.frame_id));
      for(const id of frames) {this.db.prepare('DELETE FROM delivery_job WHERE artifact_id=?').run(id);this.db.prepare('DELETE FROM protocol_frame WHERE frame_id=?').run(id);}
      this.inc('raw_pruned',ids.length);this.inc('frames_pruned',frames.length);
      return {raw_pruned:ids.length,frames_pruned:frames.length};
    });
  }
  stats() {
    const scalar=(sql:string)=>Number(this.db.prepare(sql).get()!.n);
    const counts=Object.fromEntries(this.db.prepare('SELECT * FROM counts').all().map(r=>[String(r.name),Number(r.value)])) as Record<string,number>;
    const pending=(target:DeliveryTarget)=>Number(this.db.prepare(`SELECT count(*) n FROM delivery_job WHERE target_id=? AND status!='done'`).get(target)!.n);
    const unprocessed=scalar(`SELECT count(*) n FROM processing_job WHERE status='pending'`);
    const oldest=this.db.prepare(`SELECT min(r.receive_time_utc) n FROM pending_raw p JOIN raw_message r ON r.raw_id=p.raw_id`).get()!.n;
    return {...counts,legacy_migrated:counts.legacy_migrated,frames_dropped_capacity:counts.frames_dropped_capacity,supabase_retention_skipped:counts.supabase_retention_skipped,outstanding_raw:this.pendingCount(),queued:scalar(`SELECT count(*) n FROM (SELECT raw_id FROM processing_job WHERE status='pending' UNION SELECT raw_id FROM delivery_job WHERE target_id IN ('local','supabase') AND status!='done')`),
      local_pending:pending('local')+unprocessed,supabase_pending:pending('supabase')+unprocessed,d1_pending:pending('d1'),sls_pending:pending('sls'),raw_records:scalar('SELECT count(*) n FROM raw_message'),frame_records:scalar('SELECT count(*) n FROM protocol_frame'),processing_pending:unprocessed,processing_failed:scalar(`SELECT count(*) n FROM processing_job WHERE status='failed'`),delivery_failed:scalar(`SELECT count(*) n FROM delivery_job WHERE status='failed'`),oldest_pending_time_utc:oldest===null?null:Number(oldest)};
  }
  private migrateLegacy() {
    if(this.db.prepare(`SELECT 1 FROM metadata WHERE name='layered_v2'`).get()) return;
    this.tx(()=>{
      if(this.db.prepare(`SELECT 1 FROM metadata WHERE name='layered_v2'`).get())return;
      const exists=this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending'`).get();
      if(exists) for(const r of this.db.prepare('SELECT * FROM pending ORDER BY seq').all()) {
        const row={id:String(r.id),topic:String(r.topic),payload:String(r.payload),hash:String(r.hash),received_at:String(r.received_at)};
        // Preserve every outstanding legacy row and its independent acknowledgments. The original pending table is retained for rollback.
        const raw=this.makeRaw(row);raw.source_kind='legacy_inbox';this.saveRaw(raw,row.hash);
        this.db.prepare(`INSERT INTO processing_job VALUES(?,?,?,'done',1,NULL,?,?)`).run(raw.raw_id,PROCESSOR_ID,PROCESSOR_VERSION,raw.store_time_utc,raw.store_time_utc);
        this.saveResult({...row,raw_id:raw.raw_id,processor_id:PROCESSOR_ID,processor_version:PROCESSOR_VERSION,output_key:'telemetry',lineage:{source_kind:'legacy_inbox',original_bytes_available:false}});
        if(Number(r.local_done))this.done('local',row.id);if(Number(r.supabase_done))this.done('supabase',row.id);this.inc('legacy_migrated');
      }
      this.db.prepare(`INSERT INTO metadata VALUES('layered_v2',?)`).run(String(Date.now()));
    });
  }
  close(){this.db.close();}
}
