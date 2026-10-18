import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusinessHealth } from '../src/business-health.ts';
import { Queue } from '../src/queue.ts';
import { receive } from '../src/intake.ts';
import { parseSample, stableUuid, type Sample } from '../src/message.ts';
import { collectdRaw, collectdTemperatureProcessor, type CollectdTemperatureInput } from '../src/collectd.ts';

const baseline = Date.parse('2026-01-01T00:00:00Z');
const iso = (offset: number) => new Date(baseline + offset).toISOString();
const topic = 'iot/v1/example-home/example-gateway/devices/example-sensor/telemetry';
const key = 'example-home/example-gateway/example-sensor';
function sample(offset = 0, override: Partial<Sample> = {}): Sample {
  return { schema_version: 2, message_id: stableUuid(`business-${offset}`), site_id: 'example-home', gateway_id: 'example-gateway',
    device_id: 'example-sensor', read_time_utc: iso(offset), sample_time_utc: null, observation_kind: 'direct_read',
    quality: 'ok', metrics: { temperature_c: 25, humidity_pct: 50 }, ...override };
}
function fixture(options: { maxDevices?: number; maxBytes?: number; lagMs?: () => number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'business-health-'));
  const file = join(directory, 'state.json'); let time = baseline + 1000;
  const health = new BusinessHealth(file, { now: () => time, lagMs: () => 12.5, dataDir: directory, tempDir: directory, ...options });
  const save = (value: Sample, result: 'saved' | 'duplicate' | 'rejected' = 'saved', receivedAt = time) =>
    health.observeAccepted(result, topic, Buffer.from(JSON.stringify(value)), [], receivedAt);
  return { directory, file, health, save, now: () => time, setTime: (value: number) => { time = baseline + value; },
    device: () => health.snapshot().devices[key], async close() { await health.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('accepted telemetry distinguishes receipt, collection and actual sample; duplicates and old replay cannot recover validity', async () => {
  const f = fixture();
  try {
    f.save(sample());
    assert.equal(f.device().last_received_time_utc, iso(1000));
    assert.equal(f.device().last_collect_time_utc, iso(0));
    assert.equal(f.device().last_valid_time_utc, iso(0));
    assert.equal(f.device().last_sample_time_utc, null);
    f.setTime(121000);
    const current = sample(120000, { sample_time_utc: iso(119000) }); f.save(current);
    assert.equal(f.device().last_sample_time_utc, iso(119000));
    assert.equal(f.device().last_valid_sample_time_utc, iso(119000));
    const before = f.device();
    f.save(sample(120000), 'duplicate'); f.save(sample(120000), 'rejected');
    f.health.observeAccepted('saved', topic.replace('/telemetry', '/frames'), Buffer.from('{}'));
    assert.deepEqual(f.device(), before);
    f.setTime(181000); f.save(sample(60000));
    assert.equal(f.device().last_received_time_utc, iso(181000));
    assert.equal(f.device().last_collect_time_utc, iso(120000));
    assert.equal(f.device().last_valid_time_utc, iso(120000));
    assert.equal(f.device().consecutive_invalid_samples, 0);
  } finally { await f.close(); }
});

test('Xiaomi official quality ranges drive streaks without turning cached polls into actual measurements', async () => {
  const f = fixture();
  const source = { driver: 'xiaomi-gateway-v3-temperature', sensor_model: 'WSDCGQ01LM', unrelated_secret: 'must-not-persist' };
  const cached = (offset: number, metrics: Record<string, number>) => sample(offset, { observation_kind: 'gateway_cached_state', source, metrics });
  try {
    f.save(cached(0, { temperature_c: 25, humidity_pct: 50 }));
    f.setTime(61000); f.save(cached(60000, { temperature_c: 100, humidity_pct: 0 }));
    assert.deepEqual(f.device().last_invalid_metrics, ['humidity_pct', 'temperature_c']);
    assert.equal(f.device().consecutive_invalid_samples, 1);
    assert.equal(f.device().last_valid_time_utc, iso(0));
    f.setTime(121000); f.save(cached(120000, { temperature_c: 100, humidity_pct: 50 }));
    assert.deepEqual(f.device().last_invalid_metrics, ['temperature_c']);
    assert.equal(f.device().consecutive_invalid_samples, 2);
    f.save(cached(30000, { temperature_c: 20, humidity_pct: 40 }));
    assert.equal(f.device().consecutive_invalid_samples, 2);
    f.setTime(181000); f.save(cached(180000, { temperature_c: 25, humidity_pct: 50 }));
    assert.equal(f.device().consecutive_invalid_samples, 0);
    assert.equal(f.device().last_valid_time_utc, iso(180000));
    assert.equal(f.device().last_sample_time_utc, null);
    assert.equal(f.device().last_valid_sample_time_utc, null);
    assert.equal(f.device().observation_kind, 'gateway_cached_state');
    assert.ok(!JSON.stringify(f.health.snapshot()).includes('must-not-persist'));
  } finally { await f.close(); }
});

test('existing processed metric lineage is authoritative; partial valid metrics do not hide invalid ones', async () => {
  const f = fixture();
  try {
    const row = parseSample(topic, Buffer.from(JSON.stringify(sample())), ['iot/v1/example-home/example-gateway'], new Date(f.now()));
    row.lineage = { metric_quality: { metrics: { humidity_pct: { status: 'out_of_spec' }, temperature_c: { status: 'ok' } } } };
    f.health.observe(row);
    assert.equal(f.device().consecutive_invalid_samples, 1);
    assert.deepEqual(f.device().last_invalid_metrics, ['humidity_pct']);
    assert.equal(f.device().last_valid_time_utc, null);
    f.health.observe(row);
    assert.equal(f.device().consecutive_invalid_samples, 1);
    const old = { ...row, payload: JSON.stringify({ ...sample(-60000), quality: 'historical' }) };
    f.health.observe(old); assert.equal(f.device().consecutive_invalid_samples, 1);
  } finally { await f.close(); }
});

test('collectd uses its existing normalization and source time, not arrival time', async () => {
  const f = fixture();
  const input: CollectdTemperatureInput = { topic: 'iot/v1/example-home/example-gateway/collectd/example-host/thermal-cpu/temperature', deviceId: 'example-sensor', metric: 'cpu_temperature_c' };
  try {
    const bytes = Buffer.from(`${baseline / 1000}:42.5\0`);
    const row = collectdTemperatureProcessor.process(collectdRaw(input, bytes, f.now()));
    const expected = JSON.parse(row.payload) as Sample;
    f.health.observeAccepted('saved', input.topic, bytes, [input]);
    assert.equal(f.device().last_collect_time_utc, expected.read_time_utc);
    assert.equal(f.device().last_sample_time_utc, null);
    assert.equal(f.device().consecutive_invalid_samples, 0);
    f.setTime(60000); f.health.observeAccepted('duplicate', input.topic, bytes, [input]);
    assert.equal(f.device().last_received_time_utc, iso(1000));
  } finally { await f.close(); }
});

test('future timestamps cannot poison watermarks, and a later real observation restores clock status', async () => {
  const f = fixture();
  try {
    f.save(sample(120000));
    assert.equal(f.device().clock_invalid, true);
    assert.equal(f.device().last_collect_time_utc, null);
    assert.equal(f.device().last_valid_time_utc, null);
    f.setTime(61000); f.save(sample(60000));
    assert.equal(f.device().clock_invalid, false);
    assert.equal(f.device().last_valid_time_utc, iso(60000));
    assert.equal(f.device().consecutive_invalid_samples, 0);
  } finally { await f.close(); }
});

test('repeated actual samples still advance valid polls; unknown-to-known timestamps use independent watermarks', async () => {
  const f = fixture();
  try {
    f.save(sample());
    f.setTime(61000); f.save(sample(60000, { sample_time_utc: iso(-1000) }));
    assert.equal(f.device().last_valid_time_utc, iso(60000));
    assert.equal(f.device().last_valid_sample_time_utc, iso(-1000));
    f.setTime(121000); f.save(sample(120000, { sample_time_utc: iso(-1000) }));
    assert.equal(f.device().last_valid_time_utc, iso(120000));
    assert.equal(f.device().last_valid_sample_time_utc, iso(-1000));
    f.setTime(181000); f.save(sample(180000, { sample_time_utc: iso(-2000) }));
    assert.equal(f.device().last_collect_time_utc, iso(180000));
    assert.equal(f.device().last_valid_time_utc, iso(120000));
    assert.equal(f.device().last_sample_time_utc, iso(-1000));
  } finally { await f.close(); }
});

test('event-loop peak survives the supervisor polling interval and expires from its bounded window', async () => {
  let lag = 1500;
  const f = fixture({ lagMs: () => lag });
  try {
    assert.equal(f.health.snapshot().event_loop_lag_ms, 1500);
    lag = 2; f.setTime(59000);
    assert.equal(f.health.snapshot().event_loop_lag_ms, 1500);
    assert.equal(f.health.snapshot().event_loop_lag_window_seconds, 60);
    f.setTime(61000);
    assert.equal(f.health.snapshot().event_loop_lag_ms, 2);
  } finally { await f.close(); }
});

test('atomic bounded metadata survives restart with new runtime identity and original source-time watermarks', async () => {
  const f = fixture();
  try {
    f.save(sample(0));
    f.health.publishHealth({ heartbeat_time_utc: iso(1000), business_health: f.health.snapshot() }); await f.health.settled();
    const saved = readFileSync(f.file, 'utf8');
    assert.ok(!saved.includes('temperature_c')); assert.ok(!saved.includes('message_id')); assert.ok(!saved.includes('metrics":{'));
    const exported = JSON.parse(readFileSync(join(f.directory, 'monitor', 'health.json'), 'utf8'));
    assert.equal(exported.business_health.schema_version, 1);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(f.directory, 'monitor')).mode & 0o777, 0o755);
      assert.equal(statSync(join(f.directory, 'monitor', 'health.json')).mode & 0o777, 0o644);
    }
    const restored = new BusinessHealth(f.file, { now: () => baseline + 121000, lagMs: () => 0 });
    try {
      assert.deepEqual(restored.snapshot().devices[key], f.device());
      assert.equal(restored.snapshot().runtime_start_time_utc, iso(121000));
      restored.observeAccepted('saved', topic, Buffer.from(JSON.stringify(sample(-60000))), [], baseline + 121000);
      assert.equal(restored.snapshot().devices[key].last_valid_time_utc, iso(0));
    } finally { await restored.close(); }
  } finally { await f.close(); }
});

