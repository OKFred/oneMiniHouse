import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeMiio, encodeMiio, readXiaomi, temperatureMetrics } from '../src/xiaomi.ts';
import { validateConfig, type XiaomiDeviceConfig } from '../src/config.ts';

const token = Buffer.from('00112233445566778899aabbccddeeff', 'hex'); // Synthetic test key only.
const did = 12345678, sid = 'lumi.00000000000001';
const device: XiaomiDeviceConfig = { id: 'temperature-room', driver: 'xiaomi-gateway-v3-temperature', host: '127.0.0.1', gatewayDeviceId: did, sid, credentialsFile: '', intervalSeconds: 60, timeoutSeconds: 10 };
// Generated independently with Python/PyCryptodome AES-CBC and hashlib.md5.
const fixture = Buffer.from('213100500000000000bc614e0001e24005ffbf4acdf34ca2121aa6bd7b3211b62b4319bb8a3dcfe44bb5fee830ddbfafb6b14c77799d708cc220a6e9405e64545d807e86c635db253e8cc3d7f166abed', 'hex');

test('miIO authenticates independent fixture; rejects wrong key, identity, truncation and corruption', () => {
  assert.deepEqual(decodeMiio(fixture, token, did), { id: 123, result: [[2925, 8437]] });
  assert.throws(() => decodeMiio(fixture, Buffer.alloc(16), did), /authentication/);
  assert.throws(() => decodeMiio(fixture, token, did + 1), /header/);
  assert.throws(() => decodeMiio(fixture.subarray(0, -1), token, did), /header/);
  const altered = Buffer.from(fixture); altered[47] ^= 1;
  assert.throws(() => decodeMiio(altered, token, did), /authentication/);
  assert.throws(() => encodeMiio(token, did, 0, 1, 'set_device_prop' as never, []), /read request/);
});

test('temperature units preserve raw out-of-spec readings for ingestor quality checks', () => {
  assert.deepEqual(temperatureMetrics([[2925, 8437]], [60]), { temperature_c: 29.25, humidity_pct: 84.37, battery_pct: 60 });
  assert.deepEqual(temperatureMetrics([[-125, 0]], [0]), { temperature_c: -1.25, humidity_pct: 0, battery_pct: 0 });
  assert.deepEqual(temperatureMetrics([[10000, 0]], [60]), { temperature_c: 100, humidity_pct: 0, battery_pct: 60 });
  assert.deepEqual(temperatureMetrics([[11000, -100]], [60]), { temperature_c: 110, humidity_pct: -1, battery_pct: 60 });
});

test('temperature protocol rejects missing values, nonintegers and unsafe integers', () => {
  for (const raw of [null, [], [[null, 8400]], [['2925', 8437]], [[2000]], [[2000, 5000, 60]]]) assert.throws(() => temperatureMetrics(raw, [60]));
  for (const invalid of [1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    assert.throws(() => temperatureMetrics([[invalid, 5000]], [60]));
    assert.throws(() => temperatureMetrics([[2000, invalid]], [60]));
  }
  for (const raw of [null, [], [null], [101]]) assert.throws(() => temperatureMetrics([[2000, 5000]], raw));
});

test('Xiaomi configuration checks identity, secret path and duplicates independently of BLE', () => {
  const base = JSON.parse(readFileSync(new URL('../config/gateway.example.json', import.meta.url), 'utf8'));
  base.devices = [{ ...device, credentialsFile: '/run/secrets/xiaomi_gateway_v3' }]; delete base.adapter;
  assert.equal(validateConfig(base).devices.length, 1);
  for (const change of [{ host: 'gateway.local' }, { gatewayDeviceId: -1 }, { gatewayDeviceId: 1.5 }, { sid: '../bad' }, { credentialsFile: '' }, { token: 'secret' }]) {
    const config = structuredClone(base); Object.assign(config.devices[0], change); assert.throws(() => validateConfig(config));
  }
  base.devices.push({ ...base.devices[0], id: 'duplicate', host: '127.0.0.2' });
  assert.throws(() => validateConfig(base), /Duplicate device address/);
});

function reply(id: number, result: unknown): Buffer {
  const hash = (b: Buffer) => createHash('md5').update(b).digest();
  const key = hash(token), iv = hash(Buffer.concat([key, token]));
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ id, result })), cipher.final()]);
  const header = Buffer.alloc(16); header.writeUInt16BE(0x2131); header.writeUInt16BE(body.length + 32, 2); header.writeUInt32BE(did, 8); header.writeUInt32BE(123456, 12);
  return Buffer.concat([header, hash(Buffer.concat([header, token, body])), body]);
}

