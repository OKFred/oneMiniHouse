import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.DATA_DIR ?? '/app/data';
const label = process.argv[2] ?? 'queue';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid evidence label');
const db = new DatabaseSync(join(dir, 'inbox.sqlite'), {readOnly:true});
try {
  const layered=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_job'").get();
  const pending=layered ? db.prepare(`SELECT p.id,json_extract(p.row_json,'$.hash') hash,
    coalesce(max(CASE WHEN d.target_id='local' THEN d.status='done' END),0) local_done,
    coalesce(max(CASE WHEN d.target_id='supabase' THEN d.status='done' END),0) supabase_done
    FROM processed_result p JOIN delivery_job d ON d.artifact_id=p.id
    WHERE d.target_id IN ('local','supabase') GROUP BY p.id
    HAVING local_done=0 OR supabase_done=0 ORDER BY p.id`).all()
    : db.prepare('SELECT id,hash,local_done,supabase_done FROM pending ORDER BY seq').all();
  const delivery=layered ? db.prepare('SELECT target_id,status,count(*) records FROM delivery_job GROUP BY target_id,status').all():[];
  const result={check_time_utc:new Date().toISOString(),label,health:JSON.parse(readFileSync(join(dir,'health.json'),'utf8')),pending,delivery};
  const evidence=join(dir,'evidence'); mkdirSync(evidence,{recursive:true});
  writeFileSync(join(evidence,label+'.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally { db.close(); }
