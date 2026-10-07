\set ON_ERROR_STOP on
-- 仅供独立、可丢弃的 PostgreSQL 17 测试容器；绝不能连接生产数据库。
-- 在仓库目录执行：psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -f ingestor/test/metric-quality-view.test.sql
-- 下方使用相对本文件的 \ir，因此需同时提供 ops/grafana/010-temperature-view.example.sql。
-- CREATE SCHEMA 不使用 IF NOT EXISTS：已存在 iot 时立即失败，避免覆盖现有资源。
CREATE SCHEMA iot;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='example_grafana') THEN
    CREATE ROLE example_grafana NOLOGIN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='example_grafana' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Test role must be unprivileged';
  END IF;
END $$;
GRANT USAGE ON SCHEMA iot TO example_grafana;

CREATE TABLE iot.telemetry (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_id uuid,
  schema_version integer NOT NULL DEFAULT 2,
  site_id text NOT NULL DEFAULT 'example-home',
  gateway_id text NOT NULL DEFAULT 'example-gateway',
  device_id text NOT NULL DEFAULT 'temperature-room',
  read_time_utc timestamptz DEFAULT '2026-01-02T03:04:05Z',
  sample_time_utc timestamptz,
  receive_time_utc timestamptz NOT NULL DEFAULT '2026-01-02T03:04:06Z',
  store_time_utc timestamptz NOT NULL DEFAULT '2026-01-02T03:04:07Z',
  quality text NOT NULL DEFAULT 'ok',
  metrics jsonb NOT NULL,
  processor_id text NOT NULL DEFAULT 'xiaomi-temperature-quality',
  processor_version text NOT NULL DEFAULT '1',
  lineage jsonb NOT NULL DEFAULT '{}',
  fixture_key text NOT NULL UNIQUE
);

-- 每个样例分别列出两个质量状态，不用整体异常状态丢弃另一项正常指标。
INSERT INTO iot.telemetry(fixture_key,metrics,lineage)
SELECT name,metrics,jsonb_build_object('metric_quality',jsonb_build_object(
  'rule_id','wsdcgq01lm-official-detection-range','rule_version','1',
  'metrics',jsonb_build_object(
    'temperature_c',jsonb_build_object('status',temperature_status),
    'humidity_pct',jsonb_build_object('status',humidity_status))))
FROM (VALUES
  ('normal','{"temperature_c":25,"humidity_pct":45,"battery_pct":60}'::jsonb,'ok','ok'),
  ('spike','{"temperature_c":100,"humidity_pct":0,"battery_pct":60}'::jsonb,'out_of_spec','out_of_spec'),
  ('temperature_bad','{"temperature_c":100,"humidity_pct":60,"battery_pct":60}'::jsonb,'out_of_spec','ok'),
  ('humidity_bad','{"temperature_c":20,"humidity_pct":0,"battery_pct":60}'::jsonb,'ok','out_of_spec'),
  ('lower_bounds','{"temperature_c":-20,"humidity_pct":10,"battery_pct":60}'::jsonb,'ok','ok'),
  ('upper_bounds','{"temperature_c":50,"humidity_pct":90,"battery_pct":60}'::jsonb,'ok','ok'),
  ('missing_both','{"battery_pct":60}'::jsonb,'missing','missing'),
  ('missing_temperature','{"humidity_pct":55}'::jsonb,'missing','ok'),
  ('invalid','{"temperature_c":"25","humidity_pct":null,"battery_pct":"60"}'::jsonb,'invalid','invalid'),
  ('quality_rejects_temperature','{"temperature_c":25,"humidity_pct":45,"battery_pct":60}'::jsonb,'out_of_spec','ok'),
  ('false_ok_outside_bounds','{"temperature_c":50.01,"humidity_pct":9.99,"battery_pct":60}'::jsonb,'ok','ok')
) fixtures(name,metrics,temperature_status,humidity_status);

INSERT INTO iot.telemetry(fixture_key,metrics,processor_id) VALUES
  ('legacy_without_quality','{"temperature_c":22,"humidity_pct":44,"battery_pct":60}','iot-telemetry'),
  ('legacy_spike','{"temperature_c":100,"humidity_pct":0,"battery_pct":60}','iot-telemetry');
INSERT INTO iot.telemetry(fixture_key,metrics) VALUES
  ('new_without_quality','{"temperature_c":25,"humidity_pct":45,"battery_pct":60}');

-- 新结果即便保存时间早于旧版本，也优先于同一 raw_id 的旧版本；只出现一次。
INSERT INTO iot.telemetry(fixture_key,raw_id,metrics,processor_id,store_time_utc,lineage) VALUES
  ('revision_old','00000000-0000-4000-8000-000000000001','{"temperature_c":22,"humidity_pct":44,"battery_pct":60}',
    'iot-telemetry','2026-01-02T04:00:00Z','{}'),
  ('revision_new','00000000-0000-4000-8000-000000000001','{"temperature_c":30,"humidity_pct":50,"battery_pct":60}',
    'xiaomi-temperature-quality','2026-01-02T03:00:00Z',
    '{"metric_quality":{"metrics":{"temperature_c":{"status":"ok"},"humidity_pct":{"status":"ok"}}}}');

