function macBytes(address: string): Buffer {
  if (!/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(address)) throw new Error('Invalid MAC address');
  return Buffer.from(address.replaceAll(':', ''), 'hex');
}

export function checksum(payload: Uint8Array, address: string): number {
  const mac = macBytes(address);
  let crc = mac[5] + mac[4] + 10;
  const polynomial = ((mac[5] + 11) << 8) | mac[4];
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? polynomial : 0);
  }
  return crc & 0xffff;
}

function xorMac(data: Buffer, address: string): Buffer {
  const mask = macBytes(address).reduce((sum, byte) => sum + byte, 0) & 255;
  return Buffer.from(data.map(byte => byte ^ mask));
}

export function frameCrcValid(wire: Buffer, address: string): boolean | undefined {
  const raw = xorMac(wire, address);
  if (raw.length < 6 || raw.readUInt16BE(0) !== 0xeced || raw.length !== raw.readUInt16BE(2) + 6) return undefined;
  return checksum(raw.subarray(4, -2), address) === raw.readUInt16BE(raw.length - 2);
}

export function frame(payload: Buffer, address: string): Buffer {
  if (payload.length > 0xffff) throw new Error('Payload too long');
  const raw = Buffer.alloc(payload.length + 6);
  raw.writeUInt16BE(0xeced, 0);
  raw.writeUInt16BE(payload.length, 2);
  payload.copy(raw, 4);
  raw.writeUInt16BE(checksum(payload, address), raw.length - 2);
  return xorMac(raw, address);
}

export function decodeFrame(wire: Buffer, address: string) {
  const raw = xorMac(wire, address);
  if (raw.length !== 38) throw new Error('Expected a complete 38-byte metering frame');
  if (raw.readUInt16BE(0) !== 0xeced || raw.readUInt16BE(2) !== 32) {
    throw new Error('Unexpected frame header or length');
  }
  const payload = raw.subarray(4, -2);
  if (checksum(payload, address) !== raw.readUInt16BE(raw.length - 2)) throw new Error('CRC mismatch');
  const data = Buffer.from(payload.map(byte => byte ^ 0xa5));
  if (data[0] !== 0x08 || data[1] !== 0x1d || data[30] !== 5) {
    throw new Error('Unsupported metering response or firmware');
  }
  // V5 metering layout; address and read command are supplied by the device configuration.
  // Offsets/scaling were verified against V5 packets; integers are big endian.
  return {
    energy_kwh: data.readUInt32BE(3) / 100,
    duration_minutes: data.readUInt32BE(7),
    power_w: data.readUInt16BE(11) / 10,
    voltage_v: data.readUInt16BE(13) / 10,
    current_a: data.readUInt16BE(15) / 1000,
    power_factor: data[17] / 100,
    amount_yuan: data.readUInt32BE(24) / 100,
    firmware: data[30],
    wire_hex: wire.toString('hex'),
    crc_valid: true as const,
  };
}

type Values = ReturnType<typeof decodeFrame>;

export class MeterFrame {
  private readonly address: string;
  constructor(address: string) { this.address = address; }
  private buffer: Buffer = Buffer.alloc(0);
  private complete = false;

  push(chunk: Buffer): Values | undefined {
    if (this.complete) throw new Error('Frame already complete');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 38) throw new Error('Metering frame exceeds 38 bytes');
    if (this.buffer.length >= 4) {
      const head = xorMac(this.buffer.subarray(0, 4), this.address);
      if (head.readUInt16BE(0) !== 0xeced || head.readUInt16BE(2) !== 32) {
        throw new Error('Unexpected notification header or length');
      }
    }
    if (this.buffer.length < 38) return;
    const reading = decodeFrame(this.buffer, this.address);
    this.complete = true;
    return reading;
  }
}
