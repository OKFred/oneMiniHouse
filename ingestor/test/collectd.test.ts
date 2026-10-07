import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, CapacityError } from '../src/queue.ts';
import { receive } from '../src/intake.ts';
import { collectdRaw, parseCollectdTemperature, type CollectdTemperatureInput } from '../src/collectd.ts';
import { hash, observationTimes } from '../src/message.ts';
import { mqttSubscriptions, mqttUnsubscriptions, validateConfig } from '../src/config.ts';

const base = 'iot/v1/example-home/example-router/collectd/example-home';
const routes: CollectdTemperatureInput[] = [
  { topic: `${base}/thermal-thermal_zone0/temperature`, deviceId: 'temperature-router', metric: 'cpu_temperature_c' },
  { topic: `${base}/thermal-thermal_zone1/temperature`, deviceId: 'temperature-router', metric: 'gpu_temperature_c' },
];
const now = 1790521120000;
const bytes = Buffer.from('1790521056.861:45.625\0');

test('real collectd NUL fixture retains bytes and distinguishes source read from receive time', () => {
  const raw = collectdRaw(routes[0], bytes, now);
  assert.equal(raw.raw_data, bytes.toString());
  assert.equal(raw.raw_data_sha256, hash(bytes));
  assert.equal(raw.generate_time_utc, 1790521056861);
  assert.equal(raw.receive_time_utc - raw.generate_time_utc!, 63139);
  assert.equal(raw.source_kind, 'mqtt');
  const queue = new Queue(':memory:', { maxPending: 10, maxRejected: 10, rawMirror: true });
  try {
    queue.acceptRaw(raw, 'collectd-temperature', '1');
    const result = queue.next('local')!;
    const sample = JSON.parse(result.payload);
    assert.equal(result.id, sample.message_id);
    assert.equal(result.received_at, new Date(now).toISOString());
    assert.deepEqual(sample.metrics, { cpu_temperature_c: 45.625 });
    assert.equal(sample.gateway_id, 'example-router');
    assert.deepEqual(observationTimes(sample), { sample_time_utc: null, read_time_utc: new Date(1790521056861).toISOString(), observation_kind: 'direct_read', time_basis: 'collector_read_time' });
    assert.deepEqual(queue.next('supabase'), result);
    assert.deepEqual({ ...queue.nextRaw() }, raw);
  } finally { queue.close(); }
});

test('native collectd restart/replay/dedup preserves independent channels and sink acknowledgments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collectd-test-')), path = join(dir, 'inbox.sqlite');
  const options = { maxPending: 10, maxRejected: 10, rawMirror: true };
  let queue = new Queue(path, options);
  try {
    for (const input of routes) assert.equal(receive(queue, input.topic, bytes, [], routes), 'saved');
    const cpuRaw = collectdRaw(routes[0], bytes);
    queue.close(); queue = new Queue(path, options);
    const rows = queue.nextBatch('local');
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.deepEqual(rows.map(r => Object.keys(JSON.parse(r.payload).metrics)), [['cpu_temperature_c'], ['gpu_temperature_c']]);
    queue.done('local', rows[0].id);
    for (const input of routes) assert.equal(receive(queue, input.topic, bytes, [], routes), 'duplicate');
    queue.close(); queue = new Queue(path, options);
    queue.replay(cpuRaw.raw_id, 'collectd-temperature', '1');
    assert.deepEqual(queue.nextBatch('supabase'), rows);
    assert.deepEqual(queue.nextBatch('local'), [rows[1]]);
    assert.equal(queue.getRaw(cpuRaw.raw_id)!.raw_data, bytes.toString());
    assert.equal(queue.stats().processing_failed, 0);
    // Same topic/time with different value is never a second valid observation.
    assert.equal(receive(queue, routes[0].topic, Buffer.from('1790521056.861:50\0'), [], routes), 'rejected');
    assert.deepEqual(queue.nextBatch('supabase'), rows);
  } finally { queue.close(); rmSync(dir, { recursive: true }); }
});

test('bad values, multi-values, corrupt UTF8, clocks and unconfigured topics cannot turn into zero telemetry', () => {
  for (const body of ['1790521056.861:nan\0', '1790521056.861:inf', '1790521056.861:1:2', '1790521056.861:12\0\0', '1790521056.861:999', '1790521056.861:-274', '1:12', '99999999999:12', '1790521056.8612:12', '']) {
    assert.throws(() => parseCollectdTemperature(Buffer.from(body), now));
  }
  assert.throws(() => parseCollectdTemperature(Buffer.from([255]), now));
  assert.throws(() => parseCollectdTemperature(Buffer.alloc(1025), now));
  assert.equal(parseCollectdTemperature(Buffer.from('1790521056.861:0\0'), now).temperature, 0);
  const queue = new Queue(':memory:', { maxPending: 100, maxRejected: 10 });
  try {
    assert.equal(receive(queue, routes[0].topic, Buffer.from('1790521056.861:nan\0'), [], routes), 'rejected');
    assert.equal(receive(queue, routes[0].topic, bytes, []), 'rejected');
    assert.equal(queue.next('local'), undefined);
    assert.equal(queue.next('supabase'), undefined);
  } finally { queue.close(); }
});

