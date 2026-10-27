\set ON_ERROR_STOP on
-- 仅供独立可丢弃的 PostgreSQL 17；iot 已存在即失败，绝不能连接生产。
CREATE SCHEMA iot;
CREATE ROLE example_grafana LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE example_outsider LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA iot TO example_grafana,example_outsider;
SET timezone='UTC';
CREATE TABLE iot.telemetry (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),schema_version smallint NOT NULL DEFAULT 2,
  site_id text NOT NULL DEFAULT 'example-home',gateway_id text NOT NULL DEFAULT 'example-router',
  device_id text NOT NULL DEFAULT 'temperature-example-router',
  read_time_utc timestamptz DEFAULT '2026-01-02T03:04:05Z',sample_time_utc timestamptz,
  receive_time_utc timestamptz DEFAULT '2026-01-02T03:04:06Z',quality text NOT NULL DEFAULT 'ok',
  observation_kind text NOT NULL DEFAULT 'direct_read',processor_id text NOT NULL DEFAULT 'host-health-temperature',
  processor_version text NOT NULL DEFAULT '1',output_key text NOT NULL DEFAULT 'cpu_temperature_c',
  metrics jsonb NOT NULL,lineage jsonb NOT NULL DEFAULT '{"source":{"driver":"openwrt-host-health","interface":"linux_thermal"}}',
  fixture_key text NOT NULL UNIQUE
);
ALTER TABLE iot.telemetry ENABLE ROW LEVEL SECURITY;
CREATE VIEW iot.telemetry_observation_compat WITH (security_invoker=false) AS SELECT * FROM iot.telemetry;

INSERT INTO iot.telemetry(fixture_key,metrics) VALUES
 ('normal','{"cpu_temperature_c":42.125,"memory_available_bytes":900000000}'),
 ('real_zero','{"cpu_temperature_c":0}'),('minimum','{"cpu_temperature_c":-50}'),
 ('maximum','{"cpu_temperature_c":150}'),('high_valid','{"cpu_temperature_c":90}'),
 ('missing','{}'),('string','{"cpu_temperature_c":"42"}'),('boolean','{"cpu_temperature_c":true}'),
 ('null_value','{"cpu_temperature_c":null}'),('below_range','{"cpu_temperature_c":-50.001}'),
 ('above_range','{"cpu_temperature_c":150.001}'),('extreme_numeric','{"cpu_temperature_c":1e10000}'),
 ('metrics_array','[42]'),('metrics_scalar','42');
UPDATE iot.telemetry SET read_time_utc='2026-01-02T11:04:05+08' WHERE fixture_key='normal';
INSERT INTO iot.telemetry(fixture_key,metrics,lineage) VALUES
 ('quality_ok','{"cpu_temperature_c":43}',
   '{"source":{"driver":"openwrt-host-health","interface":"linux_thermal"},"metric_quality":{"metrics":{"cpu_temperature_c":{"status":"ok"}}}}'),
 ('quality_rejected','{"cpu_temperature_c":44}',
   '{"source":{"driver":"openwrt-host-health","interface":"linux_thermal"},"metric_quality":{"metrics":{"cpu_temperature_c":{"status":"out_of_spec"}}}}'),
 ('quality_null','{"cpu_temperature_c":44}',
   '{"source":{"driver":"openwrt-host-health","interface":"linux_thermal"},"metric_quality":{"metrics":{"cpu_temperature_c":null}}}'),
 ('quality_malformed','{"cpu_temperature_c":44}',
   '{"source":{"driver":"openwrt-host-health","interface":"linux_thermal"},"metric_quality":{"metrics":{"cpu_temperature_c":"ok"}}}'),
 ('quality_no_status','{"cpu_temperature_c":44}',
   '{"source":{"driver":"openwrt-host-health","interface":"linux_thermal"},"metric_quality":{"metrics":{"cpu_temperature_c":{}}}}'),
 ('source_unavailable','{"cpu_temperature_c":44}',
   '{"source":{"driver":"openwrt-host-health","interface":"linux_thermal","metric_status":{"cpu_temperature_c":"read_failed"}}}'),
 ('wrong_driver','{"cpu_temperature_c":44}','{"source":{"driver":"another-source","interface":"linux_thermal"}}'),
 ('wrong_interface','{"cpu_temperature_c":44}','{"source":{"driver":"openwrt-host-health","interface":"another-interface"}}');
