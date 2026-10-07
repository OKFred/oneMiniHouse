import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PostgresSink, deliverOne, postgresProjection, resultHash, sourceResultHash } from '../src/database.ts';
import { projectMetricsForPostgres } from '../src/pg-metric-projection.ts';
import { parseSample, type RecordRow, type Sample } from '../src/message.ts';
import { ConflictError, Queue } from '../src/queue.ts';

const prefix = 'iot/v1/example-home/example-host';
const topic = `${prefix}/devices/temperature-example-host/telemetry`;
const queueOptions = { maxPending: 20, maxRejected: 10, rawMirror: true };
function row(metrics: Record<string, number> = {
  cpu_package_temperature_c: 60, cpu_core_0_temperature_c: 95, cpu_core_12_temperature_c: 62,
  nvme_temperature_c: 42, gpu_temperature_c: 51,
}): RecordRow {
  const sample: Sample = {
    schema_version: 2, message_id: randomUUID(), site_id: 'example-home', gateway_id: 'example-host',
    device_id: 'temperature-example-host', quality: 'ok', sample_time_utc: null,
    read_time_utc: '2026-09-28T01:02:03.000Z', observation_kind: 'direct_read', metrics,
    source: { driver: 'linux-temperature-mqtt', temperature_source: 'linux_sysfs' },
  };
  return parseSample(topic, Buffer.from(JSON.stringify(sample)), [prefix]);
}

interface StoredRow { message_id: string; payload_sha256: string; result_sha256: string; metrics: Record<string, number>; lineage: Record<string, unknown> }
function fakeSink(stored = new Map<string, StoredRow>()) {
  const sink = Object.assign(Object.create(PostgresSink.prototype), { pool: {
    query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith('INSERT')) {
        const inserted: { message_id: string }[] = [];
        for (let offset = 0; offset < values.length; offset += 20) {
          const id = String(values[offset]);
          if (stored.has(id)) continue;
          stored.set(id, { message_id: id, metrics: JSON.parse(String(values[offset + 8])),
            payload_sha256: String(values[offset + 9]), lineage: JSON.parse(String(values[offset + 14])),
            result_sha256: String(values[offset + 15]) });
          inserted.push({ message_id: id });
        }
        return { rowCount: inserted.length, rows: inserted };
      }
      const ids = Array.isArray(values[0]) ? values[0] as string[] : [String(values[0])];
      return { rows: ids.map(id => stored.get(id)).filter(Boolean) };
    },
  } }) as PostgresSink;
  return { sink, stored };
}

test('PG projection removes only exact CPU core keys and never derives the package value', () => {
  const original = row({ cpu_package_temperature_c: 45, cpu_core_0_temperature_c: 100,
    cpu_core_100_temperature_c: 95, cpu_temperature_c: 47, gpu_temperature_c: 40,
    gpu_core_temperature_c: 42, cpu_core_bad_temperature_c: 23, cpu_core_0_voltage_v: 1,
    ddr_temperature_c: 52, energy_kwh: 15 });
  const before = structuredClone(original), projected = postgresProjection(original);
  assert.deepEqual(projected.metrics, { cpu_package_temperature_c: 45, cpu_temperature_c: 47,
    gpu_temperature_c: 40, gpu_core_temperature_c: 42, cpu_core_bad_temperature_c: 23,
    cpu_core_0_voltage_v: 1, ddr_temperature_c: 52, energy_kwh: 15 });
  assert.deepEqual(projected.removedMetrics, ['cpu_core_0_temperature_c', 'cpu_core_100_temperature_c']);
  assert.deepEqual(original, before);
  assert.deepEqual(projected.lineage.pg_metric_projection, { id: 'cpu-package-only', version: '1',
    source_result_sha256: sourceResultHash(original), removed_metrics: projected.removedMetrics });
  assert.deepEqual(projected.lineage.source, original.lineage!.source);
  assert.notEqual(projected.resultHash, sourceResultHash(original));
});

test('samples without CPU core fields preserve the existing result hash and lineage contract', () => {
  const examples: Record<string, number>[] = [{ cpu_package_temperature_c: 55 }, { cpu_temperature_c: 65 },
    { temperature_c: 23, humidity_pct: 60 }, { power_w: 100, energy_kwh: 123 }, { gpu_temperature_c: 43 }];
  for (const metrics of examples) {
    const original = row(metrics), projected = postgresProjection(original);
    assert.deepEqual(projected.metrics, metrics);
    assert.deepEqual(projected.lineage, original.lineage);
    assert.deepEqual(projected.removedMetrics, []);
    assert.equal(resultHash(original), sourceResultHash(original));
  }
});

