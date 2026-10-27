import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MqttClient, IClientOptions, IPublishPacket } from 'mqtt';
import { mqttConnectionPlans, mqttSubscriptions, validateConfig, type Config } from '../src/config.ts';
import { MqttConnections, receiveConnectionMessage, observeConnectionMessage } from '../src/mqtt-connections.ts';
import { Queue, ConflictError } from '../src/queue.ts';
import { receive } from '../src/intake.ts';
import { BusinessHealth } from '../src/business-health.ts';

const example = () => JSON.parse(readFileSync(new URL('../config/ingestor.example.json', import.meta.url), 'utf8'));
const prefix = (host: string) => `iot/v1/example-home/${host}`;
function extended() {
  const config = example();
  config.mqtt.frameTopicPrefixes = [...config.mqtt.topicPrefixes];
  config.mqtt.topicPrefixes.push(...['old-a', 'old-b', 'old-c', 'old-d'].map(prefix));
  const added = ['new-a', 'new-b', 'new-c'].map(prefix);
  config.mqtt.topicPrefixes.push(...added);
  config.mqtt.telemetryClients = [{ clientId: 'example-ingestor-extra', topicPrefixes: added }];
  return config;
}
test('legacy configuration retains its one durable identity and exact existing filters', () => {
  const config = validateConfig(example()), plans = mqttConnectionPlans(config);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].clientId, config.mqtt.clientId);
  assert.deepEqual(plans[0].subscriptions, mqttSubscriptions(config));
  assert.deepEqual(plans[0].unsubscriptions, []);
});
test('synthetic MQTT extension merges into the standard config with explicit frame routing', () => {
  const extension = JSON.parse(readFileSync(new URL('../config/mqtt-telemetry-clients.example.json', import.meta.url), 'utf8'));
  const config = validateConfig({ ...example(), ...extension });
  assert.deepEqual(mqttConnectionPlans(config).map(plan => plan.subscriptions.length), [6, 3]);
});
test('ten existing subscriptions stay on primary and only three new telemetry filters use the second connection', () => {
  const config = validateConfig(extended()), [primary, additional] = mqttConnectionPlans(config);
  assert.equal(primary.subscriptions.length, 10);
  assert.equal(additional.subscriptions.length, 3);
  assert.ok(primary.subscriptions.includes(config.collectdTemperatures![0].topic));
  assert.ok(primary.subscriptions.includes(config.mqtt.frameTopicPrefixes![0] + '/devices/+/frames'));
  assert.ok(additional.subscriptions.every(topic => topic.endsWith('/telemetry')));
  assert.ok(additional.subscriptions.every(topic => primary.unsubscriptions.includes(topic)));
  assert.deepEqual(additional.unsubscriptions, primary.subscriptions);
  assert.equal(new Set([...primary.subscriptions, ...additional.subscriptions]).size, 13);
  assert.deepEqual(primary.topicPrefixes, config.mqtt.topicPrefixes.slice(0, 6));
});
test('reassigning a known telemetry prefix removes the stale filter from the previous secondary session', () => {
  const config = extended();
  const original = config.mqtt.telemetryClients[0].topicPrefixes.pop();
  config.collectdTemperatures.pop(); // Leave a primary subscription slot for the returning source.
  const [primary, additional] = mqttConnectionPlans(validateConfig(config));
  const filter = original + '/devices/+/telemetry';
  assert.ok(primary.subscriptions.includes(filter));
  assert.ok(additional.unsubscriptions.includes(filter));
  assert.ok(!additional.subscriptions.includes(filter));
  assert.ok(!primary.unsubscriptions.includes(filter));
});
test('configuration rejects client collisions, duplicate assignments, unknown prefixes and per-connection overflow', () => {
  for (const change of [
    (c: any) => { c.mqtt.telemetryClients = null; },
    (c: any) => { c.mqtt.telemetryClients[0].clientId = c.mqtt.clientId; },
    (c: any) => { c.mqtt.telemetryClients.push({ ...c.mqtt.telemetryClients[0] }); },
    (c: any) => { c.mqtt.telemetryClients[0].topicPrefixes = []; },
    (c: any) => { c.mqtt.telemetryClients[0].topicPrefixes = [prefix('unknown')]; },
    (c: any) => { c.mqtt.telemetryClients[0].topicPrefixes = ['iot/#']; },
    (c: any) => { c.mqtt.telemetryClients[0].topicPrefixes.push(c.mqtt.telemetryClients[0].topicPrefixes[0]); },
    (c: any) => { c.mqtt.telemetryClients.push({ clientId: 'third-client', topicPrefixes: [c.mqtt.telemetryClients[0].topicPrefixes[0]] }); },
    (c: any) => { delete c.mqtt.telemetryClients; },
    (c: any) => { delete c.mqtt.frameTopicPrefixes; },
  ]) { const config = extended(); change(config); assert.throws(() => validateConfig(config)); }
  const config = extended();
  const more = Array.from({ length: 8 }, (_, n) => prefix(`extra-${n}`));
  config.mqtt.topicPrefixes.push(...more); config.mqtt.telemetryClients[0].topicPrefixes.push(...more);
  assert.throws(() => validateConfig(config), /at most 10/);
});

