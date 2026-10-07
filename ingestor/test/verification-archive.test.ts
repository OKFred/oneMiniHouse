import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { verifySqliteArchive } from '../scripts/verify-layered.ts';

test('archive verification checks newest saved records with bounded payload memory and reports corrupt IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minihouse-verify-'));
  const path = join(dir, 'archive.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE raw_message(raw_id TEXT PRIMARY KEY,raw_data TEXT,raw_data_sha256 TEXT,store_time_utc INTEGER);
      CREATE TABLE delivery_job(target_id TEXT,status TEXT);
      INSERT INTO delivery_job VALUES('local','done'),('supabase','pending');`);
    const put = db.prepare('INSERT INTO raw_message VALUES(?,?,?,?)');
    const body = 'x'.repeat(65536), hash = createHash('sha256').update(body).digest('hex');
    // Payloads exceed the production /tmp budget; selection must sort IDs rather than bodies.
    db.exec('BEGIN');
    for (let i = 0; i < 300; i++) put.run(`raw-${i}`, body, hash, i);
    put.run('old-corrupt', body, 'bad', -1);
    db.exec('COMMIT');
    db.close();
    const clean = verifySqliteArchive(path, 300);
    assert.equal(clean.ok, true);
    assert.equal(clean.raw_hashes_checked, 300);
    assert.deepEqual(clean.delivery_jobs.map(r => [r.target_id,r.status,r.records]), [['local','done',1],['supabase','pending',1]]);
    const corrupt = verifySqliteArchive(path, 301);
    assert.equal(corrupt.ok, false);
    assert.deepEqual(corrupt.corrupt_raw_ids, ['old-corrupt']);
    assert.throws(() => verifySqliteArchive(path, 10001));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
