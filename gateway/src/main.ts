import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, type DeviceConfig } from './config.ts';
import { collectionGroups, runSchedule } from './scheduler.ts';
import { drivers } from './runner.ts';
import { Outbox, flush } from './outbox.ts';
import { MqttTransport } from './mqtt.ts';
import { FrameStore, FrameStorageError, frameEnvelope } from './frames.ts';

const config = loadConfig();
const dataDir = process.env.DATA_DIR ?? '/app/data';
mkdirSync(dataDir, { recursive: true });
const log = (event: string, detail: object = {}) => console.log(JSON.stringify({ utc: new Date().toISOString(), event, ...detail }));
const box = new Outbox(join(dataDir, 'outbox.sqlite'), config.queue);
const frames = new FrameStore(join(dataDir, 'frames.sqlite'), config.frameQueue);
const abort = new AbortController();
const stop = () => abort.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const envelope = (deviceId?: string) => ({ schema_version: 1, message_id: randomUUID(), site_id: config.siteId, gateway_id: config.gatewayId, ...(deviceId ? { device_id: deviceId } : {}) });
const offline = JSON.stringify({ ...envelope(), online: false, quality: 'offline', reason: 'connection_lost', captured_at: null });
const transport = new MqttTransport(config, offline);
const groups = collectionGroups(config.devices), groupProgress = groups.map(() => Date.now());
let mqttError = '', statusDue = 0;
const deviceHealth: Record<string, string> = Object.fromEntries(config.devices.map(d => [d.id, 'pending']));
transport.client.on('connect', () => { mqttError = ''; statusDue = 0; box.replayStates(); log('mqtt_connected'); });
transport.client.on('offline', () => log('mqtt_offline'));
transport.client.on('error', e => { mqttError = e.message; log('mqtt_error', { error: e.message }); });
const status = (online = true) => ({ ...envelope(), captured_at: new Date().toISOString(), online,
  quality: !online ? 'offline' : Object.values(deviceHealth).every(v => v === 'ok') && transport.connected ? 'ok' : 'degraded',
  devices: deviceHealth, mqtt_connected: transport.connected, frames: frames.stats(), ...box.stats() });

const heartbeat = setInterval(() => {
  const value = { utc: new Date().toISOString(), scheduler_progress_ms: Math.min(...groupProgress),
    scheduler_deadline_ms: Math.max(...config.devices.map(d => d.timeoutSeconds)) * 1000 + 30000,
    ...status(), mqtt_error: mqttError || undefined };
  try { writeFileSync(join(dataDir, 'health.tmp'), JSON.stringify(value)); renameSync(join(dataDir, 'health.tmp'), join(dataDir, 'health.json')); }
  catch (e) { log('storage_error', { error: String(e) }); process.exitCode = 1; stop(); }
}, 5000);

async function mqttLoop() {
  let nextFramePrune = 0;
  while (!abort.signal.aborted) {
    const dropped = box.prune();
    if (dropped) log('queue_dropped', { count: dropped, ...box.stats() });
    if (Date.now() >= nextFramePrune) { frames.prune(); nextFramePrune = Date.now() + 60000; }
    if (transport.connected) {
      try {
        if (Date.now() >= statusDue) { await transport.publish(`${config.mqtt.topicPrefix}/status`, JSON.stringify(status()), true); statusDue = Date.now() + 30000; }
        await flush(box, transport.publish);
        await frames.flush(transport.publish);
      } catch (e) { log('mqtt_publish_failed', { error: String(e), ...box.stats() }); }
    }
    try { await sleep(1000, undefined, { signal: abort.signal }); } catch { break; }
  }
}
async function collect(device: DeviceConfig) {
  const base = `${config.mqtt.topicPrefix}/devices/${device.id}`;
  const collectionId = randomUUID();
  log('sample_started', { device_id: device.id, collection_id: collectionId });
  let row;
  try { row = await drivers[device.driver].read(device, config.adapter, abort.signal, frame => {
    frames.save(`${base}/frames`, frameEnvelope({ site_id: config.siteId, gateway_id: config.gatewayId, device_id: device.id, collection_id: collectionId }, frame));
  }); }
  catch (e) {
    if (e instanceof FrameStorageError) throw e;
    if (abort.signal.aborted) return;
    const error = e instanceof Error ? e.message : String(e);
    deviceHealth[device.id] = 'error';
    const state = { ...envelope(device.id), collection_id: collectionId, captured_at: new Date().toISOString(), quality: 'error', error };
    box.state(device.id, state.message_id, `${base}/state`, JSON.stringify(state));
    log('sample_failed', { device_id: device.id, error });
  }
  // Disk/queue failures must fail the process, never be mistaken for BLE failures.
  if (row) {
    const sample = { ...envelope(device.id), schema_version: 2, collection_id: collectionId,
      sample_time_utc: row.sampleTimeUtc ?? null, read_time_utc: row.utc,
      observation_kind: row.source.observation_kind === 'gateway_cached_state' ? 'gateway_cached_state' : 'direct_read',
      quality: 'ok', metrics: row.metrics, source: row.source };
    box.save({ id: sample.message_id, topic: `${base}/telemetry`, payload: JSON.stringify(sample), captured_ms: Date.parse(row.utc) }, device.id, `${base}/state`);
    deviceHealth[device.id] = 'ok';
    log('sample_saved', { ...sample, ...box.stats() });
  }
  statusDue = 0;
}

log('gateway_started', { site_id: config.siteId, gateway_id: config.gatewayId, adapter: config.adapter, devices: config.devices.map(d => d.id), ...box.stats() });
const loops = [...groups.map((devices, index) => runSchedule(devices, collect, () => { groupProgress[index] = Date.now(); }, abort.signal)), mqttLoop()]
  .map(p => p.catch(e => { log('fatal', { error: String(e) }); process.exitCode = 1; stop(); }));
await Promise.all(loops);
clearInterval(heartbeat);
if (transport.connected) {
  try { await transport.publish(`${config.mqtt.topicPrefix}/status`, JSON.stringify(status(false)), true); } catch { /* LWT covers loss. */ }
}
await transport.close();
box.close();
frames.close();
log('gateway_stopped');
