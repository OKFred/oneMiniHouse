import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker, { classifyD1Failure, validateRaw, type RawRecord, type ArchiveEnv } from '../src/index.ts';

const TOKEN = 'test-only-token-with-at-least-thirty-two-characters';
function setup() {
  const db = new DatabaseSync(':memory:');
  const queries: { sql: string; values: (string | number | null)[]; method: 'run' | 'all' }[] = [];
  db.exec(readFileSync(new URL('../migrations/0001_raw_archive.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_replay_timestamps.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string, values: (string | number | null)[] = []) => ({
    bind: (...parameters: (string | number | null)[]) => prepare(sql, parameters),
    run: async () => { queries.push({ sql, values, method: 'run' }); return { success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
    all: async () => { queries.push({ sql, values, method: 'all' }); return { success: true, results: db.prepare(sql).all(...values) }; },
  });
  const env = { ARCHIVE_TOKEN: TOKEN, ALLOWED_SITE_ID: 'example-home', RAW_DB: { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } } } as unknown as ArchiveEnv;
  return { db, env, queries };
}
function raw(id = '3a165df5-1815-5bda-aafc-c21df0bcfe10', now = Date.now()): RawRecord {
  const rawData = '{ "energy_kwh": 388.73 }\n';
  return { raw_id: id, source_kind: 'mqtt', source_id: 'mqtt', topic: 'iot/v1/example-home/gateway/devices/socket/telemetry', data_kind: 'inline', content_type: 'application/json', raw_data: rawData, raw_data_sha256: createHash('sha256').update(rawData).digest('hex'), generate_time_utc: now, receive_time_utc: now, store_time_utc: now, expire_time_utc: now + 180*86400000, source_message_id: id, source_site_id: 'example-home', source_gateway_id: 'gateway', source_device_id: 'socket' };
}
const request = (records: RawRecord[], token = TOKEN) => new Request('https://example.workers.dev/v1/raw/batch', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schema_version: 1, records }) });
const idFor = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const DAY_MS = 86400000;

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

test('D1 retention caps only the mirror expiry while the 180-day request remains valid', async () => {
  const { db, env } = setup();
  try {
    env.D1_RETENTION_DAYS = '7';
    const original = raw(idFor(1)), shorter = { ...raw(idFor(2)), expire_time_utc: original.store_time_utc + DAY_MS };
    const response = await worker.fetch(request([original, shorter]), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: [original, shorter].map(r => ({ raw_id: r.raw_id, raw_data_sha256: r.raw_data_sha256 })) });
    const first = db.prepare('SELECT * FROM raw_message WHERE raw_id=?').get(original.raw_id)!;
    assert.equal(first.expire_time_utc, original.store_time_utc + 7 * DAY_MS);
    for (const [field, value] of Object.entries(original)) if (field !== 'expire_time_utc') assert.equal(first[field], value, field);
    assert.equal(db.prepare('SELECT expire_time_utc FROM raw_message WHERE raw_id=?').get(shorter.raw_id)!.expire_time_utc, shorter.expire_time_utc);
    assert.equal(original.expire_time_utc, original.store_time_utc + 180 * DAY_MS); // Input/local retention was not mutated.
    const replay = { ...original, receive_time_utc: original.receive_time_utc + 1000, store_time_utc: original.store_time_utc + 1000, expire_time_utc: original.expire_time_utc + 1000 };
    assert.equal((await worker.fetch(request([replay]), env)).status, 200);
    assert.equal(db.prepare('SELECT expire_time_utc FROM raw_message WHERE raw_id=?').get(original.raw_id)!.expire_time_utc, first.expire_time_utc);
  } finally { db.close(); }
});

test('retention defaults to 180 days and accepts integer boundary settings', async () => {
  const { db, env } = setup();
  try {
    for (const [i, days] of [undefined, 1, '180'].entries()) {
      env.D1_RETENTION_DAYS = days;
      const record = raw(idFor(i + 1));
      assert.equal((await worker.fetch(request([record]), env)).status, 200);
      assert.equal(db.prepare('SELECT expire_time_utc FROM raw_message WHERE raw_id=?').get(record.raw_id)!.expire_time_utc, record.store_time_utc + Number(days ?? 180) * DAY_MS);
    }
  } finally { db.close(); }
});

