import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import { databaseOptions, errorCode } from '../src/database.ts';

export interface VerificationOptions {
  before: string; after: string | null; limit: number; minRows: number; requireLineage: boolean; device: string | null;
}
export interface VerificationTargetReport {
  target: string; ok: boolean; samples: pg.QueryResultRow[]; code?: string;
  records?: string; with_raw_lineage?: string; client_tls_verified?: boolean;
}
export function verifySqliteArchive(path: string, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid raw verification limit');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    // Sort small IDs, not raw payloads: sorting 10,000 bodies can exhaust Docker's 16 MiB /tmp.
    const ids = db.prepare('SELECT rowid FROM raw_message ORDER BY store_time_utc DESC,rowid DESC LIMIT ?').all(limit);
    const get = db.prepare('SELECT raw_id,raw_data,raw_data_sha256 FROM raw_message WHERE rowid=?');
    const corrupt: string[] = [];
    for (const id of ids) {
      const row = get.get(id.rowid)!;
      if (createHash('sha256').update(String(row.raw_data)).digest('hex') !== row.raw_data_sha256) corrupt.push(String(row.raw_id));
    }
    const jobs = db.prepare('SELECT target_id,status,count(*) records FROM delivery_job GROUP BY target_id,status').all();
    db.exec('COMMIT');
    return { ok: corrupt.length === 0, raw_hashes_checked: ids.length, corrupt_raw_ids: corrupt, delivery_jobs: jobs };
  } finally { db.close(); }
}
export function verificationOptions(env: Record<string, string | undefined> = process.env, now = Date.now()): VerificationOptions {
  const beforeInput = env.VERIFY_BEFORE ?? new Date(now - 15000).toISOString();
  const afterInput = env.VERIFY_AFTER;
  const limit = Number(env.VERIFY_LIMIT ?? 100);
  const minRows = Number(env.VERIFY_MIN_ROWS ?? 1);
  if (!Number.isFinite(Date.parse(beforeInput)) || (afterInput !== undefined && !Number.isFinite(Date.parse(afterInput)))) throw new Error('Invalid verification UTC window');
  const before = new Date(beforeInput).toISOString();
  const after = afterInput === undefined ? null : new Date(afterInput).toISOString();
  if (after !== null && Date.parse(after) >= Date.parse(before)) throw new Error('VERIFY_AFTER must be earlier than VERIFY_BEFORE');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('VERIFY_LIMIT must be between 1 and 10000');
  if (!Number.isInteger(minRows) || minRows < 1 || minRows > limit) throw new Error('VERIFY_MIN_ROWS must be between 1 and VERIFY_LIMIT');
  if (env.VERIFY_REQUIRE_LINEAGE !== undefined && !['0', '1'].includes(env.VERIFY_REQUIRE_LINEAGE)) throw new Error('VERIFY_REQUIRE_LINEAGE must be 0 or 1');
  return { before, after, limit, minRows, requireLineage: env.VERIFY_REQUIRE_LINEAGE === '1', device: env.VERIFY_DEVICE ?? null };
}
export function assessReports(reports: VerificationTargetReport[], options: VerificationOptions) {
  const reasons: string[] = [];
  if (reports.length !== 2) reasons.push('EXPECTED_TWO_DATABASE_TARGETS');
  const checks = reports.map(report => {
    const lineageMissing = options.requireLineage ? report.samples.filter(row =>
      typeof row.raw_id !== 'string' || !row.raw_id.trim() || typeof row.result_sha256 !== 'string' || !row.result_sha256.trim()
    ).map(row => String(row.message_id)) : [];
    if (!report.ok) reasons.push(`${report.target}:DATABASE_QUERY_FAILED:${report.code ?? 'UNKNOWN'}`);
    if (report.samples.length < options.minRows) reasons.push(`${report.target}:MIN_ROWS_NOT_MET:${report.samples.length}<${options.minRows}`);
    if (lineageMissing.length) reasons.push(`${report.target}:MISSING_RAW_ID_OR_RESULT_SHA256:${lineageMissing.length}`);
    return { target: report.target, samples_checked: report.samples.length, minimum_rows_met: report.samples.length >= options.minRows,
      lineage_required: options.requireLineage, lineage_complete: lineageMissing.length === 0, lineage_missing_message_ids: lineageMissing };
  });
  const normalized = (row: Record<string, unknown>) => JSON.stringify(row);
  const left = new Map<string, string>((reports[0]?.samples ?? []).map(row => [row.message_id, normalized(row)]));
  const right = new Map<string, string>((reports[1]?.samples ?? []).map(row => [row.message_id, normalized(row)]));
  const matches = reports.length === 2 && reports.every(report => report.ok) && left.size > 0 && left.size === right.size && [...left].every(([id, value]) => right.get(id) === value);
  if (!matches) reasons.push(left.size && right.size ? 'DATABASE_WINDOWS_DIFFER' : 'DATABASE_WINDOW_EMPTY');
  return { verification_passed: reasons.length === 0, recent_window_identical: matches, verification_reasons: reasons, target_checks: checks };
}

