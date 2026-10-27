import mqtt, { type IClientOptions, type IPublishPacket, type MqttClient } from 'mqtt';
import { mqttConnectionPlans, secret, type Config, type MqttConnectionPlan } from './config.ts';
import { receive } from './intake.ts';
import type { Queue } from './queue.ts';
import { hostHealthProcessor, hostHealthRaw } from './host-health.ts';
import type { BusinessHealth } from './business-health.ts';

/** Enforce the connection's exact topic assignment even if an old persistent
 * session delivers messages from filters no longer configured for this client.
 * Unexpected traffic is durably quarantined before it can be acknowledged.
 */
export function receiveConnectionMessage(queue: Queue, config: Config, plan: MqttConnectionPlan, packet: IPublishPacket) {
  const bytes = Buffer.from(packet.payload), levels = packet.topic.split('/');
  const allowed = plan.subscriptions.some(filter => {
    const expected = filter.split('/');
    return expected.length === levels.length && expected.every((level, index) => level === '+' || level === levels[index]);
  });
  if (!allowed && plan.hostHealthInput) {
    queue.reject(packet.topic, Buffer.from('[invalid host health redacted]'), 'UNEXPECTED_MQTT_TOPIC'); return 'rejected' as const;
  }
  if (!allowed) { queue.reject(packet.topic, bytes, 'UNEXPECTED_MQTT_TOPIC'); return 'rejected' as const; }
  if (plan.hostHealthInput && (packet.qos !== 1 || packet.retain)) {
    queue.reject(packet.topic, Buffer.from('[invalid host health redacted]'), 'INVALID_HOST_HEALTH_TRANSPORT');
    return 'rejected' as const;
  }
  return receive(queue, packet.topic, bytes, config.mqtt.topicPrefixes, plan.primary ? config.collectdTemperatures : [], plan.hostHealthInput ? [plan.hostHealthInput] : []);
}

/** Flat host-health wire is normalized before monitoring; it is never parsed as
 * a standard telemetry envelope or counted as an individual CPU core sample. */
export function observeConnectionMessage(health: Pick<BusinessHealth, 'observe' | 'observeAccepted'>, result: 'saved' | 'duplicate' | 'rejected', packet: IPublishPacket, config: Config, plan: MqttConnectionPlan): void {
  const bytes = Buffer.from(packet.payload);
  if (plan.hostHealthInput) {
    if (result === 'saved') health.observe(hostHealthProcessor.process(hostHealthRaw(plan.hostHealthInput, bytes)));
  } else health.observeAccepted(result, packet.topic, bytes, config.collectdTemperatures);
}

type Log = (event: string, fields?: object) => void;
type Cancel = () => void;
type Schedule = (callback: () => void, milliseconds: number) => Cancel;
export interface MqttConnectionHealth {
  client_id: string; connected: boolean; subscribed: boolean; intake_paused: boolean;
  subscription_count: number; error: string | null;
}
interface Connection {
  client: MqttClient; health: MqttConnectionHealth; generation: number; attempt: number;
  retryDelay: number; cancelRetry?: Cancel; cancelControl?: Cancel;
}
interface Dependencies {
  connect?: (url: string, options: IClientOptions) => MqttClient;
  schedule?: Schedule;
  readSecret?: (path: string) => string;
}
const schedule: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};
const code = (error: unknown) => {
  const value = (error as { code?: unknown; reasonCode?: unknown } | null)?.code;
  if (typeof value === 'string' && /^[A-Z0-9_]{1,64}$/i.test(value)) return value;
  const reason = (error as { reasonCode?: unknown } | null)?.reasonCode;
  return typeof reason === 'number' && Number.isInteger(reason) ? `MQTT_REASON_${reason}` : 'MQTT_ERROR';
};

/** Independently managed durable sessions, sharing one synchronous durable intake.
 * MQTT.js sends QoS 1 PUBACK only after handleMessage's callback succeeds.
 */
