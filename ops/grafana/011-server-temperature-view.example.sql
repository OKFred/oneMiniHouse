-- 脱敏示例：先在本地副本配置站点、设备和只读角色；不得直接覆盖线上视图。
-- 先执行 ingestor/sql/005-observation-times.sql；只在本地 Grafana 数据源执行。
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
CREATE OR REPLACE VIEW iot.home_server_temperature_samples WITH (security_barrier=true) AS
SELECT t.message_id,t.read_time_utc,t.sample_time_utc,t.receive_time_utc,t.device_id,
  CASE t.device_id WHEN 'temperature-host' THEN '示例主机'
    WHEN 'temperature-router' THEN 'R4S' WHEN 'temperature-host-b' THEN '示例主机 B'
    WHEN 'temperature-host-c' THEN 'PVE' END AS device_name,
  metric.key AS sensor_id,
  CASE metric.key WHEN 'cpu_temperature_c' THEN 'CPU'
    WHEN 'ddr_temperature_c' THEN 'DDR' WHEN 'gpu_temperature_c' THEN 'GPU'
    WHEN 'cpu_package_temperature_c' THEN 'CPU 封装'
    WHEN 'nvme_a_temperature_c' THEN 'NVMe A · 综合'
    WHEN 'nvme_a_sensor_1_temperature_c' THEN 'NVMe A · 传感器 1'
    WHEN 'nvme_a_sensor_2_temperature_c' THEN 'NVMe A · 传感器 2'
    WHEN 'nvme_b_temperature_c' THEN 'NVMe B · 综合'
    WHEN 'nvme_b_sensor_1_temperature_c' THEN 'NVMe B · 传感器 1'
    WHEN 'nvme_b_sensor_2_temperature_c' THEN 'NVMe B · 传感器 2'
    WHEN 'sata_ssd_a_temperature_c' THEN 'SATA SSD A'
    WHEN 'sata_ssd_b_temperature_c' THEN 'SATA SSD B'
    WHEN 'sata_hdd_a_temperature_c' THEN 'SATA HDD A'
    ELSE CASE
      WHEN metric.key ~ '^cpu_core_[0-9]{1,2}_temperature_c$' THEN 'CPU 核心 ' || substring(metric.key from '^cpu_core_([0-9]{1,2})_temperature_c$')
      WHEN metric.key ~ '^mainboard_channel_[1-9]_temperature_c$' THEN '主板通道 ' || substring(metric.key from '^mainboard_channel_([1-9])_temperature_c$')
      WHEN metric.key ~ '^acpi_zone_[1-9]_temperature_c$' THEN 'ACPI 区域 ' || substring(metric.key from '^acpi_zone_([1-9])_temperature_c$')
    END END AS sensor_name,
  metric.value::double precision AS temperature_c,
  t.observation_kind
FROM iot.telemetry AS t
CROSS JOIN LATERAL jsonb_each(t.metrics) AS metric(key,value)
WHERE t.site_id='example-home'
  AND ((t.gateway_id='example-gateway' AND t.device_id IN ('temperature-host','temperature-host-b','temperature-host-c'))
    OR (t.gateway_id='example-router' AND t.device_id='temperature-router')
    OR (t.gateway_id='example-host' AND t.device_id='temperature-host')
    OR (t.gateway_id='example-host-b' AND t.device_id='temperature-host-b')
    OR (t.gateway_id='example-host-c' AND t.device_id='temperature-host-c'))
  AND t.quality='ok' AND t.observation_kind='direct_read' AND t.read_time_utc IS NOT NULL
  AND (metric.key IN ('cpu_temperature_c','ddr_temperature_c','gpu_temperature_c','cpu_package_temperature_c',
    'nvme_a_temperature_c','nvme_a_sensor_1_temperature_c','nvme_a_sensor_2_temperature_c',
    'nvme_b_temperature_c','nvme_b_sensor_1_temperature_c','nvme_b_sensor_2_temperature_c',
    'sata_ssd_a_temperature_c','sata_ssd_b_temperature_c','sata_hdd_a_temperature_c')
    OR metric.key ~ '^(cpu_core_[0-9]{1,2}|mainboard_channel_[1-9]|acpi_zone_[1-9])_temperature_c$')
  AND jsonb_typeof(metric.value)='number';
COMMENT ON VIEW iot.home_server_temperature_samples IS 'Grafana 主机温度只读视图：仅开放已指定主机的 CPU、DDR、GPU、NVMe、SATA SSD/HDD、主板及 ACPI 温度通道；不包含原始报文、主机地址或风扇数据。未命名的硬件通道不推测物理用途。';
COMMENT ON COLUMN iot.home_server_temperature_samples.message_id IS '来源消息唯一标识；一条主机消息可展开为多个温度点。';
COMMENT ON COLUMN iot.home_server_temperature_samples.read_time_utc IS '采集端成功读取主机内核温度接口的 UTC 时间。';
COMMENT ON COLUMN iot.home_server_temperature_samples.sample_time_utc IS '设备实际测量时间（UTC）；内核接口未提供时为 NULL，不以读取时间冒充。';
COMMENT ON COLUMN iot.home_server_temperature_samples.receive_time_utc IS '入库端首次收到该消息的 UTC 时间。';
COMMENT ON COLUMN iot.home_server_temperature_samples.device_id IS '稳定主机设备标识；示例主机 为 temperature-host。';
COMMENT ON COLUMN iot.home_server_temperature_samples.device_name IS '主机展示名：示例主机、R4S、示例主机 B 或 PVE。';
COMMENT ON COLUMN iot.home_server_temperature_samples.sensor_id IS '同一主机内的温度通道指标名，含摄氏度单位后缀。';
COMMENT ON COLUMN iot.home_server_temperature_samples.sensor_name IS '温度通道中文展示名称；CPU 封装与 CPU 核心不得混为环境温度。';
COMMENT ON COLUMN iot.home_server_temperature_samples.temperature_c IS '内核温度读数，单位摄氏度；缺失不补零。';
COMMENT ON COLUMN iot.home_server_temperature_samples.observation_kind IS '观测类型，固定为 direct_read；不同于小米网关缓存状态。';
GRANT SELECT ON iot.home_server_temperature_samples TO example_grafana;
COMMIT;
