-- Synthetic example only: adapt a private copy; never overwrite a live view with this template.
-- UUIDs, reference dates and history thresholds below are fictitious fixtures, not installation evidence.
-- Append measured fields to the existing scoped view without replacing its
-- historical filters, installation references, owner, grants or column comments.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='20s';
DO $migration$
DECLARE
  previous_definition text;
  extra_columns integer;
BEGIN
  SELECT count(*) INTO extra_columns FROM pg_attribute
  WHERE attrelid='iot.home_electricity_samples'::regclass AND NOT attisdropped
    AND attname IN ('reactive_power_var','frequency_hz');
  IF extra_columns=2 THEN RETURN; END IF;
  IF extra_columns<>0 THEN RAISE EXCEPTION 'Unexpected partial electrical view migration'; END IF;
  IF (SELECT count(*) FROM pg_attribute
      WHERE attrelid='iot.home_electricity_samples'::regclass AND attnum>0 AND NOT attisdropped)<>14 THEN
    RAISE EXCEPTION 'Expected existing 14-column scoped view; inspect before migrating';
  END IF;
  previous_definition := rtrim(pg_get_viewdef('iot.home_electricity_samples'::regclass,true), E'; \n\r');
  EXECUTE 'CREATE OR REPLACE VIEW iot.home_electricity_samples WITH (security_barrier=true) AS '
    || 'SELECT scoped.*,'
    || $$ CASE WHEN scoped.quality='ok' THEN (t.metrics->>'reactive_power_var')::double precision END AS reactive_power_var,$$
    || $$ CASE WHEN scoped.quality='ok' THEN (t.metrics->>'frequency_hz')::double precision END AS frequency_hz $$
    || 'FROM (' || previous_definition || ') scoped '
    || $$ LEFT JOIN iot.telemetry t ON t.message_id=scoped.message_id
          AND t.device_id=scoped.device_id AND t.site_id='example-home' AND t.quality='ok' $$;
END
$migration$;
COMMENT ON COLUMN iot.home_electricity_samples.reactive_power_var IS '设备实测无功功率，单位 var，保留设备正负号；仅对原限定视图中的成功实时采样提取。未上报字段或历史电能基准为 NULL，不补零、不从有功功率推算。';
COMMENT ON COLUMN iot.home_electricity_samples.frequency_hz IS '设备实测频率，单位 Hz；仅对原限定视图中的成功实时采样提取。未上报字段或历史电能基准为 NULL；60 秒采样不能代表瞬态电能质量。';
COMMENT ON COLUMN iot.home_electricity_samples.power_factor IS '设备上报的功率因数，无量纲，保留原值；不等于电器效率，低负载下的低值不直接判定故障。缺失为 NULL，不补零。';
COMMIT;
