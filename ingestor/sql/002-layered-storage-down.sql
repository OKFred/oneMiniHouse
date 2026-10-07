-- Run only after stopping the v2 ingestor. This restores old column names without deleting new rows.
-- Old ingestion software cannot represent historical v2 rows; use v2 again for importing/replaying those.
BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='iot' AND table_name='telemetry' AND column_name='sample_time_utc') THEN
    ALTER TABLE iot.telemetry RENAME COLUMN sample_time_utc TO captured_at;
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='iot' AND table_name='telemetry' AND column_name='receive_time_utc') THEN
    ALTER TABLE iot.telemetry RENAME COLUMN receive_time_utc TO received_at;
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='iot' AND table_name='telemetry' AND column_name='store_time_utc') THEN
    ALTER TABLE iot.telemetry RENAME COLUMN store_time_utc TO stored_at;
  END IF;
END $$;
-- Old writers omit these columns. Defaults retain an explicit legacy provenance.
ALTER TABLE iot.telemetry ALTER COLUMN processor_id SET DEFAULT 'legacy-ingestor';
ALTER TABLE iot.telemetry ALTER COLUMN processor_version SET DEFAULT '1';
ALTER TABLE iot.telemetry ALTER COLUMN output_key SET DEFAULT 'telemetry';
COMMIT;
