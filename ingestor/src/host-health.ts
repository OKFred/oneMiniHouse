import { canonical, hash, stableUuid, utf8, utc, type RawRecord, type Sample } from './message.ts';
import type { Processor } from './queue.ts';

export const HOST_HEALTH_PROCESSOR_ID = 'host-health-temperature';
export const HOST_HEALTH_PROCESSOR_VERSION = '1';
export interface HostHealthInput { topic: string; deviceId: string }
const topicPattern = /^iot\/v1\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\/host-health$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = ['schema_version', 'message_id', 'site_id', 'host_id', 'boot_id', 'sequence', 'read_time_utc', 'uptime_seconds', 'metrics', 'conditions', 'actions'];
const metricNames = new Set([
  'memory_total_bytes', 'memory_available_bytes', 'memory_anon_bytes', 'memory_slab_bytes',
  'memory_unreclaimable_slab_bytes', 'memory_shmem_bytes', 'memory_dirty_bytes', 'memory_writeback_bytes',
  'load_1m', 'cpu_iowait_pct', 'blocked_tasks', 'psi_memory_some_avg10_pct', 'psi_io_some_avg10_pct',
  'cpu_temperature_c', 'rootfs_free_bytes', 'rootfs_used_pct', 'datafs_free_bytes', 'datafs_used_pct',
  'proxy_working_set_bytes', 'proxy_rss_bytes',
]);
const conditions = ['memory_pressure', 'io_pressure', 'temperature', 'storage'];
const details = new Set(['none', 'metric_unavailable', 'memory_available_low', 'memory_available_critical', 'io_wait_blocked', 'temperature_high', 'storage_low']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
function fail(): never { throw new Error('Invalid host-health temperature input'); }

export function validateHostHealthInput(value: unknown): asserts value is HostHealthInput {
  if (!object(value) || typeof value.topic !== 'string' || !topicPattern.test(value.topic)
    || typeof value.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.deviceId)) fail();
}

/** JSON.parse accepts duplicate keys. Check decoded keys within each object so
 * an escaped duplicate cannot silently replace a producer identity or metric. */
function strictJson(raw: string): unknown {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const value: unknown = JSON.parse(text);
  let index = 0, nodes = 0;
  const space = () => { while (/\s/.test(text[index] ?? '') && index < text.length) index++; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    return fail();
  };
  const walk = (depth: number): void => {
    if (++nodes > 2048 || depth > 16) fail();
    space();
    if (text[index] === '{') {
      const keys = new Set<string>(); index++; space();
      if (text[index] === '}') { index++; return; }
      for (;;) {
        space(); const key = string(); if (keys.has(key)) fail(); keys.add(key);
        space(); index++; walk(depth + 1); space();
        if (text[index++] === '}') return;
      }
    }
    if (text[index] === '[') {
      index++; space(); if (text[index] === ']') { index++; return; }
      for (;;) { walk(depth + 1); space(); if (text[index++] === ']') return; }
    }
    if (text[index] === '"') { string(); return; }
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index++;
  };
  walk(0); space(); if (index !== text.length) fail();
  return value;
}