test('invalid retention fails before any archive query, insertion or cleanup', async () => {
  const { db, env, queries } = setup();
  try {
    for (const setting of ['', '0', '181', '7.5', '7days', ' 7', '07', 0, 181, 7.5, NaN, Infinity, null, false]) {
      Object.defineProperty(env, 'D1_RETENTION_DAYS', { value: setting, writable: true, configurable: true });
      const response = await worker.fetch(request([raw()]), env);
      assert.equal(response.status, 503, String(setting));
      assert.deepEqual(await response.json(), { error: 'not_configured' });
      await assert.rejects(worker.scheduled({} as ScheduledController, env), /D1_RETENTION_INVALID/);
      assert.equal(queries.length, 0);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0);
  } finally { db.close(); }
});

test('invalid cleanup row budgets fail closed before writing or deleting', async () => {
  const { db, env, queries } = setup();
  try {
    for (const setting of ['', '0', '200001', '1.5', '7days', ' 7', '07', 0, 200001, 1.5, NaN, Infinity, null, false]) {
      Object.defineProperty(env, 'D1_CLEANUP_MAX_ROWS', { value: setting, writable: true, configurable: true });
      const response = await worker.fetch(request([raw()]), env);
      assert.equal(response.status, 503, String(setting));
      assert.deepEqual(await response.json(), { error: 'not_configured' });
      await assert.rejects(worker.scheduled({} as ScheduledController, env), /D1_CLEANUP_CONFIG_INVALID/);
      assert.equal(queries.length, 0);
    }
  } finally { db.close(); }
});

test('unsuccessful or missing D1 batch results never acknowledge records', async t => {
  const { db, env } = setup();
  t.mock.method(console, 'error', () => {});
  try {
    for (const results of [[], [{ success: false, results: [], meta: {} }]]) {
      Object.defineProperty(env.RAW_DB, 'batch', { value: async () => results, configurable: true });
      const response = await worker.fetch(request([raw()]), env);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'archive_unavailable' });
      assert.equal(db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0);
    }
  } finally { db.close(); }
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

test('documented daily limits reset at the next UTC midnight; storage limits stay distinct', () => {
  const read="Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow.";
  const write="Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow.";
  assert.deepEqual(classifyD1Failure(new Error('D1_ERROR: '+read),Date.parse('2026-01-01T23:59:59.500Z')), {code:'D1_DAILY_READ_LIMIT',status:429,retry_after_seconds:6});
  assert.deepEqual(classifyD1Failure(new Error(write),Date.parse('2026-01-01T00:00:00Z')), {code:'D1_DAILY_WRITE_LIMIT',status:429,retry_after_seconds:86405});
  assert.deepEqual(classifyD1Failure(new Error('D1_ERROR: Exceeded maximum DB size.')), {code:'D1_DATABASE_SIZE_LIMIT',status:507,retry_after_seconds:3600});
  assert.deepEqual(classifyD1Failure(new Error("Your account has exceeded D1's maximum account storage limit, please contact Cloudflare to raise your limit")), {code:'D1_ACCOUNT_STORAGE_LIMIT',status:507,retry_after_seconds:3600});
  assert.equal(classifyD1Failure(new Error('D1_ERROR',{cause:new Error(read)}))?.code,'D1_DAILY_READ_LIMIT');
  assert.equal(classifyD1Failure(new Error('syntax error in SELECT '+read)),undefined);
  assert.equal(classifyD1Failure(new Error('D1 DB is overloaded. Too many requests queued.')),undefined);
  assert.equal(classifyD1Failure(new Error('daily quota exceeded')),undefined);
});

