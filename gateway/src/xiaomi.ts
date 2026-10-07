import { createCipheriv, createDecipheriv, createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import type { XiaomiDeviceConfig } from './config.ts';
import type { DriverReading } from './runner.ts';

// Local miIO protocol; no Xiaomi cloud access is required while collecting.
// Only these read operations are encoded. Never log hello packets or credentials.
type ReadMethod = 'miIO.info' | 'get_device_prop' | 'get_device_prop_exp' | 'get_battery';
const methods: ReadMethod[] = ['miIO.info', 'get_device_prop', 'get_device_prop_exp', 'get_battery'];
const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();
const hello = Buffer.from('21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');

export function encodeMiio(token: Buffer, deviceId: number, stamp: number, id: number, method: ReadMethod, params: unknown[]): Buffer {
  if (token.length !== 16 || !methods.includes(method)) throw new Error('Invalid miIO read request');
  const key = md5(token), iv = md5(key, token);
  try {
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify({ id, method, params })), cipher.final()]);
    const header = Buffer.alloc(16);
    header.writeUInt16BE(0x2131); header.writeUInt16BE(32 + body.length, 2);
    header.writeUInt32BE(deviceId, 8); header.writeUInt32BE(stamp >>> 0, 12);
    return Buffer.concat([header, md5(header, token, body), body]);
  } finally { key.fill(0); iv.fill(0); }
}

export function decodeMiio(packet: Buffer, token: Buffer, deviceId: number): { id: number; result?: unknown; error?: { code?: number } } {
  if (token.length !== 16 || packet.length < 48 || packet.length > 8192 || (packet.length - 32) % 16
    || packet.readUInt16BE(0) !== 0x2131 || packet.readUInt16BE(2) !== packet.length || packet.readUInt32BE(8) !== deviceId) throw new Error('Invalid miIO response header');
  if (!timingSafeEqual(md5(packet.subarray(0, 16), token, packet.subarray(32)), packet.subarray(16, 32))) throw new Error('miIO response authentication failed');
  const key = md5(token), iv = md5(key, token);
  try {
    const cipher = createDecipheriv('aes-128-cbc', key, iv);
    const decoded = JSON.parse(Buffer.concat([cipher.update(packet.subarray(32)), cipher.final()]).toString('utf8').replace(/\0+$/, ''));
    if (!decoded || !Number.isSafeInteger(decoded.id)) throw new Error();
    return decoded;
  } catch { throw new Error('Invalid miIO response body'); }
  finally { key.fill(0); iv.fill(0); }
}

function credential(device: XiaomiDeviceConfig): Buffer {
  // Errors deliberately omit parser snippets: malformed JSON may contain a token.
  try {
    const c = JSON.parse(readFileSync(device.credentialsFile, 'utf8'));
    if (c.host !== device.host || String(c.deviceId) !== String(device.gatewayDeviceId) || c.model !== 'lumi.gateway.v3'
      || typeof c.token !== 'string' || !/^[0-9a-f]{32}$/i.test(c.token)) throw new Error();
    return Buffer.from(c.token, 'hex');
  } catch { throw new Error('Xiaomi secret file missing, invalid, or does not match configured gateway'); }
}

export function temperatureMetrics(result: unknown, battery: unknown): Record<string, number> {
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]) || result[0].length !== 2) throw new Error('Missing Xiaomi temperature/humidity');
  const [temperature, humidity] = result[0];
  // WSDCGQ01LM 官方检测范围：温度 -20～50°C，相对湿度 10～90% RH（无冷凝）。
  // https://i01.appmifile.com/webfile/globalimg/Global_UG/Mi_Ecosystem/Mi_Temperature_and_Humidity_Sensor/Temperature_Sensor_fr_V1.pdf#page=56
  // 此处只校验协议整数并换算单位；超规格读数也须上报保留原始证据，由 ingestor 加工层统一判定质量。
  if (!Number.isSafeInteger(temperature) || !Number.isSafeInteger(humidity)) throw new Error('Invalid Xiaomi temperature/humidity');
  if (!Array.isArray(battery) || battery.length !== 1 || !Number.isInteger(battery[0]) || battery[0] < 0 || battery[0] > 100) throw new Error('Invalid Xiaomi battery level');
  return { temperature_c: temperature / 100, humidity_pct: humidity / 100, battery_pct: battery[0] };
}