INSERT INTO iot.telemetry(fixture_key,metrics,site_id) VALUES('wrong_site','{"cpu_temperature_c":44}','other-site');
INSERT INTO iot.telemetry(fixture_key,metrics,gateway_id) VALUES('wrong_gateway','{"cpu_temperature_c":44}','other-router');
INSERT INTO iot.telemetry(fixture_key,metrics,device_id) VALUES('wrong_device','{"cpu_temperature_c":44}','private-device');
INSERT INTO iot.telemetry(fixture_key,metrics,processor_id) VALUES('wrong_processor','{"cpu_temperature_c":44}','iot-telemetry');
INSERT INTO iot.telemetry(fixture_key,metrics,processor_version) VALUES('wrong_version','{"cpu_temperature_c":44}','2');
INSERT INTO iot.telemetry(fixture_key,metrics,output_key) VALUES('wrong_output','{"cpu_temperature_c":44}','telemetry');
INSERT INTO iot.telemetry(fixture_key,metrics,schema_version) VALUES('wrong_schema','{"cpu_temperature_c":44}',1);
INSERT INTO iot.telemetry(fixture_key,metrics,quality) VALUES('historical','{"cpu_temperature_c":44}','historical');
INSERT INTO iot.telemetry(fixture_key,metrics,observation_kind) VALUES('cached','{"cpu_temperature_c":44}','gateway_cached_state');
INSERT INTO iot.telemetry(fixture_key,metrics,read_time_utc) VALUES
 ('missing_read','{"cpu_temperature_c":44}',NULL),('future_read','{"cpu_temperature_c":44}','2026-01-02T03:04:07Z'),
 ('infinite_read','{"cpu_temperature_c":44}','-infinity');
INSERT INTO iot.telemetry(fixture_key,metrics,receive_time_utc) VALUES
 ('missing_receive','{"cpu_temperature_c":44}',NULL),('infinite_receive','{"cpu_temperature_c":44}','infinity');
INSERT INTO iot.telemetry(fixture_key,metrics,sample_time_utc) VALUES
 ('invented_sample_clock','{"cpu_temperature_c":44}','2026-01-02T03:04:04Z');

-- 既有展示覆盖用电基准/累计/电压电流功率、插座、光照、室温湿度、服务器、手机和资产温度。
INSERT INTO iot.telemetry(fixture_key,metrics,processor_id,output_key) VALUES
 ('old_meter_baseline','{"energy_kwh":0}','user-meter-reference','reference'),
 ('old_meter','{"energy_kwh":123.4,"voltage_v":229.5,"current_a":0.8,"power_w":175.9,"reactive_power_var":12.3,"frequency_hz":50}','iot-telemetry','telemetry'),
 ('old_socket','{"energy_kwh":18.2,"power_w":80.1}','iot-telemetry','telemetry'),
 ('old_light','{"illuminance_lux":1234}','iot-telemetry','telemetry'),
 ('old_room','{"temperature_c":23.4,"humidity_pct":45}','iot-telemetry','telemetry'),
 ('old_host','{"cpu_temperature_c":54,"ddr_temperature_c":55}','iot-telemetry','telemetry'),
 ('old_phone','{"battery_temperature_c":30}','iot-telemetry','telemetry'),
 ('old_asset','{"disk_temperature_c":35}','hardware-asset-association','telemetry-assets');
CREATE VIEW iot.home_electricity_samples WITH (security_barrier=true) AS SELECT fixture_key,read_time_utc,metrics FROM iot.telemetry WHERE fixture_key IN ('old_meter_baseline','old_meter','old_socket');
CREATE VIEW iot.home_environment_samples WITH (security_barrier=true) AS SELECT read_time_utc,metrics FROM iot.telemetry WHERE fixture_key='old_light';
CREATE VIEW iot.home_temperature_samples WITH (security_barrier=true) AS SELECT read_time_utc,metrics FROM iot.telemetry WHERE fixture_key='old_room';
CREATE VIEW iot.home_server_temperature_samples WITH (security_barrier=true) AS SELECT read_time_utc,metrics FROM iot.telemetry WHERE fixture_key='old_host';
CREATE VIEW iot.home_phone_temperature_samples WITH (security_barrier=true) AS SELECT read_time_utc,metrics FROM iot.telemetry WHERE fixture_key='old_phone';
CREATE VIEW iot.home_asset_temperature_samples WITH (security_barrier=true) AS SELECT read_time_utc,metrics FROM iot.telemetry WHERE fixture_key='old_asset';
GRANT SELECT ON iot.home_electricity_samples,iot.home_environment_samples,iot.home_temperature_samples,
 iot.home_server_temperature_samples,iot.home_phone_temperature_samples,iot.home_asset_temperature_samples TO example_grafana;
CREATE TEMP TABLE original_view_metadata AS
 SELECT c.relname,c.relowner,c.reloptions,c.relacl::text,pg_get_viewdef(c.oid,true) AS definition
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='iot' AND c.relkind='v';
CREATE FUNCTION pg_temp.original_display_snapshot() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
  'electricity',(SELECT jsonb_agg(to_jsonb(v) ORDER BY fixture_key) FROM iot.home_electricity_samples v),
  'light',(SELECT jsonb_agg(to_jsonb(v)) FROM iot.home_environment_samples v),
  'room',(SELECT jsonb_agg(to_jsonb(v)) FROM iot.home_temperature_samples v),
  'host',(SELECT jsonb_agg(to_jsonb(v)) FROM iot.home_server_temperature_samples v),
  'phone',(SELECT jsonb_agg(to_jsonb(v)) FROM iot.home_phone_temperature_samples v),
  'asset',(SELECT jsonb_agg(to_jsonb(v)) FROM iot.home_asset_temperature_samples v))
