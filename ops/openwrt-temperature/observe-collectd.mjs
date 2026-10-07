import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../../ingestor/package.json', import.meta.url));
const { connect } = require('mqtt');
const { MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD_FILE, MQTT_TOPIC, MQTT_EVIDENCE_FILE } = process.env;
if (![MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD_FILE, MQTT_TOPIC, MQTT_EVIDENCE_FILE].every(Boolean)) {
  throw new Error('Set MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD_FILE, MQTT_TOPIC, MQTT_EVIDENCE_FILE');
}
const duration = Number(process.env.MQTT_CAPTURE_SECONDS || 200);
if (!Number.isFinite(duration) || duration < 1 || duration > 600) throw new Error('Invalid capture duration');
const messages = [];
const client = connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: (await readFile(MQTT_PASSWORD_FILE, 'utf8')).trim(),
  clientId: `minihouse-r4s-verify-${randomUUID().slice(0, 8)}`,
  protocolVersion: 5, clean: true, reconnectPeriod: 0, connectTimeout: 15000,
  rejectUnauthorized: true,
});
const timeout = setTimeout(() => finish(false, 'capture timeout'), (duration + 20) * 1000);
let finishing = false;
async function finish(success, reason) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  const temperatures = messages.filter(m => /\/thermal-[^/]+\/temperature(?:-|$)/.test(m.topic));
  const topics = {};
  for (const message of temperatures) (topics[message.topic] ??= []).push(message);
  const summary = Object.entries(topics).map(([topic, values]) => ({
    topic,
    samples: values.length,
    temperatures_c: values.map(v => v.values[0]),
    source_time_utc: values.map(v => v.source_time_utc),
    intervals_s: values.slice(1).map((v, i) => (Date.parse(v.source_time_utc) - Date.parse(values[i].source_time_utc)) / 1000),
  }));
  await mkdir(dirname(MQTT_EVIDENCE_FILE), { recursive: true });
  await writeFile(MQTT_EVIDENCE_FILE, JSON.stringify({
    captured_time_utc: new Date().toISOString(), success, reason, topic_filter: MQTT_TOPIC,
    message_count: messages.length, temperature_summary: summary, messages,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ success, reason, message_count: messages.length, temperature_summary: summary }));
  client.end(true);
  process.exitCode = success ? 0 : 1;
}
client.on('connect', () => {
  client.subscribe(MQTT_TOPIC, { qos: 1 }, (error, grants) => {
    if (error || grants.some(g => g.qos > 2)) return void finish(false, 'subscription rejected');
    console.log(JSON.stringify({ status: 'subscribed', topic: MQTT_TOPIC, qos: grants[0]?.qos }));
    setTimeout(() => {
      const thermal = messages.filter(m => /\/thermal-[^/]+\/temperature(?:-|$)/.test(m.topic));
      const groups = new Map();
      for (const m of thermal) groups.set(m.topic, (groups.get(m.topic) || 0) + 1);
      const valid = groups.size >= 2 && [...groups.values()].every(n => n >= 3)
        && thermal.every(m => !m.retained && m.source_time_utc && Number.isFinite(m.values[0]));
      void finish(valid, valid ? 'at least 3 live samples per thermal channel' : 'insufficient valid thermal samples');
    }, duration * 1000).unref();
  });
});
client.on('message', (topic, payload, packet) => {
  const raw = payload.toString('utf8');
  // collectd 5.12 publishes the C string terminator as part of its MQTT payload.
  // Preserve raw evidence, but exclude this single trailing NUL from numeric parsing.
  const body = raw.endsWith('\0') ? raw.slice(0, -1) : raw;
  const fields = body.split(':').map(value => value.trim() ? Number(value) : NaN);
  const timestamp = fields[0] * 1000;
  const sourceTime = Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8640000000000000
    ? new Date(timestamp).toISOString() : null;
  const message = {
    topic, payload: raw, qos: packet.qos, retained: packet.retain,
    received_time_utc: new Date().toISOString(), source_time_utc: sourceTime,
    values: fields.slice(1).map(v => Number.isFinite(v) ? v : null),
  };
  messages.push(message);
  if (/\/thermal-[^/]+\/temperature(?:-|$)/.test(topic)) console.log(JSON.stringify(message));
});
client.on('error', error => { void finish(false, error.code || 'MQTT connection error'); });