test('quota responses and logs expose fixed codes only; unknown D1 errors retain 503', async t => {
  const {db,env}=setup();const logs:unknown[][]=[];
  t.mock.method(console,'error',(...args:unknown[])=>logs.push(args));
  try {
    for(const [message,code,status] of [
      ["Your account has exceeded D1's free tier daily row read limit.",'D1_DAILY_READ_LIMIT',429],
      ["Your account has exceeded D1's free tier daily row write limit.",'D1_DAILY_WRITE_LIMIT',429],
      ['Exceeded maximum DB size.','D1_DATABASE_SIZE_LIMIT',507],
      ["Your account has exceeded D1's maximum account storage limit,",'D1_ACCOUNT_STORAGE_LIMIT',507],
    ] as const){
      env.RAW_DB.batch=async()=>{throw new Error('D1_ERROR: '+message+' SQL source-data '+TOKEN);};
      const response=await worker.fetch(request([raw()]),env),body=await response.json() as Record<string,unknown>;
      assert.equal(response.status,status);assert.deepEqual(Object.keys(body).sort(),['code','retry_after_seconds']);
      assert.equal(body.code,code);assert.ok(Number(body.retry_after_seconds)>=1&&Number(body.retry_after_seconds)<=86405);
      assert.equal(response.headers.get('retry-after'),String(body.retry_after_seconds));
      assert.equal(response.headers.get('cache-control'),'no-store');
    }
    env.RAW_DB.batch=async()=>{throw new Error('D1_ERROR: some other SQL failure '+TOKEN);};
    const unknown=await worker.fetch(request([raw()]),env);
    assert.equal(unknown.status,503);assert.deepEqual(await unknown.json(),{error:'archive_unavailable'});
    assert.ok(!JSON.stringify(logs).includes(TOKEN));assert.ok(!JSON.stringify(logs).includes('source-data'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n,0);
  }finally{db.close();}
});

test('rollover ACKs a mixed batch across archives without copying historical rows or extending expiry', async () => {
  const current = setup(), first = setup(), second = setup();
  try {
    const now = Date.now(), a = raw(idFor(1), now), b = raw(idFor(2), now), c = raw(idFor(3), now);
    assert.equal((await worker.fetch(request([a]), first.env)).status, 200);
    assert.equal((await worker.fetch(request([b]), second.env)).status, 200);
    current.env.RAW_DB_ARCHIVE_1 = first.env.RAW_DB;
    current.env.RAW_DB_ARCHIVE_9 = second.env.RAW_DB; // Gaps in optional bindings are supported.
    const replay = { ...a, receive_time_utc: now + 1000, store_time_utc: now + 1000, expire_time_utc: a.expire_time_utc + 1000 };
    const response = await worker.fetch(request([replay, b, c]), current.env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: [a, b, c].map(r => ({ raw_id: r.raw_id, raw_data_sha256: r.raw_data_sha256 })) });
    assert.deepEqual(current.db.prepare('SELECT raw_id FROM raw_message').all().map(r => r.raw_id), [c.raw_id]);
    assert.equal(first.db.prepare('SELECT expire_time_utc FROM raw_message').get()!.expire_time_utc, a.expire_time_utc);
    assert.equal(first.db.prepare('SELECT receive_time_utc FROM raw_message').get()!.receive_time_utc, a.receive_time_utc);
    assert.equal((await worker.fetch(request([replay, b, c]), current.env)).status, 200);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 1);
  } finally { current.db.close(); first.db.close(); second.db.close(); }
});

test('every immutable field in migration 0002 is checked before a mixed batch writes anything', async () => {
  const current = setup(), archive = setup();
  const different: Pick<RawRecord, 'source_kind' | 'source_id' | 'topic' | 'data_kind' | 'content_type' | 'raw_data' | 'raw_data_sha256' | 'generate_time_utc' | 'source_message_id' | 'source_site_id' | 'source_gateway_id' | 'source_device_id'> = {
    source_kind: 'legacy_d1', source_id: 'other-source', topic: 'iot/v1/example-home/other/devices/socket/telemetry',
    data_kind: 'object_ref', content_type: 'application/jsonl', raw_data: 'different original bytes', raw_data_sha256: 'f'.repeat(64),
    generate_time_utc: null, source_message_id: null, source_site_id: null, source_gateway_id: null, source_device_id: null,
  };
  try {
    const original = raw(idFor(1));
    assert.equal((await worker.fetch(request([original]), archive.env)).status, 200);
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    for (const field of Object.keys(different) as (keyof typeof different)[]) {
      // Alter the stored copy, so the incoming source is valid even for the
      // independent raw-content/hash comparison cases.
      archive.db.prepare(`UPDATE raw_message SET ${field}=? WHERE raw_id=?`).run(different[field], original.raw_id);
      const response = await worker.fetch(request([raw(idFor(2)), original]), current.env);
      assert.equal(response.status, 409, field);
      assert.deepEqual(await response.json(), { error: 'raw_id_conflict' }, field);
      assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0, field);
      archive.db.prepare(`UPDATE raw_message SET ${field}=? WHERE raw_id=?`).run(original[field], original.raw_id);
    }
  } finally { current.db.close(); archive.db.close(); }
});

