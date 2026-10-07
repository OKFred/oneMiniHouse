-- Synthetic example only: adapt a private copy; never overwrite a live view with this template.
-- UUIDs, reference dates and history thresholds below are fictitious fixtures, not installation evidence.
-- Add exactly the user-authorized installation point to the existing live view.
-- Preserve its current definition, columns, grants and comments.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $migration$
DECLARE
  reference_id uuid := '00000000-0000-4000-8000-000000000004';
  previous_definition text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM iot.telemetry
    WHERE message_id=reference_id AND site_id='example-home'
      AND gateway_id='example-modbus' AND device_id='meter-secondary'
      AND sample_time_utc='2000-01-01T00:00:00Z'::timestamptz
      AND metrics='{"energy_kwh":0}'::jsonb
      AND quality='historical' AND processor_id='user-meter-reference'
      AND output_key='installation_energy' AND lineage->>'event_type'='meter_installation') THEN
    RAISE EXCEPTION 'Verified example secondary-meter installation row required before view change';
  END IF;
  IF EXISTS (SELECT 1 FROM iot.home_electricity_samples WHERE message_id=reference_id) THEN
    RETURN;
  END IF;
  previous_definition := rtrim(pg_get_viewdef('iot.home_electricity_samples'::regclass, true), E'; \n\r');
  EXECUTE 'CREATE OR REPLACE VIEW iot.home_electricity_samples WITH (security_barrier=true) AS '
    || previous_definition || $added$
    UNION ALL
    SELECT message_id, sample_time_utc, receive_time_utc, device_id,
           '示例分路用电'::text AS device_name,
           (metrics->>'energy_kwh')::double precision AS energy_kwh,
           NULL::double precision AS power_w, NULL::double precision AS voltage_v,
           NULL::double precision AS current_a, NULL::double precision AS power_factor,
           sample_time_utc AS record_time_utc, '用户安装基准'::text AS time_basis,
           true AS is_installation, quality
    FROM iot.telemetry
    WHERE message_id='00000000-0000-4000-8000-000000000004'
      AND site_id='example-home' AND gateway_id='example-modbus'
      AND device_id='meter-secondary' AND quality='historical'
      AND processor_id='user-meter-reference' AND output_key='installation_energy'
      AND sample_time_utc='2000-01-01T00:00:00Z'::timestamptz
      AND metrics='{"energy_kwh":0}'::jsonb
      AND lineage->>'event_type'='meter_installation'
    $added$;
END
$migration$;
COMMENT ON VIEW iot.home_electricity_samples IS 'Grafana 家庭用电视图：仅开放 example-home 的 示例总表、示例分路电表与示例插座；包含实时采样、已验证的 示例总表电能历史、总表与分表 用户安装零点及插座手动基准。基准不用于缺失期间的日用电插值；原始信封不可见，沿用既有只读权限。';
SET LOCAL ROLE example_grafana;
SELECT device_name, record_time_utc, energy_kwh, time_basis, is_installation
FROM iot.home_electricity_samples
WHERE message_id='00000000-0000-4000-8000-000000000004';
COMMIT;
