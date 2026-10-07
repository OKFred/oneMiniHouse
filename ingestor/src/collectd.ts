import { canonical, hash, stableUuid, utf8, type RawRecord, type Sample } from './message.ts';
import type { Processor } from './queue.ts';

export const COLLECTD_PROCESSOR_ID = 'collectd-temperature';
export const COLLECTD_PROCESSOR_VERSION = '1';
const metrics = ['cpu_temperature_c', 'gpu_temperature_c', 'ddr_temperature_c', 'cpu_package_temperature_c'] as const;
export interface CollectdTemperatureInput {
  topic: string;
  deviceId: string;
  metric: typeof metrics[number];
}
const topicPattern = /^iot\/v1\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/collectd\/([A-Za-z0-9_.-]{1,128})\/(thermal-[A-Za-z0-9_.-]{1,128})\/temperature$/;
export function validateCollectdInput(value: unknown): asserts value is CollectdTemperatureInput {
  const v = value as CollectdTemperatureInput | null;
  if (!v || typeof v.topic !== 'string' || !topicPattern.test(v.topic)
    || typeof v.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.deviceId)
    || !metrics.includes(v.metric)) throw new Error('Invalid collectd temperature route');
}
// collectd 5.12 mqtt publishes format_values text, including its terminating NUL.
// Only the parser removes that terminator; the durable raw archive retains every byte.
export function parseCollectdTemperature(bytes: Buffer, now = Date.now()) {
  if (bytes.length > 1024) throw new Error('Collectd temperature payload too large');
  const raw = utf8(bytes), value = raw.endsWith('\0') ? raw.slice(0, -1) : raw;
  const match = /^(\d{1,11})(?:\.(\d{1,3}))?:(-?(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?)$/.exec(value);
  if (!match) throw new Error('Invalid collectd temperature payload');
  const readTime = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  const temperature = Number(match[3]);
  if (!Number.isSafeInteger(readTime) || readTime < 946684800000 || readTime > now + 300000
    || !Number.isFinite(temperature) || temperature < -273.15 || temperature > 300) throw new Error('Invalid collectd time or temperature');
  return { raw, readTime, temperature };
}
export function collectdRaw(input: CollectdTemperatureInput, bytes: Buffer, now = Date.now(), retentionDays = 180): RawRecord {
  validateCollectdInput(input);
  const { raw, readTime } = parseCollectdTemperature(bytes, now);
  const [, site, gateway] = topicPattern.exec(input.topic)!;
  return {
    // A channel/time is one observation; conflicting values are quarantined, not counted twice.
    raw_id: stableUuid(`${COLLECTD_PROCESSOR_ID}\n${input.topic}\n${readTime}`),
    topic: input.topic, source_kind: 'mqtt', source_id: `${COLLECTD_PROCESSOR_ID}:${input.metric}`,
    source_message_id: null, source_site_id: site, source_gateway_id: gateway, source_device_id: input.deviceId,
    data_kind: 'inline', content_type: 'text/plain', raw_data: raw, raw_data_sha256: hash(bytes),
    generate_time_utc: readTime, receive_time_utc: now, store_time_utc: now, expire_time_utc: now + retentionDays * 86400000,
  };
}
export const collectdTemperatureProcessor: Processor = {
  id: COLLECTD_PROCESSOR_ID, version: COLLECTD_PROCESSOR_VERSION,
  process(raw) {
    const input = { topic: raw.topic, deviceId: raw.source_device_id!, metric: raw.source_id.slice(COLLECTD_PROCESSOR_ID.length + 1) } as CollectdTemperatureInput;
    validateCollectdInput(input);
    const decoded = collectdRaw(input, Buffer.from(raw.raw_data), raw.receive_time_utc);
    if (raw.source_kind !== 'mqtt' || raw.source_id !== decoded.source_id || raw.raw_id !== decoded.raw_id
      || raw.raw_data_sha256 !== decoded.raw_data_sha256 || raw.source_site_id !== decoded.source_site_id
      || raw.source_gateway_id !== decoded.source_gateway_id || raw.generate_time_utc !== decoded.generate_time_utc) throw new Error('Collectd raw identity or hash mismatch');
    const { temperature, readTime } = parseCollectdTemperature(Buffer.from(raw.raw_data), raw.receive_time_utc);
    const outputKey = input.metric;
    const id = stableUuid(`${raw.raw_id}\n${COLLECTD_PROCESSOR_ID}\n${COLLECTD_PROCESSOR_VERSION}\n${outputKey}`);
    const sample: Sample = {
      schema_version: 2, message_id: id, site_id: raw.source_site_id!, gateway_id: raw.source_gateway_id!, device_id: input.deviceId,
      sample_time_utc: null, read_time_utc: new Date(readTime).toISOString(), observation_kind: 'direct_read', quality: 'ok',
      metrics: { [input.metric]: temperature }, source: { driver: 'collectd-temperature', interface: 'linux_thermal', topic: raw.topic },
    };
    const payload = canonical(sample);
    return { id, topic: raw.topic, payload, hash: hash(payload), received_at: new Date(raw.receive_time_utc).toISOString(),
      output_key: outputKey, lineage: { source: sample.source } };
  },
};
