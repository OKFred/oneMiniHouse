import { Socket } from 'node:net';
import { crc16, RtuFrames, responseData, validCrc } from './modbus.ts';
import type { LightDeviceConfig } from './config.ts';
import type { FrameObserver } from './frames.ts';
import type { DriverReading } from './runner.ts';

// Historical sensor query: FC03, register 0x0002, two registers, unsigned BE.
// B-RS-L30: legacy tcp_client and an independent same-model implementation
// both use raw / 1000 lux. Manufacturer protocol is not yet independently verified.
// Preserve raw counts alongside the derived physical metric for traceability.
export function lightRequest(slave: number): Buffer {
  if (!Number.isInteger(slave) || slave < 1 || slave > 247) throw new Error('Invalid light slave');
  const b = Buffer.from([slave, 3, 0, 2, 0, 2, 0, 0]);
  b.writeUInt16LE(crc16(b.subarray(0, 6)), 6);
  return b;
}

export async function readLight(device: LightDeviceConfig, signal: AbortSignal, observer?: FrameObserver, timeoutMs = device.timeoutSeconds * 1000): Promise<DriverReading> {
  signal.throwIfAborted();
  const request = lightRequest(device.slaveId);
  const socket = new Socket();
  const parser = new RtuFrames();
  const closed = new Promise<void>(resolve => socket.once('close', resolve));
  let cleanup = () => {};
  try {
    return await new Promise<DriverReading>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (!settled) { settled = true; reject(error); }
        socket.destroy();
      };
      const abort = () => fail(new Error('Light collection cancelled'));
      const timer = setTimeout(() => fail(new Error('Light Modbus response timeout')), timeoutMs);
      cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      signal.addEventListener('abort', abort, { once: true });
      socket.on('error', fail);
      socket.on('close', () => { if (!settled) fail(new Error('Light TCP closed before complete response')); });
      socket.on('data', chunk => {
        try {
          const frames = parser.push(chunk);
          if (!frames.length) return;
          for (const frame of frames) observer?.({ direction: 'rx', protocol: 'modbus-rtu', frame_time_utc: new Date().toISOString(), wire_hex: frame.toString('hex'), crc_valid: validCrc(frame) });
          if (frames.length !== 1 || settled) throw new Error('Unexpected extra light response');
          const data = responseData(frames[0], device.slaveId, 2);
          const value = data.readUInt32BE(0);
          settled = true;
          resolve({ utc: new Date().toISOString(), metrics: { light_raw_count: value, illuminance_lux: value / 1000 }, source: {
            driver: device.driver, transport: 'rtu-over-tcp', slave_id: device.slaveId,
            register_profile: 'light-fc03-0002-u32be', crc_valid: true,
            sensor_model: 'B-RS-L30', measurement_unit: 'lux',
            scale_factor: 0.001, scale_divisor: 1000,
            scale_basis: 'legacy-code-and-same-model-implementation',
            manufacturer_protocol_verified: false,
          } });
        } catch (error) { fail(error); }
      });
      socket.once('connect', () => {
        try {
          observer?.({ direction: 'tx', protocol: 'modbus-rtu', frame_time_utc: new Date().toISOString(), wire_hex: request.toString('hex'), crc_valid: true });
          socket.setNoDelay(true); socket.write(request);
        } catch (error) { fail(error); }
      });
      socket.connect(device.port, device.host);
      if (signal.aborted) abort();
    });
  } finally {
    cleanup(); socket.destroy(); await closed;
  }
}
