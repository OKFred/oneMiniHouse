import { Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ModbusDeviceConfig } from './config.ts';
import { FrameStorageError, type FrameObserver } from './frames.ts';
import type { DriverReading } from './runner.ts';

export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}
export function validCrc(frame: Buffer): boolean { return frame.length >= 4 && crc16(frame.subarray(0, -2)) === frame.readUInt16LE(frame.length - 2); }
export function readRequest(slaveId: number, register: number, quantity: number): Buffer {
  if (!Number.isInteger(slaveId) || slaveId < 1 || slaveId > 247) throw new Error('Invalid Modbus slave');
  if (!(register === 0x4000 && quantity === 2) && !(register === 0x2000 && quantity === 16)) throw new Error('Only the two verified FC03 metering reads are allowed');
  const request = Buffer.alloc(8);
  request[0] = slaveId; request[1] = 3; request.writeUInt16BE(register, 2); request.writeUInt16BE(quantity, 4);
  request.writeUInt16LE(crc16(request.subarray(0, 6)), 6);
  return request;
}

// TCP chunks are not RTU frame boundaries. CRC and request matching are checked
// after extracting complete frames; surplus/unsolicited frames fail the attempt.
export class RtuFrames {
  private bytes: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    if (this.bytes.length > 512) throw new Error('Oversized RTU stream');
    const frames: Buffer[] = [];
    while (this.bytes.length >= 2) {
      const fn = this.bytes[1];
      if (fn !== 3 && fn !== 0x83) throw new Error('Unexpected Modbus function or non-Modbus response (serial port may be busy)');
      if (fn === 3 && this.bytes.length < 3) break;
      const count = this.bytes[2];
      if (fn === 3 && (count < 2 || count > 250 || count % 2)) throw new Error('Invalid Modbus byte count');
      const length = fn === 0x83 ? 5 : count + 5;
      if (this.bytes.length < length) break;
      frames.push(Buffer.from(this.bytes.subarray(0, length)));
      this.bytes = this.bytes.subarray(length);
    }
    return frames;
  }
}
export function responseData(frame: Buffer, slaveId: number, quantity: number): Buffer {
  if (!validCrc(frame)) throw new Error('Modbus CRC mismatch');
  if (frame[0] !== slaveId) throw new Error('Unexpected Modbus slave');
  if (frame[1] === 0x83 && frame.length === 5) throw new Error(`Modbus exception ${frame[2]}`);
  if (frame[1] !== 3 || frame[2] !== quantity * 2 || frame.length !== quantity * 2 + 5) throw new Error('Modbus response does not match requested registers');
  return frame.subarray(3, -2);
}
export function decodeRegisters(energy: Buffer, params: Buffer): Record<string, number> {
  if (energy.length !== 4 || params.length !== 32) throw new Error('Incomplete DDSU666 registers');
  const values = {
    energy_kwh: energy.readFloatBE(0), voltage_v: params.readFloatBE(0), current_a: params.readFloatBE(4),
    power_w: params.readFloatBE(8) * 1000, reactive_power_var: params.readFloatBE(12) * 1000,
    power_factor: params.readFloatBE(20), frequency_hz: params.readFloatBE(28),
  };
  if (!Object.values(values).every(Number.isFinite)) throw new Error('Non-finite DDSU666 register value');
  // Reserved registers 0x2008 and 0x200C are deliberately ignored. Do not
  // mislabel their contents as measured apparent power or frequency.
  return values;
}

