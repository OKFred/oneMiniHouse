import mqtt, { type MqttClient } from 'mqtt';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';

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
  constructor(config: Config, offline: string) {
    const m = config.mqtt;
    const password = readFileSync(m.passwordFile, 'utf8').replace(/\r?\n$/, '');
    if (!password) throw new Error('MQTT secret is empty');
    this.client = mqtt.connect(m.url, {
      protocolVersion: 5, clientId: m.clientId, username: m.username, password,
      rejectUnauthorized: true, ...(m.caFile ? { ca: readFileSync(m.caFile) } : {}),
      clean: true, reconnectPeriod: 5000, connectTimeout: 15000, keepalive: 30,
      queueQoSZero: false, resubscribe: false,
      will: { topic: `${m.topicPrefix}/status`, payload: Buffer.from(offline), qos: 1, retain: true },
    });
    // Authentication failures are logged by the caller; they never crash EventEmitter.
    this.client.on('error', () => {});
  }
  get connected() { return this.client.connected; }
  publish = (topic: string, payload: string, retain: boolean) => publishQos1(this.client, topic, payload, retain);
  async close() { await this.client.endAsync(true); }
}
