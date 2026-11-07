-- Owner-run additive migration. No telemetry rows, views or existing ACLs are replaced.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
CREATE TABLE IF NOT EXISTS iot.device_presence_events (
  result_id uuid PRIMARY KEY,
  raw_id uuid NOT NULL,
  processor_id text NOT NULL CHECK(processor_id IN('device-presence','presence-observer')),
  record_kind text NOT NULL CHECK(record_kind IN('device','observer')),
  event_id uuid NOT NULL,
  physical_device_id text,
  device_name text,
  kind text CHECK(kind IN('direct','proxy','cached')),
  parent_id text,
  site_id text NOT NULL,
  visible boolean NOT NULL,
  observer_client_id text NOT NULL,
  observer_session_id uuid NOT NULL,
  observed_time_utc timestamptz NOT NULL CHECK(isfinite(observed_time_utc)),
  observation_order bigint NOT NULL CHECK(observation_order BETWEEN 1 AND 9007199254740991),
  event text NOT NULL CHECK(event IN('online','heartbeat','offline','observation','coverage_start','coverage_heartbeat','coverage_end')),
  reporter_id text,
  boot_id text,
  session_id uuid,
  sequence bigint CHECK(sequence BETWEEN 0 AND 9007199254740991),
  source_time_utc timestamptz CHECK(source_time_utc IS NULL OR isfinite(source_time_utc)),
  uptime_ms bigint CHECK(uptime_ms BETWEEN 0 AND 9007199254740991),
  online boolean,
  reason text NOT NULL,
  retained boolean NOT NULL,
  qos smallint NOT NULL CHECK(qos=1),
  duplicate boolean NOT NULL,
  applied boolean NOT NULL,
  state_after text NOT NULL CHECK(state_after IN('online','offline','unknown')),
  decision text NOT NULL,
  freshness_seconds integer CHECK(freshness_seconds BETWEEN 300 AND 259200),
  valid_until_utc timestamptz,
  coverage_until_utc timestamptz,
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 text NOT NULL CHECK(result_sha256 ~ '^[0-9a-f]{64}$'),
  stored_time_utc timestamptz NOT NULL DEFAULT now(),
  UNIQUE(raw_id,processor_id),
  CHECK((record_kind='device' AND processor_id='device-presence' AND event IN('online','heartbeat','offline','observation')
      AND physical_device_id IS NOT NULL AND device_name IS NOT NULL AND kind IS NOT NULL
      AND reporter_id IS NOT NULL AND session_id IS NOT NULL AND (freshness_seconds IS NOT NULL OR kind='cached') AND coverage_until_utc IS NULL)
    OR(record_kind='observer' AND processor_id='presence-observer' AND NOT visible AND physical_device_id IS NULL AND kind IS NULL AND reporter_id IS NULL AND session_id IS NULL
      AND event IN('coverage_start','coverage_heartbeat','coverage_end') AND coverage_until_utc IS NOT NULL)),
  CHECK(NOT retained OR NOT applied),
  CHECK(NOT applied OR kind IS DISTINCT FROM 'cached' OR state_after='unknown')
);
CREATE INDEX IF NOT EXISTS device_presence_device_time ON iot.device_presence_events(site_id,physical_device_id,observed_time_utc DESC,observation_order DESC)
  WHERE record_kind='device' AND applied;
CREATE INDEX IF NOT EXISTS device_presence_observer_time ON iot.device_presence_events(site_id,observer_client_id,observed_time_utc DESC,observation_order DESC)
  WHERE record_kind='observer';
CREATE INDEX IF NOT EXISTS device_presence_retention_time ON iot.device_presence_events(observed_time_utc,result_id);
ALTER TABLE iot.device_presence_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON iot.device_presence_events FROM PUBLIC;
DO $grant$
DECLARE runtime_role text:=nullif(current_setting('one_min_house.ingestor_role',true),'');
BEGIN
  IF runtime_role IS NULL THEN RAISE EXCEPTION 'Set one_min_house.ingestor_role before presence migration'; END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA iot TO %I',runtime_role);
  EXECUTE format('GRANT SELECT,INSERT ON iot.device_presence_events TO %I',runtime_role);
  DROP POLICY IF EXISTS presence_ingestor_select ON iot.device_presence_events;
  DROP POLICY IF EXISTS presence_ingestor_insert ON iot.device_presence_events;
  EXECUTE format('CREATE POLICY presence_ingestor_select ON iot.device_presence_events FOR SELECT TO %I USING(true)',runtime_role);
  EXECUTE format('CREATE POLICY presence_ingestor_insert ON iot.device_presence_events FOR INSERT TO %I WITH CHECK(true)',runtime_role);
