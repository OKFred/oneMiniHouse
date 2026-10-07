import { createRequire } from 'node:module';
import type { Characteristic, Peripheral } from '@stoprocent/noble';
import type { BleDeviceConfig } from './config.ts';
import { MeterFrame, frame, frameCrcValid } from './protocol.ts';
import type { ProtocolFrame } from './frames.ts';
const require = createRequire(import.meta.url);
const device = JSON.parse(process.env.BLE_DEVICE!) as BleDeviceConfig;
const adapter = process.env.BLE_ADAPTER!;
const SERVICE = '49535343fe7d4ae58fa99fafd205e455';
const NOTIFY = '495353431e4d4bd9ba6123c647249616';
const WRITE = '49535343884143f4a8d4ecbe34729bb3';
function trace(direction: ProtocolFrame['direction'], bytes: Buffer) {
  const crc = frameCrcValid(bytes, device.address);
  process.send!({ kind: 'frame', frame: { direction, protocol: 'yunmu-v5', frame_time_utc: new Date().toISOString(), wire_hex: bytes.subarray(0, 512).toString('hex'), ...(crc === undefined ? {} : { crc_valid: crc }) } });
}

async function read() {
  if (process.platform !== 'linux') throw new Error('The gateway requires Linux BlueZ');
  // Check the exact adapter before Noble (whose fallback would choose the first one).
  const bus = require('dbus-next').systemBus();
  bus.on('error', (e: Error) => { console.error(e.message); process.exit(1); });
  try {
    const root = await bus.getProxyObject('org.bluez', '/');
    const objects = await root.getInterface('org.freedesktop.DBus.ObjectManager').GetManagedObjects();
    const chosen = objects[`/org/bluez/${adapter}`]?.['org.bluez.Adapter1'];
    if (!chosen) throw new Error(`Configured adapter ${adapter} does not exist`);
    if (!chosen.Powered.value) throw new Error(`Configured adapter ${adapter} is powered off`);
  } finally { bus.disconnect(); }
  // Import the binding factory directly to avoid constructing a second default instance.
  const noble = require('@stoprocent/noble/lib/resolve-bindings.js')('dbus', { adapterId: adapter }) as typeof import('@stoprocent/noble').default;
  let peripheral: Peripheral | undefined, notification: Characteristic | undefined;
  let phase = 'adapter';
  noble.on('error', (e: Error) => { console.error(`${phase}: ${e.message}`); process.exit(1); });
  try {
    await noble.waitForPoweredOnAsync(10000);
    phase = 'scan';
    let discovered!: (p: Peripheral) => void;
    const found = new Promise<Peripheral>(resolve => {
      discovered = p => { if (p.address.toUpperCase() === device.address.toUpperCase()) resolve(p); };
      noble.on('discover', discovered);
    });
    try { await noble.startScanningAsync([], true); peripheral = await found; }
    finally { noble.removeListener('discover', discovered); await noble.stopScanningAsync(); }
    phase = 'connect';
    await peripheral.connectAsync();
    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE], [NOTIFY, WRITE]);
    notification = characteristics.find(c => c.uuid.replaceAll('-', '').toLowerCase() === NOTIFY);
    const writer = characteristics.find(c => c.uuid.replaceAll('-', '').toLowerCase() === WRITE);
    if (!notification?.properties.includes('notify') || !writer?.properties.includes('writeWithoutResponse')) throw new Error('Required GATT characteristics missing');
    const assembler = new MeterFrame(device.address);
    let received: Buffer = Buffer.alloc(0);
    let done = false;
    const response = new Promise<{ utc: string; address: string; wire_hex: string }>((resolve, reject) => {
      notification!.on('data', (data: Buffer, isNotification: boolean) => {
        if (!isNotification || done) return;
        received = Buffer.concat([received, data]);
        try {
          const row = assembler.push(data);
          if (row) { trace('rx', received); done = true; resolve({ utc: new Date().toISOString(), address: device.address, wire_hex: row.wire_hex }); }
        } catch (e) { trace('rx', received); done = true; reject(e); }
      });
      peripheral!.once('disconnect', () => { if (!done) { if (received.length) trace('rx', received); done = true; reject(new Error('Disconnected before complete response')); } });
    });
    void response.catch(() => {});
    phase = 'subscribe/read';
    await notification.subscribeAsync();
    const request = frame(Buffer.from(device.protocol.readPayloadHex, 'hex'), device.address);
    trace('tx', request);
    await writer.writeAsync(request, true);
    return await response;
  } catch (e) { throw new Error(`${phase}: ${e instanceof Error ? e.message : e}`); }
  finally {
    notification?.removeAllListeners('data');
    try { if (peripheral) await peripheral.disconnectAsync(); } finally { noble.stop(); }
  }
}
read().then(row => process.send!(row, e => process.exit(e ? 1 : 0)))
  .catch(e => { console.error(e.message); process.exit(1); });
