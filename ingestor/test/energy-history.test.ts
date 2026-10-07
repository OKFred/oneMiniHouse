import test from 'node:test';
import assert from 'node:assert/strict';
import { installationBaseline } from '../src/energy-history.ts';
import { PostgresSink, retentionTime } from '../src/database.ts';

const INSTALLATION_TIME_UTC = '2000-01-01T04:00:00.000Z';
const reference = { siteId: 'example-home', gatewayId: 'example-modbus', deviceId: 'meter-main', installationTimeUtc: INSTALLATION_TIME_UTC, sourceTimezone: 'Asia/Shanghai', note: 'Synthetic installation reference' };

test('installation reference rejects absent, wrong-type and ambiguous source identity', () => {
  for (const field of Object.keys(reference)) {
    for (const invalid of [undefined, null, 123, '']) {
      assert.throws(() => installationBaseline({ ...reference, [field]: invalid } as any), /Invalid installation reference/);
    }
  }
  assert.throws(() => installationBaseline({ ...reference, siteId: 'a/b' }), /Invalid/);
  assert.throws(() => installationBaseline({ ...reference, installationTimeUtc: '2000-01-01' }), /Invalid/);
});

test('installation reference uses Beijing noon, preserves provenance and retry identity', () => {
  const a = installationBaseline(reference, 1789927200000), b = installationBaseline(reference, 1789927300000);
  const sample = JSON.parse(a.result.payload);
  assert.equal(INSTALLATION_TIME_UTC, new Date('2000-01-01T12:00:00+08:00').toISOString());
  assert.equal(sample.sample_time_utc, INSTALLATION_TIME_UTC);
  assert.deepEqual(sample.metrics, { energy_kwh: 0 });
  assert.equal(sample.quality, 'historical');
  assert.equal(sample.source.source_kind, 'user_reference');
  assert.equal(sample.source.wire_frames_available, false);
  assert.equal(a.raw.generate_time_utc, null);
  assert.equal(a.result.id, b.result.id); assert.equal(a.result.hash, b.result.hash);
  assert.equal(a.raw.raw_data_sha256, b.raw.raw_data_sha256);
});

test('old installation is retained locally but cannot bypass cloud age limit', () => {
  const { result } = installationBaseline(reference);
  assert.equal(retentionTime(result), Date.parse(INSTALLATION_TIME_UTC));
  const local = PostgresSink.prototype.partitionForRetention.call({ retentionDays: undefined } as PostgresSink, [result]);
  const cloud = PostgresSink.prototype.partitionForRetention.call({ retentionDays: 30, now: () => Date.parse('2026-09-21T00:00:00Z') } as PostgresSink, [result]);
  assert.equal(local.eligible.length, 1); assert.deepEqual(cloud.expired, [result.id]);
});
