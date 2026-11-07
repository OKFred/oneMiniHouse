-- Synthetic template. Generate the real VALUES in a private copy from the approved physical mapping.
-- Hidden logical reporters are dependencies, not additional physical assets.
CREATE OR REPLACE VIEW iot.home_presence_registry WITH(security_barrier=true,security_invoker=false) AS
SELECT * FROM(VALUES
  ('example-host'::text,'示例主机'::text,'example-home'::text,'direct'::text,NULL::text,true,'example-presence-reader'::text,300::integer),
  ('example-reporter','示例逻辑报告器','example-home','direct','example-host',false,'example-presence-reader',300),
  ('example-sensor','示例直接传感器','example-home','proxy','example-reporter',true,'example-presence-reader',300),
  ('example-cache','示例缓存传感器','example-home','cached','example-reporter',true,'example-presence-reader',NULL),
  ('example-unseen','示例未上报设备','example-home','direct',NULL,true,'example-presence-reader',300)
) registry(physical_device_id,device_name,site_id,kind,parent_id,visible,observer_client_id,freshness_seconds);
REVOKE ALL ON iot.home_presence_registry FROM PUBLIC;
COMMENT ON VIEW iot.home_presence_registry IS '经人工确认的物理设备与隐藏逻辑依赖白名单；无上报项保留未知，不由温度通道、VM名称或网关缓存推断物理设备。';
COMMENT ON COLUMN iot.home_presence_registry.physical_device_id IS '批准映射中的稳定身份；可见物理设备与隐藏逻辑依赖均不得重名。';
COMMENT ON COLUMN iot.home_presence_registry.device_name IS '私有部署确认的展示名称，不用于猜测物理拓扑或关联遥测。';
COMMENT ON COLUMN iot.home_presence_registry.site_id IS '限定站点身份；不开放其他站点或未配置设备。';
COMMENT ON COLUMN iot.home_presence_registry.kind IS 'direct主动上报、proxy直接读取、cached缓存观察；缓存不能证明在线。';
COMMENT ON COLUMN iot.home_presence_registry.parent_id IS '明确批准的父依赖身份；不由网关或虚拟机名称推断。';
COMMENT ON COLUMN iot.home_presence_registry.visible IS 'false仅参与依赖判断，不能展示或计数为物理设备。';
COMMENT ON COLUMN iot.home_presence_registry.observer_client_id IS '负责实时观察该主题的专用订阅客户端，供覆盖范围限定。';
COMMENT ON COLUMN iot.home_presence_registry.freshness_seconds IS '配置的新鲜度阈值；未知缓存周期为NULL，实际生效期限以冻结事件为准。';