test('all historical copies and pre-existing current copies must agree before ACK', async () => {
  const current = setup(), archive = setup(), later = setup();
  try {
    const original = raw(idFor(1));
    await worker.fetch(request([original]), archive.env);
    await worker.fetch(request([original]), current.env);
    await worker.fetch(request([{ ...original, source_device_id: 'different' }]), later.env);
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    const replay = { ...original, receive_time_utc: original.receive_time_utc + 1000, store_time_utc: original.store_time_utc + 1000, expire_time_utc: original.expire_time_utc + 1000 };
    assert.equal((await worker.fetch(request([replay]), current.env)).status, 200);
    assert.equal(current.db.prepare('SELECT store_time_utc FROM raw_message').get()!.store_time_utc, original.store_time_utc);
    current.db.prepare('UPDATE raw_message SET source_gateway_id=? WHERE raw_id=?').run('other-current', original.raw_id);
    assert.equal((await worker.fetch(request([raw(idFor(2)), original]), current.env)).status, 409);
    current.db.prepare('UPDATE raw_message SET source_gateway_id=? WHERE raw_id=?').run(original.source_gateway_id, original.raw_id);
    current.env.RAW_DB_ARCHIVE_2 = later.env.RAW_DB;
    assert.equal((await worker.fetch(request([raw(idFor(2)), original]), current.env)).status, 409);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 1);
  } finally { current.db.close(); archive.db.close(); later.db.close(); }
});

test('a failed historical query or missing historical schema never writes or ACKs even after an earlier match', async t => {
  const current = setup(), archive = setup(), broken = setup();
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  try {
    const original = raw(idFor(1));
    await worker.fetch(request([original]), archive.env);
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    current.env.RAW_DB_ARCHIVE_2 = broken.env.RAW_DB;
    broken.db.exec('DROP TABLE raw_message');
    const response = await worker.fetch(request([original, raw(idFor(2))]), current.env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'archive_unavailable' });
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0);
    assert.equal(current.queries.length, 0); // No current read or write before every historical lookup succeeded.
    assert.ok(!JSON.stringify(logs).includes(TOKEN));
    assert.ok(!JSON.stringify(logs).includes(original.raw_data));
  } finally { current.db.close(); archive.db.close(); broken.db.close(); }
});

test('32-row boundary stays indexed and within the invocation query budget; 33 is rejected before lookups', async () => {
  const current = setup(), archives = Array.from({ length: 9 }, () => setup());
  try {
    const records = Array.from({ length: 33 }, (_, i) => raw(idFor(i + 1)));
    await worker.fetch(request([records[0]]), archives[0].env);
    archives.forEach((archive, i) => { current.env[`RAW_DB_ARCHIVE_${i + 1}` as `RAW_DB_ARCHIVE_${1|2|3|4|5|6|7|8|9}`] = archive.env.RAW_DB; archive.queries.length = 0; });
    assert.equal((await worker.fetch(request(records), current.env)).status, 400);
    assert.equal(current.queries.length + archives.reduce((n, a) => n + a.queries.length, 0), 0);
    const response = await worker.fetch(request(records.slice(0, 32)), current.env);
    assert.equal(response.status, 200);
    const accepted = (await response.json() as { accepted: unknown[] }).accepted;
    assert.equal(accepted.length, 32);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 31);
    assert.equal(current.queries.length + archives.reduce((n, a) => n + a.queries.length, 0), 41);
    for (const archive of archives) {
      assert.equal(archive.queries.length, 1);
      const query = archive.queries[0];
      assert.equal(query.values.length, 32);
      const plan = archive.db.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.values);
      assert.ok(plan.some(row => String(row.detail).includes('SEARCH raw_message USING INDEX')), JSON.stringify(plan));
      assert.ok(!plan.some(row => String(row.detail).includes('SCAN raw_message')), JSON.stringify(plan));
    }
  } finally { current.db.close(); archives.forEach(a => a.db.close()); }
});

