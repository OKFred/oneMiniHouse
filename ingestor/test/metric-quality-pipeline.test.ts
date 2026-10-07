import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue, ConflictError } from '../src/queue.ts';
import { receive } from '../src/intake.ts';
import { canonical, hash, observationTimes, parseJson, parseSample, type RawRecord, type RecordRow, type Sample } from '../src/message.ts';
import { deliverOne, PostgresSink, resultHash } from '../src/database.ts';
import { assessMetricQuality, type MetricQualityAssessment } from '../src/metric-quality.ts';

const prefix = 'iot/v1/example-home/example-gateway';
const processor = 'xiaomi-temperature-quality';
const version = '1';
const options = { maxPending: 20, maxRejected: 10, rawMirror: true };
const readTime = '2026-09-27T12:00:00.000Z';
const topicFor = (sample: Sample) => `${prefix}/devices/${sample.device_id}/telemetry`;
const makeQueue = () => new Queue(':memory:', options);

function sample(): Sample {
  return {
    schema_version: 2, message_id: randomUUID(), site_id: 'example-home', gateway_id: 'example-gateway',
    device_id: 'temperature-room', sample_time_utc: null, read_time_utc: readTime,
    observation_kind: 'gateway_cached_state', quality: 'ok',
    metrics: { temperature_c: 100, humidity_pct: 0, battery_pct: 60 },
    source: { driver: 'xiaomi-gateway-v3-temperature', sensor_model: 'WSDCGQ01LM',
      observation_kind: 'gateway_cached_state', sensor_sample_time_known: false },
  };
}

function sourceRow(value: Sample): RecordRow {
  return parseSample(topicFor(value), Buffer.from(JSON.stringify(value)), [prefix]);
}

function rawRecord(value: Sample, bytes: Buffer): RawRecord {
  const now = Date.now();
  return {
    raw_id: value.message_id, topic: topicFor(value), source_kind: 'mqtt', source_id: topicFor(value),
    source_message_id: value.message_id, source_site_id: value.site_id, source_gateway_id: value.gateway_id,
    source_device_id: value.device_id, data_kind: 'inline', content_type: 'application/json',
    raw_data: bytes.toString('utf8'), raw_data_sha256: hash(bytes),
    generate_time_utc: Date.parse(value.read_time_utc ?? value.captured_at!),
    receive_time_utc: now, store_time_utc: now, expire_time_utc: now + 180 * 86400000,
  };
}

function changedAssessment(row: RecordRow): RecordRow {
  const changed = structuredClone(row);
  // Deliberately change only the quality decision, preserving IDs, source
  // envelope, numerical readings and their hash to exercise its own contract.
  const assessment = structuredClone(row.lineage?.metric_quality
    ?? assessMetricQuality(parseJson(row.payload) as Sample)) as MetricQualityAssessment;
  assert.ok(assessment);
  assessment.metrics.temperature_c.status = 'ok';
  changed.lineage = { ...changed.lineage, metric_quality: assessment };
  return changed;
}

test('Xiaomi quality processing preserves original bytes, metric values and independently mirrored raw', () => {
  const queue = makeQueue(), value = sample();
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\n' + JSON.stringify(value, null, 2) + '\n')]);
  try {
    assert.equal(receive(queue, topicFor(value), bytes, [prefix]), 'saved');
    const raw = queue.getRaw(value.message_id)!;
    assert.deepEqual(Buffer.from(raw.raw_data), bytes);
    assert.equal(raw.raw_data_sha256, hash(bytes));
    assert.equal(raw.source_message_id, value.message_id);
    const result = queue.next('local')!;
    assert.equal(result.processor_id, processor);
    assert.equal(result.processor_version, version);
    assert.equal(result.raw_id, value.message_id);
    assert.notEqual(result.id, value.message_id);
    assert.equal(result.lineage!.source_message_id, value.message_id);
    const assessment = result.lineage!.metric_quality as MetricQualityAssessment;
    assert.equal(assessment.metrics.temperature_c.status, 'out_of_spec');
    assert.equal(assessment.metrics.humidity_pct.status, 'out_of_spec');
    const processed = parseJson(result.payload) as Sample;
    assert.deepEqual(processed.metrics, value.metrics);
    assert.equal(processed.metrics.battery_pct, 60);
    assert.deepEqual(observationTimes(processed), {
      sample_time_utc: null, read_time_utc: readTime,
      observation_kind: 'gateway_cached_state', time_basis: 'gateway_state_read_time',
    });
    assert.deepEqual(queue.next('supabase'), result);
    assert.equal(receive(queue, topicFor(value), Buffer.from(canonical(value)), [prefix]), 'duplicate');
    assert.deepEqual(Buffer.from(queue.getRaw(value.message_id)!.raw_data), bytes);
    queue.done('local', result.id); queue.done('supabase', result.id);
    assert.equal(queue.stats().queued, 0);
    assert.equal(queue.nextRaw()!.raw_data, bytes.toString('utf8'));
    queue.done('d1', value.message_id);
    assert.equal(queue.stats().raw_records, 1);
  } finally { queue.close(); }
});

