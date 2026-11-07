-- Synthetic owner-run template. Generate the real literal cutover and identity map privately.
-- The cutover is the first presence installation time, fixed forever; never derive it from retained events.
CREATE OR REPLACE VIEW iot.home_presence_history_policy WITH(security_barrier=true,security_invoker=false) AS
SELECT TIMESTAMPTZ '2026-11-08T00:00:00Z' AS cutover_utc;
CREATE OR REPLACE VIEW iot.home_presence_history_sources WITH(security_barrier=true,security_invoker=false) AS
SELECT * FROM(VALUES
  ('example-host'::text,'example-home'::text,'example-host-gateway'::text,'example-host-telemetry'::text,'iot-telemetry'::text,300::integer,NULL::text,NULL::text),
  ('example-sensor','example-home','example-host-gateway','example-host-telemetry','iot-telemetry',300,'rs485.modbus.sht20','crc_verified'),
  ('example-unseen','example-home','example-other-host','example-other-telemetry','host-health-temperature',300,NULL,NULL)
) sources(physical_device_id,site_id,gateway_id,device_id,processor_id,freshness_seconds,required_source_driver,required_source_integrity);
REVOKE ALL ON iot.home_presence_history_policy,iot.home_presence_history_sources FROM PUBLIC;
COMMENT ON VIEW iot.home_presence_history_policy IS '私有部署固定的首次安装切点；不得由最早保留事件或当前时间动态推导，以免云端清理改变历史语义。';
COMMENT ON COLUMN iot.home_presence_history_policy.cutover_utc IS '首次安装 presence 的固定 UTC 时刻；之前仅允许历史直接上报推断，之后只按实时 presence 与观察覆盖判断。';
COMMENT ON VIEW iot.home_presence_history_sources IS '私有精确身份白名单；只允许已确认物理映射和已知周期，不由温度通道、虚拟机名称或缓存推断资产。';
COMMENT ON COLUMN iot.home_presence_history_sources.physical_device_id IS '对应物理 registry 的稳定身份；同一物理设备可有明确批准的历史上报别名。';
COMMENT ON COLUMN iot.home_presence_history_sources.site_id IS '精确站点身份，不支持通配符。';
COMMENT ON COLUMN iot.home_presence_history_sources.gateway_id IS '精确历史网关身份，不表示该网关本身是额外物理资产。';
COMMENT ON COLUMN iot.home_presence_history_sources.device_id IS '精确历史遥测设备身份，不使用展示名匹配。';
COMMENT ON COLUMN iot.home_presence_history_sources.processor_id IS '只允许 iot-telemetry 或 host-health-temperature；排除历史导入处理器。';
COMMENT ON COLUMN iot.home_presence_history_sources.freshness_seconds IS '已确认周期对应的有效期限，必须等于 registry；未知周期和缓存不列入本白名单。';
COMMENT ON COLUMN iot.home_presence_history_sources.required_source_driver IS '可选固定 lineage.source.driver 等值条件；用于区分共享遥测身份的已知物理子设备，不接受自由SQL。';
COMMENT ON COLUMN iot.home_presence_history_sources.required_source_integrity IS '可选固定 lineage.source.integrity 等值条件；例如SHT20要求crc_verified，不把ESP CPU消息冒充子设备成功读取。';