test('a core-only sample keeps an empty PG dedup receipt and does not fabricate package temperature', async () => {
  const original = row({ cpu_core_0_temperature_c: 99 }), { sink, stored } = fakeSink();
  assert.equal(await sink.write(original), 'confirmed');
  assert.deepEqual(stored.get(original.id)!.metrics, {});
  assert.equal(stored.get(original.id)!.payload_sha256, original.hash);
  assert.equal(await sink.write(original), 'confirmed');
  assert.equal(stored.size, 1);
});

test('history projection and old queued retry produce the same hash; repeated cleanup is unchanged', async () => {
  const original = row(), legacyHash = sourceResultHash(original);
  const history = projectMetricsForPostgres(JSON.parse(original.payload).metrics, legacyHash, original.lineage);
  assert.equal(history.resultHash, resultHash(original));
  assert.deepEqual(projectMetricsForPostgres(history.metrics, history.resultHash, history.lineage), {
    ...history, removedMetrics: [],
  });
  const { sink, stored } = fakeSink(new Map([[original.id, {
    message_id: original.id, payload_sha256: original.hash, result_sha256: history.resultHash,
    metrics: history.metrics, lineage: history.lineage,
  }]]));
  assert.equal(await sink.write(original), 'confirmed');
  assert.equal(stored.size, 1);
  assert.deepEqual(stored.get(original.id)!.metrics, { cpu_package_temperature_c: 60, nvme_temperature_c: 42, gpu_temperature_c: 51 });
});

test('an untouched legacy row can confirm an old retry during cleanup, without mutating that row', async () => {
  const original = row(), legacy = {
    message_id: original.id, payload_sha256: original.hash, result_sha256: sourceResultHash(original),
    metrics: JSON.parse(original.payload).metrics, lineage: original.lineage!,
  }, { sink, stored } = fakeSink(new Map([[original.id, legacy]]));
  const before = structuredClone(legacy);
  assert.equal(await sink.write(original), 'confirmed');
  assert.deepEqual(stored.get(original.id), before);
  // New messages are filtered immediately even while old history is being cleaned.
  const next = row(); await sink.write(next);
  assert.equal(stored.get(next.id)!.metrics.cpu_core_0_temperature_c, undefined);
  assert.deepEqual(await sink.writeBatch([original, next]), { confirmed: [original.id, next.id], expired: [] });
  assert.deepEqual(stored.get(original.id), before);
});

test('legacy transition rejects wrong metrics, lineage, source hash, missing hashes and partial cleanup', async () => {
  const original = row(), legacy: StoredRow = {
    message_id: original.id, payload_sha256: original.hash, result_sha256: sourceResultHash(original),
    metrics: JSON.parse(original.payload).metrics, lineage: original.lineage!,
  };
  const variants: StoredRow[] = [
    { ...legacy, metrics: { ...legacy.metrics, cpu_core_0_temperature_c: 94 } },
    { ...legacy, metrics: postgresProjection(original).metrics },
    { ...legacy, lineage: { ...legacy.lineage, source_kind: 'tampered' } },
    { ...legacy, lineage: { ...legacy.lineage, pg_metric_projection: {} } },
    { ...legacy, payload_sha256: 'a'.repeat(64) },
    { ...legacy, result_sha256: 'b'.repeat(64) },
    { ...legacy, result_sha256: null as unknown as string },
    { ...legacy, metrics: undefined as unknown as Record<string, number> },
    { ...legacy, lineage: undefined as unknown as Record<string, unknown> },
  ];
  for (const stored of variants) {
    const { sink } = fakeSink(new Map([[original.id, stored]]));
    await assert.rejects(sink.write(original), ConflictError);
    await assert.rejects(sink.writeBatch([original, row()]), ConflictError);
  }
});

test('projected duplicate verifies actual metrics and lineage rather than trusting only its stored hash', async () => {
  const original = row(), projection = postgresProjection(original), valid: StoredRow = {
    message_id: original.id, payload_sha256: original.hash, result_sha256: projection.resultHash,
    metrics: projection.metrics, lineage: projection.lineage,
  };
  for (const altered of [
    { ...valid, metrics: { ...valid.metrics, cpu_package_temperature_c: 10 } },
    { ...valid, metrics: JSON.parse(original.payload).metrics },
    { ...valid, lineage: original.lineage! },
  ]) {
    const { sink } = fakeSink(new Map([[original.id, altered]]));
    await assert.rejects(sink.write(original), ConflictError);
    await assert.rejects(sink.writeBatch([original, row()]), ConflictError);
  }
});

