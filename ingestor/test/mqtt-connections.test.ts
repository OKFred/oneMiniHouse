import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { MqttClient, IClientOptions, IPublishPacket } from 'mqtt';
import { mqttConnectionPlans, mqttSubscriptions, validateConfig, type Config } from '../src/config.ts';
import { MqttConnections, receiveConnectionMessage } from '../src/mqtt-connections.ts';
import { Queue } from '../src/queue.ts';
import { receive } from '../src/intake.ts';

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
  subscribe(topics: string[], options: { qos: number; rh: number }, done: (error: Error | null, grants?: { topic: string; qos: 1 | 128 }[]) => void) {
    assert.deepEqual(options, { qos: 1, rh: 2 }); this.subscribeCalls.push([...topics]);
    const callback = () => done(null, topics.map(topic => ({ topic, qos: this.rejectSubscribe ? 128 : 1 })));
    this.subscribeCallbacks.push(callback); if (!this.holdSubscribe) callback();
  }
  unsubscribe(topics: string[], done: (error: Error | null, ack?: { cmd: string; granted: number[] }) => void) {
    this.unsubscribeCalls.push([...topics]); done(null, { cmd: 'unsuback', granted: topics.map(() => this.rejectUnsubscribe ? 135 : 17) });
  }
  async endAsync(force: boolean) { assert.equal(force, true); this.ended++; this.connected = false; }
}
function fixture(intake: ConstructorParameters<typeof MqttConnections>[2] = () => {}, config: Config = validateConfig(extended())) {
  const clients: FakeClient[] = [], options: IClientOptions[] = [], events: { event: string; fields?: object }[] = [];
  const timers: { callback: () => void; milliseconds: number; cancelled: boolean }[] = [];
  const connections = new MqttConnections(config, 'synthetic-password', intake, (event, fields) => events.push({ event, fields }), {
    connect: (_url, option) => { options.push(option); const client = new FakeClient(); clients.push(client); return client as unknown as MqttClient; },
    schedule: (callback, milliseconds) => { const timer = { callback, milliseconds, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
  });
  const runTimer = () => { const timer = timers.find(t => !t.cancelled); assert.ok(timer); timer.cancelled = true; timer.callback(); return timer.milliseconds; };
  return { clients, connections, options, events, timers, runTimer };
}
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