test('all-historical replays do not invoke the current insert batch', async () => {
  const current = setup(), archive = setup();
  try {
    const original = raw(idFor(1));
    await worker.fetch(request([original]), archive.env);
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    current.env.RAW_DB.batch = async () => { throw new Error('INSERT must not run for a historical replay'); };
    assert.equal((await worker.fetch(request([original]), current.env)).status, 200);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0);
  } finally { current.db.close(); archive.db.close(); }
});

test('a current-only conflict rolls back new rows while historical ACKs remain unissued', async () => {
  const current = setup(), archive = setup();
  try {
    const historical = raw(idFor(1)), existing = raw(idFor(2)), novel = raw(idFor(3));
    await worker.fetch(request([historical]), archive.env);
    await worker.fetch(request([{ ...existing, source_device_id: 'different' }]), current.env);
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    const response = await worker.fetch(request([novel, historical, existing]), current.env);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'raw_id_conflict' });
    assert.deepEqual(current.db.prepare('SELECT raw_id FROM raw_message').all().map(r => r.raw_id), [existing.raw_id]);
    assert.equal(archive.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 1);
  } finally { current.db.close(); archive.db.close(); }
});

test('historical quota and unsuccessful results fail closed with no raw contents in responses or logs', async t => {
  const current = setup(), archive = setup(), logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  try {
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    const statement = archive.env.RAW_DB.prepare('SELECT 1');
    statement.bind = () => statement;
    statement.all = async () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. " + TOKEN); };
    archive.env.RAW_DB.prepare = () => statement;
    const quota = await worker.fetch(request([raw()]), current.env);
    assert.equal(quota.status, 429);
    assert.equal((await quota.json() as { code: string }).code, 'D1_DAILY_READ_LIMIT');
    // Simulate a malformed provider/mock response outside the generated success
    // type; production must not turn it into an ACK merely because results=[] .
    Object.defineProperty(statement, 'all', { value: async () => ({ success: false, results: [], meta: {} }), configurable: true });
    const unavailable = await worker.fetch(request([raw()]), current.env);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'archive_unavailable' });
    assert.equal(current.queries.length, 0);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0);
    assert.ok(!JSON.stringify(logs).includes(TOKEN));
  } finally { current.db.close(); archive.db.close(); }
});

test('cleanup preserves the original expiry on current and historical databases', async () => {
  const current = setup(), archive = setup();
  try {
    const expired = raw(idFor(1), Date.now() - 181 * 86400000), retained = raw(idFor(2));
    await worker.fetch(request([expired, retained]), archive.env);
    await worker.fetch(request([raw(idFor(3), Date.now() - 181 * 86400000), raw(idFor(4))]), current.env);
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    await worker.scheduled({} as ScheduledController, current.env);
    assert.deepEqual(archive.db.prepare('SELECT raw_id FROM raw_message').all().map(r => r.raw_id), [retained.raw_id]);
    assert.deepEqual(current.db.prepare('SELECT raw_id FROM raw_message').all().map(r => r.raw_id), [idFor(4)]);
  } finally { current.db.close(); archive.db.close(); }
});

