import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateConfig, mqttSubscriptions } from '../src/config.ts';

function example() {
  const base = JSON.parse(readFileSync(new URL('../config/ingestor.example.json', import.meta.url), 'utf8'));
  const extension = JSON.parse(readFileSync(new URL('../config/cpu-core-alerts.example.json', import.meta.url), 'utf8'));
  base.mqtt.topicPrefixes.push('iot/v1/example-home/example-host');
  return { ...base, ...extension };
}

test('CPU alert extension is optional and the example uses the existing host telemetry subscription', () => {
  const value = example(), enabled = validateConfig(value);
  assert.equal(enabled.cpuCoreAlerts!.thresholdC, 85);
  assert.equal(enabled.cpuCoreAlerts!.durationSeconds, 120);
  const topics = mqttSubscriptions(enabled);
  assert.equal(topics.filter(v => v === 'iot/v1/example-home/example-host/devices/+/telemetry').length, 1);
  const { cpuCoreAlerts, ...disabled } = value;
  assert.doesNotThrow(() => validateConfig(disabled));
  assert.deepEqual(mqttSubscriptions(validateConfig(disabled)), topics);
  assert.equal(cpuCoreAlerts.webhookFile, '/run/secrets/feishu_webhook');
});

test('CPU alert configuration requires a separate webhook file and rejects plaintext-only configuration', () => {
  const value = example();
  delete value.cpuCoreAlerts.webhookFile;
  assert.throws(() => validateConfig(value), /webhookFile required/);
  value.cpuCoreAlerts.webhook = 'https://example.com/not-a-credential';
  assert.throws(() => validateConfig(value), /webhookFile required/);
  value.cpuCoreAlerts.webhookFile = '  ';
  assert.throws(() => validateConfig(value), /webhookFile required/);
});

test('an alert source must already belong to an exact subscribed site and gateway', () => {
  for (const field of ['siteId', 'gatewayId']) {
    const value = example();
    value.cpuCoreAlerts.sources[0][field] = 'unsubscribed-example';
    assert.throws(() => validateConfig(value), /telemetry subscription/);
  }
  const value = example();
  value.mqtt.topicPrefixes = value.mqtt.topicPrefixes.filter((p: string) => !p.endsWith('/example-host'));
  assert.throws(() => validateConfig(value), /telemetry subscription/);
});