export class MqttConnections {
  private readonly connections: Connection[] = [];
  private stopped = false;
  constructor(
    config: Config, password: string,
    intake: (packet: IPublishPacket, plan: MqttConnectionPlan) => void,
    log: Log, dependencies: Dependencies = {},
  ) {
    const connect = dependencies.connect ?? mqtt.connect;
    const later = dependencies.schedule ?? schedule;
    const credentials = mqttConnectionPlans(config).map(plan => ({ plan,
      username: plan.hostHealthInput?.username ?? config.mqtt.username,
      password: plan.hostHealthInput ? (dependencies.readSecret ?? secret)(plan.hostHealthInput.passwordFile) : password,
    }));
    for (const { plan, username, password: connectionPassword } of credentials) {
      const client = connect(config.mqtt.url, {
        protocolVersion: 5, clean: false, clientId: plan.clientId,
        username, password: connectionPassword, rejectUnauthorized: true,
        reconnectPeriod: 5000, reconnectOnConnackError: true, connectTimeout: 15000, keepalive: 30, resubscribe: false,
        properties: { sessionExpiryInterval: config.mqtt.sessionExpirySeconds, receiveMaximum: 10, maximumPacketSize: plan.hostHealthInput ? 16384 : 1048576 },
      });
      const connection: Connection = {
        client, generation: 0, attempt: 0, retryDelay: 30000,
        health: { client_id: plan.clientId, connected: false, subscribed: false, intake_paused: false, subscription_count: plan.subscriptions.length, error: 'NOT_CONNECTED' },
      };
      this.connections.push(connection);
      const emit: Log = (event, fields = {}) => log(event, { client_id: plan.clientId, ...fields });
      client.handleMessage = (packet, done) => {
        if (this.stopped) { done(new Error('Intake stopped')); return; }
        try {
          intake(packet, plan);
          connection.health.intake_paused = false;
          done();
        } catch {
          connection.health.intake_paused = true;
          emit('mqtt_intake_paused');
          // Only this transport is closed. Other sessions and delivery loops remain
          // available; this packet stays unacknowledged for durable redelivery.
          client.stream?.destroy();
          done(new Error('Durable intake unavailable'));
        }
      };
      const cancelTimers = () => {
        connection.cancelRetry?.(); connection.cancelRetry = undefined;
        connection.cancelControl?.(); connection.cancelControl = undefined;
      };
      const unavailable = () => {
        connection.generation++;
        connection.health.connected = false;
        connection.health.subscribed = false;
        connection.health.error = 'OFFLINE';
        cancelTimers();
      };
      const synchronize = () => {
        if (this.stopped || !client.connected) return;
        cancelTimers();
        const generation = connection.generation, attempt = ++connection.attempt;
        const current = () => !this.stopped && client.connected && generation === connection.generation && attempt === connection.attempt;
        const failed = (reason: string, fields: object = {}) => {
          if (!current()) return;
          connection.attempt++; // Ignore late SUBACK/UNSUBACK callbacks after timeout.
          connection.cancelControl?.(); connection.cancelControl = undefined;
          connection.health.subscribed = false; connection.health.error = reason;
          const delay = connection.retryDelay;
          connection.retryDelay = Math.min(delay * 2, 300000);
          emit('mqtt_subscription_retry', { reason, delay_ms: delay, ...fields });
          // Keep the established transport and durable session. An ACL rejection
          // must not stop the process or reconnect every five seconds.
          connection.cancelRetry = later(synchronize, delay);
        };
        const subscribe = () => {
          if (!current()) return;
          if (!plan.subscriptions.length) { succeeded(); return; }
          try {
            client.subscribe(plan.subscriptions, { qos: 1, rh: 2, ...(plan.hostHealthInput ? { rap: true } : {}) }, (error, granted) => {
              if (!current()) return;
              const exact = granted?.length === plan.subscriptions.length && plan.subscriptions.every(topic => granted.some(grant => grant.topic === topic && grant.qos === 1));
              if (error || !exact) { failed(error ? code(error) : 'SUBACK_REJECTED'); return; }
              succeeded();
            });
          } catch (error) { failed(code(error)); }
        };
        const succeeded = () => {
          connection.cancelControl?.(); connection.cancelControl = undefined;
          connection.health.subscribed = true; connection.health.error = null;
          connection.retryDelay = 30000;
          emit('mqtt_subscribed', { count: plan.subscriptions.length });
        };
        connection.cancelControl = later(() => failed('SUBSCRIPTION_TIMEOUT'), 30000);
        if (!plan.unsubscriptions.length) { subscribe(); return; }
        try {
          client.unsubscribe(plan.unsubscriptions, (error, ack) => {
            if (!current()) return;
            const codes = ack?.cmd === 'unsuback' ? ack.granted : [];
            if (error || codes.length !== plan.unsubscriptions.length || codes.some(value => value !== 0 && value !== 17)) {
              failed(error ? code(error) : 'UNSUBACK_REJECTED', { reason_codes: codes }); return;
            }
            emit('mqtt_unsubscribed', { count: plan.unsubscriptions.length });
            subscribe();
          });
        } catch (error) { failed(code(error)); }
      };
      client.on('error', error => { connection.health.error = code(error); emit('mqtt_error', { code: code(error) }); });
      client.on('offline', () => { unavailable(); emit('mqtt_offline'); });
      client.on('close', unavailable);
      client.on('connect', packet => {
        connection.generation++;
        connection.health.connected = true; connection.health.subscribed = false;
        emit('mqtt_connected', { session_present: packet.sessionPresent, server_session_expiry: packet.properties?.sessionExpiryInterval });
        synchronize();
      });
    }
  }
  snapshot() {
    const connections = this.connections.map(({ client, health }) => ({ ...health, connected: client.connected && !this.stopped }));
    return {
      mqtt_connected: connections.every(value => value.connected),
      subscribed: connections.every(value => value.connected && value.subscribed),
      intake_paused: connections.some(value => value.intake_paused),
      mqtt_connections: connections,
    };
  }
  async stop() {
    this.stopped = true;
    for (const connection of this.connections) {
      connection.generation++;
      connection.cancelRetry?.(); connection.cancelControl?.();
      connection.health.subscribed = false;
    }
    // Forced transport shutdown leaves the broker's persistent session intact.
    await Promise.allSettled(this.connections.map(({ client }) => client.endAsync(true)));
  }
}
