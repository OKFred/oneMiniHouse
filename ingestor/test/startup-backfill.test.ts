import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Queue } from '../src/queue.ts';
import { hash, stableUuid, type FrameRecord } from '../src/message.ts';

const options = { maxPending: 100000, maxRejected: 10 };
const mirrorOptions = { ...options, rawMirror: true, frameMirror: true };
const now = Date.now(), retainedUntil = now + 86400000;
const rawId = (i: number) => stableUuid(`startup-raw-${i}`);
const frameId = (i: number) => stableUuid(`startup-frame-${i}`);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'startup-backfill-')), file = join(dir, 'inbox.sqlite');
  new Queue(file, options).close();
  return { file, close: () => rmSync(dir, { recursive: true, force: true }) };
}
function seed(file: string, count: number, expiredEvery = 0) {
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN');
    const raw = db.prepare(`INSERT INTO raw_message(rowid,raw_id,topic,source_kind,source_id,data_kind,content_type,
      raw_data,raw_data_sha256,receive_time_utc,store_time_utc,expire_time_utc,semantic_hash)
      VALUES(?,?,'iot/v1/example-home/example-gateway/devices/sensor/telemetry','mqtt','synthetic','inline','application/json',?,?,?,?,?,?)`);
    const frame = db.prepare('INSERT INTO protocol_frame(rowid,frame_id,collection_id,frame_json,raw_data_sha256,frame_time_utc,receive_time_utc,store_time_utc,expire_time_utc) VALUES(?,?,?,?,?,?,?,?,?)');
    for (let i = 1; i <= count; i++) {
      const payload = JSON.stringify({ synthetic_record: i, metrics: { temperature_c: 23.5 } });
      const expiry = expiredEvery && i % expiredEvery === 0 ? now - 1 : retainedUntil;
      // Non-contiguous rowids catch pagination that assumes the number of rows is
      // the cursor. The backfill must not need either payload column.
      raw.run(i * 3, rawId(i), payload, hash(payload), now - i, now - i, expiry, hash(payload));
      frame.run(i * 5, frameId(i), rawId(i), JSON.stringify({ frame_id: frameId(i), synthetic_record: i }), hash(payload), now - i, now - i, now - i, expiry);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}
function jobs(db: DatabaseSync) {
  return db.prepare('SELECT * FROM delivery_job ORDER BY artifact_id,target_id').all();
}
function archiveHash(db: DatabaseSync) {
  return hash(JSON.stringify([db.prepare('SELECT * FROM raw_message ORDER BY rowid').all(), db.prepare('SELECT * FROM protocol_frame ORDER BY rowid').all()]));
}

test('enabling both mirrors backfills all retained metadata across pages and preserves existing states and source bytes', () => {
  const f = fixture(); let queue: Queue | undefined;
  try {
    seed(f.file, 1603, 11);
    const db = new DatabaseSync(f.file);
    const insert = db.prepare(`INSERT INTO delivery_job(artifact_id,artifact_kind,raw_id,target_id,status,attempts,last_error,next_attempt_time_utc,create_time_utc,update_time_utc,outcome)
      VALUES(?,?,?,?,?,7,?,123456,111,222,?)`);
    for (const [i, status] of [[1, 'done'], [502, 'failed'], [1004, 'pending'], [11, 'done']] as const) {
      for (const target of ['d1', 'sls', 'local', 'supabase']) {
        const frame = target === 'sls';
        insert.run(frame ? frameId(i) : rawId(i), frame ? 'frame' : target === 'd1' ? 'raw' : 'processed', frame ? null : rawId(i), target, status,
          status === 'done' ? null : 'SYNTHETIC_RETRY', status === 'done' ? 'confirmed' : null);
      }
    }
    const previousJobs = jobs(db), previousHash = archiveHash(db);
    db.close();
    queue = new Queue(f.file, mirrorOptions); queue.close(); queue = undefined;
    const after = new DatabaseSync(f.file);
    try {
      assert.equal(archiveHash(after), previousHash);
      for (const job of previousJobs) assert.deepEqual(after.prepare('SELECT * FROM delivery_job WHERE artifact_id=? AND target_id=?').get(job.artifact_id, job.target_id), job);
      const eligible = 1603 - Math.floor(1603 / 11);
      for (const target of ['d1', 'sls']) {
        // One already-completed expired record is preserved; expired records
        // without an existing job must not be scheduled by enabling a mirror.
        assert.equal(after.prepare('SELECT count(*) AS n FROM delivery_job WHERE target_id=?').get(target)!.n, eligible + 1);
      }
      assert.equal(after.prepare("SELECT count(*) AS n FROM delivery_job WHERE target_id='d1' AND (artifact_id!=raw_id OR artifact_kind!='raw')").get()!.n, 0);
      assert.equal(after.prepare("SELECT count(*) AS n FROM delivery_job WHERE target_id='sls' AND (raw_id IS NOT NULL OR artifact_kind!='frame')").get()!.n, 0);
      assert.equal(after.prepare('SELECT create_time_utc AS t FROM delivery_job WHERE artifact_id=? AND target_id=\'d1\'').get(rawId(1603))!.t, now - 1603);
      const first = jobs(after); after.close();
      queue = new Queue(f.file, mirrorOptions); queue.close(); queue = undefined;
      const reopened = new DatabaseSync(f.file);
      try { assert.deepEqual(jobs(reopened), first); assert.equal(archiveHash(reopened), previousHash); } finally { reopened.close(); }
    } catch (error) { try { after.close(); } catch {} throw error; }
  } finally { queue?.close(); f.close(); }
});

test('restarting thousands of already-completed mirror jobs does not reset confirmations or queue them again', () => {
  const f = fixture(); let queue: Queue | undefined;
  try {
    seed(f.file, 4001);
    queue = new Queue(f.file, mirrorOptions); queue.close(); queue = undefined;
    const db = new DatabaseSync(f.file);
    db.exec("UPDATE delivery_job SET status='done',outcome='confirmed',attempts=9,next_attempt_time_utc=123456,update_time_utc=789012");
    const before = jobs(db), sourceHash = archiveHash(db); db.close();
    for (let i = 0; i < 2; i++) {
      queue = new Queue(f.file, mirrorOptions);
      assert.equal(queue.stats().d1_pending, 0); assert.equal(queue.stats().sls_pending, 0); assert.equal(queue.stats().outstanding_raw, 0);
      queue.close(); queue = undefined;
    }
    const after = new DatabaseSync(f.file);
    try { assert.deepEqual(jobs(after), before); assert.equal(archiveHash(after), sourceHash); } finally { after.close(); }
  } finally { queue?.close(); f.close(); }
});

test('failure after several startup backfill pages rolls back both mirrors and pending counts', () => {
  const f = fixture();
  try {
    seed(f.file, 1603);
    const db = new DatabaseSync(f.file);
    db.exec(`CREATE TRIGGER injected_startup_failure BEFORE INSERT ON delivery_job
      WHEN NEW.target_id='sls' AND NEW.artifact_id='${frameId(1201)}'
      BEGIN SELECT RAISE(ABORT,'synthetic startup failure'); END`);
    const sourceHash = archiveHash(db); db.close();
    // A child process closes SQLite even when construction throws, matching a
    // failed startup. Inspect the file independently to verify atomic rollback.
    const source = new URL('../src/queue.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { Queue } from ${JSON.stringify(source)};
      try { new Queue(${JSON.stringify(f.file)}, ${JSON.stringify(mirrorOptions)}).close(); }
      catch (error) { if(error.message.includes('synthetic startup failure'))process.exitCode=23;else throw error; }`], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 23, child.stderr);
    const after = new DatabaseSync(f.file);
    try {
      assert.equal(after.prepare('SELECT count(*) AS n FROM delivery_job').get()!.n, 0);
      assert.equal(after.prepare('SELECT count(*) AS n FROM pending_raw').get()!.n, 0);
      assert.equal(after.prepare("SELECT value FROM counts WHERE name='outstanding_raw'").get()!.value, 0);
      assert.equal(archiveHash(after), sourceHash);
      after.exec('DROP TRIGGER injected_startup_failure');
    } finally { after.close(); }
    new Queue(f.file, mirrorOptions).close();
    const recovered = new DatabaseSync(f.file);
    try { assert.equal(recovered.prepare('SELECT count(*) AS n FROM delivery_job').get()!.n, 3206); } finally { recovered.close(); }
  } finally { f.close(); }
});

test('startup repairs missing pending IDs across processing and delivery pages without changing jobs', () => {
  const f = fixture(); let queue: Queue | undefined;
  try {
    seed(f.file, 1603);
    const db = new DatabaseSync(f.file);
    db.exec('BEGIN');
    const process = db.prepare("INSERT INTO processing_job VALUES(?,'synthetic','1','pending',0,NULL,1,1)");
    const delivery = db.prepare("INSERT INTO delivery_job(artifact_id,artifact_kind,raw_id,target_id,status,create_time_utc,update_time_utc) VALUES(?,'processed',?,?,'failed',1,1)");
    for (let i = 1; i <= 1603; i++) {
      if (i <= 1001) process.run(rawId(i));
      if (i >= 501) { delivery.run(rawId(i), rawId(i), 'local'); delivery.run(rawId(i), rawId(i), 'supabase'); }
    }
    db.exec('DELETE FROM pending_raw; COMMIT');
    const before = jobs(db); db.close();
    queue = new Queue(f.file, options);
    assert.equal(queue.stats().outstanding_raw, 1603); queue.close(); queue = undefined;
    const after = new DatabaseSync(f.file);
    try { assert.deepEqual(jobs(after), before); assert.equal(after.prepare('SELECT count(*) AS n FROM pending_raw').get()!.n, 1603); } finally { after.close(); }
  } finally { queue?.close(); f.close(); }
});

test('frame eviction index upgrades idempotently, avoids sorting and preserves timestamp/rowid ties at capacity', () => {
  const f = fixture(); let queue: Queue | undefined;
  const config = { ...options, frameMirror: true, maxProtocolFrames: 3 };
  const frame = (i: number, time: number): FrameRecord => {
    const raw = JSON.stringify({ synthetic_frame: i });
    return { frame_id: frameId(i), collection_id: rawId(i), topic: 'iot/v1/example-home/example-gateway/devices/sensor/frames',
      raw_data: raw, raw_data_sha256: hash(raw), frame_time_utc: time, receive_time_utc: time, store_time_utc: time,
      expire_time_utc: retainedUntil, site_id: 'example-home', gateway_id: 'example-gateway', device_id: 'sensor',
      direction: 'rx', protocol: 'synthetic', wire_hex: '0102' };
  };
  // Timestamp order differs from insertion order; two oldest timestamps tie.
  const later = frame(1, now + 3), first = frame(2, now), second = frame(3, now);
  const next = frame(4, now + 2), last = frame(5, now + 4);
  const oldestSql = 'SELECT frame_id FROM protocol_frame ORDER BY store_time_utc,rowid LIMIT 1';
  try {
    queue = new Queue(f.file, config);
    for (const value of [later, first, second]) queue.acceptFrame(value);
    queue.close(); queue = undefined;
    const old = new DatabaseSync(f.file);
    old.exec('DROP INDEX frame_store_order');
    const beforeJobs = jobs(old), beforeArchive = archiveHash(old);
    assert.match(old.prepare('EXPLAIN QUERY PLAN ' + oldestSql).all().map(row => row.detail).join('\n'), /TEMP B-TREE/);
    assert.equal(old.prepare(oldestSql).get()!.frame_id, first.frame_id); old.close();
    let rootpage: unknown;
    for (let i = 0; i < 2; i++) {
      queue = new Queue(f.file, config);
      const db = new DatabaseSync(f.file, { readOnly: true });
      try {
        const plan = db.prepare('EXPLAIN QUERY PLAN ' + oldestSql).all().map(row => row.detail).join('\n');
        assert.match(plan, /USING INDEX frame_store_order/); assert.doesNotMatch(plan, /TEMP B-TREE/);
        assert.equal(db.prepare(oldestSql).get()!.frame_id, first.frame_id);
        assert.deepEqual(jobs(db), beforeJobs); assert.equal(archiveHash(db), beforeArchive);
        const index = db.prepare("SELECT rootpage FROM sqlite_schema WHERE type='index' AND name='frame_store_order'").all();
        assert.equal(index.length, 1);
        if (i === 0) rootpage = index[0].rootpage; else assert.equal(index[0].rootpage, rootpage);
      } finally { db.close(); }
      queue.close(); queue = undefined;
    }
    queue = new Queue(f.file, config);
    assert.equal(queue.acceptFrame(first), 'duplicate'); assert.equal(queue.stats().frames_dropped_capacity, 0);
    queue.acceptFrame(next); queue.acceptFrame(last);
    assert.equal(queue.stats().frame_records, 3); assert.equal(queue.stats().frames_dropped_capacity, 2);
    queue.close(); queue = undefined;
    const after = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(after.prepare("SELECT value FROM counts WHERE name='frame_received'").get()!.value, 5);
      assert.equal(after.prepare("SELECT value FROM counts WHERE name='duplicates'").get()!.value, 1);
      assert.deepEqual(after.prepare('SELECT frame_id FROM protocol_frame ORDER BY store_time_utc,rowid').all().map(row => row.frame_id), [next.frame_id, later.frame_id, last.frame_id]);
      assert.deepEqual(after.prepare("SELECT artifact_id FROM delivery_job WHERE target_id='sls' ORDER BY artifact_id").all().map(row => row.artifact_id), [later.frame_id, next.frame_id, last.frame_id].sort());
    } finally { after.close(); }
  } finally { queue?.close(); f.close(); }
});