test('collectd durable capacity failures propagate so MQTT cannot acknowledge lost records', () => {
  const queue = new Queue(':memory:', { maxPending: 1, maxRejected: 10, rawMirror: true });
  try {
    assert.equal(receive(queue, routes[0].topic, bytes, [], routes), 'saved');
    assert.throws(() => receive(queue, routes[1].topic, bytes, [], routes), CapacityError);
    assert.equal(queue.stats().raw_records, 1);
    assert.equal(receive(queue, routes[0].topic, bytes, [], routes), 'duplicate');
  } finally { queue.close(); }
});

test('native subscriptions stay exact and cannot accidentally request unauthorized gateway topics', () => {
  const config = JSON.parse(readFileSync(new URL('../config/ingestor.example.json', import.meta.url), 'utf8'));
  const subscriptions = mqttSubscriptions(validateConfig(config));
  assert.equal(subscriptions.length, 6);
  assert.deepEqual(subscriptions.slice(-2), routes.map(r => r.topic));
  assert.ok(!subscriptions.some(topic => topic.includes('/example-router/devices/')));
  assert.throws(() => validateConfig({ ...config, collectdTemperatures: [routes[0], routes[0]] }));
  assert.throws(() => validateConfig({ ...config, collectdTemperatures: [{ ...routes[0], topic: base + '/#' }] }));
  assert.throws(() => validateConfig({ ...config, collectdTemperatures: [{ ...routes[0], metric: 'temperature' }] }));
  delete config.collectdTemperatures;
  assert.equal(mqttSubscriptions(validateConfig(config)).length, 4);
});

test('omitting frame prefixes retains telemetry and frame subscriptions for every gateway', () => {
  const config = JSON.parse(readFileSync(new URL('../config/ingestor.example.json', import.meta.url), 'utf8'));
  delete config.mqtt.frameTopicPrefixes;
  const prefixes = config.mqtt.topicPrefixes as string[];
  assert.deepEqual(mqttSubscriptions(validateConfig(config)), [
    ...prefixes.map(p => `${p}/devices/+/telemetry`),
    ...prefixes.map(p => `${p}/devices/+/frames`),
    ...routes.map(r => r.topic),
  ]);
  assert.deepEqual(mqttUnsubscriptions(validateConfig(config)), []);
});

test('frame subset frees unused durable filters while retaining all telemetry and exact collectd routes', () => {
  const config = JSON.parse(readFileSync(new URL('../config/ingestor.example.json', import.meta.url), 'utf8'));
  const frames = [...config.mqtt.topicPrefixes] as string[];
  const hosts = ['host-a', 'host-b', 'host-c'].map(host => `iot/v1/example-home/${host}`);
  config.mqtt.topicPrefixes.push(...hosts);
  config.mqtt.frameTopicPrefixes = frames;
  const validated = validateConfig(config);
  const subscriptions = mqttSubscriptions(validated);
  assert.equal(subscriptions.length, 9);
  assert.deepEqual(subscriptions, [
    ...config.mqtt.topicPrefixes.map((p: string) => `${p}/devices/+/telemetry`),
    ...frames.map(p => `${p}/devices/+/frames`),
    ...routes.map(r => r.topic),
  ]);
  const removed = mqttUnsubscriptions(validated);
  assert.deepEqual(removed, hosts.map(p => `${p}/devices/+/frames`));
  assert.ok(removed.every(topic => !subscriptions.includes(topic)));
});

test('empty frame prefixes disable only frame subscriptions', () => {
  const config = JSON.parse(readFileSync(new URL('../config/ingestor.example.json', import.meta.url), 'utf8'));
  config.mqtt.frameTopicPrefixes = [];
  const validated = validateConfig(config);
  assert.deepEqual(mqttSubscriptions(validated), [
    ...config.mqtt.topicPrefixes.map((p: string) => `${p}/devices/+/telemetry`),
    ...routes.map(r => r.topic),
  ]);
  assert.deepEqual(mqttUnsubscriptions(validated), config.mqtt.topicPrefixes.map((p: string) => `${p}/devices/+/frames`));
});

test('frame prefixes reject malformed, duplicate and outside-scope values', () => {
  const config = JSON.parse(readFileSync(new URL('../config/ingestor.example.json', import.meta.url), 'utf8'));
  const first = config.mqtt.topicPrefixes[0];
  for (const frameTopicPrefixes of [null, first, {}, [0], [''], ['iot/#'], [first, first], ['iot/v1/example-home/unconfigured']]) {
    assert.throws(() => validateConfig({ ...config, mqtt: { ...config.mqtt, frameTopicPrefixes } }), /Invalid frame topic prefixes/);
  }
});