interface HostHealth {
  message_id: string; site_id: string; host_id: string; boot_id: string;
  sequence: number; read_time_utc: string; uptime_seconds: number;
  metrics: Record<string, number> & { cpu_temperature_c: number };
}
function decode(input: HostHealthInput, bytes: Buffer, now: number) {
  validateHostHealthInput(input);
  if (bytes.length > 16384 || !Number.isSafeInteger(now) || now < 946684800000) fail();
  const raw = utf8(bytes), value = strictJson(raw), match = topicPattern.exec(input.topic)!;
  if (!object(value) || !exact(value, fields) || value.schema_version !== 1
    || value.site_id !== match[1] || value.host_id !== match[2]
    || !validUuid(value.message_id) || !validUuid(value.boot_id)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
    || !finite(value.uptime_seconds) || value.uptime_seconds < 0 || value.uptime_seconds > Number.MAX_SAFE_INTEGER
    || !utc(value.read_time_utc, now) || Date.parse(value.read_time_utc) > now + 30000
    || !object(value.metrics) || !Object.keys(value.metrics).length || Object.keys(value.metrics).some(key => !metricNames.has(key))) fail();
  for (const [key, number] of Object.entries(value.metrics)) {
    if (!finite(number)) fail();
    // Keep the native Linux thermal sanity boundary; this is not a vendor
    // operating rating. sysfs millidegree conversion belongs to the producer.
    // https://docs.kernel.org/driver-api/thermal/sysfs-api.html
    const [lower, upper] = key === 'cpu_temperature_c' ? [-50, 150] : key.endsWith('_pct') ? [0, 100]
      : key === 'load_1m' ? [0, 1024] : key === 'blocked_tasks' ? [0, 1048576] : [0, Number.MAX_SAFE_INTEGER];
    if (number < lower || number > upper || ((key.endsWith('_bytes') || key === 'blocked_tasks') && !Number.isSafeInteger(number))) fail();
  }
  if (!Object.hasOwn(value.metrics, 'cpu_temperature_c')) fail(); // Missing cannot become zero or a cached reading.
  if (!object(value.conditions) || !exact(value.conditions, conditions)) fail();
  for (const condition of Object.values(value.conditions)) {
    if (!object(condition) || !exact(condition, ['state', 'severity', 'incident_id', 'detail_code'])
      || typeof condition.state !== 'string' || !['good', 'bad', 'unknown'].includes(condition.state)
      || typeof condition.severity !== 'string' || !['warning', 'critical'].includes(condition.severity)
      || typeof condition.detail_code !== 'string' || !details.has(condition.detail_code)
      || (condition.state === 'bad' ? !validUuid(condition.incident_id) : condition.incident_id !== null)) fail();
  }
  if (!Array.isArray(value.actions) || value.actions.length > 8) fail();
  const events = new Set<string>();
  for (const action of value.actions) {
    if (!object(action) || !exact(action, ['event_id', 'action_id', 'incident_id', 'action_time_utc', 'kind', 'result', 'target_id'])
      || !validUuid(action.event_id) || !validUuid(action.action_id) || !validUuid(action.incident_id)
      || !utc(action.action_time_utc, now) || Date.parse(action.action_time_utc) > now + 30000
      || action.kind !== 'restart_proxy' || action.target_id !== 'proxy'
      || typeof action.result !== 'string' || !['claimed', 'succeeded', 'failed', 'uncertain'].includes(action.result) || events.has(action.event_id)) fail();
    events.add(action.event_id);
  }
  return { raw, wire: value as unknown as HostHealth };
}

export function hostHealthRaw(input: HostHealthInput, bytes: Buffer, now = Date.now(), retentionDays = 180): RawRecord {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) fail();
  const { raw, wire } = decode(input, bytes, now);
  return {
    raw_id: stableUuid(`${HOST_HEALTH_PROCESSOR_ID}\n${input.topic}\n${wire.message_id}`),
    topic: input.topic, source_kind: 'mqtt', source_id: `${HOST_HEALTH_PROCESSOR_ID}:${input.deviceId}`,
    source_message_id: wire.message_id, source_site_id: wire.site_id, source_gateway_id: wire.host_id, source_device_id: input.deviceId,
    data_kind: 'inline', content_type: 'application/json', raw_data: raw, raw_data_sha256: hash(bytes),
    generate_time_utc: Date.parse(wire.read_time_utc), receive_time_utc: now, store_time_utc: now, expire_time_utc: now + retentionDays * 86400000,
  };
}

export const hostHealthProcessor: Processor = {
  id: HOST_HEALTH_PROCESSOR_ID, version: HOST_HEALTH_PROCESSOR_VERSION,
  process(raw) {
    const input = { topic: raw.topic, deviceId: raw.source_device_id! };
    const decoded = hostHealthRaw(input, Buffer.from(raw.raw_data), raw.receive_time_utc);
    if (raw.source_kind !== 'mqtt' || raw.source_id !== decoded.source_id || raw.raw_id !== decoded.raw_id
      || raw.raw_data_sha256 !== decoded.raw_data_sha256 || raw.source_message_id !== decoded.source_message_id
      || raw.source_site_id !== decoded.source_site_id || raw.source_gateway_id !== decoded.source_gateway_id
      || raw.generate_time_utc !== decoded.generate_time_utc || raw.data_kind !== 'inline' || raw.content_type !== 'application/json') fail();
    const { wire } = decode(input, Buffer.from(raw.raw_data), raw.receive_time_utc);
    const outputKey = 'cpu_temperature_c';
    const id = stableUuid(`${raw.raw_id}\n${HOST_HEALTH_PROCESSOR_ID}\n${HOST_HEALTH_PROCESSOR_VERSION}\n${outputKey}`);
    const sample: Sample = {
      schema_version: 2, message_id: id, site_id: wire.site_id, gateway_id: wire.host_id, device_id: input.deviceId,
      sample_time_utc: null, read_time_utc: wire.read_time_utc, observation_kind: 'direct_read', quality: 'ok',
      metrics: { cpu_temperature_c: wire.metrics.cpu_temperature_c },
      source: { driver: 'openwrt-host-health', interface: 'linux_thermal', topic: input.topic,
        source_message_id: wire.message_id, boot_id: wire.boot_id, sequence: wire.sequence },
    };
    const payload = canonical(sample);
    return { id, topic: input.topic, payload, hash: hash(payload), received_at: new Date(raw.receive_time_utc).toISOString(),
      output_key: outputKey, lineage: { source: sample.source } };
  },
};
