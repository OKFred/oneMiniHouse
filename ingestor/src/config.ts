import { readFileSync } from 'node:fs';
import { validateCollectdInput, type CollectdTemperatureInput } from './collectd.ts';
import { validateCpuCoreAlertConfig, type CpuCoreAlertConfig } from './cpu-core-alert.ts';

export interface TargetConfig {
  id: 'local' | 'supabase'; host: string; port: number; database: string; user: string;
  passwordFile: string; tls: boolean; caFile?: string; retentionDays?: number;
}
export interface TelemetryClientConfig { clientId: string; topicPrefixes: string[] }
export interface MqttConnectionPlan {
  clientId: string; primary: boolean; topicPrefixes: string[]; subscriptions: string[]; unsubscriptions: string[];
}
export interface Config {
  collectdTemperatures?: CollectdTemperatureInput[];
  cpuCoreAlerts?: CpuCoreAlertConfig & { webhookFile: string };
  mqtt: { url: string; clientId: string; username: string; passwordFile: string; topicPrefixes: string[]; frameTopicPrefixes?: string[]; telemetryClients?: TelemetryClientConfig[]; sessionExpirySeconds: number };
  queue: { maxPending: number; maxRejected: number; rawRetentionDays?: number; frameRetentionDays?: number; maxProtocolFrames?: number };
  archive?: {
    rawMirror?: { url: string; tokenFile: string; timeoutMs?: number };
    frames?: { endpoint: string; project: string; logstore: string; accessKeyIdFile: string; accessKeySecretFile: string; securityTokenFile?: string; timeoutMs?: number };
  };
  targets: TargetConfig[];
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const int = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
export function validateConfig(raw: unknown): Config {
  if (!obj(raw) || !obj(raw.mqtt) || !obj(raw.queue) || !Array.isArray(raw.targets)) throw new Error('Invalid configuration structure');
  const m = raw.mqtt;
  if (!text(m.url) || !text(m.clientId) || !text(m.username) || !text(m.passwordFile)) throw new Error('MQTT connection fields required');
  const url = new URL(m.url);
  if (url.protocol !== 'mqtts:' || url.username || url.password) throw new Error('MQTT requires TLS and separate credentials');
  if (!int(m.sessionExpirySeconds, 60, 604800)) throw new Error('Invalid MQTT session expiry');
  if (!Array.isArray(m.topicPrefixes) || m.topicPrefixes.length < 1 || !m.topicPrefixes.every(v => text(v) && /^iot\/v1\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(v)) || new Set(m.topicPrefixes).size !== m.topicPrefixes.length) throw new Error('Invalid topic prefixes');
  const prefixes = m.topicPrefixes;
  if (raw.cpuCoreAlerts !== undefined) {
    if (!obj(raw.cpuCoreAlerts) || !text(raw.cpuCoreAlerts.webhookFile)) throw new Error('CPU alert webhookFile required');
    const alerts = validateCpuCoreAlertConfig(raw.cpuCoreAlerts);
    if (alerts.sources.some(source => !prefixes.includes(`iot/v1/${source.siteId}/${source.gatewayId}`))) throw new Error('CPU alert source must have a telemetry subscription');
  }
  if (m.frameTopicPrefixes !== undefined && (!Array.isArray(m.frameTopicPrefixes) || !m.frameTopicPrefixes.every(v => text(v) && prefixes.includes(v)) || new Set(m.frameTopicPrefixes).size !== m.frameTopicPrefixes.length)) throw new Error('Invalid frame topic prefixes');
  if (m.telemetryClients !== undefined) {
    if (!Array.isArray(m.telemetryClients) || m.telemetryClients.length > 32) throw new Error('Invalid MQTT telemetry clients');
    const clientIds = new Set([m.clientId]), assigned = new Set<string>();
    for (const client of m.telemetryClients) {
      if (!obj(client) || !text(client.clientId) || clientIds.has(client.clientId)) throw new Error('MQTT client IDs must be distinct');
      clientIds.add(client.clientId);
      if (!Array.isArray(client.topicPrefixes) || !client.topicPrefixes.length || client.topicPrefixes.some(p => !text(p) || !prefixes.includes(p) || assigned.has(p))) throw new Error('Invalid or overlapping MQTT telemetry assignment');
      for (const prefix of client.topicPrefixes) {
        if (assigned.has(prefix)) throw new Error('Invalid or overlapping MQTT telemetry assignment');
        assigned.add(prefix);
      }
    }
  }
  if (!int(raw.queue.maxPending, 1, 1000000) || !int(raw.queue.maxRejected, 1, 100000)) throw new Error('Invalid queue limits');
  if (raw.collectdTemperatures !== undefined) {
    if (!Array.isArray(raw.collectdTemperatures) || raw.collectdTemperatures.length > 128) throw new Error('Invalid collectd inputs');
    for (const input of raw.collectdTemperatures) validateCollectdInput(input);
    if (new Set(raw.collectdTemperatures.map(v => v.topic)).size !== raw.collectdTemperatures.length) throw new Error('Duplicate collectd topic');
  }
  if (mqttConnectionPlans(raw as unknown as Config).some(client => client.subscriptions.length > 10)) throw new Error('Each MQTT connection supports at most 10 subscriptions; assign telemetryClients or explicit frameTopicPrefixes');
  for (const [key, max] of [['rawRetentionDays', 3650], ['frameRetentionDays', 365], ['maxProtocolFrames', 10000000]] as const) {
    if (raw.queue[key] !== undefined && !int(raw.queue[key], 1, max)) throw new Error('Invalid retention limit');
  }
  if (raw.archive !== undefined) {
    if (!obj(raw.archive)) throw new Error('Invalid archive config');
    for (const sink of [raw.archive.rawMirror,raw.archive.frames]) if (sink !== undefined) {
      if (!obj(sink) || (sink.timeoutMs !== undefined && !int(sink.timeoutMs,1000,120000))) throw new Error('Invalid archive sink');
    }
    if (raw.archive.rawMirror !== undefined) {
      const sink=raw.archive.rawMirror as Record<string,unknown>;
      if(Number(raw.queue.rawRetentionDays??180)>180)throw new Error('Cloud raw retention cannot exceed 180 days');
      if(!text(sink.url)||!text(sink.tokenFile)) throw new Error('Raw archive URL and tokenFile required');
      const url=new URL(sink.url);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Raw archive requires HTTPS');
    }
    if (raw.archive.frames !== undefined) {
      const sink=raw.archive.frames as Record<string,unknown>;
      if(!['endpoint','project','logstore','accessKeyIdFile','accessKeySecretFile'].every(k=>text(sink[k])))throw new Error('SLS archive fields required');
      if(sink.securityTokenFile!==undefined&&!text(sink.securityTokenFile))throw new Error('Invalid security token file');
    }
  }
  if (raw.targets.length !== 2 || new Set(raw.targets.map(t => obj(t) ? t.id : '')).size !== 2) throw new Error('Both distinct database targets are required');
  for (const t of raw.targets) {
    if (!obj(t) || !['local', 'supabase'].includes(String(t.id)) || !['host', 'database', 'user', 'passwordFile'].every(k => text(t[k])) || !int(t.port, 1, 65535) || typeof t.tls !== 'boolean' || (t.caFile !== undefined && !text(t.caFile))) throw new Error('Invalid database target');
    if (t.id === 'supabase' && !t.tls) throw new Error('Supabase requires verified TLS');
    if (t.retentionDays !== undefined && (t.id !== 'supabase' || !int(t.retentionDays,1,3650))) throw new Error('retentionDays is a positive whole-day setting for Supabase only');
  }
  return raw as unknown as Config;
}
export const loadConfig = (path = process.env.CONFIG_FILE ?? 'config/local.json') => validateConfig(JSON.parse(readFileSync(path, 'utf8')));
export const mqttSubscriptions = (config: Config): string[] => [
  ...config.mqtt.topicPrefixes.map(p => `${p}/devices/+/telemetry`),
  ...(config.mqtt.frameTopicPrefixes ?? config.mqtt.topicPrefixes).map(p => `${p}/devices/+/frames`),
  ...(config.collectdTemperatures ?? []).map(input => input.topic),
];
export const mqttUnsubscriptions = (config: Config): string[] => config.mqtt.topicPrefixes
  .filter(p => config.mqtt.frameTopicPrefixes !== undefined && !config.mqtt.frameTopicPrefixes.includes(p))
  .map(p => `${p}/devices/+/frames`);
export function mqttConnectionPlans(config: Config): MqttConnectionPlan[] {
  const additional = config.mqtt.telemetryClients ?? [];
  const assigned = new Set(additional.flatMap(client => client.topicPrefixes));
  const moved = [...assigned].map(prefix => `${prefix}/devices/+/telemetry`);
  return [{
    clientId: config.mqtt.clientId, primary: true,
    topicPrefixes: config.mqtt.topicPrefixes.filter(prefix => !assigned.has(prefix)),
    subscriptions: mqttSubscriptions(config).filter(topic => !moved.includes(topic)),
    // A persistent primary session must not retain a filter explicitly assigned to
    // another client. Unrelated telemetry, frame and collectd filters stay in place.
    unsubscriptions: [...mqttUnsubscriptions(config), ...moved],
  }, ...additional.map(client => ({
    clientId: client.clientId, primary: false, topicPrefixes: client.topicPrefixes,
    subscriptions: client.topicPrefixes.map(prefix => `${prefix}/devices/+/telemetry`),
    // A reused secondary session can retain filters from its previous assignment.
    // Remove known foreign filters without clearing its durable message backlog.
    unsubscriptions: mqttSubscriptions(config).filter(topic => !client.topicPrefixes.some(prefix => topic === `${prefix}/devices/+/telemetry`)),
  }))];
}
export function secret(path: string): string {
  const value = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (!value) throw new Error('Empty credential file');
  return value;
}