test('UDP round reads only configured sensor, ignores stale IDs and records gateway-cache time semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xiaomi-')), credentialsFile = join(dir, 'secret.json');
  writeFileSync(credentialsFile, JSON.stringify({ host: device.host, deviceId: did, model: 'lumi.gateway.v3', token: token.toString('hex') }));
  const socket = createSocket('udp4'), requests: { method: string; params: unknown[] }[] = [];
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  socket.on('message', (bytes, peer) => {
    if (bytes.length === 32) {
      const hello = Buffer.alloc(32); hello.writeUInt16BE(0x2131); hello.writeUInt16BE(32, 2); hello.writeUInt32BE(did, 8); hello.writeUInt32BE(123456, 12);
      socket.send(hello, peer.port, peer.address); return;
    }
    const data = decodeMiio(bytes, token, did) as unknown as { id: number; method: string; params: unknown[] };
    requests.push(data);
    const results: Record<string, unknown> = { 'miIO.info': { model: 'lumi.gateway.v3', fw_ver: '1.4.1_176' }, get_device_prop: [sid, 10, 0, 0, 1], get_device_prop_exp: [[2925, 8437]], get_battery: [60] };
    socket.send(reply(data.id - 1, [[1234, 1234]]), peer.port, peer.address);
    socket.send(reply(data.id, results[data.method]), peer.port, peer.address);
  });
  try {
    const row = await readXiaomi({ ...device, credentialsFile }, new AbortController().signal, { port, timeoutMs: 3000 });
    assert.deepEqual(row.metrics, { temperature_c: 29.25, humidity_pct: 84.37, battery_pct: 60 });
    assert.equal(row.source.observation_kind, 'gateway_cached_state'); assert.equal(row.source.sensor_sample_time_known, false);
    assert.equal(row.utc, row.source.read_time_utc);
    assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
      { method: 'miIO.info', params: [] }, { method: 'get_device_prop', params: ['lumi.0', 'device_list'] },
      { method: 'get_device_prop_exp', params: [[sid, 'temperature', 'humidity']] }, { method: 'get_battery', params: [sid] },
    ]);
    assert.equal(JSON.stringify(row).includes(token.toString('hex')), false);
  } finally { socket.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('miIO timeout and cancellation are bounded; malformed secrets never leak in errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xiaomi-timeout-')), credentialsFile = join(dir, 'secret.json');
  const socket = createSocket('udp4');
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port, d = { ...device, credentialsFile };
  writeFileSync(credentialsFile, JSON.stringify({ host: device.host, deviceId: did, model: 'lumi.gateway.v3', token: token.toString('hex') }));
  try {
    await assert.rejects(readXiaomi(d, new AbortController().signal, { port, timeoutMs: 50 }), /timed out/);
    const controller = new AbortController();
    const pending = readXiaomi(d, controller.signal, { port, timeoutMs: 3000 }); controller.abort();
    await assert.rejects(pending, /cancelled/);
    writeFileSync(credentialsFile, '{"token":"never-print-this');
    await assert.rejects(readXiaomi(d, new AbortController().signal, { port }), error => error instanceof Error && /secret file/.test(error.message) && !error.message.includes('never-print-this'));
  } finally { socket.close(); rmSync(dir, { recursive: true, force: true }); }
});