export async function runVerification(): Promise<void> {
  const options = verificationOptions();
  const { before, after, limit, device } = options;
  const config = loadConfig();
  const reports: VerificationTargetReport[] = await Promise.all(config.targets.map(async target => {
    const db = new pg.Client(databaseOptions(target));
    try {
      await db.connect();
      const eventTime = 'coalesce(sample_time_utc,read_time_utc,source_receive_time_utc,receive_time_utc)';
      const where = `${eventTime} < $1 AND ($2::text IS NULL OR device_id=$2) AND ($3::timestamptz IS NULL OR ${eventTime} >= $3::timestamptz)`;
      const parameters = [before, device, after];
      const count = await db.query(`SELECT count(*)::text records, count(*) FILTER (WHERE raw_id IS NOT NULL)::text with_raw_lineage FROM iot.telemetry WHERE ${where}`, parameters);
      const data = await db.query(`SELECT message_id,raw_id,processor_id,processor_version,output_key,payload_sha256,result_sha256,sample_time_utc,read_time_utc,observation_kind,time_basis,source_receive_time_utc,device_id,metrics FROM iot.telemetry WHERE ${where} ORDER BY ${eventTime} DESC,message_id LIMIT $4`, [...parameters, limit]);
      const socket = (db as unknown as { connection: { stream: { encrypted?: boolean; authorized?: boolean } } }).connection.stream;
      return { target: target.id, ok: true, ...count.rows[0], client_tls_verified: !!socket.encrypted && socket.authorized === true, samples: data.rows };
    } catch (error) { return { target: target.id, ok: false, code: errorCode(error), samples: [] }; }
    finally { await db.end(); }
  }));
  const assessment = assessReports(reports, options);
  let archive: object | undefined;
  if (process.env.VERIFY_SQLITE) {
    try {
      const checked = verifySqliteArchive(process.env.VERIFY_SQLITE, limit);
      archive = checked;
      if (!checked.ok) assessment.verification_reasons.push(`SQLITE_RAW_HASH_MISMATCH:${checked.corrupt_raw_ids.length}`);
    } catch (error) {
      archive = { ok: false, code: errorCode(error) };
      assessment.verification_reasons.push(`SQLITE_VERIFICATION_FAILED:${errorCode(error)}`);
    }
  }
  assessment.verification_passed = assessment.verification_reasons.length === 0;
  const result = { check_time_utc: new Date().toISOString(), after_time_utc: after, before_time_utc: before,
    window: { after_inclusive_time_utc: after, before_exclusive_time_utc: before, time_basis: 'coalesce(sample_time_utc,read_time_utc,source_receive_time_utc,receive_time_utc)' },
    device_id: device, sample_limit: limit, minimum_rows_per_target: options.minRows, require_lineage: options.requireLineage,
    ...assessment, reports, archive };
  const evidence = join(process.env.DATA_DIR ?? '.', 'evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'layered-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.verification_passed) process.exitCode = 1;
}

// Keep both direct invocation and the existing scripts/verify.ts import wrapper working.
// Importing the pure checks from another module does not connect to either database.
const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryUrl === import.meta.url || entryUrl === new URL('./verify.ts', import.meta.url).href) await runVerification();