test('75 degree host telemetry and unmatched Xiaomi identities retain the original processor and hash', () => {
  for (const source of [
    { driver: 'linux-temperature-mqtt', sensor_model: 'WSDCGQ01LM' },
    { driver: 'xiaomi-gateway-v3-temperature', sensor_model: 'different-model' },
    { driver: 'xiaomi-gateway-v3-temperature' },
  ]) {
    const queue = makeQueue(), value: Sample = { ...sample(), device_id: 'temperature-host',
      observation_kind: 'direct_read', metrics: { cpu_temperature_c: 75 }, source };
    try {
      const original = sourceRow(value);
      queue.accept(original);
      const result = queue.next('local')!;
      assert.equal(result.id, value.message_id);
      assert.equal(result.processor_id, 'iot-telemetry');
      assert.equal(result.processor_version, '1');
      assert.equal(result.lineage!.metric_quality, undefined);
      assert.deepEqual(JSON.parse(result.payload).metrics, { cpu_temperature_c: 75 });
      assert.equal(resultHash(result), resultHash(original));
    } finally { queue.close(); }
  }
});

test('legacy v1 replay appends a deterministic assessment and retains both independent result versions', () => {
  const value: Sample = { ...sample(), schema_version: 1, captured_at: readTime };
  delete value.sample_time_utc; delete value.read_time_utc; delete value.observation_kind;
  const bytes = Buffer.from(' \n' + JSON.stringify(value, null, 2) + '\n');
  const raw = rawRecord(value, bytes), queue = makeQueue(), other = makeQueue();
  try {
    // Reconstruct an already processed v1 row without depending on the new
    // live intake routing, which must now select the quality processor.
    queue.acceptRaw(raw, 'iot-telemetry', '1');
    const legacy = queue.next('local')!;
    assert.equal(legacy.id, value.message_id);
    assert.equal(legacy.lineage!.metric_quality, undefined);
    queue.done('local', legacy.id);
    queue.replay(raw.raw_id, processor, version);
    const corrected = queue.next('local')!;
    assert.notEqual(corrected.id, legacy.id);
    assert.equal(corrected.raw_id, legacy.raw_id);
    assert.equal(corrected.received_at, legacy.received_at);
    assert.equal(corrected.lineage!.source_message_id, value.message_id);
    assert.deepEqual(JSON.parse(corrected.payload).metrics, value.metrics);
    assert.equal(observationTimes(JSON.parse(corrected.payload)).read_time_utc, readTime);
    assert.deepEqual(queue.nextBatch('supabase').map(row => row.id), [legacy.id, corrected.id]);
    queue.done('local', corrected.id);
    queue.replay(raw.raw_id, processor, version);
    assert.equal(queue.next('local'), undefined);
    assert.deepEqual(queue.nextBatch('supabase').map(row => row.id), [legacy.id, corrected.id]);
    assert.equal(queue.stats().processing_failed, 0);
    assert.equal(queue.stats().raw_records, 1);
    assert.deepEqual(Buffer.from(queue.getRaw(raw.raw_id)!.raw_data), bytes);

    other.acceptRaw(raw, 'iot-telemetry', '1');
    other.processOne(); other.done('local', legacy.id);
    other.replay(raw.raw_id, processor, version);
    const independent = other.next('local')!;
    assert.equal(independent.id, corrected.id);
    assert.equal(resultHash(independent), resultHash(corrected));
  } finally { queue.close(); other.close(); }
});

