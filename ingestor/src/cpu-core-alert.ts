import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { stableUuid, type Sample } from './message.ts';

export interface CpuCoreAlertSource {
  siteId: string; gatewayId: string; deviceId: string; label: string; coreMetrics: string[];
}
export interface CpuCoreAlertConfig {
  thresholdC: number; durationSeconds: number; maxGapSeconds: number; maxSampleAgeSeconds: number;
  sources: CpuCoreAlertSource[];
}
type CoreState = { start: number | null; last: number | null; value: number | null };
type SourceState = { last: number; messageId: string; incidentId: string | null; cores: Record<string, CoreState> };
type Notice = { eventId: string; sourceId: string; label: string; thresholdC: number; durationSeconds: number;
  first_high_time_utc: string; trigger_time_utc: string; cores: { metric: string; temperatureC: number; durationSeconds: number }[] };
export type AlertObservation = { status: 'ignored' | 'observed' | 'alerted' | 'recovered'; eventId?: string };
export type AlertDelivery = { status: 'idle' | 'sent' | 'retry' | 'failed' | 'cancelled'; eventId?: string; code?: string; attempts?: number };
const sourceId = (v: CpuCoreAlertSource) => `${v.siteId}/${v.gatewayId}/${v.deviceId}`;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const CORE = /^cpu_core_[0-9]{1,3}_temperature_c$/;
const MAX_ATTEMPTS = 5, NOTICE_TTL = 600_000, HISTORY_TTL = 7 * 86400_000;

export function validateCpuCoreAlertConfig(value: unknown): CpuCoreAlertConfig {
  if (!object(value) || !integer(value.thresholdC, 40, 125) || !integer(value.durationSeconds, 120, 3600)
    || !integer(value.maxGapSeconds, 30, 90) || !integer(value.maxSampleAgeSeconds, 5, 90)
    || !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 32) throw new Error('Invalid CPU core alert settings');
  for (const source of value.sources) {
    if (!object(source) || !['siteId', 'gatewayId', 'deviceId'].every(k => typeof source[k] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(source[k] as string))
      || typeof source.label !== 'string' || !source.label.trim() || source.label.length > 100 || /[\r\n\u0000-\u001f]/.test(source.label)
      || !Array.isArray(source.coreMetrics) || source.coreMetrics.length < 1 || source.coreMetrics.length > 128
      || !source.coreMetrics.every(k => typeof k === 'string' && CORE.test(k)) || new Set(source.coreMetrics).size !== source.coreMetrics.length) throw new Error('Invalid CPU core alert source');
  }
  const config = value as unknown as CpuCoreAlertConfig;
  if (new Set(config.sources.map(sourceId)).size !== config.sources.length) throw new Error('Duplicate CPU core alert source');
  return config;
}

export function validateFeishuWebhook(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Feishu webhook'); }
  if (url.protocol !== 'https:' || url.hostname !== 'open.feishu.cn' || url.port || url.username || url.password || url.search || url.hash
    || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]{16,128}$/.test(url.pathname)) throw new Error('Invalid Feishu webhook');
}

