import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpuCoreAlerts, validateCpuCoreAlertConfig, validateFeishuWebhook, type CpuCoreAlertConfig } from '../src/cpu-core-alert.ts';
import type { Sample } from '../src/message.ts';

const epoch = Date.parse('2026-01-01T00:00:00.000Z');
const core0 = 'cpu_core_0_temperature_c', core1 = 'cpu_core_1_temperature_c';
const config: CpuCoreAlertConfig = { thresholdC: 85, durationSeconds: 120, maxGapSeconds: 90, maxSampleAgeSeconds: 90,
  sources: [{ siteId: 'example-home', gatewayId: 'example-host', deviceId: 'temperature-example-host', label: '示例主机', coreMetrics: [core0, core1] }] };
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-4000-a000-000000000000';
const at = (seconds: number) => epoch + seconds * 1000;
function sample(seconds: number, a = 90, b = 70): Sample {
  return { schema_version: 2, message_id: randomUUID(), site_id: 'example-home', gateway_id: 'example-host', device_id: 'temperature-example-host',
    quality: 'ok', read_time_utc: new Date(at(seconds)).toISOString(), sample_time_utc: null, observation_kind: 'direct_read',
    source: { driver: 'linux-temperature-mqtt', temperature_source: 'linux_sysfs' }, metrics: { [core0]: a, [core1]: b } };
}
const observe = (alerts: CpuCoreAlerts, seconds: number, a = 90, b = 70) => alerts.observe(sample(seconds, a, b), at(seconds));
function trigger(alerts: CpuCoreAlerts) { observe(alerts, 0); observe(alerts, 60); return observe(alerts, 120); }
const ok: typeof fetch = async () => Response.json({ code: 0 });

test('same core requires a real 120 second span, not two 60 second readings; 85 exactly is safe', () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    assert.equal(observe(alerts, 0, 85).status, 'observed');
    assert.equal(observe(alerts, 60).status, 'observed');
    assert.equal(observe(alerts, 120).status, 'observed');
    assert.equal(observe(alerts, 179).status, 'observed');
    assert.equal(observe(alerts, 180).status, 'alerted');
    assert.equal(alerts.stats().pending, 1);
  } finally { alerts.close(); }
});

test('changing hottest core cannot combine elapsed time; multi-core heat creates only one host notice', () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    observe(alerts, 0, 95, 70); observe(alerts, 60, 70, 96); observe(alerts, 120, 95, 70);
    assert.equal(alerts.stats().pending, 0);
    observe(alerts, 180, 95, 96);
    assert.equal(observe(alerts, 240, 95, 96).status, 'alerted');
    observe(alerts, 300, 95, 96); observe(alerts, 360, 95, 96);
    assert.equal(alerts.stats().pending, 1); assert.equal(alerts.stats().active, 1);
  } finally { alerts.close(); }
});

test('a gap over 90 seconds or missing core interrupts the heating interval', () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    observe(alerts, 0); observe(alerts, 60); observe(alerts, 151); observe(alerts, 211);
    assert.equal(alerts.stats().pending, 0);
    const absent = sample(240); delete absent.metrics[core0]; alerts.observe(absent, at(240));
    observe(alerts, 270); observe(alerts, 330); assert.equal(alerts.stats().pending, 0);
    assert.equal(observe(alerts, 390).status, 'alerted');
  } finally { alerts.close(); }
});

test('duplicates, out of order, future and stale backfill do not form a live interval', () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    const first = sample(0); alerts.observe(first, at(0));
    assert.equal(alerts.observe(first, at(60)).status, 'ignored');
    assert.equal(alerts.observe(sample(60), at(0)).status, 'ignored');
    assert.equal(alerts.observe(sample(60), at(151)).status, 'ignored');
    observe(alerts, 120); assert.equal(alerts.observe(sample(60), at(120)).status, 'ignored');
    observe(alerts, 180); assert.equal(alerts.stats().pending, 0);
    assert.equal(observe(alerts, 240).status, 'alerted');
  } finally { alerts.close(); }
});

