import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import { databaseOptions, errorCode } from '../src/database.ts';
// Use an owner configuration for migrations; runtime credentials deliberately lack DDL rights.
const config = loadConfig();
const target = config.targets.find(t => t.id === process.argv[2]);
if (!target) throw new Error('Usage: pnpm migrate local|supabase (CONFIG_FILE must contain owner credentials)');
const client = new pg.Client(databaseOptions(target));
try {
  await client.connect();
  const exists=await client.query("SELECT to_regclass('iot.telemetry') IS NOT NULL AS present");
  const files=exists.rows[0].present?[]:['001-telemetry.sql'];
  const timeMigration=exists.rows[0].present && (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='iot' AND table_name='telemetry' AND column_name='read_time_utc'")).rowCount;
  if(!timeMigration)files.push('002-layered-storage.sql','003-derived-views.sql','004-chinese-comments.sql');
  files.push('005-observation-times.sql','006-grafana-compat-permissions.sql');
  if (files.includes('003-derived-views.sql')) {
    const role = process.env.MIGRATION_INGESTOR_ROLE?.trim();
    if (!role) throw new Error('MIGRATION_INGESTOR_ROLE must name the runtime role, not the migration owner');
    await client.query("SELECT set_config('one_min_house.ingestor_role', $1, false)", [role]);
  }
  for(const file of files){
    await client.query(readFileSync(new URL('../sql/'+file,import.meta.url),'utf8'));
    console.log(JSON.stringify({target:target.id,migration:file,applied:true}));
  }
} catch (e) { console.error(JSON.stringify({ target: target.id, code: errorCode(e) })); process.exitCode = 1; }
finally { await client.end(); }
