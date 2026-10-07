import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeterFrame, decodeFrame, frame, frameCrcValid } from '../src/protocol.ts';

// Synthetic identifiers and values using the validated V5 layout; fixed golden bytes.
const ADDRESS = '02:00:00:00:00:01';
const FIXTURE = Buffer.from('efee0323aebba6a6a6969fa6a6bc23a1aeae5aa522f1af62a6a6a694a6a6bebaa6a6a30a0846', 'hex');

test('matches fixed synthetic vectors for two MAC-derived checksums', () => {
  assert.equal(frame(Buffer.from('b0b8b0', 'hex'), ADDRESS).toString('hex'), 'efee0300b3bbb30118');
  assert.equal(frame(Buffer.from('555d55', 'hex'), '02:00:00:00:00:02').toString('hex'), 'e8e904075159510d03');
});

test('decodes synthetic readings with verified layout and units', () => {
  const row = decodeFrame(FIXTURE, ADDRESS);
  assert.deepEqual([row.energy_kwh, row.power_w, row.voltage_v, row.current_a, row.power_factor,
    row.duration_minutes, row.amount_yuan, row.firmware], [123.45, 180, 230, 0.9, 0.87, 6789, 61.72, 5]);
  assert.equal(row.crc_valid, true);
});

test('assembles every possible two-chunk boundary, including the observed 20 + 18', () => {
  for (let boundary = 1; boundary < FIXTURE.length; boundary++) {
    const assembler = new MeterFrame(ADDRESS);
    assert.equal(assembler.push(FIXTURE.subarray(0, boundary)), undefined);
    assert.equal(assembler.push(FIXTURE.subarray(boundary))?.energy_kwh, 123.45);
  }
});

test('never treats partial/corrupt/oversized packets as a reading', () => {
  assert.throws(() => decodeFrame(FIXTURE.subarray(0, 20), ADDRESS), /complete/);
  const corrupt = Buffer.from(FIXTURE); corrupt[14] ^= 1;
  assert.equal(frameCrcValid(FIXTURE, ADDRESS), true);
  assert.equal(frameCrcValid(corrupt, ADDRESS), false);
  assert.equal(frameCrcValid(FIXTURE.subarray(0,20), ADDRESS), undefined);
  assert.throws(() => decodeFrame(corrupt, ADDRESS), /CRC/);
  const header = Buffer.from(FIXTURE); header[0] ^= 1;
  assert.throws(() => new MeterFrame(ADDRESS).push(header), /header/);
  assert.throws(() => new MeterFrame(ADDRESS).push(Buffer.concat([FIXTURE, Buffer.from([0])])), /exceeds/);
});

test('rejects unsupported response types even with a valid outer CRC', () => {
  const mask = Buffer.from(ADDRESS.replaceAll(':', ''), 'hex').reduce((a, b) => a + b, 0) & 255;
  const payload = Buffer.from(FIXTURE.subarray(4, -2).map(byte => byte ^ mask));
  payload[0] ^= 1;
  assert.throws(() => decodeFrame(frame(payload, ADDRESS), ADDRESS), /Unsupported/);
});