$$;
CREATE TEMP TABLE original_display_values AS SELECT pg_temp.original_display_snapshot() AS value;
GRANT SELECT ON original_display_values TO example_grafana;

-- 故意给新建视图施加危险的默认 PUBLIC SELECT，模板必须显式撤销。
ALTER DEFAULT PRIVILEGES IN SCHEMA iot GRANT SELECT ON TABLES TO PUBLIC;
\ir 014-host-health-temperature-view.example.sql
DO $$ BEGIN
  IF (SELECT count(*) FROM iot.home_host_health_temperature_samples)<>6 THEN
    RAISE EXCEPTION 'Only six valid CPU temperatures must be visible'; END IF;
  IF NOT EXISTS(SELECT 1 FROM iot.home_host_health_temperature_samples v JOIN iot.telemetry t USING(message_id)
    WHERE t.fixture_key='normal' AND temperature_c=42.125 AND v.read_time_utc='2026-01-02T03:04:05Z'::timestamptz
      AND v.receive_time_utc='2026-01-02T03:04:06Z'::timestamptz AND v.sample_time_utc IS NULL) THEN
    RAISE EXCEPTION 'Value, unit or original UTC time changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM iot.home_host_health_temperature_samples v JOIN iot.telemetry t USING(message_id)
    WHERE t.fixture_key='real_zero' AND temperature_c=0) THEN RAISE EXCEPTION 'Real zero lost'; END IF;
  IF EXISTS(SELECT 1 FROM iot.home_host_health_temperature_samples v JOIN iot.telemetry t USING(message_id)
    WHERE t.fixture_key NOT IN ('normal','real_zero','minimum','maximum','high_valid','quality_ok')) THEN
    RAISE EXCEPTION 'Invalid source, time, quality or missing temperature leaked'; END IF;
  IF EXISTS(SELECT 1 FROM iot.home_host_health_temperature_samples
    WHERE sensor_id<>'cpu_temperature_c' OR sensor_name<>'CPU' OR sensor_category<>'CPU/GPU'
      OR observation_kind<>'direct_read' OR device_name<>'示例网关' OR sample_time_utc IS NOT NULL) THEN
    RAISE EXCEPTION 'Channel identity, category or time semantics changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='iot.home_host_health_temperature_samples'::regclass
    AND reloptions@>ARRAY['security_barrier=true','security_invoker=false']) THEN
    RAISE EXCEPTION 'View security options missing'; END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='iot.home_host_health_temperature_samples'::regclass
    AND attnum>0 AND NOT attisdropped AND col_description(attrelid,attnum) IS NULL) THEN
    RAISE EXCEPTION 'Chinese column comments missing'; END IF;
END $$;
CREATE TEMP TABLE result_before_repeat AS SELECT * FROM iot.home_host_health_temperature_samples;
\ir 014-host-health-temperature-view.example.sql
DO $$ BEGIN
  IF EXISTS((SELECT * FROM result_before_repeat EXCEPT ALL SELECT * FROM iot.home_host_health_temperature_samples)
    UNION ALL (SELECT * FROM iot.home_host_health_temperature_samples EXCEPT ALL SELECT * FROM result_before_repeat)) THEN
    RAISE EXCEPTION 'Repeated migration changed results'; END IF;
  IF EXISTS(SELECT 1 FROM original_view_metadata old JOIN pg_class c ON c.relname=old.relname
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='iot'
      AND (old.relowner IS DISTINCT FROM c.relowner OR old.reloptions IS DISTINCT FROM c.reloptions
        OR old.relacl IS DISTINCT FROM c.relacl::text OR old.definition IS DISTINCT FROM pg_get_viewdef(c.oid,true))) THEN
    RAISE EXCEPTION 'Original view metadata changed'; END IF;
  IF (SELECT value FROM original_display_values) IS DISTINCT FROM pg_temp.original_display_snapshot() THEN
    RAISE EXCEPTION 'Original display values or times changed'; END IF;
END $$;
SET ROLE example_grafana;
DO $$ BEGIN
  IF (SELECT count(*) FROM iot.home_host_health_temperature_samples)<>6 THEN RAISE EXCEPTION 'Limited view unreadable'; END IF;
  IF (SELECT value FROM original_display_values) IS DISTINCT FROM pg_temp.original_display_snapshot() THEN
    RAISE EXCEPTION 'Existing categories unreadable or changed'; END IF;
  BEGIN PERFORM 1 FROM iot.telemetry; RAISE EXCEPTION 'Base table readable';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM iot.telemetry_observation_compat; RAISE EXCEPTION 'Internal view readable';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF has_table_privilege(current_user,'iot.home_host_health_temperature_samples','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Grafana can mutate view'; END IF;
END $$;
RESET ROLE;
SET ROLE example_outsider;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM iot.home_host_health_temperature_samples; RAISE EXCEPTION 'PUBLIC can read limited view';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT 'host-health-temperature-view: all assertions passed' AS result;
