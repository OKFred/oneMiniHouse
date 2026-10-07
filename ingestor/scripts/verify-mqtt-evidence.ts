import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import { databaseOptions, errorCode } from '../src/database.ts';

interface Round {
  message_id: string; collection_id: string; captured_at: string;
  metrics: Record<string, number>; payload_sha256: string;
  frames: { frame_id: string; payload_sha256: string; wire_sha256: string }[];
}
const evidence = JSON.parse(readFileSync(process.env.MQTT_EVIDENCE_FILE!, 'utf8')) as {
  status: string; device_id: string; topic_prefix: string; required_rounds: number; rounds: Round[];
};
assert.equal(evidence.status, 'passed');
assert.ok(evidence.rounds.length >= evidence.required_rounds && evidence.required_rounds >= 10);
const ids = evidence.rounds.map(r => r.message_id);
assert.equal(new Set(ids).size, ids.length);
const config = loadConfig();
assert.equal(config.targets.length, 2);
const output: Record<string, unknown> = { check_time_utc: new Date().toISOString(), device_id: evidence.device_id, message_ids: ids };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sqlite = new DatabaseSync(join(process.env.DATA_DIR ?? '/app/data', 'inbox.sqlite'), { readOnly: true });
try {
  let frameCount = 0;
  for (const round of evidence.rounds) {
    const raw = sqlite.prepare('SELECT * FROM raw_message WHERE raw_id=?').get(round.message_id);
    assert.ok(raw, 'SQLITE_RAW_MISSING');
    assert.equal(raw.raw_data_sha256, round.payload_sha256);
    assert.equal(hash(String(raw.raw_data)), round.payload_sha256);
    assert.equal(raw.generate_time_utc, Date.parse(round.captured_at));
    assert.equal(raw.topic, `${evidence.topic_prefix}/devices/${evidence.device_id}/telemetry`);
    assert.deepEqual(JSON.parse(String(raw.raw_data)).metrics, round.metrics);
    for (const expected of round.frames) {
      const frame = sqlite.prepare('SELECT * FROM protocol_frame WHERE frame_id=?').get(expected.frame_id);
      assert.ok(frame, 'SQLITE_FRAME_MISSING');
      assert.equal(frame.collection_id, round.collection_id);
      assert.equal(frame.raw_data_sha256, expected.payload_sha256);
      const archivedFrame = JSON.parse(String(frame.frame_json));
      assert.equal(hash(archivedFrame.raw_data), expected.payload_sha256);
      assert.equal(hash(Buffer.from(archivedFrame.wire_hex, 'hex')), expected.wire_sha256);
      frameCount++;
    }
    const jobs = sqlite.prepare('SELECT target_id,status,outcome FROM delivery_job WHERE raw_id=?').all(round.message_id);
    for (const target of ['local', 'supabase', 'd1']) {
      const job = jobs.find(j => j.target_id === target);
      assert.equal(job?.status, 'done', `DELIVERY_NOT_DONE:${target}`);
      assert.equal(job?.outcome, 'confirmed', `DELIVERY_NOT_CONFIRMED:${target}`);
    }
  }
  output.sqlite = { passed: true, raw_records: ids.length, protocol_frames: frameCount, all_three_deliveries_confirmed: true };
} finally { sqlite.close(); }
const reports = [];
for (const target of config.targets) {
  const client = new pg.Client(databaseOptions(target));
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const rows = (await client.query('SELECT message_id,raw_id,device_id,sample_time_utc,metrics,result_sha256 FROM iot.telemetry WHERE message_id=ANY($1::uuid[])', [ids])).rows;
    assert.equal(rows.length, ids.length, `${target.id}:PG_ROWS_MISSING`);
    for (const round of evidence.rounds) {
      const row = rows.find(r => r.message_id === round.message_id);
      assert.equal(row?.raw_id, round.message_id);
      assert.equal(row.device_id, evidence.device_id);
      assert.equal(row.sample_time_utc.toISOString(), round.captured_at);
      assert.deepEqual(row.metrics, round.metrics);
      assert.match(row.result_sha256, /^[a-f0-9]{64}$/);
    }
    await client.query('ROLLBACK');
    reports.push({ target: target.id, rows_checked: rows.length, passed: true });
  } catch (error) { throw new Error(`${target.id}:VERIFICATION_FAILED:${errorCode(error)}`); }
  finally { await client.end(); }
}
output.databases = reports;
output.passed = true;
writeFileSync(process.env.OUTPUT_FILE ?? join(process.env.DATA_DIR ?? '/app/data', 'evidence', 'mqtt-storage-verification.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output));