test('wrong route, driver, cached state, historical data and GPU cache never participate', () => {
  for (const mutate of [
    (v: Sample) => { v.gateway_id = 'unconfigured-host'; },
    (v: Sample) => { v.source!.driver = 'other-driver'; },
    (v: Sample) => { v.source!.temperature_source = 'nvidia_smi'; },
    (v: Sample) => { v.observation_kind = 'gateway_cached_state'; },
    (v: Sample) => { v.quality = 'historical'; },
  ]) {
    const alerts = new CpuCoreAlerts(':memory:', config);
    try { for (const second of [0, 60, 120]) { const value = sample(second); mutate(value); assert.equal(alerts.observe(value, at(second)).status, 'ignored'); } assert.equal(alerts.stats().pending, 0); }
    finally { alerts.close(); }
  }
});

test('nonsensical temperatures break continuity instead of triggering high-temperature alerts', () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    observe(alerts, 0); observe(alerts, 60, 999); observe(alerts, 120); observe(alerts, 180);
    assert.equal(alerts.stats().pending, 0); assert.equal(observe(alerts, 240).status, 'alerted');
  } finally { alerts.close(); }
});

test('only a fresh all-core safe observation recovers; recovery itself sends nothing', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    trigger(alerts); assert.equal((await alerts.deliverOne(webhook, { now: at(120), fetch: ok })).status, 'sent');
    const absent = sample(180, 70); delete absent.metrics[core1]; alerts.observe(absent, at(180));
    assert.equal(alerts.stats().active, 1);
    observe(alerts, 240, 70, 96); assert.equal(alerts.stats().active, 1);
    assert.equal(observe(alerts, 300, 85, 85).status, 'recovered');
    assert.equal(alerts.stats().active, 0); assert.equal(alerts.stats().pending, 0);
    observe(alerts, 360); observe(alerts, 420); assert.equal(observe(alerts, 480).status, 'alerted');
    assert.equal(alerts.stats().sent, 1); assert.equal(alerts.stats().pending, 1);
  } finally { alerts.close(); }
});

test('stale unsent alert is cancelled and a fresh complete interval can trigger a new event', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    const event = trigger(alerts);
    assert.deepEqual(await alerts.deliverOne(webhook, { now: at(211), fetch: async () => { throw new Error('must not send'); } }),
      { status: 'cancelled', eventId: event.eventId, code: 'ALERT_STALE' });
    assert.equal(alerts.stats().active, 0);
    assert.equal(observe(alerts, 240).status, 'observed');
    assert.equal(observe(alerts, 300).status, 'observed');
    const renewed = observe(alerts, 360);
    assert.equal(renewed.status, 'alerted'); assert.notEqual(renewed.eventId, event.eventId);
    assert.equal((await alerts.deliverOne(webhook, { now: at(360), fetch: ok })).status, 'sent');
  } finally { alerts.close(); }
});

test('an already delivered high-temperature event stays deduplicated through an outage', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    trigger(alerts); await alerts.deliverOne(webhook, { now: at(120), fetch: ok });
    assert.equal((await alerts.deliverOne(webhook, { now: at(240), fetch: ok })).status, 'idle');
    for (const second of [240, 300, 360, 420]) assert.equal(observe(alerts, second).status, 'observed');
    assert.equal(alerts.stats().active, 1); assert.equal(alerts.stats().sent, 1); assert.equal(alerts.stats().pending, 0);
  } finally { alerts.close(); }
});