test('pending assessment and separate database acknowledgments survive restart and lost commit responses', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'metric-quality-restart-')), file = join(directory, 'inbox.sqlite');
  const value = sample(), bytes = Buffer.from(JSON.stringify(value));
  let queue = new Queue(file, options);
  const committed = new Map<string, string>();
  try {
    assert.equal(receive(queue, topicFor(value), bytes, [prefix]), 'saved');
    queue.close(); queue = new Queue(file, options);
    assert.equal(queue.stats().processing_pending, 1);
    const result = queue.next('local')!;
    assert.equal(result.processor_id, processor);
    await assert.rejects(deliverOne(queue, 'local', async row => {
      committed.set(row.id, resultHash(row));
      throw new Error('simulated commit response loss');
    }), /response loss/);
    assert.equal(queue.stats().local_pending, 1);
    queue.close(); queue = new Queue(file, options);
    assert.equal(queue.next('local')!.id, result.id);
    await deliverOne(queue, 'local', async row => {
      assert.equal(committed.get(row.id), resultHash(row));
      committed.set(row.id, resultHash(row));
    });
    assert.equal(committed.size, 1);
    await assert.rejects(deliverOne(queue, 'supabase', async () => { throw new Error('simulated network outage'); }), /outage/);
    queue.failed('supabase', result.id, 'OFFLINE');
    queue.close(); queue = new Queue(file, options);
    assert.equal(queue.next('local'), undefined);
    assert.equal(queue.stats().supabase_pending, 1);
    queue.retry('supabase', result.id);
    await deliverOne(queue, 'supabase', async row => {
      assert.deepEqual(row, result);
      assert.equal(resultHash(row), committed.get(row.id));
    });
    assert.equal(queue.stats().queued, 0);
    assert.equal(queue.nextRaw()!.raw_data, bytes.toString());
    queue.done('d1', value.message_id);
    assert.equal(queue.stats().d1_pending, 0);
    assert.equal(queue.stats().raw_records, 1);
  } finally { queue.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('quality decisions are covered by the new result hash and PG duplicate checks without changing legacy hashes', async () => {
  const queue = makeQueue(), value = sample();
  try {
    const original = sourceRow(value);
    queue.accept(original);
    const assessed = queue.next('local')!, altered = changedAssessment(assessed);
    assert.equal(altered.payload, assessed.payload);
    assert.equal(altered.hash, assessed.hash);
    assert.notEqual(resultHash(altered), resultHash(assessed));
    assert.equal(resultHash(changedAssessment(original)), resultHash(original));
    const sink = Object.assign(Object.create(PostgresSink.prototype), {
      pool: { query: async (sql: string) => sql.startsWith('INSERT')
        ? { rowCount: 0, rows: [] }
        : { rows: [{ payload_sha256: assessed.hash, result_sha256: resultHash(assessed) }] } },
    }) as PostgresSink;
    await sink.write(assessed);
    await assert.rejects(sink.write(altered), ConflictError);
    await assert.rejects(sink.writeBatch([altered]), ConflictError);
  } finally { queue.close(); }
});

test('replaying the same quality processor version cannot silently replace an earlier assessment', () => {
  const queue = makeQueue(), value = sample();
  try {
    queue.accept(sourceRow(value));
    const first = queue.next('local')!;
    queue.registerProcessor({ id: processor, version, process: () => changedAssessment(first) });
    queue.replay(value.message_id, processor, version);
    assert.equal(queue.processOne(), true);
    assert.equal(queue.stats().processing_failed, 1);
    assert.deepEqual(queue.next('local'), first);
    assert.deepEqual(queue.next('supabase'), first);
    assert.equal(queue.getRaw(value.message_id)!.raw_data, JSON.stringify(value));
  } finally { queue.close(); }
});
