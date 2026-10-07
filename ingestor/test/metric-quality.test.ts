import assert from 'node:assert/strict';
import test from 'node:test';
import { assessMetricQuality } from '../src/metric-quality.ts';

const source = { driver: 'xiaomi-gateway-v3-temperature', sensor_model: 'WSDCGQ01LM' };
const assess = (temperature_c: unknown, humidity_pct: unknown) => assessMetricQuality({ source, metrics: { temperature_c, humidity_pct } })!;

test('WSDCGQ01LM official limits are inclusive, with explicit units and versioned provenance', () => {
  const lower = assess(-20, 10);
  assert.deepEqual(lower, {
    rule_id: 'wsdcgq01lm-official-detection-range', rule_version: '1',
    metrics: {
      temperature_c: { status: 'ok', minimum: -20, maximum: 50, unit: '°C' },
      humidity_pct: { status: 'ok', minimum: 10, maximum: 90, unit: '%RH' },
    },
  });
  assert.equal(assess(50, 90).metrics.temperature_c.status, 'ok');
  assert.equal(assess(50, 90).metrics.humidity_pct.status, 'ok');
  assert.equal(assess(-20.01, 9.99).metrics.temperature_c.status, 'out_of_spec');
  assert.equal(assess(-20.01, 9.99).metrics.humidity_pct.status, 'out_of_spec');
  assert.equal(assess(50.01, 90.01).metrics.temperature_c.status, 'out_of_spec');
  assert.equal(assess(50.01, 90.01).metrics.humidity_pct.status, 'out_of_spec');
});

test('100°C and zero humidity are retained as out-of-spec readings, without clamping', () => {
  const metrics = { temperature_c: 100, humidity_pct: 0 };
  const quality = assessMetricQuality({ source, metrics })!;
  assert.equal(quality.metrics.temperature_c.status, 'out_of_spec');
  assert.equal(quality.metrics.humidity_pct.status, 'out_of_spec');
  assert.deepEqual(metrics, { temperature_c: 100, humidity_pct: 0 });
});

test('one out-of-spec metric does not invalidate the other metric', () => {
  assert.equal(assess(100, 45).metrics.temperature_c.status, 'out_of_spec');
  assert.equal(assess(100, 45).metrics.humidity_pct.status, 'ok');
  assert.equal(assess(25, 0).metrics.temperature_c.status, 'ok');
  assert.equal(assess(25, 0).metrics.humidity_pct.status, 'out_of_spec');
});

test('absent metrics are missing and never become zero', () => {
  const metrics = { humidity_pct: 45 };
  const result = assessMetricQuality({ source, metrics })!;
  assert.equal(result.metrics.temperature_c.status, 'missing');
  assert.equal(result.metrics.humidity_pct.status, 'ok');
  assert.equal(Object.hasOwn(metrics, 'temperature_c'), false);
  assert.equal(assessMetricQuality({ source, metrics: {} })!.metrics.humidity_pct.status, 'missing');
});

test('non-numeric and non-finite values are invalid rather than out-of-spec', () => {
  for (const value of [NaN, Infinity, -Infinity, '25', null, true, [], {}]) {
    assert.equal(assess(value, value).metrics.temperature_c.status, 'invalid');
    assert.equal(assess(value, value).metrics.humidity_pct.status, 'invalid');
  }
});

test('rule only applies to the exact source driver and sensor model, not CPU temperatures', () => {
  for (const otherSource of [
    undefined,
    { driver: 'linux-hwmon', sensor_model: 'WSDCGQ01LM' },
    { driver: 'xiaomi-gateway-v3-temperature', sensor_model: 'WSDCGQ11LM' },
    { driver: 'xiaomi-gateway-v3-temperature', model: 'WSDCGQ01LM' },
    { driver: 'xiaomi-gateway-v3-temperature' },
    { driver: 'linux-hwmon', model: 'example-host' },
  ]) assert.equal(assessMetricQuality({ source: otherSource, metrics: { temperature_c: 75, cpu_temperature_c: 75 } }), undefined);
});

test('assessment does not mutate frozen input or share mutable result state', () => {
  const sample = Object.freeze({
    message_id: '00000000-0000-4000-8000-000000000001', quality: 'ok',
    source: Object.freeze({ ...source, observation_kind: 'gateway_cached_state' }),
    metrics: Object.freeze({ temperature_c: 100, humidity_pct: 0, battery_pct: 85 }),
  });
  const before = JSON.stringify(sample);
  const first = assessMetricQuality(sample)!;
  first.metrics.temperature_c.minimum = 0;
  assert.equal(assessMetricQuality(sample)!.metrics.temperature_c.minimum, -20);
  assert.equal(JSON.stringify(sample), before);
});