test('history cleanup fails closed for missing original hashes or partially projected rows', () => {
  for (const invalid of [undefined, null, '', 'invalid', 'x'.repeat(64)]) {
    assert.throws(() => projectMetricsForPostgres({ cpu_core_0_temperature_c: 80 }, invalid as string), /original result hash/);
  }
  assert.throws(() => projectMetricsForPostgres({ cpu_core_0_temperature_c: 80 }, 'a'.repeat(64), {
    pg_metric_projection: { id: 'cpu-package-only' },
  }), /already recorded/);
});

test('changing even a removed core reading still conflicts for the same source message ID', async () => {
  const original = row(), changed = structuredClone(original), { sink } = fakeSink();
  const payload = JSON.parse(changed.payload); payload.metrics.cpu_core_0_temperature_c += 1;
  changed.payload = JSON.stringify(payload);
  // Keep the legacy payload checksum equal intentionally: the result hash must
  // independently detect a change, including values excluded from PG metrics.
  assert.deepEqual(postgresProjection(changed).metrics, postgresProjection(original).metrics);
  assert.notEqual(resultHash(changed), resultHash(original));
  await sink.write(original);
  await assert.rejects(sink.write(changed), ConflictError);
});

test('mixed batch writes project each result for both PG sinks without changing the caller rows', async () => {
  const rows = [row(), row({ energy_kwh: 15, power_w: 80 }), row({ cpu_core_1_temperature_c: 88 })];
  const before = structuredClone(rows), local = fakeSink(), cloud = fakeSink();
  for (const { sink, stored } of [local, cloud]) {
    assert.deepEqual(await sink.writeBatch(rows), { confirmed: rows.map(v => v.id), expired: [] });
    assert.deepEqual(await sink.writeBatch(rows), { confirmed: rows.map(v => v.id), expired: [] });
    assert.equal(stored.size, 3);
    for (const value of stored.values()) assert.ok(!Object.keys(value.metrics).some(k => /^cpu_core_[0-9]+_temperature_c$/.test(k)));
  }
  assert.deepEqual(local.stored, cloud.stored);
  assert.deepEqual(rows, before);
  local.stored.get(rows[0].id)!.result_sha256 = 'a'.repeat(64);
  await assert.rejects(local.sink.writeBatch(rows), ConflictError);
});

test('pre-upgrade SQLite result, raw bytes, D1 delivery and independent PG retries survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cpu-pg-projection-'));
  const filename = join(directory, 'inbox.sqlite'), original = row(), local = fakeSink(), cloud = fakeSink();
  let queue = new Queue(filename, queueOptions);
  try {
    queue.accept(original);
    const pending = queue.next('local')!;
    assert.equal(JSON.parse(pending.payload).metrics.cpu_core_0_temperature_c, 95);
    queue.close(); queue = new Queue(filename, queueOptions);
    // Simulate a committed local write followed by a lost network response.
    await assert.rejects(deliverOne(queue, 'local', async value => {
      await local.sink.write(value); throw new Error('lost commit response');
    }), /lost commit response/);
    queue.close(); queue = new Queue(filename, queueOptions);
    assert.equal(await deliverOne(queue, 'local', value => local.sink.write(value)), true);
    assert.equal(queue.next('local'), undefined);
    assert.equal(queue.next('supabase')!.id, pending.id);
    assert.deepEqual(queue.next('supabase'), pending);
    assert.equal(await deliverOne(queue, 'supabase', value => cloud.sink.write(value)), true);
    assert.deepEqual(local.stored, cloud.stored);
    assert.equal(local.stored.size, 1);
    assert.equal(queue.getRaw(original.id)!.raw_data, original.payload);
    assert.equal(JSON.parse(queue.nextRaw()!.raw_data).metrics.cpu_core_0_temperature_c, 95);
    queue.done('d1', original.id);
    queue.replay(original.id, 'iot-telemetry', '1');
    queue.processOne();
    assert.equal(queue.stats().processing_failed, 0);
    assert.equal(queue.next('local'), undefined);
  } finally { queue.close(); rmSync(directory, { recursive: true, force: true }); }
});
