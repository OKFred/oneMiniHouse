/** Run with PRESENCE_DISPOSABLE_MQTT=1 and Node 24. Uses only cached local Docker,
 * a loopback-only anonymous broker and synthetic config; never connects to PG. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { mqttConnectionPlans, validateConfig, type MqttConnectionPlan } from '../src/config.ts';
import { MqttConnections, receiveConnectionMessage } from '../src/mqtt-connections.ts';
import { stableUuid } from '../src/message.ts';
import { isPresenceRow, observerRaw, presenceAt, presenceEvent, type PresenceDevice, type PresenceWire } from '../src/presence.ts';
import { Queue } from '../src/queue.ts';

if (process.env.PRESENCE_DISPOSABLE_MQTT !== '1') {
  console.log('Skipped: set PRESENCE_DISPOSABLE_MQTT=1 for a disposable local broker.');
  process.exit(0);
}

const docker = (args: string[]) => execFileSync('docker', ['--context', 'desktop-linux', ...args], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
const context = JSON.parse(docker(['context', 'inspect', 'desktop-linux']))[0];
assert.match(context.Endpoints?.docker?.Host ?? '', /^npipe:\/\/\/\/\.\/pipe\/dockerDesktopLinuxEngine$/);
assert.equal(docker(['info', '--format', '{{.OperatingSystem}}']), 'Docker Desktop');
const image = JSON.parse(docker(['image', 'inspect', 'eclipse-mosquitto:2.0']))[0];
assert.equal(image.Os, 'linux');
const runId = randomUUID().slice(0, 8), name = `presence-mqtt-${runId}-test`;
const label = 'one-minihouse.disposable-test', labelValue = 'presence-mqtt-ingestor';
const temp = mkdtempSync(join(tmpdir(), 'one-minihouse-presence-mqtt-'));
const sqlite = join(temp, 'inbox.sqlite'), queueOptions = { maxPending: 1000, maxRejected: 10, rawMirror: true };
let queue = new Queue(sqlite, queueOptions), connections: MqttConnections | undefined, container: string | undefined;
const clients = new Map<string, MqttClient>(), publishers = new Set<MqttClient>();
const checks: string[] = [], failures: unknown[] = [];
const receipts: { id: string; result: string; retained: boolean; clientId: string }[] = [];
const acknowledgements: { id: string; clientId: string; rawArchived: true }[] = [];
const coverage: { clientId: string; event: string; id: string }[] = [];
const connectCounts = new Map<string, number>();
const site = 'synthetic', gateway = 'mqtt-integration', prefix = `iot/v1/${site}/${gateway}`;
const physical = (id: string): PresenceDevice => ({ id, label: id, topic: `${prefix}/devices/${id}/status`,
  siteId: site, gatewayId: gateway, deviceId: id, reporterId: `synthetic-${id}-publisher`,
  kind: 'direct', intervalSeconds: 60, freshnessSeconds: 300 });
const devices = [physical('host'), physical('unknown-host')], device = devices[0];
const example = JSON.parse(readFileSync(new URL('../config/ingestor.example.json', import.meta.url), 'utf8'));
example.mqtt = { ...example.mqtt, url: 'mqtts://synthetic.example.invalid:8883', clientId: `synthetic-telemetry-${runId}`,
  username: 'synthetic-reader', passwordFile: '/synthetic/not-read', topicPrefixes: [prefix], frameTopicPrefixes: [] };
example.collectdTemperatures = []; example.hostHealthInputs = [];
const baseline = validateConfig(structuredClone(example));
example.presence = { devices, clients: [{ clientId: `synthetic-presence-${runId}`, topics: devices.map(value => value.topic) }] };
const config = validateConfig(example), plans = mqttConnectionPlans(config), readerId = config.presence!.clients[0].clientId;
assert.deepEqual(plans.filter(plan => !plan.presenceDevices), mqttConnectionPlans(baseline));
assert.ok(plans.every(plan => plan.subscriptions.length <= 10));
const rows = () => queue.nextBatch('local', 1000);
const events = () => queue.nextBatch('supabase', 1000).filter(isPresenceRow).map(presenceEvent);
const event = (id: string) => events().find(value => value.event_id === id);
const rawId = (topic: string, id: string) => stableUuid(`device-presence\n${topic}\n${id}`);
const wait = async (predicate: () => unknown, message: string, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (failures.length) throw failures[0];
    assert.ok(Date.now() < deadline, message);
    await sleep(10);
  }
};
const wire = (mapping: PresenceDevice, session: string, overrides: Partial<PresenceWire> = {}): PresenceWire => ({
  schema_version: 1, event_id: randomUUID(), site_id: mapping.siteId, gateway_id: mapping.gatewayId,
  device_id: mapping.deviceId, reporter_id: mapping.reporterId, boot_id: 'synthetic-runtime', session_id: session,
  sequence: 1, event: 'online', online: true, reason: 'connected', source_time_utc: new Date().toISOString(), uptime_ms: 1000, ...overrides,
});
const will = (mapping: PresenceDevice, session: string) => wire(mapping, session, {
  event: 'offline', online: false, reason: 'lwt', sequence: null, source_time_utc: null, uptime_ms: null,
});
let endpoint = '', failNextPresence = false;
const publish = async (client: MqttClient, topic: string, value: object) => {
  await new Promise<void>((done, reject) => client.publish(topic, JSON.stringify(value), { qos: 1, retain: true }, error => error ? reject(error) : done()));
};
const publisher = async (id: string, lastWill?: PresenceWire) => {
  const client = mqtt.connect(endpoint, { protocolVersion: 5, clientId: id, clean: true, reconnectPeriod: 0, keepalive: 10,
    ...(lastWill ? { will: { topic: device.topic, payload: Buffer.from(JSON.stringify(lastWill)), qos: 1, retain: true } } : {}) });
  publishers.add(client); client.on('error', error => failures.push(error));
  await wait(() => client.connected, 'publisher connected');
  return client;
};
const send = async (client: MqttClient, mapping: PresenceDevice, value: PresenceWire) => {
  const before = receipts.filter(item => item.id === value.event_id).length;
  await publish(client, mapping.topic, value);
  await wait(() => receipts.filter(item => item.id === value.event_id).length > before, 'presence entered durable intake');
  await wait(() => acknowledgements.filter(item => item.id === value.event_id).length >= receipts.filter(item => item.id === value.event_id).length, 'reader PUBACK followed archive');
  return event(value.event_id)!;
};

try {
  container = docker(['run', '--detach', '--pull', 'never', '--name', name, '--label', `${label}=${labelValue}`,
    '--user', '1883:1883', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/mosquitto/data', '--tmpfs', '/mosquitto/log', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--network', 'bridge', '-p', '127.0.0.1::1883', '--entrypoint', 'sh', image.Id,
    '-c', 'printf "listener 1883\nallow_anonymous true\npersistence false\nlog_dest stdout\n" > /tmp/synthetic-mqtt.conf; exec mosquitto -c /tmp/synthetic-mqtt.conf']);
  const state = JSON.parse(docker(['inspect', container]))[0];
  assert.equal(state.State.Running, true, docker(['logs', container]));
  assert.equal(state.Image, image.Id); assert.equal(state.Name, `/${name}`);
  assert.equal(state.Config.Labels[label], labelValue);
  assert.equal(state.HostConfig.ReadonlyRootfs, true);
  assert.ok(state.Mounts.every((mount: { Type: string }) => mount.Type !== 'bind' && mount.Type !== 'volume'));
  const ports = state.NetworkSettings.Ports['1883/tcp'];
  assert.equal(Object.values(state.NetworkSettings.Ports).filter(Boolean).length, 1);
  assert.equal(ports?.length, 1); assert.equal(ports[0].HostIp, '127.0.0.1');
  endpoint = `mqtt://127.0.0.1:${ports[0].HostPort}`;
  await wait(() => docker(['logs', container!]).includes('Opening ipv4 listen socket on port 1883'), 'disposable broker ready');
  const seed = await publisher(`synthetic-seed-${runId}`), snapshot = wire(device, randomUUID());
  await publish(seed, device.topic, snapshot); await seed.endAsync(); publishers.delete(seed);

  connections = new MqttConnections(config, 'synthetic-only', (packet, plan) => {
    if (plan.presenceDevices && failNextPresence) { failNextPresence = false; throw new Error('Synthetic storage unavailable'); }
    const result = receiveConnectionMessage(queue, config, plan, packet);
    const value = JSON.parse(packet.payload.toString());
    receipts.push({ id: value.event_id ?? value.message_id, result, retained: packet.retain, clientId: plan.clientId });
  }, () => {}, {
    // Preserve the real production options/plans; remap only this synthetic URL to the local anonymous broker.
    connect: (url, options: IClientOptions) => {
      assert.equal(url, 'mqtts://synthetic.example.invalid:8883'); assert.equal(options.rejectUnauthorized, true);
      if (options.clientId === readerId) { assert.equal(options.clean, true); assert.equal(options.properties?.sessionExpiryInterval, 0); }
      else { assert.equal(options.clean, false); assert.equal(options.properties?.sessionExpiryInterval, baseline.mqtt.sessionExpirySeconds); }
      const client = mqtt.connect(endpoint, options), incoming = new Map<number, { id: string; topic: string }>();
      clients.set(options.clientId!, client);
      client.on('connect', () => connectCounts.set(options.clientId!, (connectCounts.get(options.clientId!) ?? 0) + 1));
      client.on('packetreceive', packet => {
        if (packet.cmd !== 'publish' || packet.messageId === undefined) return;
        const value = JSON.parse(packet.payload.toString()); incoming.set(packet.messageId, { id: value.event_id ?? value.message_id, topic: packet.topic });
      });
      client.on('packetsend', packet => {
        try {
          if (packet.cmd === 'subscribe') {
            assert.ok(packet.subscriptions.length <= 10);
            if (options.clientId === readerId) for (const subscription of packet.subscriptions) { assert.equal(subscription.rh, 0); assert.equal(!!subscription.rap, false); }
          }
          if (packet.cmd !== 'puback' || packet.messageId === undefined) return;
          const received = incoming.get(packet.messageId); assert.ok(received);
          const raw = queue.getRaw(options.clientId === readerId ? rawId(received.topic, received.id) : received.id);
          assert.ok(raw, 'raw transaction committed before reader sends PUBACK');
          if (options.clientId === readerId) {
            const frozen = JSON.parse(raw.source_id);
            const observed = coverage.find(value => value.clientId === readerId && value.event === 'coverage_start'
              && queue.getRaw(value.id)?.raw_data.includes(frozen.receipt.observerSessionId));
            assert.ok(observed, 'coverage_start durably archived before device PUBACK');
          }
          acknowledgements.push({ id: received.id, clientId: options.clientId!, rawArchived: true }); incoming.delete(packet.messageId);
        } catch (error) { failures.push(error); }
      });
      return client;
    },
    coverage: (plan: MqttConnectionPlan, kind, sequence, now) => {
      for (const siteId of new Set(plan.presenceDevices!.map(value => value.siteId))) {
        const raw = observerRaw(siteId, plan.clientId, plan.presenceSessionId!, sequence, kind, now, queue.options.rawRetentionDays);
        queue.acceptRaw(raw, 'presence-observer', '1'); coverage.push({ clientId: plan.clientId, event: kind, id: raw.raw_id });
      }
    },
  });
  await wait(() => connections!.snapshot().subscribed, 'all real SUBACKs accepted');
  await wait(() => event(snapshot.event_id), 'first retained snapshot archived');
  assert.equal(event(snapshot.event_id)!.retained, true); assert.equal(event(snapshot.event_id)!.state_after, 'unknown');
  assert.equal(presenceAt(devices, events(), Date.now())[device.id], 'unknown');
  checks.push('retained snapshot archived without seeding online; RH0 and RAPfalse on real subscription');

  const session1 = randomUUID(), lastWill = will(device, session1);
  let live = await publisher(device.reporterId, lastWill), activeWill = lastWill;
  await sleep(2);
  const birth = wire(device, session1), born = await send(live, device, birth);
  assert.equal(born.retained, false); assert.equal(born.applied, true); assert.equal(born.state_after, 'online');
  const beat = wire(device, session1, { event: 'heartbeat', reason: 'heartbeat', sequence: 2, uptime_ms: 2000 });
  assert.equal((await send(live, device, beat)).retained, false);
  assert.equal(presenceAt(devices, events(), Date.now())[device.id], 'online');
  checks.push('real retained live birth and heartbeat arrive retainfalse and open online with coverage');
  await wait(() => Date.now() > Date.parse(event(snapshot.event_id)!.observed_time_utc) + 500, 'old retained candidate passes the recovery delay');
  const retiredBeat = wire(device, snapshot.session_id, { event: 'heartbeat', reason: 'heartbeat', sequence: 2, uptime_ms: 2000 });
  const retired = await send(live, device, retiredBeat);
  assert.equal(retired.applied, false); assert.equal(retired.decision, 'closed_reporter_session');
  assert.equal(presenceAt(devices, events(), Date.now())[device.id], 'online');
  checks.push('explicit new live birth retires the older retained candidate before delayed old-session heartbeat');

  const unknown = wire(devices[1], randomUUID(), { event: 'heartbeat', reason: 'heartbeat' });
  const unobserved = await send(live, devices[1], unknown);
  assert.equal(unobserved.state_after, 'unknown');
  assert.equal(presenceAt(devices, events(), Date.now())[devices[1].id], 'unknown');
  const initial = queue.getRaw(rawId(device.topic, beat.event_id))!, initialRows = rows();
  const localRow = initialRows.find(row => isPresenceRow(row) && presenceEvent(row).event_id === beat.event_id)!;
  queue.done('local', localRow.id); queue.close(); queue = new Queue(sqlite, queueOptions);
  const rawCount = queue.stats().raw_records;
  assert.equal((await send(live, device, beat)).event_id, beat.event_id);
  assert.equal(receipts.at(-1)!.result, 'duplicate'); assert.equal(queue.stats().raw_records, rawCount);
  assert.deepEqual(queue.getRaw(initial.raw_id), initial);
  assert.ok(!queue.nextBatch('local', 1000).some(row => row.id === localRow.id));
  assert.ok(queue.nextBatch('supabase', 1000).some(row => row.id === localRow.id));
  checks.push('unknown-session heartbeat cannot seed; SQLite restart retains exact first receipt and independent target jobs');

  const telemetry = () => ({ schema_version: 1, message_id: randomUUID(), site_id: site, gateway_id: gateway,
    device_id: 'host', captured_at: new Date().toISOString(), quality: 'ok', metrics: { temperature_c: 21.5 } });
  const primary = clients.get(config.mqtt.clientId)!, primaryCount = connectCounts.get(config.mqtt.clientId);
  const failed = wire(device, session1, { event: 'heartbeat', reason: 'heartbeat', sequence: 3, uptime_ms: 3000 });
  failNextPresence = true; await publish(live, device.topic, failed);
  await wait(() => coverage.at(-1)?.event === 'coverage_end', 'observer loss archived');
  assert.equal(queue.getRaw(rawId(device.topic, failed.event_id)), undefined);
  assert.ok(!acknowledgements.some(value => value.id === failed.event_id), 'failed archive never PUBACKs');
  assert.equal(presenceAt(devices, events(), Date.now())[device.id], 'unknown');
  const sample = telemetry(); await publish(live, `${prefix}/devices/host/telemetry`, sample);
  await wait(() => acknowledgements.some(value => value.id === sample.message_id), 'telemetry still archives and ACKs while presence unavailable');
  assert.ok(primary.connected); assert.equal(connectCounts.get(config.mqtt.clientId), primaryCount);
  // The observer misses the replacement publisher's birth and can recover only its retained snapshot.
  await live.endAsync(); publishers.delete(live);
  const missedSession = randomUUID(); activeWill = will(device, missedSession);
  live = await publisher(device.reporterId, activeWill);
  const missedBirth = wire(device, missedSession, { uptime_ms: 4000 });
  assert.equal(clients.get(readerId)!.connected, false, 'replacement birth occurs while the observer is absent');
  await publish(live, device.topic, missedBirth);
  await wait(() => connections!.snapshot().subscribed, 'presence observer reconnected and subscribed');
  await wait(() => event(missedBirth.event_id), 'missed birth recovered as an unknown retained candidate');
  const candidate = event(missedBirth.event_id)!;
  assert.equal(candidate.retained, true); assert.equal(candidate.state_after, 'unknown');
  assert.equal(presenceAt(devices, events(), Date.now())[device.id], 'unknown');
  const oldSourceBeat = wire(device, missedSession, { event: 'heartbeat', reason: 'heartbeat', sequence: 2,
    uptime_ms: 5000, source_time_utc: missedBirth.source_time_utc });
  assert.notEqual((await send(live, device, oldSourceBeat)).state_after, 'online');
  assert.equal(presenceAt(devices, events(), Date.now())[device.id], 'unknown');
  const observationStart = events().filter(value => value.event === 'coverage_start' && value.observer_client_id === readerId).at(-1)!;
  const recoveryWatermark = Math.max(Date.parse(candidate.observed_time_utc), Date.parse(observationStart.observed_time_utc));
  await wait(() => Date.now() > recoveryWatermark + 500, 'fresh source time exceeds candidate and coverage watermarks plus clock allowance');
  const fresh = wire(device, missedSession, { event: 'heartbeat', reason: 'heartbeat', sequence: 3, uptime_ms: 6000 });
  assert.equal((await send(live, device, fresh)).applied, true);
  assert.equal(presenceAt(devices, events(), Date.now())[device.id], 'online');
  const firstOnline = events().find(value => value.session_id === missedSession && value.state_after === 'online');
  assert.equal(firstOnline?.event_id, fresh.event_id);
  checks.push('storage fault withholds actual PUBACK and keeps telemetry connected; missed publisher birth stays unknown until a same-session live heartbeat is newer than retained receipt');

  live.stream.destroy();
  await wait(() => event(activeWill.event_id), 'broker actually emits LWT after TCP loss');
  assert.equal(event(activeWill.event_id)!.retained, false); assert.equal(event(activeWill.event_id)!.source_time_utc, null);
  assert.equal(event(activeWill.event_id)!.state_after, 'offline');
  await live.endAsync(true); publishers.delete(live);
  const session2 = randomUUID(), normal = await publisher(device.reporterId, will(device, session2));
  const nextBirth = wire(device, session2, { uptime_ms: 7000 }); await send(normal, device, nextBirth);
  const oldWill = { ...activeWill, event_id: randomUUID() }, stale = await send(normal, device, oldWill);
  assert.equal(stale.applied, false); assert.equal(stale.decision, 'closed_reporter_session');
  assert.equal(presenceAt(devices, events(), Date.now())[device.id], 'online');
  const offline = wire(device, session2, { event: 'offline', online: false, reason: 'shutdown', sequence: 2, uptime_ms: 8000 });
  assert.equal((await send(normal, device, offline)).state_after, 'offline'); await normal.endAsync(); publishers.delete(normal);
  checks.push('actual abnormal TCP LWT, normal offline, new birth and stale will preserve correct session state');
  assert.equal(failures.length, 0); assert.ok(acknowledgements.length >= 10);
  assert.ok(queue.stats().local_pending > 0 && queue.stats().supabase_pending > 0 && queue.stats().d1_pending > 0);
  const report = { ok: true, broker_image: image.Id, broker_bound_only_localhost: true, production_accessed: false,
    pg_connections: 0, pg_persistence_claimed: false, sqlite_archived_before_reader_puback: acknowledgements.length,
    subscription_counts: plans.map(plan => ({ presence: !!plan.presenceDevices, count: plan.subscriptions.length })),
    checks, queue: queue.stats() };
  const evidence = new URL('../../.local/presence-checks/mqtt-integration.private.json', import.meta.url);
  mkdirSync(dirname(fileURLToPath(evidence)), { recursive: true });
  writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await connections?.stop();
  await Promise.allSettled([...publishers].map(client => client.endAsync(true)));
  queue.close();
  if (container) {
    const state = JSON.parse(docker(['inspect', container]))[0];
    assert.equal(state.Id, container); assert.equal(state.Name, `/${name}`);
    assert.equal(state.Image, image.Id); assert.equal(state.Config.Labels[label], labelValue);
    docker(['rm', '--force', '--volumes', container]);
  }
  const target = realpathSync(temp);
  assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith('one-minihouse-presence-mqtt-'));
  rmSync(target, { recursive: true, force: true });
}
