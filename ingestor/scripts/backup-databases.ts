import pg from 'pg';
import { createHash } from 'node:crypto';
import { mkdirSync,writeFileSync,createReadStream,createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { databaseOptions,errorCode } from '../src/database.ts';

const config=loadConfig();
const start=new Date().toISOString();
const dir=join(process.env.DATA_DIR??'data','backups',start.replaceAll(':','-'));
mkdirSync(dir,{recursive:true,mode:0o700});
const reports:object[]=[];
for(const target of config.targets){
  // Cloud snapshots can cross a slow WAN; keep each page small and bound each query.
  const db=new pg.Client({...databaseOptions(target),statement_timeout:120000,query_timeout:125000});
  const file=join(dir,target.id+'.jsonl.gz');
  const zip=createGzip();
  const output=pipeline(zip,createWriteStream(file,{flags:'wx',mode:0o600}));
  // Mark the promise handled immediately; it is also awaited before a backup is accepted.
  void output.catch(()=>{});
  let phase='connect';
  try{
    await db.connect();
    phase='snapshot';
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const columns=await db.query("SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='iot' AND table_name='telemetry' ORDER BY ordinal_position");
    const total=await db.query('SELECT count(*)::int n FROM iot.telemetry');
    let after:string|null=null,rows=0;
    phase='export';
    for(;;){
      const page:pg.QueryResult<{message_id:string;payload:string}>=await db.query('SELECT message_id,row_to_json(t)::text payload FROM iot.telemetry t WHERE ($1::uuid IS NULL OR message_id>$1) ORDER BY message_id LIMIT 100',[after]);
      if(!page.rows.length)break;
      for(const row of page.rows){if(!zip.write(row.payload+'\n'))await once(zip,'drain');rows++;after=row.message_id;}
    }
    phase='finish';
    await db.query('COMMIT');
    zip.end();await output;
    if(rows!==total.rows[0].n)throw new Error('Snapshot count mismatch');
    const digest=createHash('sha256');
    for await(const chunk of createReadStream(file))digest.update(chunk);
    writeFileSync(join(dir,target.id+'-columns.json'),JSON.stringify(columns.rows,null,2),{mode:0o600});
    reports.push({target:target.id,ok:true,rows,file,sha256:digest.digest('hex')});
  }catch(error){zip.destroy();await output.catch(()=>{});reports.push({target:target.id,ok:false,phase,code:errorCode(error)});process.exitCode=1;}
  finally{await db.end();}
}
const result={backup_time_utc:start,finish_time_utc:new Date().toISOString(),reports};
writeFileSync(join(dir,'manifest.json'),JSON.stringify(result,null,2),{mode:0o600});
console.log(JSON.stringify(result));
