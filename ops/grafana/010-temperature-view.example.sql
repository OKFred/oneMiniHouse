-- 脱敏示例：先在本地副本配置站点、设备和只读角色；不得直接覆盖线上视图。
-- 仅在 Grafana 连接的本地 PostgreSQL 执行；不改变遥测入库或云端保留策略。
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
CREATE OR REPLACE VIEW iot.home_temperature_samples WITH (security_barrier=true) AS
-- WSDCGQ01LM 官方检测范围（含边界）：温度 -20～50°C；湿度 10～90%RH、无冷凝。
-- https://i01.appmifile.com/webfile/globalimg/Global_UG/Mi_Ecosystem/Mi_Temperature_and_Humidity_Sensor/Temperature_Sensor_fr_V1.pdf#page=56
-- 配置本视图时仅选择该型号；旧记录没有质量标签时也按相同范围保护展示。
-- 订正通过新加工版本追加；按原始记录选一版，避免同一观测重复参与均值。
WITH latest AS (
  SELECT DISTINCT ON (site_id,gateway_id,device_id,COALESCE(raw_id,message_id)) *
  FROM iot.telemetry
  WHERE site_id='example-home' AND gateway_id='example-gateway'
    AND device_id='temperature-room' AND quality='ok'
  ORDER BY site_id,gateway_id,device_id,COALESCE(raw_id,message_id),
    (processor_id='xiaomi-temperature-quality' AND processor_version='1') DESC,
    store_time_utc DESC,message_id
)
SELECT message_id,
       COALESCE(read_time_utc,sample_time_utc) AS read_time_utc,
       receive_time_utc,
       device_id,
       '室内传感器'::text AS device_name,
       CASE WHEN jsonb_typeof(metrics->'temperature_c')='number' THEN
         CASE WHEN (metrics->>'temperature_c')::numeric BETWEEN -20 AND 50
           AND (processor_id<>'xiaomi-temperature-quality' OR
             lineage#>>'{metric_quality,metrics,temperature_c,status}'='ok')
         THEN (metrics->>'temperature_c')::double precision END END AS temperature_c,
       CASE WHEN jsonb_typeof(metrics->'humidity_pct')='number' THEN
         CASE WHEN (metrics->>'humidity_pct')::numeric BETWEEN 10 AND 90
           AND (processor_id<>'xiaomi-temperature-quality' OR
             lineage#>>'{metric_quality,metrics,humidity_pct,status}'='ok')
         THEN (metrics->>'humidity_pct')::double precision END END AS humidity_pct,
       CASE WHEN jsonb_typeof(metrics->'battery_pct')='number'
         THEN (metrics->>'battery_pct')::double precision END AS battery_pct,
       'gateway_cached_state'::text AS observation_kind,
       CASE WHEN schema_version=2 THEN sample_time_utc END AS sensor_sample_time_utc
FROM latest
WHERE COALESCE(read_time_utc,sample_time_utc) IS NOT NULL;
COMMENT ON VIEW iot.home_temperature_samples IS 'Grafana 家庭温湿度只读视图：仅开放 example-home 的室内传感器温湿度设备成功读取值。来源为小米网关缓存，真实传感器测量时间未知；原始信封与其他设备不可见。';
COMMENT ON COLUMN iot.home_temperature_samples.message_id IS '消息唯一标识，用于去重和关联原始档案。';
COMMENT ON COLUMN iot.home_temperature_samples.read_time_utc IS '采集端成功读取小米网关缓存状态的时间（UTC），不代表传感器测量时间。';
COMMENT ON COLUMN iot.home_temperature_samples.receive_time_utc IS '入库服务收到该消息的时间（UTC）。';
COMMENT ON COLUMN iot.home_temperature_samples.device_id IS '稳定设备标识，固定为 temperature-room。';
COMMENT ON COLUMN iot.home_temperature_samples.device_name IS '中文展示名称：室内传感器。';
COMMENT ON COLUMN iot.home_temperature_samples.temperature_c IS '网关缓存温度（摄氏度）；WSDCGQ01LM 官方检测范围 -20～50°C（含边界）；超规格、缺失或指标质量异常时为 NULL，不补零。官方说明书：https://i01.appmifile.com/webfile/globalimg/Global_UG/Mi_Ecosystem/Mi_Temperature_and_Humidity_Sensor/Temperature_Sensor_fr_V1.pdf#page=56';
COMMENT ON COLUMN iot.home_temperature_samples.humidity_pct IS '网关缓存相对湿度（%RH）；WSDCGQ01LM 官方检测范围 10～90%RH（含边界、无冷凝）；超规格、缺失或指标质量异常时为 NULL，不补零。官方说明书：https://i01.appmifile.com/webfile/globalimg/Global_UG/Mi_Ecosystem/Mi_Temperature_and_Humidity_Sensor/Temperature_Sensor_fr_V1.pdf#page=56';
COMMENT ON COLUMN iot.home_temperature_samples.battery_pct IS '网关缓存的传感器剩余电量，单位百分比；缺失或非数字时为 NULL。';
COMMENT ON COLUMN iot.home_temperature_samples.observation_kind IS '观测类型，固定为 gateway_cached_state（网关缓存状态）。';
COMMENT ON COLUMN iot.home_temperature_samples.sensor_sample_time_utc IS '传感器实际测量时间（UTC）；当前协议未提供，保持 NULL，不用轮询时间代替。';
GRANT SELECT ON iot.home_temperature_samples TO example_grafana;
COMMIT;
