-- Synthetic example only: adapt a private copy; never overwrite a live view with this template.
-- UUIDs, reference dates and history thresholds below are fictitious fixtures, not installation evidence.
-- B-RS-L30: correct the earlier 1:1 label. Historical raw telemetry is unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
CREATE OR REPLACE VIEW iot.home_environment_samples WITH (security_barrier=true) AS
SELECT message_id,sample_time_utc,receive_time_utc,device_id,
       '光照传感器（0x03）'::text AS device_name,
       (metrics->>'light_raw_count')::double precision AS light_raw_count,
       coalesce((metrics->>'illuminance_lux')::double precision,
                (metrics->>'light_raw_count')::double precision / 1000.0) AS illuminance_lux
FROM iot.telemetry
WHERE site_id='example-home' AND gateway_id='example-modbus'
  AND device_id='light-example' AND quality='ok'
  AND sample_time_utc IS NOT NULL AND metrics->>'light_raw_count' IS NOT NULL;
COMMENT ON VIEW iot.home_environment_samples IS 'Grafana 家庭环境展示视图：仅开放 example-home 光照设备 light-example 的成功采样。B-RS-L30 依据原采集代码与同型号接入实现采用原始计数除以 1000 换算 lux；厂家协议原文尚待核实。保留原始计数和原有访问范围。';
COMMENT ON COLUMN iot.home_environment_samples.light_raw_count IS '未经倍率换算的原始计数：FC03 读取 0x0002 起两个寄存器，按大端无符号 32 位整数解码；此列不是 lux，历史记录保持原值。';
COMMENT ON COLUMN iot.home_environment_samples.illuminance_lux IS '照度，单位 lux（勒克斯）。新采样采用 illuminance_lux；历史采样按 light_raw_count/1000 换算，不修改原始数据、不重复换算。倍率依据原采集代码与 B-RS-L30 同型号接入实现，厂家协议原文尚待核实。';
COMMIT;