test('seven-day cleanup applies to older 180-day rows in current and sealed historical databases', async t => {
  const current = setup(), archive = setup(), now = Date.parse('2026-02-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  try {
    const records = [
      raw(idFor(1), now - 7 * DAY_MS - 1), // Legacy expiry is in the future, but storage window is over.
      raw(idFor(2), now - 7 * DAY_MS), // Exact boundary is retained until strictly expired.
      raw(idFor(3), now - 6 * DAY_MS),
      { ...raw(idFor(4), now - DAY_MS), expire_time_utc: now - 1 }, // Earlier caller expiry wins.
      { ...raw(idFor(5), now), generate_time_utc: now - 365 * DAY_MS }, // Source age does not shorten storage.
      { ...raw(idFor(6), now), expire_time_utc: now + DAY_MS }, // Inside the wide expiry range; storage guard must retain it.
    ];
    for (const database of [current, archive]) {
      assert.equal((await worker.fetch(request(records), database.env)).status, 200);
      database.queries.length = 0;
    }
    archive.db.exec("CREATE TRIGGER raw_archive_sealed BEFORE INSERT ON raw_message BEGIN SELECT RAISE(ABORT,'RAW_ARCHIVE_SEALED'); END");
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    current.env.D1_RETENTION_DAYS = '7';
    await worker.scheduled({} as ScheduledController, current.env);
    for (const database of [current, archive]) {
      assert.deepEqual(database.db.prepare('SELECT raw_id FROM raw_message ORDER BY raw_id').all().map(r => r.raw_id), [idFor(2), idFor(3), idFor(5), idFor(6)]);
      assert.equal(database.db.prepare('SELECT expire_time_utc FROM raw_message WHERE raw_id=?').get(idFor(2))!.expire_time_utc, records[1].expire_time_utc); // Existing timestamps were not rewritten.
      const query = database.queries[0];
      assert.equal(database.queries.length, 1);
      assert.deepEqual(query.values, database === current ? [now - 7 * DAY_MS, now, 5000] : [now + 173 * DAY_MS, now - 7 * DAY_MS, now, 5000]);
      const plan = database.db.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.values);
      if (database === current) {
        assert.ok(plan.some(row => String(row.detail).includes('SEARCH raw_message USING INTEGER PRIMARY KEY')), JSON.stringify(plan));
        assert.ok(plan.some(row => String(row.detail).includes('SCAN raw_message')), JSON.stringify(plan));
        assert.ok(!query.sql.includes('INDEXED BY'));
      } else {
        assert.ok(plan.some(row => String(row.detail).includes('raw_message_expiry (expire_time_utc<?)')), JSON.stringify(plan));
        assert.ok(!plan.some(row => String(row.detail).includes('SCAN raw_message')), JSON.stringify(plan));
      }
    }
    assert.throws(() => archive.db.prepare('INSERT OR IGNORE INTO raw_message SELECT * FROM raw_message WHERE raw_id=?').run(idFor(2)), /RAW_ARCHIVE_SEALED/);
  } finally { current.db.close(); archive.db.close(); }
});

test('seven-day rollover replays keep the first archive timestamps and still compare immutable fields', async () => {
  const current = setup(), archive = setup();
  try {
    const original = raw(idFor(1));
    await worker.fetch(request([original]), archive.env);
    current.env.D1_RETENTION_DAYS = 7;
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    const replay = { ...original, receive_time_utc: original.receive_time_utc + 1000, store_time_utc: original.store_time_utc + 1000, expire_time_utc: original.expire_time_utc + 1000 };
    assert.equal((await worker.fetch(request([replay, raw(idFor(2))]), current.env)).status, 200);
    assert.equal(archive.db.prepare('SELECT expire_time_utc FROM raw_message').get()!.expire_time_utc, original.expire_time_utc);
    assert.equal(current.db.prepare('SELECT expire_time_utc-store_time_utc AS window FROM raw_message').get()!.window, 7 * DAY_MS);
    assert.equal((await worker.fetch(request([{ ...replay, source_device_id: 'different' }, raw(idFor(3))]), current.env)).status, 409);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 1);
  } finally { current.db.close(); archive.db.close(); }
});

test('older queued requests are really stored and acknowledged before the seven-day cleaner expires them', async () => {
  const { db, env } = setup();
  try {
    env.D1_RETENTION_DAYS = 7;
    const record = raw(idFor(1), Date.now() - 8 * DAY_MS);
    const response = await worker.fetch(request([record]), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: [{ raw_id: record.raw_id, raw_data_sha256: record.raw_data_sha256 }] });
    const stored = db.prepare('SELECT * FROM raw_message').get()!;
    assert.equal(stored.raw_id, record.raw_id);
    assert.equal(stored.raw_data, record.raw_data);
    assert.equal(stored.expire_time_utc, record.store_time_utc + 7 * DAY_MS);
    assert.equal((await worker.fetch(request([record]), env)).status, 200);
    await worker.scheduled({} as ScheduledController, env);
    assert.equal(db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0);
  } finally { db.close(); }
});

