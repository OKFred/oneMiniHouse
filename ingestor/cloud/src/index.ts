import { timingSafeEqual, createHash } from 'node:crypto';

export interface RawRecord {
  raw_id: string; source_kind: string; source_id: string; topic: string;
  data_kind: 'inline' | 'object_ref'; content_type: string; raw_data: string; raw_data_sha256: string;
  generate_time_utc: number | null; receive_time_utc: number; store_time_utc: number; expire_time_utc: number;
  source_message_id: string | null; source_site_id: string | null; source_gateway_id: string | null; source_device_id: string | null;
}
const ARCHIVE_BINDINGS = ['RAW_DB_ARCHIVE_1', 'RAW_DB_ARCHIVE_2', 'RAW_DB_ARCHIVE_3', 'RAW_DB_ARCHIVE_4', 'RAW_DB_ARCHIVE_5', 'RAW_DB_ARCHIVE_6', 'RAW_DB_ARCHIVE_7', 'RAW_DB_ARCHIVE_8', 'RAW_DB_ARCHIVE_9'] as const;
// Optional rollover bindings use Wrangler's generated D1 binding type. Keeping
// them optional preserves the existing, single-database deployment.
export type ArchiveEnv = Env & Partial<Record<typeof ARCHIVE_BINDINGS[number], Env['RAW_DB']>> & {
  D1_RETENTION_DAYS?: string | number;
  D1_CLEANUP_MAX_ROWS?: string | number;
};
// Match migrations/0002_replay_timestamps.sql, including nullable metadata.
// Receive/store/expiry timestamps belong to the first stored copy and may differ
// during recovery; they must neither conflict nor be rewritten on a replay.
const IMMUTABLE_FIELDS = ['source_kind', 'source_id', 'topic', 'data_kind', 'content_type', 'raw_data', 'raw_data_sha256', 'generate_time_utc', 'source_message_id', 'source_site_id', 'source_gateway_id', 'source_device_id'] as const;
type ImmutableRaw = Pick<RawRecord, 'raw_id' | typeof IMMUTABLE_FIELDS[number]>;
const MAX_BODY = 1024 * 1024;
const RETENTION_MS = 180 * 86400000;
const DAY_MS = 86400000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const stamp = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const digest = (value: string) => createHash('sha256').update(value).digest();

function integerSetting(value: unknown, fallback: number, maximum: number, code: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9][0-9]{0,5}$/.test(value))) throw new Error(code);
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(code);
  return number;
}

function archiveSettings(env: ArchiveEnv): { days: number; maxRows: number } {
  // Keep the 180-day request contract and old deployments compatible; only the
  // D1 copy is shortened. An invalid setting must not silently retain 180 days.
  return {
    days: integerSetting(env.D1_RETENTION_DAYS, 180, 180, 'D1_RETENTION_INVALID'),
    maxRows: integerSetting(env.D1_CLEANUP_MAX_ROWS, 60000, 200000, 'D1_CLEANUP_CONFIG_INVALID'),
  };
}

export function classifyD1Failure(error: unknown, now = Date.now()): { code: string; status: 429 | 507; retry_after_seconds: number } | undefined {
  // Only documented provider messages identify quota/storage failures. Never
  // return the original error: it can contain SQL or bound source data.
  // https://developers.cloudflare.com/d1/observability/debug-d1/
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++, current = current.cause) {
    if (current.message.length > 16384) continue;
    const message = current.message.trim().replace(/^D1_ERROR:\s*/i, '');
    const daily = message.startsWith("Your account has exceeded D1's free tier daily row read limit.") ? 'D1_DAILY_READ_LIMIT'
      : message.startsWith("Your account has exceeded D1's free tier daily row write limit.") ? 'D1_DAILY_WRITE_LIMIT' : undefined;
    // Free daily limits reset at 00:00 UTC; five seconds avoid the boundary.
    // https://developers.cloudflare.com/d1/platform/pricing/
    if (daily) return { code: daily, status: 429, retry_after_seconds: Math.ceil(((Math.floor(now / 86400000) + 1) * 86400000 + 5000 - now) / 1000) };
    if (message.startsWith('Exceeded maximum DB size.')) return { code: 'D1_DATABASE_SIZE_LIMIT', status: 507, retry_after_seconds: 3600 };
    if (message.startsWith("Your account has exceeded D1's maximum account storage limit,")) return { code: 'D1_ACCOUNT_STORAGE_LIMIT', status: 507, retry_after_seconds: 3600 };
  }
  return undefined;
}

