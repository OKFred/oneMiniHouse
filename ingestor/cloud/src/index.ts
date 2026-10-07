import { timingSafeEqual, createHash } from 'node:crypto';

export interface RawRecord {
  raw_id: string; source_kind: string; source_id: string; topic: string;
  data_kind: 'inline' | 'object_ref'; content_type: string; raw_data: string; raw_data_sha256: string;
  generate_time_utc: number | null; receive_time_utc: number; store_time_utc: number; expire_time_utc: number;
  source_message_id: string | null; source_site_id: string | null; source_gateway_id: string | null; source_device_id: string | null;
}
const MAX_BODY = 1024 * 1024;
const RETENTION_MS = 180 * 86400000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const stamp = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const digest = (value: string) => createHash('sha256').update(value).digest();

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/raw/batch' || request.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!env.ARCHIVE_TOKEN || env.ARCHIVE_TOKEN.length < 32) return json({ error: 'not_configured' }, 503);
    const authorization = request.headers.get('authorization') ?? '';
    if (authorization.length > 1024 || !timingSafeEqual(digest(authorization), digest(`Bearer ${env.ARCHIVE_TOKEN}`))) return json({ error: 'unauthorized' }, 401);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'json_required' }, 415);
    let records: RawRecord[];
    try {
      const body = await boundedBody(request);
      if (!object(body) || body.schema_version !== 1 || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 32) throw new Error('Invalid batch');
      records = body.records.map(value => validateRaw(value, env.ALLOWED_SITE_ID));
      if (new Set(records.map(r => r.raw_id)).size !== records.length) throw new Error('Duplicate IDs in batch');
    } catch { return json({ error: 'invalid_batch' }, 400); }
    try {
      const statement = env.RAW_DB.prepare(`INSERT OR IGNORE INTO raw_message(raw_id,source_kind,source_id,topic,data_kind,content_type,raw_data,raw_data_sha256,generate_time_utc,receive_time_utc,store_time_utc,expire_time_utc,source_message_id,source_site_id,source_gateway_id,source_device_id,mirror_store_time_utc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const now = Date.now();
      // D1 batch is transactional; the immutable trigger aborts the whole batch
      // if any existing ID contains different source content.
      await env.RAW_DB.batch(records.map(r => statement.bind(r.raw_id,r.source_kind,r.source_id,r.topic,r.data_kind,r.content_type,r.raw_data,r.raw_data_sha256,r.generate_time_utc,r.receive_time_utc,r.store_time_utc,r.expire_time_utc,r.source_message_id,r.source_site_id,r.source_gateway_id,r.source_device_id,now)));
      return json({ accepted: records.map(r => ({ raw_id: r.raw_id, raw_data_sha256: r.raw_data_sha256 })) });
    } catch (error) {
      if (error instanceof Error && error.message.includes('RAW_ID_CONFLICT')) return json({ error: 'raw_id_conflict' }, 409);
      console.error(JSON.stringify({ event: 'raw_archive_failed', records: records.length }));
      return json({ error: 'archive_unavailable' }, 503);
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    let total = 0;
    // Bound each run and each transaction; an index prevents full-table scans.
    for (let batch = 0; batch < 12; batch++) {
      const result = await env.RAW_DB.prepare('DELETE FROM raw_message WHERE raw_id IN (SELECT raw_id FROM raw_message WHERE expire_time_utc < ? ORDER BY expire_time_utc LIMIT 5000)').bind(Date.now()).run();
      total += result.meta.changes;
      if (result.meta.changes < 5000) break;
    }
    console.log(JSON.stringify({ event: 'raw_archive_cleanup', deleted: total }));
  },
} satisfies ExportedHandler<Env>;