class FakeClient extends EventEmitter {
  connected = false; destroyed = 0; ended = 0; rejectSubscribe = false; rejectUnsubscribe = false; holdSubscribe = false;
  subscribeCalls: string[][] = []; unsubscribeCalls: string[][] = [];
  subscribeCallbacks: (() => void)[] = [];
  stream = { destroy: () => { this.destroyed++; this.connected = false; this.emit('close'); } };
  handleMessage!: MqttClient['handleMessage'];
  open() { this.connected = true; this.emit('connect', { sessionPresent: true }); }
  subscribe(topics: string[], options: { qos: number; rh: number; rap?: boolean }, done: (error: Error | null, grants?: { topic: string; qos: 1 | 128 }[]) => void) {
    assert.deepEqual(options, topics.every(topic => topic.endsWith('/host-health')) ? { qos: 1, rh: 2, rap: true } : { qos: 1, rh: 2 }); this.subscribeCalls.push([...topics]);
    const callback = () => done(null, topics.map(topic => ({ topic, qos: this.rejectSubscribe ? 128 : 1 })));
    this.subscribeCallbacks.push(callback); if (!this.holdSubscribe) callback();
  }
  unsubscribe(topics: string[], done: (error: Error | null, ack?: { cmd: string; granted: number[] }) => void) {
    this.unsubscribeCalls.push([...topics]); done(null, { cmd: 'unsuback', granted: topics.map(() => this.rejectUnsubscribe ? 135 : 17) });
  }
  async endAsync(force: boolean) { assert.equal(force, true); this.ended++; this.connected = false; }
}
function fixture(intake: ConstructorParameters<typeof MqttConnections>[2] = () => {}, config: Config = validateConfig(extended())) {
  const clients: FakeClient[] = [], urls: string[] = [], options: IClientOptions[] = [], events: { event: string; fields?: object }[] = [], readSecretCalls: string[] = [];
  const timers: { callback: () => void; milliseconds: number; cancelled: boolean }[] = [];
  const connections = new MqttConnections(config, 'synthetic-password', intake, (event, fields) => events.push({ event, fields }), {
    connect: (url, option) => { urls.push(url); options.push(option); const client = new FakeClient(); clients.push(client); return client as unknown as MqttClient; },
    readSecret: path => { readSecretCalls.push(path); return 'synthetic-host-password'; },
    schedule: (callback, milliseconds) => { const timer = { callback, milliseconds, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
  });
  const runTimer = () => { const timer = timers.find(t => !t.cancelled); assert.ok(timer); timer.cancelled = true; timer.callback(); return timer.milliseconds; };
  return { clients, connections, urls, options, events, timers, runTimer, readSecretCalls };
}

test('verified TLS MQTT and WebSocket transports preserve both durable identities and subscriptions', async () => {
  const baseline = validateConfig(extended());
  for (const url of ['mqtts://mqtt.example.com:8883', 'wss://mqtt.example.com:8084/mqtt', 'wss://mqtt.example.com/mqtt', 'wss://mqtt.example.com/mqtt%2Fv5']) {
    const raw = extended(); raw.mqtt.url = url;
    const config = validateConfig(raw), f = fixture(() => {}, config);
    assert.deepEqual(mqttConnectionPlans(config), mqttConnectionPlans(baseline));
    assert.deepEqual(f.urls, [url, url]);
    assert.deepEqual(f.options.map(option => option.clientId), mqttConnectionPlans(baseline).map(plan => plan.clientId));
    for (const option of f.options) {
      assert.equal(option.rejectUnauthorized, true);
      assert.equal(option.clean, false);
      assert.equal(option.protocolVersion, 5);
      assert.equal(option.properties?.sessionExpiryInterval, baseline.mqtt.sessionExpirySeconds);
    }
    f.clients.forEach(client => client.open());
    assert.equal(f.connections.snapshot().subscribed, true);
    await f.connections.stop();
  }
});

test('MQTT URL validation rejects plaintext, inline credentials and persistent-identity overrides', () => {
  for (const url of [
    'mqtt://mqtt.example.com:1883', 'ws://mqtt.example.com/mqtt', 'https://mqtt.example.com/mqtt',
    'mqtts:///mqtt', 'wss:///', 'wss:mqtt.example.com/mqtt', 'wss:////mqtt.example.com/mqtt',
    'wss://mqtt.example.com:0/mqtt', 'mqtts://mqtt.example.com:0', 'wss://mqtt.example.com/with space',
    'wss://%6dqtt.example.com/mqtt', 'wss://mqtt%2eexample.com/mqtt',
    'wss://mqtt.example.com\\mqtt', 'wss://mqtt.example.com/mq\ntt',
    'mqtts://user:secret@mqtt.example.com', 'wss://user@mqtt.example.com/mqtt',
    'mqtts://mqtt.example.com?clientId=other-session', 'wss://mqtt.example.com/mqtt?clientId=other-session',
    'wss://mqtt.example.com/mqtt?%63lientId=other-session', 'wss://mqtt.example.com/mqtt?token=secret',
    'mqtts://mqtt.example.com#fragment', 'wss://mqtt.example.com/mqtt#fragment',
  ]) {
    const config = extended(); config.mqtt.url = url;
    assert.throws(() => validateConfig(config), url);
  }
});
test('second SUBACK failure is degraded and retries with backoff while primary keeps its durable transport', async () => {
  const f = fixture(); f.clients[1].rejectSubscribe = true;
  f.clients.forEach(client => client.open());
  assert.equal(f.connections.snapshot().subscribed, false);
  assert.equal(f.connections.snapshot().mqtt_connections[0].subscribed, true);
  assert.equal(f.connections.snapshot().mqtt_connections[1].error, 'SUBACK_REJECTED');
  assert.equal(f.runTimer(), 30000); assert.equal(f.runTimer(), 60000);
  assert.equal(f.clients[0].subscribeCalls.length, 1);
  assert.equal(f.clients[0].destroyed + f.clients[1].destroyed, 0);
  f.clients[1].rejectSubscribe = false; assert.equal(f.runTimer(), 120000);
  assert.equal(f.connections.snapshot().subscribed, true);
  assert.equal(f.connections.snapshot().mqtt_connected, true);
  assert.ok(f.options.every(option => option.clean === false && option.resubscribe === false && option.protocolVersion === 5 && option.rejectUnauthorized === true));
  assert.equal(new Set(f.options.map(option => option.clientId)).size, 2);
  await f.connections.stop(); assert.ok(f.clients.every(client => client.ended === 1));
});
test('UNSUBACK rejection, late SUBACK and retry cancellation cannot stop or corrupt another connection', async () => {
  const f = fixture(); f.clients[0].rejectUnsubscribe = true; f.clients[1].holdSubscribe = true;
  f.clients.forEach(client => client.open());
  assert.equal(f.connections.snapshot().mqtt_connections[0].error, 'UNSUBACK_REJECTED');
  assert.equal(f.clients[0].subscribeCalls.length, 0);
  f.clients[1].connected = false; f.clients[1].emit('close');
  f.clients[1].subscribeCallbacks[0]();
  assert.equal(f.connections.snapshot().mqtt_connections[1].subscribed, false);
  f.clients[0].rejectUnsubscribe = false; assert.equal(f.runTimer(), 30000);
  assert.equal(f.connections.snapshot().mqtt_connections[0].subscribed, true);
  f.clients[1].holdSubscribe = false; f.clients[1].open();
  assert.equal(f.connections.snapshot().subscribed, true);
  f.clients[1].rejectSubscribe = true; f.clients[1].open();
  await f.connections.stop();
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 0);
  assert.equal(f.connections.snapshot().mqtt_connected, false);
});
test('a missing SUBACK times out; late success cannot override the pending retry', async () => {
  const f = fixture(); f.clients[1].holdSubscribe = true;
  f.clients.forEach(client => client.open());
  assert.equal(f.runTimer(), 30000);
  assert.equal(f.connections.snapshot().mqtt_connections[1].error, 'SUBSCRIPTION_TIMEOUT');
  f.clients[1].subscribeCallbacks[0]();
  assert.equal(f.connections.snapshot().subscribed, false);
  f.clients[1].holdSubscribe = false; assert.equal(f.runTimer(), 30000);
  assert.equal(f.connections.snapshot().subscribed, true);
  await f.connections.stop();
});
function packet(gateway: string, messageId = randomUUID()): IPublishPacket {
  return { cmd: 'publish', qos: 1, dup: false, retain: false,
    topic: prefix(gateway) + '/devices/temperature-host/telemetry',
    payload: Buffer.from(JSON.stringify({ schema_version: 1, message_id: messageId, site_id: 'example-home', gateway_id: gateway,
      device_id: 'temperature-host', captured_at: new Date().toISOString(), quality: 'ok', metrics: { cpu_temperature_c: 47.5 }, source: { driver: 'linux-temperature-mqtt' } })),
  };
}
test('PUBACK callback follows durable intake and alert observation; failure isolates a connection and redelivery deduplicates', async () => {
  const queue = new Queue(':memory:', { maxPending: 10, maxRejected: 10 });
  let observationFails = true, observed = 0;
  const f = fixture((packet, plan) => {
    receive(queue, packet.topic, Buffer.from(packet.payload), plan.topicPrefixes);
    if (plan.primary) return;
    if (observationFails) throw new Error('Synthetic alert storage failure');
    observed++;
  });
  f.clients.forEach(client => client.open());
  const input = packet('new-a'); let acknowledgements = 0;
  try {
    f.clients[1].handleMessage(input, error => {
      assert.ok(error); assert.equal(queue.stats().raw_records, 1); acknowledgements++;
    });
    assert.equal(f.clients[1].destroyed, 1); assert.equal(f.clients[0].destroyed, 0);
    assert.equal(f.connections.snapshot().intake_paused, true);
    f.clients[0].handleMessage(packet('old-a'), error => { assert.ifError(error); assert.equal(queue.stats().raw_records, 2); acknowledgements++; });
    assert.equal(f.connections.snapshot().mqtt_connections[0].subscribed, true);
    observationFails = false; f.clients[1].open();
    f.clients[1].handleMessage(input, error => { assert.ifError(error); assert.equal(observed, 1); assert.equal(queue.stats().raw_records, 2); acknowledgements++; });
    assert.equal(f.connections.snapshot().intake_paused, false);
    assert.equal(f.connections.snapshot().subscribed, true); assert.equal(acknowledgements, 3);
  } finally { await f.connections.stop(); queue.close(); }
});
test('storage capacity failure withholds ACK without discarding the previously queued sample', async () => {
  const queue = new Queue(':memory:', { maxPending: 1, maxRejected: 10 });
  const f = fixture((packet, plan) => { receive(queue, packet.topic, Buffer.from(packet.payload), plan.topicPrefixes); });
  try {
    f.clients.forEach(client => client.open());
    const pending = packet('new-a');
    f.clients[0].handleMessage(packet('old-a'), error => assert.ifError(error));
    f.clients[1].handleMessage(pending, error => assert.ok(error));
    assert.equal(queue.stats().raw_records, 1); assert.equal(queue.stats().queued, 1);
    assert.equal(f.clients[0].destroyed, 0); assert.equal(f.clients[1].destroyed, 1);
    const firstId = queue.next('local')!.id;
    queue.done('local', firstId); queue.done('supabase', firstId);
    f.clients[1].open();
    f.clients[1].handleMessage(pending, error => assert.ifError(error));
    assert.equal(queue.stats().raw_records, 2); assert.equal(queue.stats().queued, 1);
    assert.equal(f.connections.snapshot().intake_paused, false);
    await f.connections.stop();
    f.clients[0].handleMessage(packet('old-b'), error => assert.ok(error));
    assert.equal(queue.stats().raw_records, 2);
  } finally { await f.connections.stop(); queue.close(); }
});
test('intake enforces each connection topic and payload identity, including stale frames and collectd filters', () => {
  const queue = new Queue(':memory:', { maxPending: 10, maxRejected: 10 });
  const config = validateConfig(extended()), [primary, additional] = mqttConnectionPlans(config);
  try {
    assert.equal(receiveConnectionMessage(queue, config, primary, packet('old-a')), 'saved');
    assert.equal(receiveConnectionMessage(queue, config, additional, packet('new-a')), 'saved');
    assert.equal(receiveConnectionMessage(queue, config, primary, packet('new-a')), 'rejected');
    assert.equal(receiveConnectionMessage(queue, config, additional, packet('old-a')), 'rejected');
    const swapped = packet('new-b');
    swapped.payload = Buffer.from(JSON.stringify({ ...JSON.parse(swapped.payload.toString()), gateway_id: 'old-a' }));
    assert.equal(receiveConnectionMessage(queue, config, additional, swapped), 'rejected');
    const unknownFrames = { ...packet('new-a'), topic: prefix('new-a') + '/devices/temperature-host/frames' };
    assert.equal(receiveConnectionMessage(queue, config, additional, unknownFrames), 'rejected');
    const collectd = { ...packet('new-a'), topic: config.collectdTemperatures![0].topic, payload: Buffer.from('N:48') };
    assert.equal(receiveConnectionMessage(queue, config, additional, collectd), 'rejected');
    assert.equal(queue.nextBatch('local').length, 2);
    assert.equal(queue.nextBatch('supabase').length, 2);
  } finally { queue.close(); }
});

function hostConfig() {
  const config = extended();
  config.hostHealthInputs = [{ topic: prefix('example-router') + '/host-health', siteId: 'example-home', hostId: 'example-router',
    deviceId: 'temperature-example-router', clientId: 'example-host-health-ingestor', username: 'example-host-health-reader',
    passwordFile: '/run/secrets/example-host-health-password' }];
  return config;
}
function hostPacket(): IPublishPacket {
  return { cmd: 'publish', qos: 1, dup: false, retain: false, topic: prefix('example-router') + '/host-health',
    payload: Buffer.from(JSON.stringify({ schema_version: 1, message_id: randomUUID(), site_id: 'example-home', host_id: 'example-router',
      boot_id: randomUUID(), sequence: 1, read_time_utc: new Date().toISOString(), uptime_seconds: 1000, metrics: { cpu_temperature_c: 42.25 },
      conditions: Object.fromEntries(['memory_pressure', 'io_pressure', 'temperature', 'storage'].map(key => [key,
        { state: 'good', severity: 'warning', incident_id: null, detail_code: 'none' }])), actions: [] })),
  };
}
test('host-health adds one independent least-privilege session without changing any existing MQTT plan', async () => {
  const baseline = mqttConnectionPlans(validateConfig(extended()));
  const config = validateConfig(hostConfig()), plans = mqttConnectionPlans(config), input = config.hostHealthInputs![0];
  assert.deepEqual(plans.slice(0, 2), baseline);
  assert.equal(plans[2].clientId, input.clientId); assert.deepEqual(plans[2].subscriptions, [input.topic]);
  assert.deepEqual(plans[2].unsubscriptions, []); assert.deepEqual(plans[2].topicPrefixes, []);
  const f = fixture(() => {}, config);
  try {
    assert.deepEqual(f.readSecretCalls, [input.passwordFile]);
    assert.deepEqual(f.options.map(value => value.username), [config.mqtt.username, config.mqtt.username, input.username]);
    assert.deepEqual(f.options.map(value => value.password), ['synthetic-password', 'synthetic-password', 'synthetic-host-password']);
    assert.deepEqual(f.options.map(value => value.properties?.maximumPacketSize), [1048576, 1048576, 16384]);
    f.clients.forEach(client => client.open());
    assert.equal(f.connections.snapshot().subscribed, true);
    assert.deepEqual(f.connections.snapshot().mqtt_connections.map(value => value.subscription_count), [10, 3, 1]);
  } finally { await f.connections.stop(); }
});
test('host-health configuration rejects ambiguous identities, topics, credential paths and durable client collisions', () => {
  for (const change of [
    (c: any) => { c.hostHealthInputs = null; },
    (c: any) => { c.hostHealthInputs[0].topic = 'iot/v1/example-home/+/host-health'; },
    (c: any) => { c.hostHealthInputs[0].siteId = 'other-site'; },
    (c: any) => { c.hostHealthInputs[0].hostId = 'other-router'; },
    (c: any) => { c.hostHealthInputs[0].deviceId = '../invalid'; },
    (c: any) => { c.hostHealthInputs[0].clientId = c.mqtt.clientId; },
    (c: any) => { c.hostHealthInputs[0].clientId = c.mqtt.telemetryClients[0].clientId; },
    (c: any) => { c.hostHealthInputs[0].username = 'inline:credential'; },
    (c: any) => { c.hostHealthInputs[0].passwordFile = '../secrets/password'; },
    (c: any) => { c.hostHealthInputs[0].passwordFile = '/run/secrets/invalid\npassword'; },
    (c: any) => { c.hostHealthInputs.push({ ...c.hostHealthInputs[0], clientId: 'different-client', deviceId: 'different-device' }); },
  ]) { const raw = hostConfig(); change(raw); assert.throws(() => validateConfig(raw)); }
});
test('all host credentials load before any MQTT session is opened', () => {
  let connected = 0;
  assert.throws(() => new MqttConnections(validateConfig(hostConfig()), 'synthetic-password', () => {}, () => {}, {
    connect: () => { connected++; throw new Error('Connect should not run'); },
    readSecret: () => { throw new Error('Missing synthetic credential'); },
  }), /Missing synthetic credential/);
  assert.equal(connected, 0);
});
test('host-health durable intake normalizes CPU temperature for both targets and business health without weakening wire isolation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'host-health-intake-'));
  const queue = new Queue(':memory:', { maxPending: 20, maxRejected: 20 });
  const health = new BusinessHealth(join(directory, 'monitor.json'), { dataDir: directory, lagMs: () => 0 });
  const config = validateConfig(hostConfig()), plans = mqttConnectionPlans(config), plan = plans[2];
  try {
    const packet = hostPacket(), result = receiveConnectionMessage(queue, config, plan, packet);
    assert.equal(result, 'saved'); observeConnectionMessage(health, result, packet, config, plan);
    const first = queue.nextBatch('local');
    assert.equal(first.length, 1); assert.deepEqual(JSON.parse(first[0].payload).metrics, { cpu_temperature_c: 42.25 });
    assert.equal(JSON.parse(first[0].payload).observation_kind, 'direct_read');
    assert.equal(JSON.parse(first[0].payload).source.driver, 'openwrt-host-health');
    assert.deepEqual(queue.nextBatch('supabase').map(value => value.id), first.map(value => value.id));
    assert.equal(receiveConnectionMessage(queue, config, plan, packet), 'duplicate');
    observeConnectionMessage(health, 'duplicate', packet, config, plan);
    const snapshot = health.snapshot();
    assert.equal(snapshot.monitor_error, null);
    assert.equal(snapshot.devices['example-home/example-router/temperature-example-router'].consecutive_invalid_samples, 0);
    assert.equal(snapshot.devices['example-home/example-router/temperature-example-router'].observation_kind, 'direct_read');
    assert.equal(queue.stats().processing_failed, 0);
    assert.equal(receiveConnectionMessage(queue, config, plans[0], packet), 'rejected');
    assert.equal(receiveConnectionMessage(queue, config, plan, { ...packet, retain: true }), 'rejected');
    assert.equal(receiveConnectionMessage(queue, config, plan, { ...packet, qos: 0 }), 'rejected');
    assert.equal(receiveConnectionMessage(queue, config, plan, { ...packet, topic: prefix('other-router') + '/host-health' }), 'rejected');
    const swapped = { ...packet, payload: Buffer.from(JSON.stringify({ ...JSON.parse(packet.payload.toString()), host_id: 'other-router' })) };
    assert.equal(receiveConnectionMessage(queue, config, plan, swapped), 'rejected');
    assert.equal(queue.nextBatch('local').length, 1); assert.equal(Reflect.get(queue.stats(), 'rejected'), 5);
  } finally { await health.close(); queue.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('a host-health subscription failure leaves all original sessions active', async () => {
  const f = fixture(() => {}, validateConfig(hostConfig()));
  try {
    f.clients[2].rejectSubscribe = true; f.clients.forEach(client => client.open());
    const health = f.connections.snapshot();
    assert.deepEqual(health.mqtt_connections.slice(0, 2).map(value => value.subscribed), [true, true]);
    assert.equal(health.mqtt_connections[2].error, 'SUBACK_REJECTED');
    assert.equal(f.clients[0].destroyed + f.clients[1].destroyed, 0);
    assert.equal(f.runTimer(), 30000);
  } finally { await f.connections.stop(); }
});
test('host-health rejection, transport and conflicting identity paths retain only a fixed redacted diagnostic', () => {
  const config = validateConfig(hostConfig()), plan = mqttConnectionPlans(config)[2], packet = hostPacket();
  const rejections: { topic: string; body: string; reason: string }[] = [];
  const queue = { options: { rawRetentionDays: 7 },
    reject: (topic: string, body: Buffer, reason: string) => { rejections.push({ topic, body: body.toString(), reason }); },
    acceptRaw: () => { throw new ConflictError('Synthetic duplicate conflict'); },
  } as unknown as Queue;
  const privateBytes = Buffer.from('SYNTHETIC-INVALID-PRIVATE-MARKER');
  assert.equal(receiveConnectionMessage(queue, config, plan, { ...packet, payload: privateBytes }), 'rejected');
  assert.equal(receiveConnectionMessage(queue, config, plan, { ...packet, retain: true, payload: privateBytes }), 'rejected');
  assert.equal(receiveConnectionMessage(queue, config, plan, { ...packet, topic: prefix('other-router') + '/host-health', payload: privateBytes }), 'rejected');
  assert.equal(receiveConnectionMessage(queue, config, plan, packet), 'rejected');
  assert.deepEqual(rejections.map(value => value.reason), ['INVALID_HOST_HEALTH', 'INVALID_HOST_HEALTH_TRANSPORT', 'UNEXPECTED_MQTT_TOPIC', 'HOST_HEALTH_OBSERVATION_CONFLICT']);
  assert.ok(rejections.every(value => value.body === '[invalid host health redacted]'));
});