test('an unsent event with no current qualifying core re-arms without combining core intervals', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    const event = trigger(alerts); observe(alerts, 180, 70, 95);
    assert.equal((await alerts.deliverOne(webhook, { now: at(180), fetch: ok })).code, 'NO_CURRENT_QUALIFYING_CORE');
    assert.equal(observe(alerts, 240, 70, 95).status, 'observed');
    assert.equal(observe(alerts, 300, 70, 95).status, 'observed');
    const renewed = observe(alerts, 360, 70, 95);
    assert.equal(renewed.status, 'alerted'); assert.notEqual(renewed.eventId, event.eventId);
  } finally { alerts.close(); }
});

test('a failed or malformed Feishu acknowledgment retries without printing credentials', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    trigger(alerts);
    assert.equal((await alerts.deliverOne(webhook, { now: at(120), fetch: async () => Response.json({ code: 19001, message: webhook }) })).status, 'retry');
    assert.equal((await alerts.deliverOne(webhook, { now: at(121), fetch: ok })).status, 'idle');
    assert.equal((await alerts.deliverOne(webhook, { now: at(135), fetch: async () => new Response('not JSON') })).status, 'retry');
    observe(alerts, 180);
    const result = await alerts.deliverOne(webhook, { now: at(180), fetch: ok });
    assert.equal(result.status, 'sent'); assert.equal(result.attempts, 3); assert.ok(!JSON.stringify(result).includes('hook'));
    assert.equal((await alerts.deliverOne(webhook, { now: at(190), fetch: ok })).status, 'idle');
  } finally { alerts.close(); }
});

test('notification retries are capped, retain stable event IDs and survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpu-alert-')), path = join(dir, 'alerts.sqlite');
  let alerts = new CpuCoreAlerts(path, config);
  try {
    observe(alerts, 0); observe(alerts, 60); alerts.close(); alerts = new CpuCoreAlerts(path, config);
    const event = observe(alerts, 120); assert.equal(event.status, 'alerted');
    const bodies: string[] = [];
    const fail: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); throw new Error(webhook); };
    for (const second of [120, 135, 165, 225, 345]) {
      // Advance real samples often enough to keep the episode current while transport fails.
      if (second === 225) observe(alerts, 210);
      if (second === 345) { observe(alerts, 270); observe(alerts, 330); }
      const result = await alerts.deliverOne(webhook, { now: at(second), fetch: fail });
      assert.equal(result.eventId, event.eventId); assert.equal(result.code, 'FEISHU_NETWORK_ERROR');
    }
    alerts.close(); alerts = new CpuCoreAlerts(path, config);
    assert.equal(alerts.stats().failed, 1); assert.equal(bodies.length, 5);
    assert.ok(bodies.every(body => body.includes(event.eventId!)));
    assert.equal((await alerts.deliverOne(webhook, { now: at(400), fetch: ok })).status, 'idle');
  } finally { alerts.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('successful Feishu message carries source, threshold, measured time and qualified cores without @all', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    trigger(alerts); let sent: any;
    const result = await alerts.deliverOne(webhook, { now: at(120), fetch: async (url, init) => {
      assert.equal(url, webhook); assert.equal(init!.redirect, 'error'); sent = JSON.parse(String(init!.body)); return Response.json({ code: 0 });
    } });
    assert.equal(result.status, 'sent'); assert.equal(sent.msg_type, 'text');
    for (const value of ['示例主机', '120', '85°C', core0, '2026-01-01T00:02:00.000Z', result.eventId]) assert.ok(sent.content.text.includes(value));
    assert.ok(!sent.content.text.includes(core1)); assert.ok(!sent.content.text.includes('<at'));
  } finally { alerts.close(); }
});

test('recovering before dispatch cancels an obsolete queued alert', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try { trigger(alerts); observe(alerts, 180, 70, 70); assert.equal(alerts.stats().cancelled, 1); assert.equal((await alerts.deliverOne(webhook, { now: at(180), fetch: ok })).status, 'idle'); }
  finally { alerts.close(); }
});