test('monitor persistence/export failures cannot roll back intake; storage probes report unknown instead of zero', async () => {
  const f = fixture(); const queue = new Queue(join(f.directory, 'queue.sqlite'), { maxPending: 100, maxRejected: 10 });
  writeFileSync(join(f.directory, 'blocked'), 'file-not-directory');
  const health = new BusinessHealth(join(f.directory, 'blocked', 'state.json'), { now: f.now, lagMs: () => 0, dataDir: join(f.directory, 'blocked'), tempDir: join(f.directory, 'missing-temp') });
  try {
    const bytes = Buffer.from(JSON.stringify(sample()));
    const result = receive(queue, topic, bytes, ['iot/v1/example-home/example-gateway']);
    assert.equal(result, 'saved');
    assert.doesNotThrow(() => health.observeAccepted(result, topic, bytes));
    health.publishHealth({ business_health: health.snapshot() }); await health.settled();
    assert.equal(queue.stats().raw_records, 1);
    assert.equal(queue.getRaw(sample().message_id)?.raw_data, bytes.toString());
    assert.equal(health.snapshot().persistence_error, 'STATE_PERSIST_FAILED');
    assert.equal(health.snapshot().export_error, 'HEALTH_EXPORT_FAILED');
    assert.equal(health.snapshot().storage.temp_free_bytes, null);
    assert.equal(health.snapshot().storage.error, 'STORAGE_PROBE_FAILED');
    assert.equal(health.snapshot().devices[key].last_valid_time_utc, iso(0));
  } finally { queue.close(); await health.close(); await f.close(); }
});

