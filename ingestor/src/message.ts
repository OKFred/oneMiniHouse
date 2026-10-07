import { createHash } from 'node:crypto';

export const PROCESSOR_ID = 'iot-telemetry';
export const PROCESSOR_VERSION = '1';
export interface Sample {
  schema_version: 1 | 2; message_id: string; site_id: string; gateway_id: string; device_id: string;
  captured_at?: string; sample_time_utc?: string | null; read_time_utc?: string;
  observation_kind?: 'direct_read' | 'gateway_cached_state'; source_receive_time_utc?: string;
  collection_id?: string; quality: 'ok' | 'historical'; metrics: Record<string, number>; source?: Record<string, unknown>;
}
// payload is the original UTF-8 envelope; hash is its semantic hash for legacy idempotency.
export interface RecordRow {
  id: string; topic: string; payload: string; hash: string; received_at: string;
  raw_id?: string; processor_id?: string; processor_version?: string; output_key?: string;
  lineage?: Record<string, unknown>; source_kind?: string; source_id?: string;
}
export interface RawRecord {
  raw_id: string; topic: string; source_kind: string; source_id: string;
  source_message_id: string | null; source_site_id: string | null; source_gateway_id: string | null; source_device_id: string | null;
  data_kind: 'inline' | 'object_ref'; content_type: string; raw_data: string; raw_data_sha256: string;
  generate_time_utc: number | null; receive_time_utc: number; store_time_utc: number; expire_time_utc: number;
}
export interface FrameRecord {
  frame_id: string; collection_id: string; topic: string; raw_data: string; raw_data_sha256: string;
  frame_time_utc: number; receive_time_utc: number; store_time_utc: number; expire_time_utc: number;
  site_id: string; gateway_id: string; device_id: string; direction: 'tx' | 'rx'; protocol: string;
  wire_hex: string; crc_valid?: boolean;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function stableUuid(value: string): string {
  const h = hash(value); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function utf8(bytes: Buffer): string {
  if (bytes.length > 65536) throw new Error('Payload exceeds 64 KiB');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export const parseJson = (value:string):unknown => JSON.parse(value.charCodeAt(0)===0xfeff?value.slice(1):value);
export function utc(value: unknown, now = Date.now()): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis <= now + 300000 && new Date(millis).toISOString().slice(0,19) === value.slice(0,19);
}
function identity(v: {site_id?:unknown;gateway_id?:unknown;device_id?:unknown}, topic: string, prefixes: string[], suffix: string) {
  if (![v.site_id,v.gateway_id,v.device_id].every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s))) throw new Error('Invalid device identity');
  const prefix = `iot/v1/${v.site_id}/${v.gateway_id}`;
  if (!prefixes.includes(prefix) || topic !== `${prefix}/devices/${v.device_id}/${suffix}`) throw new Error('Topic and envelope identity mismatch');
}
export function validateMetrics(metrics: unknown): asserts metrics is Record<string, number> {
  if (!metrics || Array.isArray(metrics) || typeof metrics !== 'object' || Object.keys(metrics).length < 1 || Object.keys(metrics).length > 128 || !Object.entries(metrics).every(([k,n]) => /^[a-z][a-z0-9_]{0,63}$/.test(k) && typeof n === 'number' && Number.isFinite(n))) throw new Error('Invalid numeric metrics');
}
export interface ObservationTimes {
  sample_time_utc: string | null;
  read_time_utc: string | null;
  observation_kind: string;
  time_basis: string;
}
// V1 captured_at was the collector response time, not a device timestamp.
// Keep original bytes/IDs/hashes intact while projecting that distinction into PG.
export function observationTimes(v: Sample): ObservationTimes {
  if (v.quality === 'historical') return {
    sample_time_utc: v.sample_time_utc ?? null, read_time_utc: null,
    observation_kind: v.source?.source_kind === 'user_reference' ? 'user_reference' : 'historical',
    time_basis: v.source?.source_kind === 'user_reference' ? 'user_provided' : v.source_receive_time_utc ? 'source_receive_time' : 'unknown',
  };
  const cached = v.observation_kind === 'gateway_cached_state'
    || v.source?.observation_kind === 'gateway_cached_state'
    || v.source?.driver === 'xiaomi-gateway-v3-temperature';
  if (v.schema_version === 2) return {
    sample_time_utc: v.sample_time_utc ?? null, read_time_utc: v.read_time_utc ?? null,
    observation_kind: cached ? 'gateway_cached_state' : 'direct_read',
    time_basis: v.sample_time_utc ? 'device_sample_time' : cached ? 'gateway_state_read_time' : 'collector_read_time',
  };
  return { sample_time_utc: null, read_time_utc: v.captured_at ?? v.sample_time_utc ?? null,
    observation_kind: cached ? 'gateway_cached_state' : 'direct_read',
    time_basis: cached ? 'gateway_state_read_time' : 'collector_read_time' };
}
export function parseSample(topic: string, bytes: Buffer, prefixes: string[], now = new Date()): RecordRow {
  const payload = utf8(bytes), v = parseJson(payload) as Sample;
  if (!v || typeof v !== 'object' || ![1,2].includes(v.schema_version) || v.quality !== 'ok') throw new Error('Unsupported telemetry envelope');
  if (!isUuid(v.message_id) || (v.collection_id !== undefined && !isUuid(v.collection_id))) throw new Error('Invalid message ID');
  identity(v, topic, prefixes, 'telemetry');
  if (v.schema_version === 1) {
    const sampleTime = v.sample_time_utc ?? v.captured_at;
    if (!utc(sampleTime, now.getTime())) throw new Error('Invalid UTC sample time');
    if (v.sample_time_utc !== undefined && v.captured_at !== undefined && Date.parse(v.sample_time_utc!) !== Date.parse(v.captured_at)) throw new Error('Conflicting sample times');
  } else {
    if (v.captured_at !== undefined || !utc(v.read_time_utc,now.getTime())
      || !['direct_read','gateway_cached_state'].includes(v.observation_kind ?? '')
      || (v.sample_time_utc !== null && !utc(v.sample_time_utc,now.getTime()))) throw new Error('Invalid explicit observation times');
    if (v.sample_time_utc && Date.parse(v.sample_time_utc) > Date.parse(v.read_time_utc!)) throw new Error('Measurement occurs after reading');
  }
  if (v.source !== undefined && (!v.source || typeof v.source !== 'object' || Array.isArray(v.source))) throw new Error('Invalid source metadata');
  validateMetrics(v.metrics);
  return { id: v.message_id, topic, payload, hash: hash(canonical(v)), received_at: now.toISOString(), lineage: v.source ? {source:v.source} : {} };
}
export function parseFrame(topic: string, bytes: Buffer, prefixes: string[], now = Date.now(), retentionDays = 30): FrameRecord {
  const raw = utf8(bytes), v = parseJson(raw) as Record<string,any>;
  if (!v || v.schema_version !== 1 || !isUuid(v.frame_id) || !isUuid(v.collection_id)) throw new Error('Invalid frame envelope');
  identity(v,topic,prefixes,'frames');
  if (!utc(v.frame_time_utc,now) || !['tx','rx'].includes(v.direction) || typeof v.protocol !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(v.protocol) || typeof v.wire_hex !== 'string' || !/^(?:[0-9a-fA-F]{2}){1,8192}$/.test(v.wire_hex) || (v.crc_valid !== undefined && typeof v.crc_valid !== 'boolean')) throw new Error('Invalid protocol frame');
  return { frame_id:v.frame_id,collection_id:v.collection_id,topic,raw_data:raw,raw_data_sha256:hash(raw),frame_time_utc:Date.parse(v.frame_time_utc),receive_time_utc:now,store_time_utc:now,expire_time_utc:now+retentionDays*86400000,site_id:v.site_id,gateway_id:v.gateway_id,device_id:v.device_id,direction:v.direction,protocol:v.protocol,wire_hex:v.wire_hex,...(v.crc_valid===undefined?{}:{crc_valid:v.crc_valid}) };
}
