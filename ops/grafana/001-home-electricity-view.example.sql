-- Synthetic example only: adapt a private copy; never overwrite a live view with this template.
-- UUIDs, reference dates and history thresholds below are fictitious fixtures, not installation evidence.
-- Run as the owner of the example database. Does not alter telemetry or its RLS.
BEGIN;
CREATE OR REPLACE VIEW iot.home_electricity_samples
WITH (security_barrier=true) AS
SELECT message_id, sample_time_utc, receive_time_utc, device_id,
       CASE device_id WHEN 'meter-main' THEN '示例总用电'
                      WHEN 'socket-example' THEN '示例插座用电' END AS device_name,
       (metrics->>'energy_kwh')::double precision AS energy_kwh,
       (metrics->>'power_w')::double precision AS power_w,
       (metrics->>'voltage_v')::double precision AS voltage_v,
       (metrics->>'current_a')::double precision AS current_a,
       (metrics->>'power_factor')::double precision AS power_factor
FROM iot.telemetry
WHERE site_id='example-home' AND quality='ok' AND sample_time_utc IS NOT NULL
  AND ((gateway_id='example-modbus' AND device_id='meter-main')
    OR (gateway_id='example-gateway' AND device_id='socket-example'));
REVOKE ALL ON iot.home_electricity_samples FROM PUBLIC;
COMMENT ON VIEW iot.home_electricity_samples IS
'Grafana 家庭用电查询视图：仅展示 example-home 站点中明确限定的 示例总表和示例插座，且要求 quality=ok、真实采样时间非空；不暴露原始信封。底表访问采用视图所有者权限，以视图条件限定范围。';
COMMIT;