test('a recovery while a failing request is in flight cannot resurrect its pending notice', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    trigger(alerts);
    await alerts.deliverOne(webhook, { now: at(120), fetch: async () => { observe(alerts, 180, 70, 70); throw new Error('transient'); } });
    assert.equal(alerts.stats().pending, 0); assert.equal(alerts.stats().cancelled, 1); assert.equal(alerts.stats().notification_error, null);
    assert.equal((await alerts.deliverOne(webhook, { now: at(180), fetch: ok })).status, 'idle');
  } finally { alerts.close(); }
});

test('notification errors affect active episodes only, and success clears retry health', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    trigger(alerts);
    await alerts.deliverOne(webhook, { now: at(120), fetch: async () => new Response('', { status: 503 }) });
    assert.equal(alerts.stats().notification_error, 'FEISHU_HTTP_ERROR');
    await alerts.deliverOne(webhook, { now: at(135), fetch: ok }); assert.equal(alerts.stats().notification_error, null);
    observe(alerts, 180, 70, 70); assert.equal(alerts.stats().notification_error, null);
  } finally { alerts.close(); }
});

test('duplicate, out-of-order, stale and future low readings cannot recover an active episode', () => {
  const alerts = new CpuCoreAlerts(':memory:', config);
  try {
    trigger(alerts);
    for (const [read, receive] of [[120, 120], [60, 120], [180, 271], [300, 180]]) {
      assert.equal(alerts.observe(sample(read, 70, 70), at(receive)).status, 'ignored');
      assert.equal(alerts.stats().active, 1);
    }
  } finally { alerts.close(); }
});

test('graceful shutdown preserves a pending notice and does not consume a retry or mark failure', async () => {
  const alerts = new CpuCoreAlerts(':memory:', config), controller = new AbortController();
  try {
    trigger(alerts);
    const result = await alerts.deliverOne(webhook, { now: at(120), signal: controller.signal, fetch: async () => {
      controller.abort(); throw new Error('shutdown');
    } });
    assert.equal(result.code, 'NOTIFIER_STOPPING'); assert.equal(result.attempts, 0);
    assert.equal(alerts.stats().pending, 1); assert.equal(alerts.stats().failed, 0); assert.equal(alerts.stats().notification_error, null);
    assert.equal((await alerts.deliverOne(webhook, { now: at(121), fetch: ok })).attempts, 1);
  } finally { alerts.close(); }
});

test('configuration changes reset continuity and cancel notices made under previous rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpu-alert-config-')), path = join(dir, 'alerts.sqlite');
  let alerts = new CpuCoreAlerts(path, config);
  try {
    trigger(alerts); alerts.close(); alerts = new CpuCoreAlerts(path, { ...config, thresholdC: 90 });
    assert.equal(alerts.stats().active, 0); assert.equal(alerts.stats().pending, 0); assert.equal(alerts.stats().cancelled, 1);
    observe(alerts, 180, 95); assert.equal(alerts.stats().pending, 0);
  } finally { alerts.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('source configuration and webhook validation reject unsafe or ambiguous settings', () => {
  assert.doesNotThrow(() => validateCpuCoreAlertConfig(config));
  for (const bad of [{ ...config, durationSeconds: 60 }, { ...config, maxGapSeconds: 120 }, { ...config, maxSampleAgeSeconds: 3600 },
    { ...config, sources: [...config.sources, ...config.sources] }, { ...config, sources: [{ ...config.sources[0], coreMetrics: ['cpu_package_temperature_c'] }] }]) assert.throws(() => validateCpuCoreAlertConfig(bad));
  assert.doesNotThrow(() => validateFeishuWebhook(webhook));
  for (const value of [webhook.replace('https:', 'http:'), webhook.replace('open.feishu.cn', 'example.com'), `${webhook}?secret=value`, `https://user:password@open.feishu.cn${new URL(webhook).pathname}`]) assert.throws(() => validateFeishuWebhook(value), /^Error: Invalid Feishu webhook$/);
});
