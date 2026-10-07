-- 本地 PostgreSQL / Supabase：以对象所有者执行，先于 v2 采集与入库程序上线。
-- 事务内完成兼容视图与旧时间迁移；原始字节、消息 ID、指标、哈希不变。
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS read_time_utc timestamptz;
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS observation_kind text NOT NULL DEFAULT 'unknown';
ALTER TABLE iot.telemetry ADD COLUMN IF NOT EXISTS time_basis text NOT NULL DEFAULT 'unknown';

-- 兼容仍在运行的 v1 采集端以及滚动升级期间的旧入库程序。
CREATE OR REPLACE FUNCTION iot.normalize_observation_times() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $normalize$
BEGIN
  IF NEW.quality='ok' AND NEW.schema_version=1 THEN
    IF NEW.read_time_utc IS NULL THEN
      NEW.read_time_utc := NEW.sample_time_utc;
      NEW.sample_time_utc := NULL;
    END IF;
    IF NEW.observation_kind='unknown' THEN
      NEW.observation_kind := CASE WHEN
        NEW.lineage#>>'{source,observation_kind}'='gateway_cached_state'
        OR NEW.payload#>>'{source,observation_kind}'='gateway_cached_state'
        OR NEW.lineage#>>'{source,driver}'='xiaomi-gateway-v3-temperature'
        OR NEW.payload#>>'{source,driver}'='xiaomi-gateway-v3-temperature'
        THEN 'gateway_cached_state' ELSE 'direct_read' END;
    END IF;
    NEW.time_basis := CASE WHEN NEW.observation_kind='gateway_cached_state'
      THEN 'gateway_state_read_time' ELSE 'collector_read_time' END;
  ELSIF NEW.quality='historical' AND NEW.observation_kind='unknown' THEN
    NEW.observation_kind := CASE WHEN NEW.processor_id='user-meter-reference'
      THEN 'user_reference' ELSE 'historical' END;
    NEW.time_basis := CASE WHEN NEW.processor_id='user-meter-reference' THEN 'user_provided'
      WHEN NEW.source_receive_time_utc IS NOT NULL THEN 'source_receive_time' ELSE 'unknown' END;
  END IF;
  RETURN NEW;
END $normalize$;
COMMENT ON FUNCTION iot.normalize_observation_times() IS '兼容旧采集端：v1 的时间代表采集端读取，将其归入 read_time_utc；历史安装基准保留用户时间。';
CREATE OR REPLACE TRIGGER normalize_observation_times
BEFORE INSERT OR UPDATE ON iot.telemetry
FOR EACH ROW EXECUTE FUNCTION iot.normalize_observation_times();

-- 仅在存在旧 Grafana 视图的本地库创建内部兼容投影，不授予客户端直接访问权。
-- 保留既有视图的完整设备/历史过滤、列顺序及授权，避免重建旧版本看板。
DO $compat$
DECLARE view_name text; definition text;
BEGIN
  IF to_regclass('iot.home_electricity_samples') IS NULL
     AND to_regclass('iot.home_environment_samples') IS NULL
     AND to_regclass('iot.home_temperature_samples') IS NULL THEN RETURN; END IF;
  -- 内部投影沿用视图所有者权限；invoker=true 会穿透外层屏障视图，要求 Grafana 读取整张底表。
  -- 客户端仅获准访问外层限定视图，不能直接读取此投影。
  EXECUTE $view$CREATE OR REPLACE VIEW iot.telemetry_observation_compat WITH (security_invoker=false) AS
    SELECT message_id,schema_version,site_id,gateway_id,device_id,
      COALESCE(sample_time_utc,read_time_utc) AS sample_time_utc,
      receive_time_utc,store_time_utc,quality,metrics,payload,payload_sha256,
      raw_id,processor_id,processor_version,output_key,lineage,result_sha256,
      source_receive_time_utc,read_time_utc,observation_kind,time_basis
    FROM iot.telemetry$view$;
  COMMENT ON VIEW iot.telemetry_observation_compat IS '内部看板兼容投影：sample_time_utc 为测量或读取时间的观测时间，非真实设备时钟保证；只供旧安全屏障视图使用，不向客户端直接授权。';
  FOREACH view_name IN ARRAY ARRAY['home_electricity_samples','home_environment_samples','home_temperature_samples'] LOOP
    IF to_regclass('iot.'||view_name) IS NULL THEN CONTINUE; END IF;
    definition := pg_get_viewdef(to_regclass('iot.'||view_name),true);
    IF position('iot.telemetry_observation_compat' IN definition)>0 THEN CONTINUE; END IF;
    -- 新版视图已直接读取真实 read_time_utc，不再经过旧时间兼容投影。
    -- 用列依赖判断，避免把温湿度未知的 sample_time_utc 错换成读取时间。
    IF EXISTS(SELECT 1 FROM pg_rewrite r JOIN pg_depend d
        ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
      JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
      WHERE r.ev_class=to_regclass('iot.'||view_name)
        AND d.refclassid='pg_class'::regclass AND d.refobjid='iot.telemetry'::regclass
        AND a.attname='read_time_utc') THEN CONTINUE; END IF;
    IF position('iot.telemetry' IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected source for view %, inspect before migration',view_name;
    END IF;
    definition := replace(definition,'telemetry.','telemetry_observation_compat.');
    definition := replace(definition,'iot.telemetry','iot.telemetry_observation_compat');
    definition := replace(definition,'设备采样时间','采集端读取时间');
    EXECUTE format('CREATE OR REPLACE VIEW iot.%I WITH (security_barrier=true) AS %s',view_name,definition);
    IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('iot.'||view_name) AND attname='sample_time_utc') THEN
      EXECUTE format('COMMENT ON COLUMN iot.%I.sample_time_utc IS %L',view_name,
        '兼容看板的观测时间（UTC）：设备测量时间未知时使用采集端读取时间；真实测量时间请查询加工层 sample_time_utc。');
    END IF;
  END LOOP;
