import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../src/config.ts';
import { Outbox, flush } from '../src/outbox.ts';
import { successfulPuback } from '../src/mqtt.ts';
import { runWorker } from '../src/runner.ts';
import { publishQos1 } from '../src/mqtt.ts';
import { FrameStorageError, type ProtocolFrame } from '../src/frames.ts';
import { EventEmitter } from 'node:events';
import type { MqttClient } from 'mqtt';

const config = JSON.parse(readFileSync(new URL('../config/gateway.example.json', import.meta.url), 'utf8'));
test('configuration rejects unsafe writes, mismatched topics, duplicate devices and invalid limits', () => {
  assert.equal(validateConfig(config).siteId, 'example-home');
  for (const mutate of [
    (c: any) => c.mqtt.topicPrefix = 'iot/v1/home/example-gateway',
    (c: any) => c.mqtt.url = 'mqtt://example.com',
    (c: any) => c.devices.push(c.devices[0]),
    (c: any) => c.devices[0].protocol.readPayloadHex = 'b0b9b0',
    (c: any) => c.devices[0].timeoutSeconds = Infinity,
    (c: any) => c.queue.maxRows = 100001,
  ]) { const c = structuredClone(config); mutate(c); assert.throws(() => validateConfig(c)); }
});
test('PUBACK success is explicit, denied or missing ACK cannot delete queued data', () => {
  assert.equal(successfulPuback({ cmd: 'puback', reasonCode: 0 }), true);
  assert.equal(successfulPuback({ cmd: 'puback', reasonCode: 16 }), true);
  assert.equal(successfulPuback({ cmd: 'puback', reasonCode: 135 }), false);
  assert.equal(successfulPuback(undefined), false);
});
test('MQTT.js original-PUBLISH success callback must match an observed successful PUBACK', async () => {
  for (const reason of [0, 16, 135, undefined]) {
    const events = new EventEmitter();
    const client = Object.assign(events, { connected: true,
      publish(_topic: string, _payload: string, _options: unknown, cb: Function) {
        if (reason !== undefined) events.emit('packetreceive', { cmd: 'puback', messageId: 7, reasonCode: reason });
        cb(null, { cmd: 'publish', messageId: 7 });
      },
    });
    const p = publishQos1(client as unknown as MqttClient, 'test', '{}', false);
    if (reason === 0 || reason === 16) await p; else await assert.rejects(p, /PUBACK/);
    assert.equal(client.listenerCount('packetreceive'), 0);
  }
});
test('restart recovery, failed PUBACK, duplicate IDs and chronological replay preserve latest retained state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-'));
  let b = new Outbox(join(dir, 'q.db'), { maxRows: 100, maxAgeDays: 7 });
  try {
    for (const id of ['old', 'new']) b.save({ id, topic: 'telemetry', payload: id, captured_ms: Date.now() }, 'd', 'state');
    b.close(); b = new Outbox(join(dir, 'q.db'), { maxRows: 100, maxAgeDays: 7 });
    const received: string[] = [];
    await assert.rejects(flush(b, async (_, payload) => { received.push(payload); throw new Error('lost PUBACK'); }));
    assert.equal(b.stats().queued, 2);
    const retained: string[] = [];
    await flush(b, async (_, payload, retain) => { if (retain) retained.push(payload); else received.push(payload); });
    assert.deepEqual(received, ['old', 'old', 'new']);
    assert.deepEqual(retained, ['new']); assert.equal(b.stats().queued, 0);
    b.state('d', 'error', 'state', '{"quality":"error"}');
    b.ackState('d', 'new'); assert.equal(b.dirty()[0].id, 'error');
    b.ackState('d', 'error'); b.replayStates(); assert.equal(b.dirty()[0].id, 'error');
  } finally { b.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('age and count limits drop oldest pending rows and persist drop counters', () => {
  const b = new Outbox(':memory:', { maxRows: 2, maxAgeDays: 7 });
  try {
    for (let i=0; i<4; i++) b.save({ id: String(i), topic: 't', payload: '{}', captured_ms: i === 0 ? 0 : Date.now() }, 'd', 's');
    assert.equal(b.prune(), 2); assert.equal(b.first()!.id, '2'); assert.deepEqual(b.stats(), { queued: 2, dropped: 2 });
    assert.equal(b.prune(Date.now()+8*86400000), 2); assert.equal(b.stats().dropped, 4);
  } finally { b.close(); }
});
test('hung worker is killed and reaped on timeout and cancellation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-worker-'));
  const script = join(dir, 'hang.cjs'); writeFileSync(script, 'setInterval(()=>{},1000)');
  try {
    await assert.rejects(runWorker(config.devices[0], 'hci0', new AbortController().signal, script, 100), /timed out/);
    const abort = new AbortController();
    const p = runWorker(config.devices[0], 'hci0', abort.signal, script, 10000);
    abort.abort(); await assert.rejects(p, /Cancelled/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('BLE worker IPC traces remain separate from its result and preserve storage errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-trace-'));
  const script = join(dir, 'trace.cjs');
  // Fixture re-keyed for the synthetic MAC in gateway.example.json.
  const wire = 'efee0323aebba6a6a63e9ba6a4885da11aafb4a545f3af62a6a6a694a6a6eab8a6a6a30a0365';
  const trace = { direction: 'rx', protocol: 'yunmu-v5', frame_time_utc: new Date().toISOString(), wire_hex: wire, crc_valid: true };
  const result = { utc: trace.frame_time_utc, address: config.devices[0].address, wire_hex: wire };
  writeFileSync(script, `process.send(${JSON.stringify({kind:'frame',frame:trace})}); process.send(${JSON.stringify(result)},()=>process.exit(0));`);
  try {
    const received: ProtocolFrame[] = [];
    assert.deepEqual(await runWorker(config.devices[0], 'hci0', new AbortController().signal, script, 5000, f=>received.push(f)), result);
    assert.equal(received.length, 1);
    await assert.rejects(runWorker(config.devices[0], 'hci0', new AbortController().signal, script, 5000, ()=>{throw new FrameStorageError('disk full');}), FrameStorageError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
