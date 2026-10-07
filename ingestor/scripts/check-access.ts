import pg from 'pg';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { databaseOptions, PostgresSink, errorCode } from '../src/database.ts';
import { parseSample } from '../src/message.ts';

const config=loadConfig();
const reports:object[]=[];
for (const target of config.targets.filter(t => !process.argv[2] || t.id===process.argv[2])) {
  const db=new pg.Client(databaseOptions(target));
  try {
    await db.connect();
    const {rows:[rights]}=await db.query(`SELECT current_user,
      has_table_privilege(current_user,'iot.telemetry','SELECT') AS can_select,
      has_table_privilege(current_user,'iot.telemetry','INSERT') AS can_insert,
      has_table_privilege(current_user,'iot.telemetry','UPDATE') AS can_update,
      has_table_privilege(current_user,'iot.telemetry','DELETE') AS can_delete,
      has_table_privilege(current_user,'iot.telemetry','TRUNCATE') AS can_truncate,
      has_schema_privilege(current_user,'iot','CREATE') AS can_create,
      (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user) AS bypass_rls,
      (SELECT relrowsecurity FROM pg_class WHERE oid='iot.telemetry'::regclass) AS rls,
      (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl`);
    assert.equal(rights.can_select,true); assert.equal(rights.can_insert,true); assert.equal(rights.rls,true);
    for (const key of ['can_update','can_delete','can_truncate','can_create','bypass_rls']) assert.equal(rights[key],false,key);
    // pg_stat_ssl is the pooler's backend hop; inspect our own socket for client TLS.
    const socket=(db as unknown as {connection:{stream:{encrypted?:boolean;authorized?:boolean}}}).connection.stream;
    rights.client_tls_verified=!!socket.encrypted && socket.authorized===true;
    if (target.tls) assert.equal(rights.client_tls_verified,true);
    // Exercise real INSERT, duplicate delivery and hash validation in a rolled-back transaction.
    const prefix=config.mqtt.topicPrefixes[0], [, , site, gateway]=prefix.split('/');
    const payload={schema_version:1,message_id:randomUUID(),site_id:site,gateway_id:gateway,device_id:'acceptance-rollback',captured_at:new Date().toISOString(),quality:'ok',metrics:{power_w:1}};
    const row=parseSample(`${prefix}/devices/acceptance-rollback/telemetry`,Buffer.from(JSON.stringify(payload)),[prefix]);
    const sink=Object.create(PostgresSink.prototype) as PostgresSink;
    Object.assign(sink,{pool:db});
    await db.query('BEGIN');
    await sink.write(row); await sink.write(row);
    const count=await db.query('SELECT count(*)::int n FROM iot.telemetry WHERE message_id=$1',[row.id]); assert.equal(count.rows[0].n,1);
    await assert.rejects(sink.write({...row,hash:'0'.repeat(64)}),/conflict/i);
    await db.query('ROLLBACK');
    await db.query('BEGIN');
    let denied=false;
    try { await sink.write({...row,payload:JSON.stringify({...payload,site_id:'forbidden-site'})}); }
    catch (e) { denied=(e as {code?:string}).code==='42501'; }
    finally { await db.query('ROLLBACK'); }
    assert.equal(denied,true,'RLS must deny a different site');
    const remaining=await db.query('SELECT count(*)::int n FROM iot.telemetry WHERE message_id=$1',[row.id]); assert.equal(remaining.rows[0].n,0);
    reports.push({target:target.id,ok:true,rights,idempotency:true,conflict_detection:true,cross_site_denied:true,fixtures_rolled_back:true});
  } catch (e) {reports.push({target:target.id,ok:false,code:errorCode(e),...((e as Error).name==='AssertionError'?{assertion:(e as Error).message}:{})});process.exitCode=1;}
  finally {await db.end();}
}
const evidenceDir=join(process.env.DATA_DIR ?? '.', 'evidence');
mkdirSync(evidenceDir,{recursive:true});
writeFileSync(join(evidenceDir,'database-access.json'),JSON.stringify({utc:new Date().toISOString(),reports},null,2));
console.log(JSON.stringify(reports));
