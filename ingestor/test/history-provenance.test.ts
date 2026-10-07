import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertHistory } from '../src/history.ts';
import { Queue } from '../src/queue.ts';
import type { RawRecord, RecordRow } from '../src/message.ts';

// Frozen output of the previous converter with synthetic source identities.
// Keep these bytes independent of the current converter to detect ID/hash drift.
const raw: RawRecord = {
  raw_id: 'ab663773-d5ec-53b9-abe6-67b6c4510b93',
  topic: 'iot/v1/archived-home/retired-gateway/devices/retired-meter/telemetry',
  source_kind: 'legacy_d1', source_id: 'archive-example-db/electricity_energy/71',
  source_message_id: null, source_site_id: 'archived-home',
  source_gateway_id: 'retired-gateway', source_device_id: 'retired-meter',
  data_kind: 'inline', content_type: 'application/json',
  raw_data: '{"consumed_energy":71.25,"create_time_utc":1668000000000,"id":71,"owner_id":1}',
  raw_data_sha256: '85fad774fcdc6474520157ce7855ce1e7938e552d56d84954b25293b9a045ce5',
  generate_time_utc: null, receive_time_utc: 1789809994000,
  store_time_utc: 1789809994000, expire_time_utc: 1805361994000,
};
const payload = '{"device_id":"retired-meter","gateway_id":"retired-gateway","message_id":"ab663773-d5ec-53b9-abe6-67b6c4510b93","metrics":{"energy_kwh":71.25},"quality":"historical","sample_time_utc":null,"schema_version":2,"site_id":"archived-home","source":{"excluded_metrics":[],"source_database_id":"archive-example-db","source_kind":"legacy_d1","source_owner_id":1,"source_receive_time_utc":"2022-11-09T13:20:00.000Z","source_row_id":71,"source_table":"electricity_energy","source_time_semantics":"server_ingest","wire_frames_available":false},"source_receive_time_utc":"2022-11-09T13:20:00.000Z"}';
const result: RecordRow = {
  id: raw.raw_id, raw_id: raw.raw_id, topic: raw.topic, payload,
  hash: 'cb7f6e00c08bb6cf3983fce85f6f029d425c9814b04a21a0fd2b4f8846cb21f1',
  received_at: '2026-09-19T09:26:34.000Z',
  processor_id: 'legacy-ddsu666', processor_version: '1', output_key: 'electricity_energy',
  lineage: JSON.parse(payload).source, source_kind: raw.source_kind, source_id: raw.source_id,
};
const options = { maxPending: 10, maxRejected: 10 };

test('explicit historical configuration preserves the archived converter bytes', () => {
  const converted = convertHistory('electricity_energy', JSON.parse(raw.raw_data), {
    databaseId: 'archive-example-db', ownerId: 1, siteId: 'archived-home',
    gatewayId: 'retired-gateway', deviceId: 'retired-meter',
  }, raw.store_time_utc);
  assert.deepEqual(converted, { raw, result });
});

test('persisted historical provenance replays after restart without changing IDs, hashes or delivery state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-provenance-'));
  const path = join(dir, 'queue.sqlite');
  let queue = new Queue(path, options);
  try {
    queue.importHistorical(raw, result);
    queue.done('local', result.id); queue.done('supabase', result.id);
    queue.close(); queue = new Queue(path, options);
    queue.replay(raw.raw_id, 'legacy-ddsu666', '1');
    assert.equal(queue.processOne(), true);
    assert.equal(queue.stats().processing_failed, 0);
    assert.equal(queue.stats().raw_records, 1);
    assert.equal(queue.next('local'), undefined, 'Confirmed delivery must stay confirmed');
    queue.retry('local', result.id);
    const replayed = queue.next('local');
    assert.equal(replayed?.id, result.id);
    assert.equal(replayed?.hash, result.hash);
    assert.equal(replayed?.payload, result.payload);
    assert.equal(replayed?.received_at, result.received_at);
  } finally {
    queue.close(); rmSync(path, { force: true }); rmdirSync(dir);
  }
});

test('historical replay rejects corrupted source database, row identity and topic', () => {
  for (const changed of [
    { source_id: 'other-example-db/electricity_energy/71' },
    { source_id: 'archive-example-db/electricity_energy/72' },
    { source_id: 'archive-example-db/electricity_energy/71/extra' },
    { topic: 'iot/v1/other-home/retired-gateway/devices/retired-meter/telemetry' },
  ]) {
    const queue = new Queue(':memory:', options);
    try {
      queue.importHistorical({ ...raw, ...changed }, result);
      queue.replay(raw.raw_id, 'legacy-ddsu666', '1');
      assert.equal(queue.processOne(), true);
      assert.equal(queue.stats().processing_failed, 1);
      assert.equal(queue.stats().raw_records, 1);
    } finally { queue.close(); }
  }
});