-- raw_id 为 NULL 的遗留记录仍按各自 message_id 保留，不能合并成一行。
INSERT INTO iot.telemetry(fixture_key,metrics,processor_id) VALUES
  ('null_raw_a','{"temperature_c":15,"humidity_pct":30}','iot-telemetry'),
  ('null_raw_b','{"temperature_c":16,"humidity_pct":32}','legacy-ingestor');

-- 其他设备/站点/网关、历史基准、无时间记录都不能混入室温展示。
INSERT INTO iot.telemetry(fixture_key,metrics,device_id) VALUES
  ('cpu_75','{"cpu_temperature_c":75,"temperature_c":75}','temperature-host');
INSERT INTO iot.telemetry(fixture_key,metrics,site_id) VALUES
  ('wrong_site','{"temperature_c":25,"humidity_pct":45}','other-site');
INSERT INTO iot.telemetry(fixture_key,metrics,gateway_id) VALUES
  ('wrong_gateway','{"temperature_c":25,"humidity_pct":45}','other-gateway');
INSERT INTO iot.telemetry(fixture_key,metrics,quality) VALUES
  ('historical','{"temperature_c":25,"humidity_pct":45}','historical');
INSERT INTO iot.telemetry(fixture_key,metrics,read_time_utc) VALUES
  ('no_time','{"temperature_c":25,"humidity_pct":45}',NULL);

CREATE TEMP TABLE expected (
  fixture_key text PRIMARY KEY, temperature_c double precision, humidity_pct double precision, battery_pct double precision
);
INSERT INTO expected VALUES
  ('normal',25,45,60),('spike',NULL,NULL,60),('temperature_bad',NULL,60,60),('humidity_bad',20,NULL,60),
  ('lower_bounds',-20,10,60),('upper_bounds',50,90,60),('missing_both',NULL,NULL,60),('missing_temperature',NULL,55,NULL),
  ('invalid',NULL,NULL,NULL),('quality_rejects_temperature',NULL,45,60),('false_ok_outside_bounds',NULL,NULL,60),
  ('legacy_without_quality',22,44,60),('legacy_spike',NULL,NULL,60),('new_without_quality',NULL,NULL,60),
  ('revision_new',30,50,60),('null_raw_a',15,30,NULL),('null_raw_b',16,32,NULL);

\ir ../../ops/grafana/010-temperature-view.example.sql

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM expected e FULL JOIN (
      SELECT t.fixture_key,v.temperature_c,v.humidity_pct,v.battery_pct
      FROM iot.home_temperature_samples v JOIN iot.telemetry t USING(message_id)
    ) actual USING(fixture_key)
    WHERE e.fixture_key IS NULL OR actual.fixture_key IS NULL
      OR ROW(e.temperature_c,e.humidity_pct,e.battery_pct)
         IS DISTINCT FROM ROW(actual.temperature_c,actual.humidity_pct,actual.battery_pct)
  ) THEN RAISE EXCEPTION 'Per-metric values, exclusions, legacy handling or raw deduplication differ from expected'; END IF;
  IF (SELECT count(*) FROM iot.home_temperature_samples) <> (SELECT count(*) FROM expected) THEN
    RAISE EXCEPTION 'Unexpected duplicate observations';
  END IF;
  IF (SELECT ROW(avg(temperature_c),avg(humidity_pct)) FROM iot.home_temperature_samples)
    IS DISTINCT FROM (SELECT ROW(avg(temperature_c),avg(humidity_pct)) FROM expected) THEN
    RAISE EXCEPTION 'Average includes rejected values, inserted zeros or duplicate processing versions';
  END IF;
  IF EXISTS(SELECT 1 FROM iot.home_temperature_samples WHERE sensor_sample_time_utc IS NOT NULL
      OR observation_kind<>'gateway_cached_state' OR read_time_utc<>'2026-01-02T03:04:05Z'::timestamptz) THEN
    RAISE EXCEPTION 'Observation-time semantics changed';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM iot.telemetry WHERE fixture_key='spike'
      AND metrics='{"temperature_c":100,"humidity_pct":0,"battery_pct":60}'::jsonb) THEN
    RAISE EXCEPTION 'Underlying anomalous readings were changed';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM iot.telemetry WHERE fixture_key='cpu_75' AND metrics->>'cpu_temperature_c'='75') THEN
    RAISE EXCEPTION 'Host temperature was changed';
  END IF;
END $$;

CREATE TEMP TABLE before_repeat AS SELECT * FROM iot.home_temperature_samples;
\ir ../../ops/grafana/010-temperature-view.example.sql
DO $$ BEGIN
  IF EXISTS ((SELECT * FROM before_repeat EXCEPT ALL SELECT * FROM iot.home_temperature_samples)
    UNION ALL (SELECT * FROM iot.home_temperature_samples EXCEPT ALL SELECT * FROM before_repeat)) THEN
    RAISE EXCEPTION 'Repeated view migration changed results';
  END IF;
END $$;

-- 必须用只读角色实际查询；不能拿管理员查询成功替代权限验收。
SET ROLE example_grafana;
DO $$ BEGIN
  IF (SELECT count(*) FROM iot.home_temperature_samples) <> 17 THEN
    RAISE EXCEPTION 'Grafana cannot read all permitted observations';
  END IF;
  BEGIN
    PERFORM 1 FROM iot.telemetry LIMIT 1;
    RAISE EXCEPTION 'Grafana must not read the underlying table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
SELECT 'metric-quality-view: all assertions passed' AS result;
