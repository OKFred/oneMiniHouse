-- Owner-only additive migration. Original JSON payload and semantic hash remain intact.
BEGIN;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='iot' AND table_name='telemetry' AND column_name='captured_at') THEN
    ALTER TABLE iot.telemetry RENAME COLUMN captured_at TO sample_time_utc;
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='iot' AND table_name='telemetry' AND column_name='received_at') THEN
    ALTER TABLE iot.telemetry RENAME COLUMN received_at TO receive_time_utc;
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='iot' AND table_name='telemetry' AND column_name='stored_at') THEN
    ALTER TABLE iot.telemetry RENAME COLUMN stored_at TO store_time_utc;
  END IF;
END $$;
ALTER TABLE iot.telemetry ALTER COLUMN payload DROP NOT NULL;
ALTER TABLE iot.telemetry ALTER COLUMN sample_time_utc DROP NOT NULL;
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS raw_id uuid;
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS processor_id text;
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS processor_version text;
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS output_key text;
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS lineage jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS result_sha256 text;
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS source_receive_time_utc timestamptz;
UPDATE iot.telemetry SET processor_id='legacy-ingestor',processor_version='1',output_key='telemetry',
  lineage=jsonb_build_object('source_kind','legacy_pg','original_bytes_available',false,'raw_archive_available',false)
  WHERE processor_id IS NULL;
ALTER TABLE iot.telemetry ALTER COLUMN processor_id SET NOT NULL;
ALTER TABLE iot.telemetry ALTER COLUMN processor_version SET NOT NULL;
ALTER TABLE iot.telemetry ALTER COLUMN output_key SET NOT NULL;
ALTER TABLE iot.telemetry DROP CONSTRAINT IF EXISTS telemetry_schema_version_check;
ALTER TABLE iot.telemetry ADD CONSTRAINT telemetry_schema_version_check CHECK(schema_version IN(1,2));
ALTER TABLE iot.telemetry DROP CONSTRAINT IF EXISTS telemetry_quality_check;
ALTER TABLE iot.telemetry ADD CONSTRAINT telemetry_quality_check CHECK(quality IN('ok','historical'));
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='iot.telemetry'::regclass AND conname='telemetry_result_sha256_check') THEN
    ALTER TABLE iot.telemetry ADD CONSTRAINT telemetry_result_sha256_check CHECK(result_sha256 IS NULL OR length(result_sha256)=64);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_lineage_key ON iot.telemetry(raw_id,processor_id,processor_version,output_key) WHERE raw_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telemetry_receive_time ON iot.telemetry(receive_time_utc DESC);
COMMENT ON COLUMN iot.telemetry.sample_time_utc IS '真实测量时间（UTC）；历史来源若只记录服务端接收时间则为 NULL。';
COMMENT ON COLUMN iot.telemetry.source_receive_time_utc IS '历史来源提供的上游接收时间（UTC），不是设备测量时间。';
COMMENT ON COLUMN iot.telemetry.raw_id IS '独立原始档案标识；不建跨层外键，原始记录过期不会级联删除加工历史。';
COMMENT ON COLUMN iot.telemetry.payload IS '迁移前的完整信封保留作审计；新记录不重复保存原始内容。';
COMMENT ON COLUMN iot.telemetry.payload_sha256 IS '规范化来源信封的 SHA-256 语义哈希，兼容旧入库服务的幂等校验。';
COMMENT ON COLUMN iot.telemetry.result_sha256 IS '版本化加工结果的 SHA-256 校验值；迁移前记录可为 NULL。';
COMMIT;
