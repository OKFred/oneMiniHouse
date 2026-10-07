-- 本地 PostgreSQL 和 Supabase 通用；以对象所有者执行，可重复运行。
-- 前置：001、002、003 已执行。本迁移只修改注释，不改数据、结构或权限。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

COMMENT ON SCHEMA iot IS '家庭物联网数据域：保存加工后的遥测结果，并通过视图提供实测指标和查询时派生指标；原始消息与协议帧在独立存储层管理。';

COMMENT ON TABLE iot.telemetry IS '物联网加工层遥测结果表：按消息标识幂等写入本地 PostgreSQL 与 Supabase；保留测量指标、时间、质量和加工来源。原始内容与协议帧独立存储，两个数据库的保留期限由各自策略控制。';
COMMENT ON COLUMN iot.telemetry.message_id IS '加工结果的唯一消息标识，也是幂等写入主键；两个数据库副本使用相同值。当前实时处理器沿用来源消息标识，其他处理版本可按原始记录、处理器版本和输出键确定性生成。';
COMMENT ON COLUMN iot.telemetry.schema_version IS '遥测信封格式版本：1 为当前实时采集格式，2 为历史数据导入格式；与处理器版本 processor_version 区分。';
COMMENT ON COLUMN iot.telemetry.site_id IS '站点标识，例如 example-home；用于数据归属、MQTT 主题校验及行级访问控制。';
COMMENT ON COLUMN iot.telemetry.gateway_id IS '采集网关标识；与站点标识、设备标识共同确定数据来源，例如 example-gateway 或 example-modbus。';
COMMENT ON COLUMN iot.telemetry.device_id IS '网关内的设备标识；设备完整身份由 site_id、gateway_id、device_id 共同确定。';
COMMENT ON COLUMN iot.telemetry.sample_time_utc IS '真实测量时间（UTC，timestamptz）；实时消息由 captured_at 或 sample_time_utc 映射。历史来源若只记录接收时间则为 NULL，不以接收时间冒充采样时间。';
COMMENT ON COLUMN iot.telemetry.receive_time_utc IS '本入库服务首次接收该原始事件的时间（UTC，timestamptz）；补发重试沿用首次接收时间，与设备测量时间区分。';
COMMENT ON COLUMN iot.telemetry.store_time_utc IS '当前数据库副本首次保存记录时的事务时间（UTC，timestamptz，默认 now()）；本地与云端副本的保存时间可能不同。';
COMMENT ON COLUMN iot.telemetry.quality IS '数据质量类别：ok 表示通过当前实时解析校验；historical 表示历史导入。采集失败不写入伪造零值；质量标记不表示采样连续无缺口。';
COMMENT ON COLUMN iot.telemetry.metrics IS '加工后的数值指标 JSON 对象，字段名带明确单位：energy_kwh 为累计电能（kWh），power_w 为有功功率（W），voltage_v 为电压（V），current_a 为电流（A），reactive_power_var 为无功功率（var），frequency_hz 为频率（Hz），power_factor 为无量纲功率因数；缺失指标不补零，累计表底不等于区间用电量。';
COMMENT ON COLUMN iot.telemetry.payload IS '兼容迁移前记录的完整 JSON 信封，保留作审计；新分层链路不在 PostgreSQL 重复保存原文，因此新记录通常为 NULL。';
COMMENT ON COLUMN iot.telemetry.payload_sha256 IS '来源信封的 SHA-256 语义哈希，当前实时链路对规范化 JSON 计算，兼容旧入库服务的幂等校验；不等于原始 UTF-8 字节哈希 raw_data_sha256。';
COMMENT ON COLUMN iot.telemetry.raw_id IS '独立原始层记录标识，用于追溯 SQLite 或 D1 的原始消息；迁移前无原始档案的记录可为 NULL。不建立跨层外键，原始记录过期不会级联删除加工结果。';
COMMENT ON COLUMN iot.telemetry.processor_id IS '生成本结果的处理器标识，例如 iot-telemetry、legacy-ddsu666 或 legacy-ingestor；用于区分加工规则来源。';
COMMENT ON COLUMN iot.telemetry.processor_version IS '处理器规则版本；与 raw_id、processor_id、output_key 共同构成加工结果唯一来源键，规则变更应使用新版本。';
COMMENT ON COLUMN iot.telemetry.output_key IS '同一原始记录经过同一处理器版本生成的输出分支标识，例如 telemetry 或历史来源表名；用于区分一条原始记录的多个加工结果。';
COMMENT ON COLUMN iot.telemetry.lineage IS '数据来源与加工血缘 JSON：可记录来源类型、来源表及记录标识、原始消息标识、时间语义、证据可用性和被排除指标等；具体字段随处理器而异。';
COMMENT ON COLUMN iot.telemetry.result_sha256 IS '版本化加工结果的 SHA-256 校验值，用于防止相同结果标识对应不同指标或来源；迁移前尚未计算该值的记录为 NULL。';
COMMENT ON COLUMN iot.telemetry.source_receive_time_utc IS '历史来源系统记录的上游接收时间（UTC，timestamptz）；未提供时为 NULL。它不是设备测量时间，仅在采样时间未知时作为云端保留期判断的后备时间。';

COMMENT ON VIEW iot.measured_metrics IS '加工层实测指标查询视图：直接投影遥测表的指标、时间、质量及加工血缘，不额外计算电量或功率；访问遵循调用者的底表权限与行级策略。';
COMMENT ON VIEW iot.derived_electrical IS '电气派生指标视图：查询时使用同一遥测记录的电压乘电流计算视在功率；该值是派生量，不冒充设备实测值，也不是区间用电量。访问遵循调用者的底表权限与行级策略。';

-- 直投影字段沿用底表的完整中文定义，避免视图与底表的解释漂移。
DO $comments$
DECLARE field record;
BEGIN
  FOR field IN
    SELECT c.relname, a.attname, col_description(t.oid, source.attnum) AS description
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    JOIN pg_class t ON t.relnamespace=n.oid AND t.relname='telemetry'
    JOIN pg_attribute source ON source.attrelid=t.oid AND source.attname=a.attname
      AND source.attnum>0 AND NOT source.attisdropped
    WHERE n.nspname='iot' AND c.relkind='v'
      AND c.relname IN ('measured_metrics','derived_electrical')
  LOOP
    EXECUTE format('COMMENT ON COLUMN iot.%I.%I IS %L', field.relname, field.attname, field.description);
  END LOOP;
END
$comments$;
COMMENT ON COLUMN iot.derived_electrical.apparent_power_va IS '派生视在功率（VA）：由同一条遥测记录的 voltage_v × current_a 计算，仅包含这两个指标均为 JSON 数值的记录；不是设备上报的实测视在功率。';
COMMIT;