END $grant$;
COMMENT ON TABLE iot.device_presence_events IS '独立在线观察及订阅覆盖事件；首次服务器观察时间与来源时间分离，原始消息存于既有档案，不写入温度遥测表。';
COMMENT ON COLUMN iot.device_presence_events.observed_time_utc IS '服务器首次接收时刻；LWT 的离线观察使用此时间，不使用 CONNECT 时预制的遗嘱时间。';
COMMENT ON COLUMN iot.device_presence_events.applied IS '首次持久化事务冻结的归并决定；retained、旧序号、旧会话、延迟及未来来源时间不得恢复在线。';
COMMENT ON COLUMN iot.device_presence_events.coverage_until_utc IS '独立实时订阅观察租约，正常每30秒延长至90秒；明确关闭立即终止，崩溃或失联后过期为未知。';
COMMENT ON COLUMN iot.device_presence_events.kind IS 'direct为主动设备，proxy为直接读取代理，cached始终仅代表缓存观察而不证明物理在线。';
COMMENT ON COLUMN iot.device_presence_events.result_id IS '确定性版本化加工结果 UUID，双库投递和重放保持不变。';
COMMENT ON COLUMN iot.device_presence_events.raw_id IS '既有独立原始档案 UUID；原文到期不级联删除本地在线历史。';
COMMENT ON COLUMN iot.device_presence_events.processor_id IS '独立处理器标识 device-presence 或 presence-observer，不使用温度处理器。';
COMMENT ON COLUMN iot.device_presence_events.record_kind IS 'device为设备观察；observer为服务器订阅覆盖证据。';
COMMENT ON COLUMN iot.device_presence_events.event_id IS '来源事件 UUID，首次观察后重复投递不会增加新状态。';
COMMENT ON COLUMN iot.device_presence_events.physical_device_id IS '服务器精确配置的稳定展示身份；隐藏逻辑依赖也有身份，不接受发布端自行指定物理映射。';
COMMENT ON COLUMN iot.device_presence_events.device_name IS '私有映射中的展示名称；更名不改变事件和设备身份。';
COMMENT ON COLUMN iot.device_presence_events.parent_id IS '服务器明确配置的依赖身份；父状态未知或离线时子设备不得显示在线。';
COMMENT ON COLUMN iot.device_presence_events.site_id IS '精确匹配并冻结的站点身份，供受限视图白名单过滤。';
COMMENT ON COLUMN iot.device_presence_events.visible IS '是否展示为物理设备；false的逻辑报告器仅参与依赖判断，不能计为物理设备。';
COMMENT ON COLUMN iot.device_presence_events.observer_client_id IS '本次实时接收订阅的 MQTT 客户端身份，不是设备发布客户端。';
COMMENT ON COLUMN iot.device_presence_events.observer_session_id IS '本次订阅连接 UUID；重连生成新值并要求新的设备在线证据。';
COMMENT ON COLUMN iot.device_presence_events.observation_order IS 'SQLite 首次持久接收顺序，同毫秒事件按此稳定排序；重放不重新编号。';
COMMENT ON COLUMN iot.device_presence_events.event IS '设备 online/heartbeat/offline/observation 或服务器覆盖开始、脉冲、结束事件。';
COMMENT ON COLUMN iot.device_presence_events.reporter_id IS '经精确映射校验的发布端 MQTT 客户端身份。';
COMMENT ON COLUMN iot.device_presence_events.boot_id IS '报告进程或 MCU 的运行实例；不代表被代理子设备的启动实例。';
COMMENT ON COLUMN iot.device_presence_events.session_id IS '报告器每次 MQTT 连接新建的 UUID；旧会话遗嘱不得结束新会话。';
COMMENT ON COLUMN iot.device_presence_events.sequence IS '报告会话内递增序号，遗嘱为 NULL；观察覆盖事件使用自己的序号。';
COMMENT ON COLUMN iot.device_presence_events.source_time_utc IS '来源声明的原始 UTC 时间；遗嘱为 NULL，不使用旧 CONNECT 时刻冒充离线时刻。';
COMMENT ON COLUMN iot.device_presence_events.uptime_ms IS '报告器单调运行时长，单位毫秒；遗嘱为 NULL，重放不更新。';
COMMENT ON COLUMN iot.device_presence_events.online IS '来源声明的布尔观察；NULL表示无法判断，并非最终合成在线状态。';
COMMENT ON COLUMN iot.device_presence_events.reason IS '协议允许的来源原因枚举；不保存自由文本异常或凭据。';
COMMENT ON COLUMN iot.device_presence_events.retained IS '订阅交付的历史保留快照标志；true仅归档，不改变在线历史。';
COMMENT ON COLUMN iot.device_presence_events.qos IS '接收的 MQTT QoS，presence仅接受1，持久提交后才确认。';
COMMENT ON COLUMN iot.device_presence_events.duplicate IS '首次收到消息时的 MQTT DUP 标记；不会因后续重试改写。';
COMMENT ON COLUMN iot.device_presence_events.state_after IS '本事件冻结的候选状态；最终展示还须检查观察覆盖、租约、父依赖和可见性。';
COMMENT ON COLUMN iot.device_presence_events.decision IS '归并接受或忽略原因；旧序号、旧会话、延迟、未来或保留快照不能恢复在线。';
COMMENT ON COLUMN iot.device_presence_events.freshness_seconds IS 'direct阈值300秒；proxy为max(300,3乘实际采集周期)；未知周期缓存为NULL且不证明在线。';
COMMENT ON COLUMN iot.device_presence_events.valid_until_utc IS '在线新鲜度截止；以来源与服务器首次接收较早者起算，不向未来延长。';
COMMENT ON COLUMN iot.device_presence_events.payload_sha256 IS '冻结加工投影的 SHA-256，独立原始字节哈希在原始档案中保存。';
COMMENT ON COLUMN iot.device_presence_events.result_sha256 IS '覆盖加工结果、原始档案和版本身份的 SHA-256；幂等重放逐列核对。';
COMMENT ON COLUMN iot.device_presence_events.stored_time_utc IS '本目标数据库首次保存时间；不作为物理在线发生或来源采集时间。';
COMMIT;
