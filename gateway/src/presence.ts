import { randomUUID } from 'node:crypto';
import type { MqttClient } from 'mqtt';

export function discardPresenceOnDisconnect(client: MqttClient, isPresence: (topic: string) => boolean): void {
  const pending = new Set<number>();
  client.on('packetsend', packet => {
    if (packet.cmd === 'publish' && packet.qos === 1 && packet.messageId !== undefined && isPresence(packet.topic)) pending.add(packet.messageId);
  });
  client.on('packetreceive', packet => {
    if (packet.cmd === 'puback' && packet.messageId !== undefined) pending.delete(packet.messageId);
  });
  client.on('close', () => {
    for (const mid of pending) client.removeOutgoingMessage(mid);
    pending.clear();
  });
}

export interface PresenceIdentity { site_id: string; gateway_id: string; device_id: string; reporter_id: string }
export type PresenceEvent = 'online' | 'heartbeat' | 'offline' | 'observation';
export type PresenceReason = 'connected' | 'heartbeat' | 'shutdown' | 'lwt' | 'read_ok' | 'read_failed' | 'upstream_unknown';
export function encodePresence(value: object): string {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > 4096) throw new Error('Presence envelope too large');
  return raw;
}
export class PresenceSession {
  readonly identity: PresenceIdentity;
  readonly bootId = randomUUID();
  readonly started = performance.now();
  sessionId = '';
  sequence = 0;
  readonly failures = new Map<string, number>();
  constructor(identity: PresenceIdentity) { this.identity = identity; }
  begin() {
    this.sessionId = randomUUID(); this.sequence = 0; this.failures.clear();
    return this.message('offline', false, 'lwt');
  }
  message(event: PresenceEvent, online: boolean | null, reason: PresenceReason, deviceId = this.identity.device_id, sourceTime?: string) {
    if (!this.sessionId) throw new Error('Presence session required');
    const will = reason === 'lwt';
    const value = { schema_version: 1, event_id: randomUUID(), ...this.identity, device_id: deviceId,
      boot_id: this.bootId, session_id: this.sessionId, sequence: will ? null : ++this.sequence,
      event, online, reason, source_time_utc: will ? null : sourceTime ?? new Date().toISOString(),
      uptime_ms: will ? null : Math.max(0, Math.floor(performance.now() - this.started)) };
    encodePresence(value);
    return value;
  }
  observation(deviceId: string, readable: boolean | null, sourceTime?: string) {
    if (readable === null) return this.message('observation', null, 'upstream_unknown', deviceId);
    if (readable) {
      this.failures.delete(deviceId);
      return this.message('observation', true, 'read_ok', deviceId, sourceTime);
    }
    const count = (this.failures.get(deviceId) ?? 0) + 1;
    this.failures.set(deviceId, count);
    return count < 3 ? null : this.message('observation', false, 'read_failed', deviceId);
  }
  readObservations(device: { id: string; driver: string; gatewayDeviceId?: unknown },
    reading?: { utc: string; source: { observation_kind?: unknown } }) {
    const xiaomi = device.driver === 'xiaomi-gateway-v3-temperature';
    const cached = xiaomi || reading?.source.observation_kind === 'gateway_cached_state';
    const sensor = this.observation(device.id, cached ? null : !!reading, reading?.utc);
    const observations = sensor ? [sensor] : [];
    // A completed authenticated RPC proves the hub is readable, not its cached Zigbee sensor.
    if (xiaomi && typeof device.gatewayDeviceId === 'number' && Number.isSafeInteger(device.gatewayDeviceId)
      && device.gatewayDeviceId >= 1 && device.gatewayDeviceId <= 0xfffffffe) {
      observations.push(this.observation(`xiaomi-gateway-${device.gatewayDeviceId}`, reading ? true : null, reading?.utc)!);
    }
    return observations;
  }
}