test('combined expiry and storage guards do not stop seven-day cleanup early', async t => {
  const { db, env, queries } = setup();
  t.mock.method(console, 'log', () => {});
  try {
    const old = Date.now() - 181 * DAY_MS;
    for (let offset = 0; offset < 6001; offset += 32) {
      const records = Array.from({ length: Math.min(32, 6001 - offset) }, (_, i) => raw(idFor(offset + i + 1), old));
      assert.equal((await worker.fetch(request(records), env)).status, 200);
    }
    env.D1_RETENTION_DAYS = 7;
    queries.length = 0;
    await worker.scheduled({} as ScheduledController, env);
    assert.equal(queries.length, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0);
    assert.ok(queries.every(query => query.sql.includes('LIMIT ?') && query.values.at(-1) === 5000));
  } finally { db.close(); }
});

test('short active cleanup needs no expiry index while a missing archive index fails safely', async t => {
  const current = setup(), missing = setup(), logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  try {
    const old = raw(idFor(1), Date.now() - 8 * DAY_MS);
    await worker.fetch(request([old]), current.env);
    await worker.fetch(request([old]), missing.env);
    missing.queries.length = 0;
    current.db.exec('DROP INDEX raw_message_expiry');
    missing.db.exec('DROP INDEX raw_message_expiry');
    current.env.D1_RETENTION_DAYS = 7;
    current.env.RAW_DB_ARCHIVE_1 = missing.env.RAW_DB;
    await assert.rejects(worker.scheduled({} as ScheduledController, current.env), /RAW_ARCHIVE_CLEANUP_FAILED/);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0);
    assert.equal(missing.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 1);
    assert.equal(missing.queries.length, 1); // The attempted statement fails because the required index is absent.
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(String(logs[0][0])), { event: 'raw_archive_cleanup_failed', binding: 'RAW_DB_ARCHIVE_1', code: 'D1_QUERY_FAILED' });
  } finally { current.db.close(); missing.db.close(); }
});

test('cleanup logs provider read and write metadata without inferring quota from deleted rows', async t => {
  const { db, env } = setup(), logs: unknown[][] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => logs.push(args));
  try {
    env.D1_RETENTION_DAYS = 7;
    const provider = (changes: number, read: number, written: number) => ({ prepare: () => ({ bind: () => ({ run: async () => ({ success: true, meta: { changes, rows_read: read, rows_written: written } }) }) }) }) as unknown as D1Database;
    env.RAW_DB = provider(0, 42, 0);
    env.RAW_DB_ARCHIVE_1 = provider(1, 50, 3);
    await worker.scheduled({} as ScheduledController, env);
    const result = JSON.parse(String(logs[0][0]));
    assert.equal(result.deleted, 1);
    assert.equal(result.rows_read, 92);
    assert.equal(result.rows_written, 3);
    assert.equal(result.queries, 2);
  } finally { db.close(); }
});

test('cleanup has a fair global 40-query cap and preserves the single-database 12-batch cap', async () => {
  const current = setup();
  try {
    const order: number[] = [];
    const busy = (index: number) => ({ prepare: () => ({ bind: () => ({ run: async () => { order.push(index); return { success: true, meta: { changes: 5000 } }; } }) }) }) as unknown as D1Database;
    current.env.RAW_DB = busy(0);
    await worker.scheduled({} as ScheduledController, current.env);
    assert.equal(order.length, 12); // Default row budget is 60,000, matching the original single-database cap.
    order.length = 0;
    current.env.D1_CLEANUP_MAX_ROWS = 200000;
    for (let i = 1; i <= 9; i++) current.env[`RAW_DB_ARCHIVE_${i}` as `RAW_DB_ARCHIVE_${1|2|3|4|5|6|7|8|9}`] = busy(i);
    await worker.scheduled({} as ScheduledController, current.env);
    assert.equal(order.length, 40);
    assert.deepEqual(order.slice(0, 10), Array.from({ length: 10 }, (_, i) => i));
    assert.deepEqual(Array.from({ length: 10 }, (_, i) => order.filter(n => n === i).length), Array(10).fill(4));
  } finally { current.db.close(); }
});