test('oversized export does not block independent state persistence or graceful final-state flush', async () => {
  const f = fixture();
  try {
    f.save(sample());
    f.health.publishHealth({ oversized: 'x'.repeat(65536) }); await f.health.settled();
    assert.equal(f.health.snapshot().export_error, 'HEALTH_EXPORT_CAPACITY');
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).devices[key].last_valid_time_utc, iso(0));
    f.setTime(61000); f.save(sample(60000));
    await f.health.close();
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).devices[key].last_valid_time_utc, iso(60000));
  } finally { await f.close(); }
});

test('capacity, corrupt persisted state and lag reader errors are visible without exposing input payloads', async () => {
  const f = fixture({ maxDevices: 1, lagMs: () => { throw new Error('private-details'); } });
  try {
    f.save(sample());
    const other = sample(0, { device_id: 'another-sensor' });
    f.health.observeAccepted('saved', topic.replace('example-sensor', 'another-sensor'), Buffer.from(JSON.stringify(other)), [], f.now());
    assert.equal(Object.keys(f.health.snapshot().devices).length, 1);
    assert.equal(f.health.snapshot().event_loop_lag_ms, null);
    assert.ok(!JSON.stringify(f.health.snapshot()).includes('private-details'));
    writeFileSync(f.file, JSON.stringify({ schema_version: 1, devices: { [key]: { ...f.device(), last_collect_time_utc: iso(999999), payload: 'must-not-export' } } }));
    const restored = new BusinessHealth(f.file, { now: f.now, lagMs: () => 0 });
    try {
      assert.equal(restored.snapshot().monitor_error, 'STATE_RESTORE_FAILED');
      assert.deepEqual(restored.snapshot().devices, {});
      assert.ok(!JSON.stringify(restored.snapshot()).includes('must-not-export'));
    } finally { await restored.close(); }
  } finally { await f.close(); }
});
