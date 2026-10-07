import type { HistoryIdentity } from './history.ts';
import { canonical, hash, stableUuid, type RawRecord, type RecordRow, type Sample } from './message.ts';

export interface InstallationReference extends HistoryIdentity { installationTimeUtc: string; sourceTimezone: string; note: string }

// A user-provided installation reference, not a recovered device packet.
export function installationBaseline(reference: InstallationReference, now = Date.now()): { raw: RawRecord; result: RecordRow } {
  const { siteId, gatewayId, deviceId, installationTimeUtc } = reference;
  if (![siteId, gatewayId, deviceId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value)) || typeof installationTimeUtc !== 'string' || !Number.isFinite(Date.parse(installationTimeUtc)) || new Date(installationTimeUtc).toISOString() !== installationTimeUtc || typeof reference.sourceTimezone !== 'string' || !reference.sourceTimezone.trim() || typeof reference.note !== 'string' || !reference.note.trim()) throw new Error('Invalid installation reference');
  const sourceId = `${siteId}/${deviceId}/installation/${installationTimeUtc}`;
  const id = stableUuid(`oneMiniHouse:user_reference:${sourceId}`);
  const topic = `iot/v1/${siteId}/${gatewayId}/devices/${deviceId}/telemetry`;
  const lineage = { source_kind: 'user_reference', event_type: 'meter_installation',
    time_basis: 'user_provided', source_timezone: reference.sourceTimezone, wire_frames_available: false };
  const rawData = canonical({ event_time_utc: installationTimeUtc, energy_kwh: 0,
    reference: reference.note, ...lineage });
  const sample: Sample = { schema_version: 2, message_id: id, site_id: siteId, gateway_id: gatewayId,
    device_id: deviceId, sample_time_utc: installationTimeUtc, quality: 'historical',
    metrics: { energy_kwh: 0 }, source: lineage };
  const payload = canonical(sample);
  return {
    raw: { raw_id: id, topic, source_kind: 'user_reference', source_id: sourceId, source_message_id: null,
      source_site_id: siteId, source_gateway_id: gatewayId, source_device_id: deviceId,
      data_kind: 'inline', content_type: 'application/json', raw_data: rawData, raw_data_sha256: hash(rawData),
      generate_time_utc: null, receive_time_utc: now, store_time_utc: now, expire_time_utc: now + 180 * 86400000 },
    result: { id, raw_id: id, topic, payload, hash: hash(payload), received_at: new Date(now).toISOString(),
      processor_id: 'user-meter-reference', processor_version: '1', output_key: 'installation_energy',
      lineage, source_kind: 'user_reference', source_id: sourceId },
  };
}