test('shorter retention clears the current database before fairly servicing archives within 40 queries', async () => {
  const current = setup();
  try {
    const order: number[] = [];
    const busy = (index: number, changes = 5000) => ({ prepare: () => ({ bind: () => ({ run: async () => { order.push(index); return { success: true, meta: { changes } }; } }) }) }) as unknown as D1Database;
    current.env.D1_RETENTION_DAYS = 7;
    current.env.RAW_DB = busy(0);
    current.env.RAW_DB_ARCHIVE_1 = busy(1);
    await worker.scheduled({} as ScheduledController, current.env);
    assert.deepEqual(order, Array(12).fill(0)); // A busy current database consumes its budget before any old backlog.
    order.length = 0;
    current.env.RAW_DB = busy(0, 0);
    current.env.D1_CLEANUP_MAX_ROWS = 200000;
    for (let i = 1; i <= 9; i++) current.env[`RAW_DB_ARCHIVE_${i}` as `RAW_DB_ARCHIVE_${1|2|3|4|5|6|7|8|9}`] = busy(i);
    await worker.scheduled({} as ScheduledController, current.env);
    assert.equal(order.length, 40);
    assert.deepEqual(order.slice(0, 10), Array.from({ length: 10 }, (_, i) => i));
    assert.equal(order.filter(n => n === 0).length, 1);
    for (let i = 1; i <= 9; i++) assert.ok(order.filter(n => n === i).length >= 4 && order.filter(n => n === i).length <= 5);
  } finally { current.db.close(); }
});

test('cleanup row budget of one is exact and cannot spend an extra row on an archive', async () => {
  const current = setup(), archive = setup();
  try {
    const old = Date.now() - 8 * DAY_MS;
    await worker.fetch(request([raw(idFor(1), old), raw(idFor(2), old)]), current.env);
    await worker.fetch(request([raw(idFor(3), old)]), archive.env);
    current.queries.length = 0; archive.queries.length = 0;
    current.env.D1_RETENTION_DAYS = 7;
    current.env.D1_CLEANUP_MAX_ROWS = '1';
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    await worker.scheduled({} as ScheduledController, current.env);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 1);
    assert.equal(archive.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 1);
    assert.equal(current.queries.length, 1);
    assert.equal(current.queries[0].values.at(-1), 1);
    assert.equal(archive.queries.length, 0);
  } finally { current.db.close(); archive.db.close(); }
});

test('the remaining cleanup row budget determines the final archive batch limit', async () => {
  const current = setup(), archive = setup();
  try {
    const old = Date.now() - 8 * DAY_MS;
    await worker.fetch(request(Array.from({ length: 10 }, (_, i) => raw(idFor(i + 1), old))), current.env);
    await worker.fetch(request(Array.from({ length: 10 }, (_, i) => raw(idFor(i + 11), old))), archive.env);
    current.queries.length = 0; archive.queries.length = 0;
    current.env.D1_RETENTION_DAYS = 7;
    current.env.D1_CLEANUP_MAX_ROWS = 14;
    current.env.RAW_DB_ARCHIVE_1 = archive.env.RAW_DB;
    await worker.scheduled({} as ScheduledController, current.env);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 0);
    assert.equal(archive.db.prepare('SELECT count(*) AS n FROM raw_message').get()!.n, 6);
    assert.deepEqual([current.queries[0].values.at(-1), archive.queries[0].values.at(-1)], [14, 4]);
  } finally { current.db.close(); archive.db.close(); }
});

test('a cleanup failure is isolated and reported; other databases still delete only expired rows', async t => {
  const current = setup(), broken = setup(), archive = setup();
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  try {
    const expired = raw(idFor(1), Date.now() - 181 * 86400000), retained = raw(idFor(2));
    await worker.fetch(request([expired, retained]), archive.env);
    current.env.RAW_DB_ARCHIVE_1 = broken.env.RAW_DB;
    current.env.RAW_DB_ARCHIVE_2 = archive.env.RAW_DB;
    broken.db.exec('DROP TABLE raw_message');
    await assert.rejects(worker.scheduled({} as ScheduledController, current.env), /RAW_ARCHIVE_CLEANUP_FAILED/);
    assert.deepEqual(archive.db.prepare('SELECT raw_id FROM raw_message').all().map(r => r.raw_id), [retained.raw_id]);
    assert.equal(broken.queries.length, 1);
    assert.equal(archive.queries.filter(q => q.sql.startsWith('DELETE')).length, 1);
    assert.equal(logs.length, 1);
    assert.ok(!JSON.stringify(logs).includes(TOKEN));
    assert.ok(!JSON.stringify(logs).includes('DROP TABLE'));
  } finally { current.db.close(); broken.db.close(); archive.db.close(); }
});
