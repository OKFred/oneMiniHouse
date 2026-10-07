import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BleDeviceConfig, DeviceConfig } from './config.ts';
import { decodeFrame } from './protocol.ts';
import { readModbus } from './modbus.ts';
import { readLight } from './light.ts';
import { readXiaomi } from './xiaomi.ts';
import { readHostTemperature } from './temperature.ts';
import { FrameStorageError, type FrameObserver, type ProtocolFrame } from './frames.ts';

export interface WireReading { utc: string; address: string; wire_hex: string }
export interface DriverReading {
  utc: string;
  sampleTimeUtc?: string;
  metrics: Record<string, number>;
  source: Record<string, string | number | boolean>;
  diagnostics?: Record<string, string | number | boolean>;
}
export interface Driver { read(device: DeviceConfig, adapter: string | undefined, signal: AbortSignal, onFrame?: FrameObserver): Promise<DriverReading> }
export function runWorker(device: BleDeviceConfig, adapter: string, signal: AbortSignal, workerFile = fileURLToPath(new URL('./worker.ts', import.meta.url)), timeoutMs = device.timeoutSeconds * 1000, onFrame?: FrameObserver): Promise<WireReading> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = fork(workerFile, [], { silent: true, env: { ...process.env, BLE_DEVICE: JSON.stringify(device), BLE_ADAPTER: adapter } });
    let result: unknown, failure: Error | undefined, stderr = '';
    child.stderr?.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
    child.stdout?.resume();
    child.on('message', m => {
      const trace = m as { kind?: string; frame?: ProtocolFrame };
      if (trace.kind !== 'frame') { result = m; return; }
      try {
        const f = trace.frame;
        if (!f || f.protocol !== 'yunmu-v5' || !['tx', 'rx'].includes(f.direction) || !Number.isFinite(Date.parse(f.frame_time_utc)) || !/^(?:[\da-f]{2}){1,512}$/i.test(f.wire_hex)) throw new Error('Invalid worker trace');
        onFrame?.(f);
      } catch (error) { failure = error instanceof FrameStorageError ? error : new Error('Worker frame capture failed', { cause: error }); child.kill('SIGKILL'); }
    });
    const stop = (reason: string) => { failure = new Error(reason); child.kill('SIGKILL'); };
    const abort = () => stop('Cancelled');
    const timer = setTimeout(() => stop(`BLE attempt timed out after ${timeoutMs}ms`), timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', error => { cleanup(); reject(error); });
    // Reap before returning, including timeout: adapter attempts can never overlap.
    child.once('close', code => {
      cleanup();
      if (failure || code !== 0) return reject(failure ?? new Error(stderr.trim() || `Worker exit ${code}`));
      try {
        const row = result as WireReading;
        if (row?.address?.toUpperCase() !== device.address.toUpperCase() || !Number.isFinite(Date.parse(row.utc)) || !/^[\da-f]{76}$/i.test(row.wire_hex)) throw new Error('Invalid worker reading');
        decodeFrame(Buffer.from(row.wire_hex, 'hex'), device.address);
        resolve(row);
      } catch (e) { reject(e); }
    });
  });
}
export const drivers: Record<DeviceConfig['driver'], Driver> = { 'yunmu-v5': {
  async read(device, adapter, signal, onFrame) {
    if (device.driver !== 'yunmu-v5' || !adapter) throw new Error('BLE device and adapter required');
    const row = await runWorker(device, adapter, signal, undefined, undefined, onFrame);
    const { wire_hex, firmware, crc_valid, ...metrics } = decodeFrame(Buffer.from(row.wire_hex, 'hex'), device.address);
    return { utc: row.utc, metrics, source: { driver: device.driver, address: device.address, firmware, crc_valid }, diagnostics: { wire_hex } };
  },
}, 'chint-ddsu666-rtu-tcp': {
  async read(device, _adapter, signal, onFrame) {
    if (device.driver !== 'chint-ddsu666-rtu-tcp') throw new Error('Modbus device required');
    return readModbus(device, signal, onFrame);
  },
}, 'modbus-light-u32-rtu-tcp': {
  async read(device, _adapter, signal, onFrame) {
    if (device.driver !== 'modbus-light-u32-rtu-tcp') throw new Error('Light device required');
    return readLight(device, signal, onFrame);
  },
}, 'xiaomi-gateway-v3-temperature': {
  async read(device, _adapter, signal) {
    if (device.driver !== 'xiaomi-gateway-v3-temperature') throw new Error('Xiaomi device required');
    return readXiaomi(device, signal);
  },
}, 'linux-temperature-ssh': {
  async read(device, _adapter, signal) {
    if (device.driver !== 'linux-temperature-ssh') throw new Error('Host temperature device required');
    return readHostTemperature(device, signal);
  },
} };