export function validateRaw(value: unknown, allowedSite: string, now = Date.now()): RawRecord {
  if (!object(value) || !text(value.raw_id) || !uuid.test(value.raw_id) || !['mqtt', 'legacy_d1', 'legacy_inbox'].includes(String(value.source_kind)) || !text(value.source_id, 2048) || !text(value.topic, 2048)) throw new Error('Invalid raw identity');
  if (value.topic.endsWith('/frames') || value.topic.includes('/frames/')) throw new Error('Protocol frames are not accepted by the business archive');
  if (!['inline', 'object_ref'].includes(String(value.data_kind)) || !text(value.content_type, 128) || typeof value.raw_data !== 'string' || Buffer.byteLength(value.raw_data) > 65536) throw new Error('Invalid raw content');
  if (value.raw_data_sha256 !== digest(value.raw_data).toString('hex')) throw new Error('Raw content hash mismatch');
  if ((value.generate_time_utc !== null && !stamp(value.generate_time_utc)) || !stamp(value.receive_time_utc) || !stamp(value.store_time_utc) || !stamp(value.expire_time_utc) || value.store_time_utc > now + 300000 || value.expire_time_utc < value.store_time_utc || value.expire_time_utc > value.store_time_utc + RETENTION_MS) throw new Error('Invalid raw timestamps or retention');
  for (const name of ['source_message_id','source_gateway_id','source_device_id']) if (value[name] !== null && !text(value[name], 256)) throw new Error('Invalid source metadata');
  // Raw invalid messages can have no decoded identity. Topic/source still must
  // belong to this site, preventing a compromised token from writing another site.
  if (value.source_site_id !== null && value.source_site_id !== allowedSite) throw new Error('Site is not allowed');
  if (value.source_kind === 'mqtt' && !value.topic.startsWith(`iot/v1/${allowedSite}/`)) throw new Error('Topic is not allowed');
  return value as unknown as RawRecord;
}