export async function readXiaomi(device: XiaomiDeviceConfig, signal: AbortSignal,
  options: { port?: number; timeoutMs?: number } = {}): Promise<DriverReading> {
  signal.throwIfAborted();
  const token = credential(device);
  const socket = createSocket('udp4');
  const port = options.port ?? 54321;
  const controller = new AbortController();
  const cancelled = () => controller.abort(new Error('Xiaomi collection cancelled'));
  const timer = setTimeout(() => controller.abort(new Error('Xiaomi collection timed out')), options.timeoutMs ?? device.timeoutSeconds * 1000);
  signal.addEventListener('abort', cancelled, { once: true });
  let networkError: Error | undefined;
  socket.on('error', () => { networkError = new Error('Xiaomi UDP error'); controller.abort(networkError); });
  if (signal.aborted) cancelled();

  // A round has one absolute deadline. Ignore late request IDs, but never accept
  // unauthenticated data, another gateway, or a response from another UDP peer.
  function exchange<T>(packet: Buffer, parse: (response: Buffer) => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { socket.off('message', receive); controller.signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(controller.signal.reason); };
      const receive = (data: Buffer, peer: { address: string; port: number }) => {
        if (peer.address !== device.host || peer.port !== port) return;
        try { const value = parse(data); if (value !== undefined) { cleanup(); resolve(value); } }
        catch (error) { cleanup(); reject(error); }
      };
      if (controller.signal.aborted) { abort(); return; }
      socket.on('message', receive); controller.signal.addEventListener('abort', abort, { once: true });
      socket.send(packet, port, device.host, error => {
        if (error) { cleanup(); reject(networkError ?? new Error('Xiaomi UDP send failed')); }
      });
    });
  }
  try {
    const stamp = await exchange(hello, packet => {
      if (packet.length !== 32 || packet.readUInt16BE(0) !== 0x2131 || packet.readUInt16BE(2) !== 32
        || packet.readUInt32BE(8) !== device.gatewayDeviceId) throw new Error('Xiaomi gateway identity mismatch');
      return packet.readUInt32BE(12);
    });
    const started = performance.now();
    let id = randomInt(100, 1000000);
    async function query(method: ReadMethod, params: unknown[]): Promise<unknown> {
      const currentId = ++id;
      return exchange(encodeMiio(token, device.gatewayDeviceId, stamp + Math.floor((performance.now() - started) / 1000), currentId, method, params), packet => {
        if (packet.length === 32) return undefined; // A late hello response.
        const response = decodeMiio(packet, token, device.gatewayDeviceId);
        if (response.id !== currentId) return undefined;
        if (response.error) throw new Error('Xiaomi gateway rejected the read request');
        if (response.result === undefined) throw new Error('Xiaomi gateway returned no result');
        return { result: response.result };
      }).then(value => value.result);
    }
    const info = await query('miIO.info', []) as { model?: unknown; fw_ver?: unknown } | null;
    if (info?.model !== 'lumi.gateway.v3') throw new Error('Unsupported Xiaomi gateway model');
    const list = await query('get_device_prop', ['lumi.0', 'device_list']);
    if (!Array.isArray(list) || list.length % 5) throw new Error('Invalid Xiaomi subdevice list');
    const index = list.findIndex((value, i) => i % 5 === 0 && value === device.sid);
    if (index < 0 || list[index + 1] !== 10) throw new Error('Configured Xiaomi temperature sensor not found or unsupported');
    const properties = await query('get_device_prop_exp', [[device.sid, 'temperature', 'humidity']]);
    const readTime = new Date().toISOString();
    const battery = await query('get_battery', [device.sid]);
    return { utc: readTime, metrics: temperatureMetrics(properties, battery), source: {
      driver: device.driver, transport: 'miio-udp', gateway_model: 'lumi.gateway.v3', gateway_device_id: device.gatewayDeviceId,
      sensor_sid: device.sid, sensor_model: 'WSDCGQ01LM',
      observation_kind: 'gateway_cached_state', sensor_sample_time_known: false,
      read_time_utc: readTime, time_basis: 'gateway_state_read_time',
      ...(typeof info.fw_ver === 'string' && /^[\w.\-]{1,64}$/.test(info.fw_ver) ? { gateway_firmware: info.fw_ver } : {}),
    } };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancelled); token.fill(0);
    await new Promise<void>(resolve => { try { socket.close(() => resolve()); } catch { resolve(); } });
  }
}