END $compat$;

-- 只修改已经启用的同名云端清理任务的时间表达式；不新建、不启用、不改变调度。
DO $retention$
DECLARE job record; updated_command text;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
  FOR job IN SELECT jobid,command FROM cron.job WHERE jobname='one-minihouse-iot-telemetry-30d' LOOP
    updated_command := regexp_replace(job.command,
      'COALESCE\(\s*sample_time_utc,\s*source_receive_time_utc,\s*receive_time_utc\s*\)',
      'COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)','gi');
    IF position('read_time_utc' IN updated_command)=0 THEN
      RAISE EXCEPTION 'Unexpected retention command; inspect before migration';
    END IF;
    IF updated_command<>job.command THEN
      PERFORM cron.alter_job(job.jobid,command:=updated_command);
    END IF;
    CREATE INDEX IF NOT EXISTS telemetry_retention_30d_time_v2 ON iot.telemetry
      ((COALESCE(sample_time_utc,read_time_utc,source_receive_time_utc,receive_time_utc)),message_id);
  END LOOP;
END $retention$;

UPDATE iot.telemetry SET observation_kind=observation_kind
WHERE (schema_version=1 AND quality='ok' AND (read_time_utc IS NULL OR observation_kind='unknown'))
   OR (quality='historical' AND observation_kind='unknown');

CREATE INDEX IF NOT EXISTS telemetry_device_read_time
  ON iot.telemetry(site_id,gateway_id,device_id,read_time_utc DESC) WHERE read_time_utc IS NOT NULL;
CREATE OR REPLACE VIEW iot.measured_metrics WITH (security_invoker=true) AS
SELECT message_id,raw_id,site_id,gateway_id,device_id,sample_time_utc,receive_time_utc,store_time_utc,
  quality,metrics,processor_id,processor_version,output_key,lineage,read_time_utc,observation_kind,time_basis
FROM iot.telemetry;
CREATE OR REPLACE VIEW iot.derived_electrical WITH (security_invoker=true) AS
SELECT message_id,raw_id,site_id,gateway_id,device_id,sample_time_utc,
  (metrics->>'voltage_v')::double precision*(metrics->>'current_a')::double precision AS apparent_power_va,
  read_time_utc,observation_kind,time_basis
FROM iot.telemetry
WHERE jsonb_typeof(metrics->'voltage_v')='number' AND jsonb_typeof(metrics->'current_a')='number';

COMMENT ON COLUMN iot.telemetry.schema_version IS '来源信封版本：1 为旧实时格式；2 支持显式测量/读取时间，也用于历史导入，具体类别由 quality 区分。';
COMMENT ON COLUMN iot.telemetry.sample_time_utc IS '设备提供的实际测量时间（UTC）；未提供时为 NULL，不用轮询时间代替。历史用户安装基准保留用户指定时间，结合 time_basis 解释。';
COMMENT ON COLUMN iot.telemetry.read_time_utc IS '采集端成功读取设备或网关状态的时间（UTC），不是消息接收/落库时间；网关缓存的读取不代表传感器刚刚上报。';
COMMENT ON COLUMN iot.telemetry.observation_kind IS '观测类别：direct_read 直接读取、gateway_cached_state 网关缓存、historical 历史来源、user_reference 用户基准、unknown 未知。';
COMMENT ON COLUMN iot.telemetry.time_basis IS '时间依据：device_sample_time 设备测量、collector_read_time 采集端读取、gateway_state_read_time 网关缓存读取、source_receive_time 历史接收、user_provided 用户指定、unknown 未知。';
DO $comments$
DECLARE field record;
BEGIN
  FOR field IN SELECT c.relname,a.attname,col_description(t.oid,s.attnum) AS description
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    JOIN pg_class t ON t.relnamespace=n.oid AND t.relname='telemetry'
    JOIN pg_attribute s ON s.attrelid=t.oid AND s.attname=a.attname AND s.attnum>0 AND NOT s.attisdropped
    WHERE n.nspname='iot' AND c.relname IN ('measured_metrics','derived_electrical','telemetry_observation_compat')
  LOOP
    EXECUTE format('COMMENT ON COLUMN iot.%I.%I IS %L',field.relname,field.attname,field.description);
  END LOOP;
  IF to_regclass('iot.telemetry_observation_compat') IS NOT NULL THEN
    COMMENT ON COLUMN iot.telemetry_observation_compat.sample_time_utc IS '旧看板兼容字段：COALESCE(实际测量时间,采集端读取时间)，不应解释为设备提供的时间。';
  END IF;
END $comments$;
COMMIT;