// One durable episode per host; continuity itself is tracked separately for every core.
// Call observe after the raw intake transaction commits and before MQTT QoS 1 PUBACK.
// Duplicate/replayed intake then safely fills a crash between those two transactions.
export class CpuCoreAlerts {
  private db: DatabaseSync;
  private config: CpuCoreAlertConfig;
  private sources: Map<string, CpuCoreAlertSource>;
  private delivering = false;
  constructor(path: string, config: CpuCoreAlertConfig) {
    this.config = structuredClone(validateCpuCoreAlertConfig(config));
    this.sources = new Map(this.config.sources.map(v => [sourceId(v), v]));
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cpu_alert_metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cpu_alert_source_state(source_id TEXT PRIMARY KEY,state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cpu_alert_outbox(
        event_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,notice_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,next_attempt_time_utc INTEGER NOT NULL,
        create_time_utc INTEGER NOT NULL,update_time_utc INTEGER NOT NULL,last_error TEXT);
      CREATE INDEX IF NOT EXISTS cpu_alert_delivery ON cpu_alert_outbox(status,next_attempt_time_utc);`);
    const fingerprint = createHash('sha256').update(JSON.stringify(this.config)).digest('hex');
    const previous = this.db.prepare("SELECT value FROM cpu_alert_metadata WHERE name='config_hash'").get();
    if (previous?.value !== fingerprint) this.transaction(() => {
      // A changed core list or threshold must not reuse elapsed time under older rules.
      this.db.exec('DELETE FROM cpu_alert_source_state;');
      this.db.prepare("UPDATE cpu_alert_outbox SET status='cancelled',last_error='CONFIG_CHANGED',update_time_utc=? WHERE status='pending'").run(Date.now());
      this.db.prepare("INSERT OR REPLACE INTO cpu_alert_metadata VALUES('config_hash',?)").run(fingerprint);
    });
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private load(key: string): SourceState | undefined {
    const row = this.db.prepare('SELECT state_json FROM cpu_alert_source_state WHERE source_id=?').get(key);
    return row ? JSON.parse(String(row.state_json)) as SourceState : undefined;
  }
  private save(key: string, state: SourceState) {
    this.db.prepare('INSERT OR REPLACE INTO cpu_alert_source_state VALUES(?,?)').run(key, JSON.stringify(state));
  }
  private qualified(state: SourceState, time: number) {
    return Object.entries(state.cores).filter(([, core]) => core.start !== null && core.last === time && core.value !== null
      && core.value > this.config.thresholdC && time - core.start >= this.config.durationSeconds * 1000);
  }
  observe(sample: Sample, now = Date.now()): AlertObservation {
    const key = `${sample.site_id}/${sample.gateway_id}/${sample.device_id}`, source = this.sources.get(key);
    if (!source || sample.schema_version !== 2 || sample.quality !== 'ok' || sample.observation_kind !== 'direct_read'
      || sample.source?.driver !== 'linux-temperature-mqtt' || sample.source?.temperature_source !== 'linux_sysfs') return { status: 'ignored' };
    const time = Date.parse(sample.read_time_utc ?? '');
    // Old buffers never trigger a current alert. Future points cannot contribute duration.
    if (!Number.isFinite(now) || !Number.isFinite(time) || time > now || now - time > this.config.maxSampleAgeSeconds * 1000) return { status: 'ignored' };
    return this.transaction(() => {
      const state = this.load(key) ?? { last: -1, messageId: '', incidentId: null, cores: {} };
      if (time <= state.last || sample.message_id === state.messageId) return { status: 'ignored' };
      for (const metric of source.coreMetrics) {
        const previous = state.cores[metric], value = sample.metrics[metric];
        // Missing or nonsensical input breaks continuity, but does not imply recovery.
        const valid = typeof value === 'number' && Number.isFinite(value) && value >= -50 && value <= 150;
        const high = valid && value > this.config.thresholdC;
        const continuous = previous?.last !== null && previous?.last !== undefined && time - previous.last <= this.config.maxGapSeconds * 1000;
        state.cores[metric] = { last: valid ? time : null, value: valid ? value : null,
          start: high ? continuous && previous?.start !== null && previous?.start !== undefined ? previous.start : time : null };
      }
      state.last = time; state.messageId = sample.message_id;
      let result: AlertObservation = { status: 'observed' };
      if (state.incidentId) {
        const recovered = source.coreMetrics.every(metric => state.cores[metric].last === time && state.cores[metric].value !== null && state.cores[metric].value! <= this.config.thresholdC);
        if (recovered) {
          this.db.prepare("UPDATE cpu_alert_outbox SET status='cancelled',last_error='RECOVERED_BEFORE_SEND',update_time_utc=? WHERE event_id=? AND status='pending'").run(now, state.incidentId);
          result = { status: 'recovered', eventId: state.incidentId }; state.incidentId = null;
        }
      } else {
        const qualified = this.qualified(state, time);
        if (qualified.length) {
          const first = Math.min(...qualified.map(([, core]) => core.start!)), eventId = stableUuid(`cpu-core-high\n${key}\n${first}\n${time}`);
          const notice: Notice = { eventId, sourceId: key, label: source.label, thresholdC: this.config.thresholdC, durationSeconds: this.config.durationSeconds,
            first_high_time_utc: new Date(first).toISOString(), trigger_time_utc: new Date(time).toISOString(),
            cores: qualified.map(([metric, core]) => ({ metric, temperatureC: core.value!, durationSeconds: (time - core.start!) / 1000 })) };
          this.db.prepare("INSERT OR IGNORE INTO cpu_alert_outbox VALUES(?,?,?,'pending',0,?,?,?,NULL)").run(eventId, key, JSON.stringify(notice), now, now, now);
          state.incidentId = eventId; result = { status: 'alerted', eventId };
        }
      }
      this.save(key, state); return result;
    });
  }
  async deliverOne(webhook: string, options: { now?: number; fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<AlertDelivery> {
    if (this.delivering || options.signal?.aborted) return { status: 'idle' };
    validateFeishuWebhook(webhook);
    this.delivering = true;
    try {
      const now = options.now ?? Date.now();
      const inactive = "event_id NOT IN (SELECT json_extract(state_json,'$.incidentId') FROM cpu_alert_source_state WHERE json_extract(state_json,'$.incidentId') IS NOT NULL)";
      this.db.prepare(`DELETE FROM cpu_alert_outbox WHERE status!='pending' AND ${inactive} AND update_time_utc<?`).run(now - HISTORY_TTL);
      // At most one pending notification per configured host; keep at most 1,000
      // completed notices for diagnostics as well as the seven-day age bound.
      this.db.exec(`DELETE FROM cpu_alert_outbox WHERE event_id IN (SELECT event_id FROM cpu_alert_outbox WHERE status!='pending' AND ${inactive} ORDER BY update_time_utc DESC,event_id DESC LIMIT -1 OFFSET 1000)`);
      const row = this.db.prepare("SELECT * FROM cpu_alert_outbox WHERE status='pending' AND next_attempt_time_utc<=? ORDER BY create_time_utc,event_id LIMIT 1").get(now);
      if (!row) return { status: 'idle' };
      const id = String(row.event_id), state = this.load(String(row.source_id)), notice = JSON.parse(String(row.notice_json)) as Notice;
      const cancel = (code: string): AlertDelivery => {
        this.transaction(() => {
          this.db.prepare("UPDATE cpu_alert_outbox SET status='cancelled',last_error=?,update_time_utc=? WHERE event_id=?").run(code, now, id);
          if (state?.incidentId === id && (code === 'ALERT_STALE' || code === 'NO_CURRENT_QUALIFYING_CORE')) {
            // No notification was confirmed for this episode. Re-arm after data
            // loss, requiring a wholly new measured interval; this is not a
            // recovery observation. A sent/failed episode is never re-armed here.
            state.incidentId = null;
            for (const core of Object.values(state.cores)) core.start = null;
            this.save(String(row.source_id), state);
          }
        });
        return { status: 'cancelled', eventId: id, code };
      };
      if (!state || state.incidentId !== id) return cancel('EPISODE_ENDED');
      if (now - Number(row.create_time_utc) > NOTICE_TTL || now - state.last > this.config.maxSampleAgeSeconds * 1000) return cancel('ALERT_STALE');
      if (!this.qualified(state, state.last).length) return cancel('NO_CURRENT_QUALIFYING_CORE');
      const attempts = Number(row.attempts) + 1;
      if (attempts > MAX_ATTEMPTS) {
        this.db.prepare("UPDATE cpu_alert_outbox SET status='failed',last_error='ATTEMPTS_EXHAUSTED',update_time_utc=? WHERE event_id=?").run(now, id);
        return { status: 'failed', eventId: id, code: 'ATTEMPTS_EXHAUSTED', attempts: MAX_ATTEMPTS };
      }
      const retryAt = now + Math.min(120000, 15000 * 2 ** (attempts - 1));
      // Reserve the attempt before the request. A crash can duplicate a notification after
      // remote acceptance; Feishu webhooks have no idempotency key. The stable event ID
      // is included in all retries and a host episode never creates repeated notices.
      this.db.prepare('UPDATE cpu_alert_outbox SET attempts=?,next_attempt_time_utc=?,update_time_utc=? WHERE event_id=?').run(attempts, retryAt, now, id);
      const text = ['家庭 IoT CPU 核心持续高温告警', `主机：${notice.label}`,
        `条件：同一核心连续 ${notice.durationSeconds} 秒高于 ${notice.thresholdC}°C（逐次采样确认）`,
        ...notice.cores.slice(0, 8).map(core => `${core.metric}：${core.temperatureC}°C，持续 ${core.durationSeconds} 秒`),
        ...(notice.cores.length > 8 ? [`另外 ${notice.cores.length - 8} 个核心同时满足条件`] : []),
        `触发时间（UTC）：${notice.trigger_time_utc}`, `事件 ID：${id}`].join('\n');
      let code = 'FEISHU_NETWORK_ERROR';
      try {
        // Official custom-bot payload and success code:
        // https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
        const response = await (options.fetch ?? fetch)(webhook, { method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text } }) });
        if (!response.ok) code = 'FEISHU_HTTP_ERROR';
        else {
          const result: unknown = await response.json();
          if (object(result) && result.code === 0) {
            this.db.prepare("UPDATE cpu_alert_outbox SET status='sent',last_error=NULL,update_time_utc=? WHERE event_id=?").run(now, id);
            return { status: 'sent', eventId: id, attempts };
          }
          code = 'FEISHU_REJECTED';
        }
      } catch { /* Never expose a URL, response body, or exception containing a secret. */ }
      if (options.signal?.aborted) {
        // Graceful process shutdown is not a failed delivery. Preserve the durable
        // notice for the next process instead of exhausting the last retry here.
        this.db.prepare("UPDATE cpu_alert_outbox SET attempts=?,next_attempt_time_utc=?,update_time_utc=? WHERE event_id=? AND status='pending'")
          .run(attempts - 1, now, now, id);
        return { status: 'retry', eventId: id, code: 'NOTIFIER_STOPPING', attempts: attempts - 1 };
      }
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
      // A new observation can recover while the HTTP request is in flight. Never
      // turn that concurrently cancelled notice back into a pending retry.
      this.db.prepare("UPDATE cpu_alert_outbox SET status=?,last_error=?,update_time_utc=? WHERE event_id=? AND status='pending'").run(status === 'failed' ? 'failed' : 'pending', code, now, id);
      return { status, eventId: id, code, attempts };
    } finally { this.delivering = false; }
  }
  stats() {
    const counts = Object.fromEntries(this.db.prepare('SELECT status,count(*) AS n FROM cpu_alert_outbox GROUP BY status').all().map(v => [String(v.status), Number(v.n)]));
    const active = this.db.prepare('SELECT state_json FROM cpu_alert_source_state').all().map(v => JSON.parse(String(v.state_json)) as SourceState).filter(v => v.incidentId);
    const errors = active.map(state => this.db.prepare('SELECT status,last_error FROM cpu_alert_outbox WHERE event_id=?').get(state.incidentId!))
      .filter(v => v && v.status !== 'sent' && v.last_error).map(v => String(v!.last_error));
    return { pending: counts.pending ?? 0, sent: counts.sent ?? 0, failed: counts.failed ?? 0, cancelled: counts.cancelled ?? 0,
      active: active.length, notification_error: errors[0] ?? null };
  }
  close() { this.db.close(); }
}
