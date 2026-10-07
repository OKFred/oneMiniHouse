-- Derived data is calculated on demand initially; sampled power is never presented as interval consumption.
CREATE OR REPLACE VIEW iot.measured_metrics WITH (security_invoker=true) AS
SELECT message_id,raw_id,site_id,gateway_id,device_id,sample_time_utc,receive_time_utc,store_time_utc,
       quality,metrics,processor_id,processor_version,output_key,lineage
FROM iot.telemetry;
-- apparent_power_va is derived, so it is exposed separately from measured metrics.
CREATE OR REPLACE VIEW iot.derived_electrical WITH (security_invoker=true) AS
SELECT message_id,raw_id,site_id,gateway_id,device_id,sample_time_utc,
       (metrics->>'voltage_v')::double precision * (metrics->>'current_a')::double precision AS apparent_power_va
FROM iot.telemetry
WHERE jsonb_typeof(metrics->'voltage_v')='number' AND jsonb_typeof(metrics->'current_a')='number';
-- Set this session setting explicitly; never infer the runtime role from the owner login.
DO $grant$
DECLARE runtime_role text := nullif(current_setting('one_min_house.ingestor_role', true), '');
BEGIN
  IF runtime_role IS NULL THEN
    RAISE EXCEPTION 'Set one_min_house.ingestor_role to the intended runtime role before migration';
  END IF;
  EXECUTE format('GRANT SELECT ON iot.measured_metrics,iot.derived_electrical TO %I', runtime_role);
END $grant$;
