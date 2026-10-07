-- Synthetic example only: adapt a private copy; never overwrite a live view with this template.
-- UUIDs, reference dates and history thresholds below are fictitious fixtures, not installation evidence.
-- Dedicated read-only presentation surface for the user-selected light sensor.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
CREATE OR REPLACE VIEW iot.home_environment_samples WITH (security_barrier=true) AS
SELECT message_id,sample_time_utc,receive_time_utc,device_id,
       '光照传感器（0x03）'::text AS device_name,
       (metrics->>'light_raw_count')::double precision AS light_raw_count
FROM iot.telemetry
WHERE site_id='example-home' AND gateway_id='example-modbus'
  AND device_id='light-example' AND quality='ok'
  AND sample_time_utc IS NOT NULL AND metrics->>'light_raw_count' IS NOT NULL;
COMMENT ON VIEW iot.home_environment_samples IS 'Grafana 家庭环境展示视图：仅开放 example-home 光照设备 light-example 的成功采样和原始计数；物理量单位与倍率尚未确认，不作为 lux，原始信封和其它设备不可见。';
COMMENT ON COLUMN iot.home_environment_samples.message_id IS '采样消息唯一标识，与原始记录关联，用于去重和追溯。';
COMMENT ON COLUMN iot.home_environment_samples.sample_time_utc IS '采集端获得有效响应的时间（UTC）。';
COMMENT ON COLUMN iot.home_environment_samples.receive_time_utc IS '入库服务收到该消息的时间（UTC）。';
COMMENT ON COLUMN iot.home_environment_samples.device_id IS '独立光照设备标识，固定为 light-example。';
COMMENT ON COLUMN iot.home_environment_samples.device_name IS '展示名称：光照传感器（原 Modbus 地址 0x03）。';
COMMENT ON COLUMN iot.home_environment_samples.light_raw_count IS 'FC03 读取 0x0002 起两寄存器的大端无符号原始计数；不套用旧代码 /1000，也不标为 lux。';
GRANT SELECT ON iot.home_environment_samples TO example_grafana;
COMMIT;
