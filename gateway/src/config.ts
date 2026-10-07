import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';

interface DeviceBase { id: string; intervalSeconds: number; timeoutSeconds: number }
export interface BleDeviceConfig extends DeviceBase {
  id: string; driver: 'yunmu-v5'; address: string;
  protocol: { readPayloadHex: string }; intervalSeconds: number; timeoutSeconds: number;
}
export interface ModbusDeviceConfig extends DeviceBase {
  driver: 'chint-ddsu666-rtu-tcp';
  host: string; port: number; slaveId: number;
}
export interface LightDeviceConfig extends Omit<ModbusDeviceConfig, 'driver'> { driver: 'modbus-light-u32-rtu-tcp' }
export interface XiaomiDeviceConfig extends DeviceBase {
  driver: 'xiaomi-gateway-v3-temperature';
  host: string; gatewayDeviceId: number; sid: string; credentialsFile: string;
}
export interface TemperatureDeviceConfig extends DeviceBase {
  driver: 'linux-temperature-ssh';
  host: string; port: number; username: string; identityFile: string; knownHostsFile: string;
  sensors: {selector: string; metric: string}[];
}
export type DeviceConfig = BleDeviceConfig | ModbusDeviceConfig | LightDeviceConfig | XiaomiDeviceConfig | TemperatureDeviceConfig;
export interface Config {
  siteId: string; gatewayId: string; adapter?: string;
  mqtt: { url: string; clientId: string; username: string; passwordFile: string; caFile?: string; topicPrefix: string };
  queue: { maxAgeDays: number; maxRows: number };
  frameQueue?: { maxAgeDays: number; maxRows: number };
  devices: DeviceConfig[];
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const number = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function validateConfig(input: unknown): Config {
  const c = input as Config;
  if (!c || !id(c.siteId) || !id(c.gatewayId)) throw new Error('Invalid siteId or gatewayId');
  if (c.adapter !== undefined && !/^hci\d+$/.test(c.adapter)) throw new Error('Invalid adapter');
  const m = c.mqtt;
  if (!m || !id(m.clientId) || typeof m.username !== 'string' || !m.username || !m.passwordFile) throw new Error('Missing MQTT identity/secret file');
  const url = new URL(m.url);
  if (url.protocol !== 'mqtts:' || !url.hostname || url.username || url.password) throw new Error('MQTT requires mqtts:// and credentials in a secret file');
  if (m.topicPrefix !== `iot/v1/${c.siteId}/${c.gatewayId}`) throw new Error('MQTT topicPrefix must match siteId and gatewayId');
  if (!number(c.queue?.maxAgeDays, 1 / 86400, 7) || !number(c.queue?.maxRows, 1, 100000) || !Number.isInteger(c.queue.maxRows)) throw new Error('Invalid queue limits (maximum 7 days / 100000 rows)');
  if (c.frameQueue && (!number(c.frameQueue.maxAgeDays, 1 / 86400, 30) || !Number.isInteger(c.frameQueue.maxRows) || !number(c.frameQueue.maxRows, 1, 1000000))) throw new Error('Invalid frame queue limits (maximum 30 days / 1000000 rows)');
  if (!Array.isArray(c.devices) || !c.devices.length) throw new Error('At least one device is required');
  const ids = new Set<string>(), addresses = new Set<string>();
  for (const d of c.devices) {
    if (!id(d.id) || ids.has(d.id)) throw new Error('Invalid or duplicate device ID');
    let address: string;
    if (d.driver === 'yunmu-v5') {
      if (!c.adapter) throw new Error('BLE devices require an explicit adapter');
      if (!/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(d.address)) throw new Error('Invalid MAC');
      address = d.address.toUpperCase();
      // The verified read operation is [key, key XOR 0x08, key]. No arbitrary BLE writes.
      if (!/^[\da-f]{6}$/i.test(d.protocol?.readPayloadHex ?? '')) throw new Error('Read payload must contain exactly three bytes');
      const bytes = Buffer.from(d.protocol.readPayloadHex, 'hex');
      if (bytes[0] !== bytes[2] || (bytes[0] ^ bytes[1]) !== 8) throw new Error('Only the verified 0x08 metering read command is allowed');
    } else if (d.driver === 'chint-ddsu666-rtu-tcp' || d.driver === 'modbus-light-u32-rtu-tcp') {
      if (typeof d.host !== 'string' || !/^[A-Za-z0-9.:-]{1,253}$/.test(d.host) || !Number.isInteger(d.port) || !number(d.port, 1, 65535) || !Number.isInteger(d.slaveId) || !number(d.slaveId, 1, 247)) throw new Error('Invalid Modbus TCP endpoint or slave address');
      address = `${d.host.toLowerCase()}:${d.port}/${d.slaveId}`;
    } else if (d.driver === 'xiaomi-gateway-v3-temperature') {
      if (!isIPv4(d.host) || !Number.isInteger(d.gatewayDeviceId) || !number(d.gatewayDeviceId, 1, 0xfffffffe)
        || !/^lumi\.[0-9a-f]{12,16}$/i.test(d.sid) || typeof d.credentialsFile !== 'string' || !d.credentialsFile.trim()) throw new Error('Invalid Xiaomi gateway identity or secret file');
      if ('token' in d) throw new Error('Xiaomi token must be supplied in a secret file');
      address = `miio:${d.gatewayDeviceId}/${d.sid.toLowerCase()}`;
    } else if (d.driver === 'linux-temperature-ssh') {
      if (!isIPv4(d.host) || !Number.isInteger(d.port) || !number(d.port,1,65535)
        || !/^[a-z_][a-z0-9_-]{0,31}$/.test(d.username)
        || ![d.identityFile,d.knownHostsFile].every(p => typeof p === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(p))) throw new Error('Invalid temperature SSH endpoint or secret paths');
      if (!Array.isArray(d.sensors) || !d.sensors.length || d.sensors.length > 16
        || !d.sensors.every(s => s && /^(thermal|hwmon):[A-Za-z0-9_. -]{1,80}:[A-Za-z0-9_. -]{1,80}$/.test(s.selector)
          && /^[a-z][a-z0-9_]{0,44}_temperature_c$/.test(s.metric))
        || new Set(d.sensors.map(s => s.metric)).size !== d.sensors.length
        || new Set(d.sensors.map(s => s.selector)).size !== d.sensors.length) throw new Error('Invalid or duplicate temperature sensor selection');
      address = `temperature:${d.host}:${d.port}`;
    } else throw new Error(`Unsupported driver: ${(d as DeviceConfig).driver}`);
    if (addresses.has(address)) throw new Error('Duplicate device address');
    if (!number(d.intervalSeconds, 10, 86400) || !number(d.timeoutSeconds, 5, 300)) throw new Error('Invalid device interval/timeout');
    ids.add(d.id); addresses.add(address);
  }
  return c;
}
export const loadConfig = (path = process.env.CONFIG_FILE ?? '/app/config/gateway.json') => validateConfig(JSON.parse(readFileSync(path, 'utf8')));
