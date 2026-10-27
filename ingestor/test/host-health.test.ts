import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_HEALTH_PROCESSOR_ID as ID, HOST_HEALTH_PROCESSOR_VERSION as VERSION,
  hostHealthRaw, hostHealthProcessor, validateHostHealthInput, type HostHealthInput } from '../src/host-health.ts';
import { hash, observationTimes, type RawRecord } from '../src/message.ts';
import { Queue, CapacityError, ConflictError } from '../src/queue.ts';

const input: HostHealthInput = { topic: 'iot/v1/example-home/example-router/host-health', deviceId: 'temperature-example-router' };
const now = Date.parse('2026-10-27T06:00:00.000Z');
const messageId = '11111111-2222-4333-8444-555555555555';
function fixture() {
  return { schema_version: 1, message_id: messageId, site_id: 'example-home', host_id: 'example-router',
    boot_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sequence: 4, read_time_utc: '2026-10-27T05:59:00.000Z', uptime_seconds: 7200,
    metrics: { cpu_temperature_c: 42.125, memory_available_bytes: 900000000, memory_total_bytes: 1800000000, cpu_iowait_pct: 0.25 },
    conditions: Object.fromEntries(['memory_pressure', 'io_pressure', 'temperature', 'storage'].map(key => [key,
      { state: 'good', severity: 'warning', incident_id: null, detail_code: 'none' }])) as Record<string, { state: string; severity: string; incident_id: string | null; detail_code: string }>, actions: [] as object[] };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
function raw(value: unknown = fixture()) { return hostHealthRaw(input, encode(value), now, 7); }

test('host-health keeps exact raw bytes, original read time, producer identity and only CPU temperature output', () => {
  const value = fixture();
  value.actions = [{ event_id: 'dddddddd-1111-4222-8333-444444444444', action_id: 'dddddddd-1111-4222-8333-555555555555',
    incident_id: 'dddddddd-1111-4222-8333-666666666666', action_time_utc: '2026-10-27T05:59:00.000Z', kind: 'restart_proxy', result: 'succeeded', target_id: 'proxy' }];
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const r = hostHealthRaw(input, bytes, now, 7), row = hostHealthProcessor.process(r), sample = JSON.parse(row.payload);
  assert.equal(r.raw_data, bytes.toString()); assert.equal(r.raw_data_sha256, hash(bytes));
  assert.equal(r.source_message_id, messageId); assert.equal(r.source_kind, 'mqtt');
  assert.equal(r.generate_time_utc, now - 60000); assert.equal(r.receive_time_utc, now);
  assert.equal(r.expire_time_utc, now + 7 * 86400000);
  assert.equal(sample.schema_version, 2); assert.equal(sample.quality, 'ok');
  assert.deepEqual(sample.metrics, { cpu_temperature_c: 42.125 });
  assert.equal(sample.device_id, input.deviceId); assert.equal(sample.gateway_id, 'example-router');
  assert.equal(sample.source.driver, 'openwrt-host-health'); assert.equal(sample.source.source_message_id, messageId);
  assert.equal(sample.source.boot_id, value.boot_id); assert.equal(sample.source.sequence, 4);
  assert.equal(sample.source.actions, undefined); assert.deepEqual(row.lineage?.source, sample.source);
  assert.equal(row.id, sample.message_id); assert.equal(row.output_key, 'cpu_temperature_c');
  assert.deepEqual(observationTimes(sample), { sample_time_utc: null, read_time_utc: value.read_time_utc,
    observation_kind: 'direct_read', time_basis: 'collector_read_time' });
});

test('host route is one exact topic and never a wildcard or mismatched site/host', () => {
  assert.doesNotThrow(() => validateHostHealthInput({ ...input, clientId: 'example-reader' }));
  for (const bad of [null, {}, { ...input, topic: 'iot/v1/example-home/+/host-health' }, { ...input, topic: input.topic + '/extra' },
    { ...input, topic: 'iot/v1/example-home/example-router/devices/temp/telemetry' }, { ...input, deviceId: '../temperature' }]) {
    assert.throws(() => validateHostHealthInput(bad));
  }
  for (const mutation of [{ site_id: 'another-home' }, { host_id: 'another-router' }]) assert.throws(() => raw({ ...fixture(), ...mutation }));
});

test('CPU range matches native sanity boundary, genuine zero is preserved and unavailable cannot become zero', () => {
  for (const temperature of [-50, 0, 85, 150]) {
    const value = fixture(); value.metrics.cpu_temperature_c = temperature;
    assert.equal(JSON.parse(hostHealthProcessor.process(raw(value)).payload).metrics.cpu_temperature_c, temperature);
  }
  for (const temperature of [-50.001, 150.001, null, true, '42', Infinity, NaN]) {
    const value = fixture() as any; value.metrics.cpu_temperature_c = temperature; assert.throws(() => raw(value));
  }
  const absent = fixture() as any; delete absent.metrics.cpu_temperature_c; assert.throws(() => raw(absent));
  const critical = fixture(); critical.conditions.temperature = { state: 'bad', severity: 'critical', incident_id: 'bbbbbbbb-1111-4222-8333-444444444444', detail_code: 'temperature_high' };
  critical.metrics.cpu_temperature_c = 90;
  assert.equal(JSON.parse(hostHealthProcessor.process(raw(critical)).payload).metrics.cpu_temperature_c, 90);
});

test('original identities are immutable across retries, distinct producer observations stay distinct', () => {
  const first = raw(), later = hostHealthRaw(input, encode(fixture()), now + 10000, 7);
  assert.equal(first.raw_id, later.raw_id); assert.equal(first.raw_data_sha256, later.raw_data_sha256);
  const changed = raw({ ...fixture(), message_id: '11111111-2222-4333-8444-666666666666' });
  assert.notEqual(changed.raw_id, first.raw_id);
  assert.notEqual(hostHealthProcessor.process(changed).id, hostHealthProcessor.process(first).id);
});

test('closed wire rejects duplicate JSON keys, unknown fields, malformed UTF8 and oversized/deep JSON', () => {
  const text = encode(fixture()).toString();
  for (const bytes of [Buffer.from(text.replace('"schema_version":1', '"schema_version":1,"schema_version":1')),
    Buffer.from(text.replace('"cpu_temperature_c":42.125', '"cpu_temperature_c":42.125,"cpu_temperature_\\u0063":43')),
    Buffer.from([255]), Buffer.alloc(16385), Buffer.from('{"schema_version":')]) assert.throws(() => hostHealthRaw(input, bytes, now));
  assert.throws(() => raw({ ...fixture(), quality: 'ok' }));
  assert.throws(() => raw({ ...fixture(), source: { token: 'not-a-real-secret' } }));
  const deep = fixture() as any; deep.actions = JSON.parse('['.repeat(18) + '0' + ']'.repeat(18)); assert.throws(() => raw(deep));
});

test('non-finite, fractional byte counters, invalid state types and action semantics fail validation', () => {
  for (const mutate of [
    (v: any) => { v.metrics.memory_available_bytes = -1; },
    (v: any) => { v.metrics.memory_available_bytes = 1.5; },
    (v: any) => { v.metrics.cpu_iowait_pct = 100.001; },
    (v: any) => { v.metrics.unknown_sensor = 1; },
    (v: any) => { v.conditions.storage.state = ['good']; },
    (v: any) => { v.conditions.storage.severity = ['warning']; },
    (v: any) => { v.conditions.storage.state = 'bad'; },
    (v: any) => { v.conditions.storage.incident_id = messageId; },
    (v: any) => { delete v.conditions.storage; },
    (v: any) => { v.conditions.storage.detail_code = 'arbitrary text'; },
    (v: any) => { v.actions = [{ command: 'not-a-command' }]; },
  ]) { const value = fixture(); mutate(value); assert.throws(() => raw(value)); }
});

test('future and malformed clocks fail, delayed source samples keep their old UTC time', () => {
  for (const mutation of [{ read_time_utc: '2026-10-27T06:00:30.001Z' }, { read_time_utc: '2026-10-27T06:00:00+00:00' },
    { read_time_utc: '2026-02-30T00:00:00Z' }, { uptime_seconds: -1 }, { sequence: 0 }, { sequence: 1.5 },
    { message_id: 'not-a-uuid' }, { boot_id: 'not-a-boot' }]) assert.throws(() => raw({ ...fixture(), ...mutation }));
  const old = fixture(); old.read_time_utc = '2026-10-26T22:00:00.000Z';
  assert.equal(JSON.parse(hostHealthProcessor.process(raw(old)).payload).read_time_utc, old.read_time_utc);
});

test('processor verifies all stored raw provenance before producing telemetry', () => {
  const original = raw();
  for (const mutation of [{ source_kind: 'http' }, { source_id: 'another-source' }, { raw_id: messageId },
    { raw_data_sha256: '0'.repeat(64) }, { source_message_id: '11111111-2222-4333-8444-666666666666' },
    { source_site_id: 'another-home' }, { source_gateway_id: 'another-router' }, { source_device_id: undefined },
    { generate_time_utc: now }, { data_kind: 'object_ref' }, { content_type: 'text/plain' }]) {
    assert.throws(() => hostHealthProcessor.process({ ...original, ...mutation } as RawRecord));
  }
});

test('persistent queue restart, duplicate replay and independent PG acknowledgments preserve CPU sample and raw archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-health-test-')), path = join(dir, 'inbox.sqlite');
  const options = { maxPending: 10, maxRejected: 10, rawMirror: true };
  let queue = new Queue(path, options, [hostHealthProcessor]);
  try {
    const source = raw(); assert.equal(queue.acceptRaw(source, ID, VERSION), 'saved');
    const local = queue.next('local')!, cloud = queue.next('supabase')!;
    assert.deepEqual(cloud, local); assert.deepEqual(JSON.parse(local.payload).metrics, { cpu_temperature_c: 42.125 });
    assert.deepEqual({ ...queue.nextRaw() }, source);
    queue.done('local', local.id); queue.close(); queue = new Queue(path, options, [hostHealthProcessor]);
    assert.equal(queue.acceptRaw(source, ID, VERSION), 'duplicate'); assert.equal(queue.next('local'), undefined);
    assert.deepEqual(queue.next('supabase'), cloud);
    queue.replay(source.raw_id, ID, VERSION); assert.deepEqual(queue.next('supabase'), cloud);
    assert.equal(queue.next('local'), undefined); assert.equal(queue.stats().processing_failed, 0);
    const altered = fixture(); altered.metrics.cpu_temperature_c = 43;
    assert.throws(() => queue.acceptRaw(raw(altered), ID, VERSION), ConflictError);
    assert.deepEqual(queue.next('supabase'), cloud);
  } finally { queue.close(); rmSync(dir, { recursive: true }); }
});

test('durable queue capacity errors remain fatal to intake instead of acknowledging a lost host sample', () => {
  const queue = new Queue(':memory:', { maxPending: 1, maxRejected: 10 }, [hostHealthProcessor]);
  try {
    assert.equal(queue.acceptRaw(raw(), ID, VERSION), 'saved');
    assert.throws(() => queue.acceptRaw(raw({ ...fixture(), message_id: '11111111-2222-4333-8444-777777777777' }), ID, VERSION), CapacityError);
    assert.equal(queue.stats().raw_records, 1); assert.equal(queue.acceptRaw(raw(), ID, VERSION), 'duplicate');
  } finally { queue.close(); }
});
