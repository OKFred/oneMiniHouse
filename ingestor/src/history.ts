import { canonical, hash, stableUuid, type RawRecord, type RecordRow, type Sample } from './message.ts';

export const LEGACY_TABLES = ['electricity_energy', 'electricity_params'] as const;
export type LegacyTable = typeof LEGACY_TABLES[number];
export interface LegacyRow { id: number; owner_id: number; create_time_utc: number; [key: string]: unknown }
export interface HistoryIdentity { siteId: string; gatewayId: string; deviceId: string }
export interface HistorySource extends HistoryIdentity { databaseId: string; ownerId: number }

export function convertHistory(table: LegacyTable, row: LegacyRow, identity: HistorySource, now = Date.now()): { raw: RawRecord; result: RecordRow } {
  if (![identity.databaseId, identity.siteId, identity.gatewayId, identity.deviceId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value)) || !Number.isSafeInteger(identity.ownerId)) throw new Error('Invalid history source configuration');
  if (!LEGACY_TABLES.includes(table) || !Number.isSafeInteger(row.id) || row.id < 1 || row.owner_id !== identity.ownerId || !Number.isSafeInteger(row.create_time_utc) || row.create_time_utc < 0 || row.create_time_utc > now + 300000) throw new Error('Invalid legacy identity or source timestamp');
  const sourceId = `${identity.databaseId}/${table}/${row.id}`;
  const rawId = stableUuid(`oneMiniHouse:legacy_d1:${sourceId}`);
  const metrics: Record<string, number> = {};
  const copy = (from: string, to: string, scale = 1, min = -Infinity, max = Infinity) => {
    const value = row[from];
    if (value === null || value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid legacy metric: ${from}`);
    metrics[to] = value * scale;
  };
  if (table === 'electricity_energy') copy('consumed_energy', 'energy_kwh', 1, 0);
  else {
    copy('voltage', 'voltage_v', 1, 0); copy('current', 'current_a', 1, 0);
    copy('active_power', 'power_w', 1000); copy('reactive_power', 'reactive_power_var', 1000);
    copy('power_factor', 'power_factor', 1, -1, 1);
  }
  if (!Object.keys(metrics).length) throw new Error('Legacy row contains no usable measurements');
  const topic = `iot/v1/${identity.siteId}/${identity.gatewayId}/devices/${identity.deviceId}/telemetry`;
  const rawData = canonical(row);
  const lineage = { source_kind: 'legacy_d1', source_database_id: identity.databaseId, source_table: table, source_row_id: row.id, source_owner_id: row.owner_id, source_time_semantics: 'server_ingest', source_receive_time_utc: new Date(row.create_time_utc).toISOString(), excluded_metrics: table === 'electricity_params' ? ['frequency:legacy_register_offset_unverified','apparent_power:reserved_register'] : [], wire_frames_available: false };
  const sample: Sample = { schema_version: 2, message_id: rawId, site_id: identity.siteId, gateway_id: identity.gatewayId, device_id: identity.deviceId, sample_time_utc: null, source_receive_time_utc: new Date(row.create_time_utc).toISOString(), quality: 'historical', metrics, source: lineage };
  const payload = canonical(sample);
  return {
    raw: { raw_id: rawId, topic, source_kind: 'legacy_d1', source_id: sourceId, source_message_id: null, source_site_id: identity.siteId, source_gateway_id: identity.gatewayId, source_device_id: identity.deviceId, data_kind: 'inline', content_type: 'application/json', raw_data: rawData, raw_data_sha256: hash(rawData), generate_time_utc: null, receive_time_utc: now, store_time_utc: now, expire_time_utc: now + 180 * 86400000 },
    result: { id: rawId, raw_id: rawId, topic, payload, hash: hash(payload), received_at: new Date(now).toISOString(), processor_id: 'legacy-ddsu666', processor_version: '1', output_key: table, lineage, source_kind: 'legacy_d1', source_id: sourceId },
  };
}
