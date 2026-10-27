-- 脱敏模板：先在私有副本替换精确身份、展示名和只读角色；不得直接覆盖线上资源。
-- 在本地 Grafana 数据源库，以可信视图所有者执行；不修改任何既有视图或底表权限。
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';

CREATE OR REPLACE VIEW iot.home_host_health_temperature_samples
WITH (security_barrier=true,security_invoker=false) AS
WITH allowed_devices(site_id,gateway_id,device_id,device_name) AS (
  VALUES ('example-home'::text,'example-router'::text,'temperature-example-router'::text,'示例网关'::text)
), temperatures AS (
  SELECT t.message_id,t.read_time_utc,t.sample_time_utc,t.receive_time_utc,t.device_id,d.device_name,t.observation_kind,
    CASE WHEN jsonb_typeof(t.metrics)='object' AND jsonb_typeof(t.metrics->'cpu_temperature_c')='number'
      THEN (t.metrics->>'cpu_temperature_c')::numeric END AS value
  FROM iot.telemetry t
  JOIN allowed_devices d ON (t.site_id,t.gateway_id,t.device_id)=(d.site_id,d.gateway_id,d.device_id)
  WHERE t.schema_version=2 AND t.quality='ok' AND t.observation_kind='direct_read'
    AND t.processor_id='host-health-temperature' AND t.processor_version='1' AND t.output_key='cpu_temperature_c'
    AND t.lineage#>>'{source,driver}'='openwrt-host-health'
    AND t.lineage#>>'{source,interface}'='linux_thermal'
    AND t.read_time_utc IS NOT NULL AND isfinite(t.read_time_utc)
    AND t.receive_time_utc IS NOT NULL AND isfinite(t.receive_time_utc)
    AND t.read_time_utc<=t.receive_time_utc
    -- 此处理器只有内核读取时间，未提供传感器独立测量时钟，不将接收时间冒充测量时间。
    AND t.sample_time_utc IS NULL
    AND (t.lineage#>'{metric_quality,metrics,cpu_temperature_c}' IS NULL
      OR (jsonb_typeof(t.lineage#>'{metric_quality,metrics,cpu_temperature_c}')='object'
        AND t.lineage#>>'{metric_quality,metrics,cpu_temperature_c,status}'='ok'))
    AND t.lineage#>'{source,metric_status,cpu_temperature_c}' IS NULL
)
SELECT message_id,read_time_utc,sample_time_utc,receive_time_utc,device_id,device_name,
  'cpu_temperature_c'::text AS sensor_id,'CPU'::text AS sensor_name,
  -- 与原生采集器相同的合理性保护，不是厂商工作范围或告警阈值。
  -- Linux thermal sysfs 使用毫摄氏度，生产端已换算为摄氏度；这里不重复除以 1000。
  -- https://docs.kernel.org/driver-api/thermal/sysfs-api.html
  CASE WHEN value BETWEEN -50 AND 150 THEN value::double precision END AS temperature_c,
  observation_kind,'CPU/GPU'::text AS sensor_category
FROM temperatures WHERE value BETWEEN -50 AND 150;

COMMENT ON VIEW iot.home_host_health_temperature_samples IS 'Grafana 主机健康 CPU 温度限定只读视图：仅开放精确白名单与 host-health-temperature v1 加工结果，不修改既有视图，不暴露原始报文、缓解动作、主机地址或认证信息。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.message_id IS '版本化加工结果标识；原始 MQTT 消息标识保留在来源档案与 lineage，不以展示名作为身份。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.read_time_utc IS '主机完成内核温度读取的 UTC 时间；断网补报保持原值，不以接收时间刷新数据新鲜度。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.sample_time_utc IS '传感器独立测量 UTC 时间；本处理器没有该时钟，固定为 NULL。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.receive_time_utc IS '入库服务首次接收原始 MQTT 消息的 UTC 时间，不作为温度采样时间替代。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.device_id IS '私有配置中精确绑定的稳定设备标识，不是展示名、IP、MAC 或硬件序列号。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.device_name IS '私有白名单内的主机展示名称；更名不改已有设备身份或历史。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.sensor_id IS '稳定指标名，固定 cpu_temperature_c；仅代表整颗 CPU，不产生单核心温度行。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.sensor_name IS '通道展示名称，固定 CPU；不将 CPU 温度归为室温或电源温度。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.temperature_c IS 'CPU 温度，单位摄氏度。-50 至 150°C 是与原生采集器一致的合理性保护，不是厂商物理额定范围或告警阈值；缺失、质量拒绝和越界不产生样本，真实零保留。Linux thermal ABI：https://docs.kernel.org/driver-api/thermal/sysfs-api.html 。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.observation_kind IS '观测类型，固定 direct_read；读取内核接口，不是网关缓存状态。';
COMMENT ON COLUMN iot.home_host_health_temperature_samples.sensor_category IS '现有设备页温度分类，固定 CPU/GPU，不新增看板类别。';

REVOKE ALL ON iot.home_host_health_temperature_samples FROM PUBLIC;
GRANT SELECT ON iot.home_host_health_temperature_samples TO example_grafana;
COMMIT;
