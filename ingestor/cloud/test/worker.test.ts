import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker, { validateRaw, type RawRecord } from '../src/index.ts';

const TOKEN = 'test-only-token-with-at-least-thirty-two-characters';
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_raw_archive.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_replay_timestamps.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string, values: (string | number | null)[] = []) => ({
    bind: (...parameters: (string | number | null)[]) => prepare(sql, parameters),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } }),
  });
  const env = { ARCHIVE_TOKEN: TOKEN, ALLOWED_SITE_ID: 'example-home', RAW_DB: { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } } } as unknown as Env;
  return { db, env };
}
function raw(id = '3a165df5-1815-5bda-aafc-c21df0bcfe10', now = Date.now()): RawRecord {
  const rawData = '{ "energy_kwh": 388.73 }\n';
  return { raw_id: id, source_kind: 'mqtt', source_id: 'mqtt', topic: 'iot/v1/example-home/gateway/devices/socket/telemetry', data_kind: 'inline', content_type: 'application/json', raw_data: rawData, raw_data_sha256: createHash('sha256').update(rawData).digest('hex'), generate_time_utc: now, receive_time_utc: now, store_time_utc: now, expire_time_utc: now + 180*86400000, source_message_id: id, source_site_id: 'example-home', source_gateway_id: 'gateway', source_device_id: 'socket' };
}
const request = (records: RawRecord[], token = TOKEN) => new Request('https://example.workers.dev/v1/raw/batch', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schema_version: 1, records }) });

test('auth fails before persistence; original UTF8 survives idempotent replay', async () => {
  const {db,env} = setup();
  try {
    const record = raw();
    assert.equal((await worker.fetch(request([record], 'wrong'), env)).status, 401);
    assert.equal((await worker.fetch(request([record]), env)).status, 200);
    assert.equal((await worker.fetch(request([record]), env)).status, 200);
    const stored = db.prepare('SELECT * FROM raw_message').all();
    assert.equal(stored.length, 1); assert.equal(stored[0].raw_data, record.raw_data);
  } finally { db.close(); }
});
test('identity or content conflict rolls back complete D1 batch', async () => {
  const {db,env} = setup();
  try {
    const first = raw(); await worker.fetch(request([first]), env);
    const second = raw('d27d8d91-fab0-518f-a48c-1b817f81564d');
    assert.equal((await worker.fetch(request([second, {...first,source_device_id:'other'}]),env)).status,409);
    assert.equal(db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n,1);
  } finally { db.close(); }
});
test('recovery replay keeps first archive timestamps without extending expiry', async () => {
  const {db,env}=setup();
  try {
    const record=raw(); await worker.fetch(request([record]),env);
    const replay={...record,receive_time_utc:record.receive_time_utc+1000,store_time_utc:record.store_time_utc+1000,expire_time_utc:record.expire_time_utc+1000};
    assert.equal((await worker.fetch(request([replay]),env)).status,200);
    assert.equal(db.prepare('SELECT expire_time_utc FROM raw_message').get()!.expire_time_utc,record.expire_time_utc);
  } finally {db.close();}
});
test('reject changed hash, foreign site, oversized raw and protocol frames', () => {
  assert.throws(() => validateRaw({...raw(),raw_data:'changed'},'example-home'));
  assert.throws(() => validateRaw({...raw(),source_site_id:'elsewhere'},'example-home'));
  assert.throws(() => validateRaw({...raw(),topic:'iot/v1/example-home/gateway/devices/socket/frames'},'example-home'));
  assert.throws(() => validateRaw({...raw(),raw_data:'x'.repeat(65537)},'example-home'));
});
test('cleanup deletes expired raw only; source timestamps do not cause early deletion', async () => {
  const {db,env} = setup();
  try {
    const expired = raw('d27d8d91-fab0-518f-a48c-1b817f81564d',Date.now()-181*86400000);
    const imported = {...raw(),source_kind:'legacy_d1',generate_time_utc:null};
    assert.equal((await worker.fetch(request([expired,imported]),env)).status,200);
    await worker.scheduled({} as ScheduledController,env);
    assert.deepEqual(db.prepare('SELECT raw_id FROM raw_message').all().map(row=>row.raw_id),[imported.raw_id]);
  } finally { db.close(); }
});
