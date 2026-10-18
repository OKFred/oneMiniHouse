import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { collectdRaw, collectdTemperatureProcessor, type CollectdTemperatureInput } from './collectd.ts';
import { assessMetricQuality } from './metric-quality.ts';
import { observationTimes, parseJson, parseSample, type RecordRow, type Sample } from './message.ts';

export interface DeviceBusinessHealth {
  site_id: string; gateway_id: string; device_id: string;
  last_received_time_utc: string | null; last_collect_time_utc: string | null;
  // Valid poll time is distinct from the sensor's actual measurement time.
  last_valid_time_utc: string | null; last_sample_time_utc: string | null;
  last_valid_sample_time_utc: string | null; last_observation_time_utc: string | null;
  observation_kind: string; consecutive_invalid_samples: number;
  last_invalid_metrics: string[]; clock_invalid: boolean;
}
interface Options {
  now?: () => number; maxDevices?: number; maxBytes?: number;
  lagMs?: () => number; dataDir?: string; tempDir?: string;
}
interface StorageHealth {
  database_bytes: number | null; sqlite_wal_bytes: number | null; temp_directory: string;
  temp_free_bytes: number | null; temp_total_bytes: number | null;
  temp_free_inodes: number | null; temp_total_inodes: number | null;
  error: string | null;
}
const identity = /^[A-Za-z0-9_-]{1,128}$/;
const metric = /^[a-z][a-z0-9_]{0,63}$/;
const timestamp = (value: unknown): number | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const later = (old: string | null, value: number): string => new Date(Math.max(timestamp(old) ?? -Infinity, value)).toISOString();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Best-effort observability: no writes or thrown monitor errors in MQTT intake. */
export class BusinessHealth {
  private readonly file: string;
  private devices: Record<string, DeviceBusinessHealth> = Object.create(null);
  private readonly now: () => number;
  private readonly maxDevices: number;
  private readonly maxBytes: number;
  private readonly runtimeStart: string;
  private readonly lag: () => number;
  private lagWindow: { time: number; value: number }[] = [];
  private readonly disableLag: () => void;
  private readonly dataDir: string;
  private storage: StorageHealth;
  private monitorError: string | null = null;
  private persistenceError: string | null = null;
  private exportError: string | null = null;
  private pending: Promise<void> | undefined;
  constructor(file: string, options: Options = {}) {
    this.file = file;
    this.now = options.now ?? Date.now;
    this.maxDevices = options.maxDevices ?? 256;
    this.maxBytes = options.maxBytes ?? 48 * 1024;
    this.runtimeStart = new Date(this.now()).toISOString();
    this.dataDir = options.dataDir ?? dirname(file);
    this.storage = { database_bytes: null, sqlite_wal_bytes: null, temp_directory: options.tempDir ?? process.env.SQLITE_TMPDIR ?? '/tmp',
      temp_free_bytes: null, temp_total_bytes: null, temp_free_inodes: null, temp_total_inodes: null, error: 'NOT_CHECKED' };
    if (options.lagMs) { this.lag = options.lagMs; this.disableLag = () => {}; }
    else {
      const histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable();
      this.lag = () => { const value = histogram.max / 1e6; histogram.reset(); return value; };
      this.disableLag = () => histogram.disable();
    }
    try {
      if (statSync(file).size > this.maxBytes) throw new Error('State too large');
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (saved.schema_version !== 1 || !object(saved.devices) || Object.keys(saved.devices).length > this.maxDevices) throw new Error('Invalid state');
      for (const [key, value] of Object.entries(saved.devices)) {
        if (!this.validStored(key, value)) throw new Error('Invalid device state');
      }
      this.devices = Object.assign(Object.create(null), saved.devices);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.monitorError = 'STATE_RESTORE_FAILED';
    }
  }
  private validStored(key: string, value: unknown): value is DeviceBusinessHealth {
    if (!object(value) || ![value.site_id, value.gateway_id, value.device_id].every(v => typeof v === 'string' && identity.test(v))
      || key !== `${value.site_id}/${value.gateway_id}/${value.device_id}`
      || !Number.isSafeInteger(value.consecutive_invalid_samples) || Number(value.consecutive_invalid_samples) < 0
      || !Array.isArray(value.last_invalid_metrics) || value.last_invalid_metrics.length > 128
      || !value.last_invalid_metrics.every(v => typeof v === 'string' && metric.test(v))
      || !['direct_read', 'gateway_cached_state'].includes(String(value.observation_kind)) || typeof value.clock_invalid !== 'boolean'
      || Object.keys(value).some(field => !['site_id', 'gateway_id', 'device_id', 'last_received_time_utc', 'last_collect_time_utc', 'last_valid_time_utc', 'last_sample_time_utc', 'last_valid_sample_time_utc', 'last_observation_time_utc', 'observation_kind', 'consecutive_invalid_samples', 'last_invalid_metrics', 'clock_invalid'].includes(field))) return false;
    for (const field of ['last_received_time_utc', 'last_collect_time_utc', 'last_valid_time_utc', 'last_sample_time_utc', 'last_valid_sample_time_utc', 'last_observation_time_utc']) {
      if (value[field] !== null && (timestamp(value[field]) === null || timestamp(value[field])! > this.now())) return false;
    }
    return true;
  }
  observeAccepted(result: 'saved' | 'duplicate' | 'rejected', topic: string, bytes: Buffer,
    collectd: CollectdTemperatureInput[] = [], receivedAt = this.now()): void {
    if (result !== 'saved' || topic.endsWith('/frames')) return;
    try {
      const input = collectd.find(value => value.topic === topic);
      // These are the same pure normalization/quality functions used by Queue;
      // the monitor neither runs jobs nor modifies stored payloads or lineage.
      const row = input ? collectdTemperatureProcessor.process(collectdRaw(input, bytes, receivedAt))
        : parseSample(topic, bytes, [topic.split('/').slice(0, 4).join('/')], new Date(receivedAt));
      this.observe(row);
    } catch { this.monitorError = 'OBSERVATION_FAILED'; }
  }
  observe(row: RecordRow): void {
    try {
      const sample = parseJson(row.payload) as Sample;
      if (sample.quality !== 'ok') return; // Historical imports are never live observations.
      if (![sample.site_id, sample.gateway_id, sample.device_id].every(value => typeof value === 'string' && identity.test(value))) throw new Error('Invalid identity');
      const received = timestamp(row.received_at), times = observationTimes(sample), collect = timestamp(times.read_time_utc), actual = timestamp(times.sample_time_utc);
      if (received === null || received > this.now()) throw new Error('Invalid receive time');
      const key = `${sample.site_id}/${sample.gateway_id}/${sample.device_id}`;
      const previous = this.devices[key];
      const value: DeviceBusinessHealth = previous ? { ...previous, last_invalid_metrics: [...previous.last_invalid_metrics] } : {
        site_id: sample.site_id, gateway_id: sample.gateway_id, device_id: sample.device_id,
        last_received_time_utc: null, last_collect_time_utc: null, last_valid_time_utc: null,
        last_sample_time_utc: null, last_valid_sample_time_utc: null, last_observation_time_utc: null,
        observation_kind: times.observation_kind, consecutive_invalid_samples: 0, last_invalid_metrics: [], clock_invalid: false,
      };
      value.last_received_time_utc = later(value.last_received_time_utc, received);
      // A future read must not poison the watermark or recover a stale device.
      if (collect === null || collect > received || (actual !== null && (actual > collect || actual > received))) {
        value.clock_invalid = true;
      } else {
        const previousCollect = timestamp(value.last_collect_time_utc) ?? -Infinity;
        const previousActual = timestamp(value.last_sample_time_utc) ?? -Infinity;
        const observation = actual ?? collect;
        if (collect > previousCollect) {
          value.last_collect_time_utc = later(value.last_collect_time_utc, collect);
          value.observation_kind = times.observation_kind;
          if (actual !== null) value.last_sample_time_utc = later(value.last_sample_time_utc, actual);
          value.clock_invalid = false;
        }
        // Poll and actual-sample watermarks are separate. A repeated known sample
        // can be read successfully again, but cannot increment/reset its streak.
        // Newly available actual timestamps must not be compared with old poll times.
        if (collect > previousCollect && (actual === null || actual >= previousActual)) {
          const existing = row.lineage?.metric_quality;
          const quality = existing === undefined ? assessMetricQuality(sample) : existing;
          if (quality !== undefined && (!object(quality) || !object(quality.metrics))) throw new Error('Invalid metric assessment');
          const assessed = (quality as { metrics: Record<string, { status?: unknown }> } | undefined)?.metrics ?? {};
          const names = [...new Set([...Object.keys(sample.metrics), ...Object.keys(assessed)])];
          if (!names.length || names.length > 128 || !names.every(name => metric.test(name))) throw new Error('Invalid metric set');
          value.last_invalid_metrics = names.filter(name => !Number.isFinite(sample.metrics[name])
            || (name in assessed && assessed[name]?.status !== 'ok')).sort();
          value.last_observation_time_utc = new Date(observation).toISOString();
          if (actual === null || actual > previousActual) value.consecutive_invalid_samples = value.last_invalid_metrics.length
            ? Math.min(Number.MAX_SAFE_INTEGER, value.consecutive_invalid_samples + 1) : 0;
          if (!value.last_invalid_metrics.length) {
            value.last_valid_time_utc = later(value.last_valid_time_utc, collect);
            if (actual !== null) value.last_valid_sample_time_utc = later(value.last_valid_sample_time_utc, actual);
          }
        }
      }
      const candidate = { ...this.devices, [key]: value };
      if (Object.keys(candidate).length > this.maxDevices || Buffer.byteLength(JSON.stringify({ schema_version: 1, devices: candidate })) > this.maxBytes) {
        this.monitorError = 'DEVICE_STATE_CAPACITY'; return;
      }
      this.devices[key] = value;
      if (this.monitorError === 'OBSERVATION_FAILED') this.monitorError = null;
    } catch { this.monitorError = 'OBSERVATION_FAILED'; }
  }
  snapshot() {
    let lag: number | null = null;
    try {
      const value = this.lag(), time = Math.floor(this.now() / 5000) * 5000;
      if (Number.isFinite(value) && value >= 0) {
        const bucket = this.lagWindow.find(entry => entry.time === time);
        if (bucket) bucket.value = Math.max(bucket.value, value); else this.lagWindow.push({ time, value });
        if (this.monitorError === 'LAG_MONITOR_FAILED') this.monitorError = null;
      }
    }
    catch { this.monitorError = 'LAG_MONITOR_FAILED'; }
    this.lagWindow = this.lagWindow.filter(entry => entry.time > this.now() - 60000 && entry.time <= this.now()).slice(-12);
    if (this.lagWindow.length) lag = Math.round(Math.max(...this.lagWindow.map(entry => entry.value)) * 1000) / 1000;
    return { schema_version: 1, runtime_start_time_utc: this.runtimeStart, event_loop_lag_ms: lag, event_loop_lag_window_seconds: 60,
      devices: Object.fromEntries(Object.entries(this.devices).map(([key, value]) => [key, { ...value, last_invalid_metrics: [...value.last_invalid_metrics] }])),
      monitor_error: this.monitorError, persistence_error: this.persistenceError, export_error: this.exportError, storage: { ...this.storage } };
  }
  /** Called from the heartbeat, never intake; serialize asynchronous writes. */
  publishHealth(health: object): void {
    if (this.pending) return;
    try {
      const state = JSON.stringify({ schema_version: 1, devices: this.devices });
      const exported = JSON.stringify(health);
      const exportFits = Buffer.byteLength(exported) <= 64 * 1024;
      if (!exportFits) this.exportError = 'HEALTH_EXPORT_CAPACITY';
      this.pending = Promise.all([
        this.atomic(this.file, state, 0o600).then(() => { this.persistenceError = null; }, () => { this.persistenceError = 'STATE_PERSIST_FAILED'; }),
        exportFits ? this.atomic(join(this.dataDir, 'monitor', 'health.json'), exported, 0o644, 0o755)
          .then(() => { this.exportError = null; }, () => { this.exportError = 'HEALTH_EXPORT_FAILED'; }) : Promise.resolve(),
        this.readStorage(),
      ]).then(() => {}, () => { this.monitorError = 'MONITOR_REFRESH_FAILED'; }).finally(() => { this.pending = undefined; });
    } catch { this.monitorError = 'MONITOR_REFRESH_FAILED'; }
  }
  private async atomic(file: string, body: string, mode: number, directoryMode = 0o700) {
    await mkdir(dirname(file), { recursive: true, mode: directoryMode });
    if (directoryMode === 0o755) await chmod(dirname(file), directoryMode);
    await writeFile(file + '.tmp', body, { mode }); await chmod(file + '.tmp', mode); await rename(file + '.tmp', file);
  }
  private async readStorage() {
    const values = await Promise.allSettled([stat(join(this.dataDir, 'inbox.sqlite')), stat(join(this.dataDir, 'inbox.sqlite-wal')), statfs(this.storage.temp_directory)]);
    const [database, wal, temp] = values;
    this.storage.database_bytes = database.status === 'fulfilled' ? database.value.size : null;
    this.storage.sqlite_wal_bytes = wal.status === 'fulfilled' ? wal.value.size : null;
    if (temp.status === 'fulfilled') {
      this.storage.temp_free_bytes = temp.value.bavail * temp.value.bsize; this.storage.temp_total_bytes = temp.value.blocks * temp.value.bsize;
      this.storage.temp_free_inodes = temp.value.ffree; this.storage.temp_total_inodes = temp.value.files;
    } else {
      this.storage.temp_free_bytes = this.storage.temp_total_bytes = this.storage.temp_free_inodes = this.storage.temp_total_inodes = null;
    }
    const walMissing = wal.status === 'rejected' && (wal.reason as NodeJS.ErrnoException)?.code === 'ENOENT';
    this.storage.error = database.status === 'rejected' || temp.status === 'rejected' || (wal.status === 'rejected' && !walMissing) ? 'STORAGE_PROBE_FAILED' : null;
  }
  async settled() { await this.pending; }
  async close() {
    this.disableLag(); await this.settled();
    try { await this.atomic(this.file, JSON.stringify({ schema_version: 1, devices: this.devices }), 0o600); this.persistenceError = null; }
    catch { this.persistenceError = 'STATE_PERSIST_FAILED'; }
  }
}