async function boundedBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Error('Body too large');
  if (!request.body) throw new Error('Body required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('Body too large'); }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

function archiveDatabases(env: ArchiveEnv): { binding: string; database: Env['RAW_DB'] }[] {
  return ARCHIVE_BINDINGS.flatMap(binding => env[binding] ? [{ binding, database: env[binding] }] : []);
}

async function findExisting(database: Env['RAW_DB'], records: RawRecord[]): Promise<ImmutableRaw[]> {
  // At most 32 primary-key lookups, with no table scan or unbounded response.
  // https://developers.cloudflare.com/d1/worker-api/prepared-statements/
  const result = await database.prepare(`SELECT raw_id,${IMMUTABLE_FIELDS.join(',')} FROM raw_message WHERE raw_id IN (${records.map(() => '?').join(',')})`).bind(...records.map(record => record.raw_id)).all<ImmutableRaw>();
  if (!result.success) throw new Error('D1_QUERY_FAILED');
  return result.results;
}

async function recordsForCurrentDatabase(records: RawRecord[], env: ArchiveEnv): Promise<RawRecord[]> {
  const archives = archiveDatabases(env);
  if (!archives.length) return records;
  const byId = new Map(records.map(record => [record.raw_id, record]));
  const archivedIds = new Set<string>();
  const check = (stored: ImmutableRaw) => {
    const incoming = byId.get(stored.raw_id);
    if (!incoming || IMMUTABLE_FIELDS.some(field => stored[field] !== incoming[field])) throw new Error('RAW_ID_CONFLICT');
  };
  // Historical databases are sealed for ingestion after rollover. Query every
  // one before any new write, even after a match: later copies can conflict.
  // Sequential queries also stay below D1's concurrent connection limit.
  for (const { database } of archives) {
    for (const stored of await findExisting(database, records)) {
      check(stored);
      archivedIds.add(stored.raw_id);
    }
  }
  if (archivedIds.size) {
    // A pre-existing current copy must agree too. New-only IDs remain protected
    // atomically by the current database's immutable INSERT trigger.
    for (const stored of await findExisting(env.RAW_DB, records.filter(record => archivedIds.has(record.raw_id)))) check(stored);
  }
  return records.filter(record => !archivedIds.has(record.raw_id));
}

export default {
  async fetch(request: Request, env: ArchiveEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/raw/batch' || request.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!env.ARCHIVE_TOKEN || env.ARCHIVE_TOKEN.length < 32) return json({ error: 'not_configured' }, 503);
    const authorization = request.headers.get('authorization') ?? '';
    if (authorization.length > 1024 || !timingSafeEqual(digest(authorization), digest(`Bearer ${env.ARCHIVE_TOKEN}`))) return json({ error: 'unauthorized' }, 401);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'json_required' }, 415);
    let days: number;
    try { ({ days } = archiveSettings(env)); }
    catch { return json({ error: 'not_configured' }, 503); }
    let records: RawRecord[];
    try {
      const body = await boundedBody(request);
      if (!object(body) || body.schema_version !== 1 || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 32) throw new Error('Invalid batch');
      records = body.records.map(value => validateRaw(value, env.ALLOWED_SITE_ID));
      if (new Set(records.map(r => r.raw_id)).size !== records.length) throw new Error('Duplicate IDs in batch');
    } catch { return json({ error: 'invalid_batch' }, 400); }
    try {
      const pending = await recordsForCurrentDatabase(records, env);
      const statement = env.RAW_DB.prepare(`INSERT OR IGNORE INTO raw_message(raw_id,source_kind,source_id,topic,data_kind,content_type,raw_data,raw_data_sha256,generate_time_utc,receive_time_utc,store_time_utc,expire_time_utc,source_message_id,source_site_id,source_gateway_id,source_device_id,mirror_store_time_utc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const now = Date.now();
      // D1 batch is transactional; the immutable trigger aborts the whole batch
      // if any existing ID contains different source content.
      if (pending.length) {
        const results = await env.RAW_DB.batch(pending.map(r => statement.bind(r.raw_id,r.source_kind,r.source_id,r.topic,r.data_kind,r.content_type,r.raw_data,r.raw_data_sha256,r.generate_time_utc,r.receive_time_utc,r.store_time_utc,Math.min(r.expire_time_utc, r.store_time_utc + days * DAY_MS),r.source_message_id,r.source_site_id,r.source_gateway_id,r.source_device_id,now)));
        if (results.length !== pending.length || results.some(result => !result.success)) throw new Error('D1_QUERY_FAILED');
      }
      return json({ accepted: records.map(r => ({ raw_id: r.raw_id, raw_data_sha256: r.raw_data_sha256 })) });
    } catch (error) {
      if (error instanceof Error && error.message.includes('RAW_ID_CONFLICT')) return json({ error: 'raw_id_conflict' }, 409);
      const failure = classifyD1Failure(error);
      if (failure) {
        console.error(JSON.stringify({ event: 'raw_archive_failed', records: records.length, code: failure.code }));
        return Response.json({ code: failure.code, retry_after_seconds: failure.retry_after_seconds }, { status: failure.status, headers: { 'cache-control': 'no-store', 'retry-after': String(failure.retry_after_seconds) } });
      }
      console.error(JSON.stringify({ event: 'raw_archive_failed', records: records.length }));
      return json({ error: 'archive_unavailable' }, 503);
    }
  },
  async scheduled(_event: ScheduledController, env: ArchiveEnv): Promise<void> {
    const { days, maxRows } = archiveSettings(env);
    let total = 0, queries = 0, failed = 0, rowsRead = 0, rowsWritten = 0, missingReadCount = false, missingWriteCount = false;
    const databases = [{ binding: 'RAW_DB', database: env.RAW_DB }, ...archiveDatabases(env)];
    const now = Date.now();
    // The request contract bounds every stored expiry by store + 180 days.
    // Thus an overdue storage window implies expiry < now + (180-days) days.
    // Reuse the existing expiry index, then check the actual storage/expiry
    // guard; the range alone must NEVER authorize deletion of a recent row.
    // LIMIT bounds deletion, not index reads: recent short-window rows inside
    // this range may be inspected and excluded. Observe meta.rows_read.
    // https://developers.cloudflare.com/d1/best-practices/use-indexes/
    const indexedCleanupSql = days === 180
      ? 'DELETE FROM raw_message WHERE raw_id IN (SELECT raw_id FROM raw_message INDEXED BY raw_message_expiry WHERE expire_time_utc < ? ORDER BY expire_time_utc LIMIT ?)'
      : `DELETE FROM raw_message WHERE raw_id IN (
          SELECT raw_id FROM raw_message INDEXED BY raw_message_expiry
          WHERE expire_time_utc < ? AND (store_time_utc < ? OR expire_time_utc < ?)
          ORDER BY expire_time_utc LIMIT ?
        )`;
    const indexedCleanupValues = days === 180 ? [now] : [now + (180 - days) * DAY_MS, now - days * DAY_MS, now];
    // A short-window active database may omit the expiry index to leave room
    // for INSERT + DELETE in a Free daily write budget. Rowid-ordered batches
    // need no cursor table or extra index. Their predicate may scan retained
    // rows repeatedly: LIMIT controls deleted rows, not total read quota.
    const activeCleanupSql = `DELETE FROM raw_message WHERE rowid IN (
      SELECT rowid FROM raw_message WHERE store_time_utc < ? OR expire_time_utc < ?
      ORDER BY rowid LIMIT ?
    )`;
    const withinBudget = () => queries < 40 && total < maxRows;
    const cleanup = async ({ binding, database }: typeof databases[number], limit: number): Promise<number | null> => {
      queries++;
      try {
        const activeWithoutIndex = days < 180 && binding === 'RAW_DB';
        const result = await database.prepare(activeWithoutIndex ? activeCleanupSql : indexedCleanupSql)
          .bind(...(activeWithoutIndex ? [now - days * DAY_MS, now] : indexedCleanupValues), limit).run();
        if (!result.success) throw new Error('D1_QUERY_FAILED');
        const changes = result.meta.changes;
        if (!Number.isInteger(changes) || changes < 0 || changes > limit) throw new Error('D1_QUERY_FAILED');
        total += changes;
        if (Number.isFinite(result.meta.rows_read) && result.meta.rows_read >= 0) rowsRead += result.meta.rows_read;
        else missingReadCount = true;
        if (Number.isFinite(result.meta.rows_written) && result.meta.rows_written >= 0) rowsWritten += result.meta.rows_written;
        else missingWriteCount = true;
        return changes;
      } catch (error) {
        failed++; missingReadCount = true; missingWriteCount = true;
        console.error(JSON.stringify({ event: 'raw_archive_cleanup_failed', binding, code: classifyD1Failure(error, now)?.code ?? 'D1_QUERY_FAILED' }));
        return null;
      }
    };
    let active = databases;
    if (days < 180) {
      // Protect the active database's steady retention before spending the
      // same daily write budget on a large sealed historical backlog.
      let currentExhausted = false;
      for (let round = 0; round < 12 && withinBudget(); round++) {
        const limit = Math.min(5000, maxRows - total);
        const changes = await cleanup(databases[0], limit);
        if (changes === null) break;
        if (changes < limit) { currentExhausted = true; break; }
      }
      active = currentExhausted ? databases.slice(1) : [];
    }
    // Each remaining database gets a turn before a second. Preserve the
    // per-database maximum (12 x 5000) and global 40-query invocation budget.
    // The last DELETE limit also respects the exact configured row budget.
    // https://developers.cloudflare.com/d1/platform/limits/
    for (let round = 0; round < 12 && active.length && withinBudget(); round++) {
      const next: typeof databases = [];
      for (const entry of active) {
        if (!withinBudget()) break;
        const limit = Math.min(5000, maxRows - total);
        if (await cleanup(entry, limit) === limit) next.push(entry);
      }
      active = next;
    }
    console.log(JSON.stringify({ event: 'raw_archive_cleanup', deleted: total, queries, databases: databases.length, failed, max_rows: maxRows, retention_days: days, rows_read: missingReadCount ? null : rowsRead, rows_written: missingWriteCount ? null : rowsWritten }));
    if (failed) throw new Error('RAW_ARCHIVE_CLEANUP_FAILED');
  },
} satisfies ExportedHandler<ArchiveEnv>;
