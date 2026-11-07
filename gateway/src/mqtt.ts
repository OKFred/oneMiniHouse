import mqtt, { type MqttClient } from 'mqtt';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';
import { PresenceSession, encodePresence, discardPresenceOnDisconnect } from './presence.ts';

export function successfulPuback(packet: unknown): boolean {
  const ack = packet as { cmd?: string; reasonCode?: number } | undefined;
  return ack?.cmd === 'puback' && (ack.reasonCode === undefined || ack.reasonCode < 128);
}
export function publishQos1(client: MqttClient, topic: string, payload: string, retain: boolean): Promise<void> {
  if (!client.connected) return Promise.reject(new Error('MQTT disconnected'));
  return new Promise((resolve, reject) => {
    const acks = new Map<number, unknown>();
    const received = (packet: { cmd: string; messageId?: number }) => {
      if (packet.cmd === 'puback' && packet.messageId !== undefined) acks.set(packet.messageId, packet);
    };
    client.on('packetreceive', received);
    const cleanup = () => { clearTimeout(timer); client.removeListener('packetreceive', received); };
    const timer = setTimeout(() => {
      cleanup(); client.stream?.destroy(); reject(new Error('PUBACK timeout'));
    }, 15000);
    client.publish(topic, payload, { qos: 1, retain }, (error, packet) => {
      cleanup();
      // MQTT.js 5.16 removes the outgoing store entry and passes the original
      // PUBLISH packet on success. Correlate its ID with the actual received ACK.
      const id = (packet as { messageId?: number } | undefined)?.messageId;
      if (error) reject(error);
      else if (id === undefined || !successfulPuback(acks.get(id))) reject(new Error('PUBACK rejected or absent'));
      else resolve();
    });
  });
}
export class MqttTransport {
  readonly client: MqttClient;
  readonly presence: PresenceSession;
  constructor(config: Config) {
    const m = config.mqtt;
    this.presence = new PresenceSession({ site_id: config.siteId, gateway_id: config.gatewayId,
      device_id: config.gatewayId, reporter_id: m.clientId });
    const will = () => ({ topic: `${m.topicPrefix}/status`,
      payload: Buffer.from(encodePresence({ ...this.presence.begin(), quality: 'offline', captured_at: null })),
      qos: 1 as const, retain: true });
    const password = readFileSync(m.passwordFile, 'utf8').replace(/\r?\n$/, '');
    if (!password) throw new Error('MQTT secret is empty');
    this.client = mqtt.connect(m.url, {
      protocolVersion: 5, clientId: m.clientId, username: m.username, password,
      rejectUnauthorized: true, ...(m.caFile ? { ca: readFileSync(m.caFile) } : {}),
      clean: true, reconnectPeriod: 5000, connectTimeout: 15000, keepalive: 30,
      queueQoSZero: false, resubscribe: false,
      will: will(),
    });
    // Authentication failures are logged by the caller; they never crash EventEmitter.
    this.client.on('error', () => {});
    discardPresenceOnDisconnect(this.client, topic => topic === `${m.topicPrefix}/status` || topic.startsWith(`${m.topicPrefix}/devices/`) && topic.endsWith('/status'));
    this.client.on('reconnect', () => { this.client.options.will = will(); });
  }
  get connected() { return this.client.connected; }
  publish = (topic: string, payload: string, retain: boolean) => publishQos1(this.client, topic, payload, retain);
  async close() { await this.client.endAsync(true); }
}
