-- Run once as the database owner, in one_minihouse (local) / postgres (Supabase).
-- No changes to existing application schemas or Supabase API exposure.
BEGIN;
CREATE SCHEMA IF NOT EXISTS iot;
CREATE TABLE IF NOT EXISTS iot.telemetry (
  message_id uuid PRIMARY KEY,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  site_id text NOT NULL,
  gateway_id text NOT NULL,
  device_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  quality text NOT NULL CHECK (quality = 'ok'),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (length(payload_sha256) = 64)
);
CREATE INDEX IF NOT EXISTS telemetry_device_time ON iot.telemetry(site_id,gateway_id,device_id,captured_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_time ON iot.telemetry(captured_at DESC);
ALTER TABLE iot.telemetry ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE iot.telemetry IS '家庭物联网遥测表：按消息标识幂等保存采集结果，本地 PostgreSQL 与 Supabase 副本共用相同消息标识。';
COMMIT;