type TimedData = { bytes: Buffer; time: string };
class RtuConnection {
  private socket = new Socket();
  private parser = new RtuFrames();
  private pending?: { quantity: number; resolve: (data: TimedData) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
  private failure?: Error;
  private connectReject?: (e: Error) => void;
  private closed: Promise<void>;
  private detach = () => {};
  private device: ModbusDeviceConfig;
  private observer?: FrameObserver;
  private responseMs: number;
  constructor(device: ModbusDeviceConfig, observer: FrameObserver | undefined, responseMs: number) {
    this.device = device; this.observer = observer; this.responseMs = responseMs;
    this.closed = new Promise(resolve => this.socket.once('close', () => { this.fail(new Error('Modbus TCP disconnected')); resolve(); }));
    this.socket.on('error', error => this.fail(error));
    this.socket.on('data', chunk => {
      try {
        let frames: Buffer[];
        try { frames = this.parser.push(chunk); }
        catch (error) {
          this.observer?.({ direction: 'rx', protocol: 'modbus-rtu', frame_time_utc: new Date().toISOString(), wire_hex: chunk.subarray(0, 512).toString('hex') });
          throw error;
        }
        for (const frame of frames) {
          const time = new Date().toISOString();
          this.observer?.({ direction: 'rx', protocol: 'modbus-rtu', frame_time_utc: time, wire_hex: frame.toString('hex'), crc_valid: validCrc(frame) });
          if (!this.pending) throw new Error('Unsolicited or duplicate Modbus response');
          const bytes = responseData(frame, this.device.slaveId, this.pending.quantity);
          const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
          pending.resolve({ bytes, time });
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  async connect(signal: AbortSignal, timeoutMs: number) {
    signal.throwIfAborted();
    const abort = () => this.fail(new Error('Modbus collection cancelled or timed out'));
    signal.addEventListener('abort', abort, { once: true }); this.detach = () => signal.removeEventListener('abort', abort);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Modbus TCP connection timeout')), timeoutMs);
      this.connectReject = e => { clearTimeout(timer); reject(e); };
      this.socket.once('connect', () => { clearTimeout(timer); this.connectReject = undefined; this.socket.setNoDelay(true); resolve(); });
      this.socket.connect(this.device.port, this.device.host);
      if (signal.aborted) abort();
    });
  }
  private fail(error: Error) {
    this.failure ??= error;
    this.connectReject?.(this.failure); this.connectReject = undefined;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(this.failure); this.pending = undefined; }
    this.socket.destroy();
  }
  query(register: number, quantity: number): Promise<TimedData> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('Overlapping Modbus request'));
    const request = readRequest(this.device.slaveId, register, quantity);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Modbus response timeout')), this.responseMs);
      this.pending = { quantity, resolve, reject, timer };
      try {
        this.observer?.({ direction: 'tx', protocol: 'modbus-rtu', frame_time_utc: new Date().toISOString(), wire_hex: request.toString('hex'), crc_valid: true });
        this.socket.write(request);
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  assertHealthy() { if (this.failure) throw this.failure; }
  async close() { this.detach(); this.socket.destroy(); await this.closed; }
}

export async function readModbus(device: ModbusDeviceConfig, signal: AbortSignal, observer?: FrameObserver, options: { connectMs?: number; responseMs?: number; retryDelayMs?: number } = {}): Promise<DriverReading> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(device.timeoutSeconds * 1000))]);
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    bounded.throwIfAborted();
    const connection = new RtuConnection(device, observer, options.responseMs ?? 5000);
    try {
      await connection.connect(bounded, options.connectMs ?? 5000);
      const energy = await connection.query(0x4000, 2);
      // 9600 baud RTU needs an inter-frame gap. This also lets TCP close/errors
      // from surplus data surface before sending the next request.
      await sleep(20, undefined, { signal: bounded });
      const params = await connection.query(0x2000, 16);
      connection.assertHealthy();
      const metrics = decodeRegisters(energy.bytes, params.bytes);
      return { utc: params.time, metrics, source: {
        driver: device.driver, transport: 'rtu-over-tcp', slave_id: device.slaveId,
        register_profile: 'ddsu666-2000-4000-v1', crc_valid: true,
        energy_time_utc: energy.time, parameters_time_utc: params.time,
      } };
    } catch (error) {
      if (error instanceof FrameStorageError) throw error;
      last = error;
    } finally { await connection.close(); }
    if (attempt === 0) await sleep(options.retryDelayMs ?? 250, undefined, { signal: bounded });
  }
  throw last;
}
