"""Real PostgreSQL checks in a guarded, disposable local Docker container."""

import importlib.util
import json
import subprocess
import time
import unittest
import uuid
from pathlib import Path


spec = importlib.util.spec_from_file_location('optimizer', Path(__file__).with_name('optimize-temperature-view.py'))
optimizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(optimizer)

PROJECTION = """SELECT t.message_id,t.read_time_utc,t.device_id,
 CASE t.device_id WHEN 'temperature-a' THEN 'Host A CASE t.device_id' WHEN 'temperature-b' THEN 'Host B' ELSE 'GPU host' END AS device_name,
 metric.key AS sensor_id,metric.value::double precision AS temperature_c
FROM iot.telemetry t CROSS JOIN LATERAL jsonb_each(t.metrics) metric(key,value)
WHERE t.site_id='example-home' AND (
 t.gateway_id='old-gateway' AND t.device_id=ANY(ARRAY['temperature-a','temperature-b'])
 OR t.gateway_id='host-a' AND t.device_id='temperature-a'
 OR t.gateway_id='gpu-vm' AND t.device_id='temperature-gpu' AND metric.key='gpu_temperature_c'
) AND t.quality='ok' AND t.read_time_utc IS NOT NULL AND jsonb_typeof(metric.value)='number'
 AND ((t.device_id=ANY(ARRAY['temperature-a','temperature-b']) AND
   (metric.key=ANY(ARRAY['cpu_temperature_c','ddr_temperature_c']) OR
    metric.key ~ '^(cpu_core_[0-9]{1,2}|mainboard_channel_[1-9]|acpi_zone_[1-9])_temperature_c$'))
 OR t.device_id='temperature-gpu' AND metric.key='gpu_temperature_c')
UNION ALL
SELECT t.message_id,t.read_time_utc,t.device_id,'Other'::text,'cpu_temperature_c'::text,
 (t.metrics->>'cpu_temperature_c')::double precision FROM iot.telemetry t
WHERE t.site_id='example-home' AND t.gateway_id='other' AND t.quality='ok'
 AND jsonb_typeof(t.metrics->'cpu_temperature_c')='number'"""


class PostgresRewriteTests(unittest.TestCase):
    container = None

    @classmethod
    def docker(cls, *arguments, data=None):
        return subprocess.check_output(['docker', '--context', 'desktop-linux', *arguments],
                                       input=data, text=True, encoding='utf-8', stderr=subprocess.PIPE, timeout=90).strip()

    @classmethod
    def query(cls, sql, role='postgres'):
        return cls.docker('exec', '-i', cls.container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                          '-U', role, '-d', 'postgres', data=sql)

    @classmethod
    def metadata(cls):
        return json.loads(cls.query("""SELECT json_build_object('owner',pg_get_userbyid(c.relowner),
 'acl',c.relacl::text,'options',c.reloptions,'comment',obj_description(c.oid),
 'columns',(SELECT json_agg(json_build_object('name',attname,'type',format_type(atttypid,atttypmod),
 'comment',col_description(c.oid,attnum)) ORDER BY attnum) FROM pg_attribute
 WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped))
 FROM pg_class c WHERE c.oid='iot.home_server_temperature_samples'::regclass;"""))

    @classmethod
    def rows(cls, start, end):
        return json.loads(cls.query("SELECT coalesce(json_agg(t ORDER BY message_id,sensor_id),'[]'::json) FROM "
                         + "(SELECT * FROM iot.home_server_temperature_samples WHERE read_time_utc>='" + start
                         + "' AND read_time_utc<='" + end + "') t;", 'example_grafana'))

    @classmethod
    def setUpClass(cls):
        context = json.loads(cls.docker('context', 'inspect', 'desktop-linux'))[0]
        if context['Endpoints']['docker']['Host'] != 'npipe:////./pipe/dockerDesktopLinuxEngine':
            raise RuntimeError('Refusing a non-local Docker endpoint')
        if cls.docker('info', '--format', '{{.OperatingSystem}}') != 'Docker Desktop':
            raise RuntimeError('Refusing a non-local Docker engine')
        cls.name = 'one-minihouse-temperature-query-' + uuid.uuid4().hex[:8] + '-test'
        try:
            cls.container = cls.docker('run', '--detach', '--name', cls.name,
                '--label', 'one-minihouse.disposable-test=temperature-query', '--network', 'none',
                '--memory', '256m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data',
                '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17')
            state = json.loads(cls.docker('inspect', cls.container))[0]
            assert state['HostConfig']['NetworkMode'] == 'none'
            assert not state['HostConfig'].get('PortBindings')
            assert not any(item['Type'] in ('bind', 'volume') for item in state['Mounts'])
            for attempt in range(40):
                try:
                    cls.docker('exec', cls.container, 'pg_isready', '-U', 'postgres')
                    break
                except subprocess.CalledProcessError:
                    if attempt == 39:
                        raise
                    time.sleep(0.25)
            cls.query("""CREATE SCHEMA iot;CREATE ROLE example_grafana LOGIN;CREATE ROLE example_outsider LOGIN;
CREATE TABLE iot.telemetry(message_id uuid PRIMARY KEY,site_id text,gateway_id text,device_id text,
read_time_utc timestamptz,quality text,metrics jsonb);
CREATE INDEX telemetry_device_read_time ON iot.telemetry(site_id,gateway_id,device_id,read_time_utc DESC);
INSERT INTO iot.telemetry VALUES
('00000000-0000-4000-8000-000000000001','example-home','old-gateway','temperature-a','2026-11-01T00:00:00Z','ok','{"cpu_temperature_c":0}'),
('00000000-0000-4000-8000-000000000002','example-home','host-a','temperature-a','2026-11-07T23:30:00Z','ok','{"cpu_temperature_c":51,"ddr_temperature_c":47,"cpu_core_00_temperature_c":10,"cpu_core_09_temperature_c":11,"cpu_core_0_temperature_c":12,"cpu_core_99_temperature_c":13,"mainboard_channel_1_temperature_c":14,"mainboard_channel_9_temperature_c":15,"acpi_zone_1_temperature_c":16,"acpi_zone_9_temperature_c":17,"cpu_core_100_temperature_c":999,"cpu_core_١_temperature_c":999,"cpu_core_９_temperature_c":999,"cpu_core_9_temperature_c_bad":999,"mainboard_channel_0_temperature_c":999,"acpi_zone_10_temperature_c":999}'),
('00000000-0000-4000-8000-000000000003','example-home','old-gateway','temperature-b','2026-11-07T12:00:00Z','ok','{"cpu_temperature_c":49}'),
('00000000-0000-4000-8000-000000000004','example-home','gpu-vm','temperature-gpu','2026-11-07T23:30:00Z','ok','{"cpu_temperature_c":99,"cpu_core_00_temperature_c":999,"gpu_temperature_c":0}'),
('00000000-0000-4000-8000-000000000005','example-home','unlisted','temperature-a','2026-11-07T23:30:00Z','ok','{"cpu_temperature_c":999}'),
('00000000-0000-4000-8000-000000000006','example-home','host-a','unlisted','2026-11-07T23:30:00Z','ok','{"cpu_temperature_c":999}'),
('00000000-0000-4000-8000-000000000007','example-home','host-a','temperature-a','2026-11-07T23:30:00Z','error','{"cpu_temperature_c":999}'),
('00000000-0000-4000-8000-000000000008','example-home','host-a','temperature-a','2026-11-07T23:30:00Z','ok','{"cpu_temperature_c":"42"}'),
('00000000-0000-4000-8000-000000000009','example-home','host-a','temperature-a','2026-10-01T00:00:00Z','ok','{"cpu_temperature_c":1}'),
('00000000-0000-4000-8000-000000000010','example-home','host-a','temperature-a','2026-11-07T23:30:00Z','ok','{}'),
('00000000-0000-4000-8000-000000000011','example-home','other','temperature-other','2026-11-08T00:00:00Z','ok','{"cpu_temperature_c":40}'),
('00000000-0000-4000-8000-000000000012','wrong-site','host-a','temperature-a','2026-11-07T23:30:00Z','ok','{"cpu_temperature_c":999}');
""" + 'CREATE VIEW iot.home_server_temperature_samples WITH(security_barrier=true) AS ' + PROJECTION + ";"
                + "COMMENT ON VIEW iot.home_server_temperature_samples IS '保留原有注释';"
                + "COMMENT ON COLUMN iot.home_server_temperature_samples.temperature_c IS '摄氏度';"
                + 'GRANT USAGE ON SCHEMA iot TO example_grafana;GRANT SELECT ON iot.home_server_temperature_samples TO example_grafana;')
            cls.before_metadata = cls.metadata()
            cls.windows = [('2026-11-07T23:00:00Z', '2026-11-08T00:00:00Z'),
                           ('2026-11-07T00:00:00Z', '2026-11-08T00:00:00Z'),
                           ('2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z'),
                           ('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z')]
            cls.before_rows = [cls.rows(*window) for window in cls.windows]
            definition = cls.query("SELECT pg_get_viewdef('iot.home_server_temperature_samples'::regclass,true);")
            cls.rollback = optimizer.render({'options': cls.before_metadata['options']}, definition)
            branches, count, _ = optimizer.source_branches(definition)
            assert count == 4
            cls.migration = optimizer.render({'options': cls.before_metadata['options']}, '\nUNION ALL\n'.join(branches))
            cls.query(cls.migration)
        except BaseException:
            cls.cleanup()
            raise

    @classmethod
    def cleanup(cls):
        if cls.container:
            state = json.loads(cls.docker('inspect', cls.container))[0]
            if state['Id'] != cls.container or state['Name'] != '/' + cls.name or state['Config']['Labels'].get('one-minihouse.disposable-test') != 'temperature-query':
                raise RuntimeError('Refusing cleanup after disposable identity changed')
            cls.docker('rm', '--force', cls.container)
            cls.container = None

    @classmethod
    def tearDownClass(cls):
        cls.cleanup()

    def test_fixed_windows_values_zero_and_filtering(self):
        for index, window in enumerate(self.windows):
            self.assertEqual(self.before_rows[index], self.rows(*window))
        week = self.rows(*self.windows[2])
        self.assertEqual(len(week), 14)
        self.assertEqual(sum(row['temperature_c'] == 0 for row in week), 2)
        self.assertTrue(all(row['temperature_c'] != 999 for row in week))
        self.assertTrue(all(row['sensor_id'] == 'gpu_temperature_c' for row in week if row['device_id'] == 'temperature-gpu'))
        self.assertEqual(self.rows(*self.windows[3]), [])

    def test_metadata_and_repeated_migration(self):
        self.assertEqual(self.before_metadata, self.metadata())
        self.query(self.migration)
        self.assertEqual(self.before_metadata, self.metadata())

    def test_actual_reader_cannot_read_or_write_base(self):
        self.query("""DO $$ BEGIN
BEGIN PERFORM 1 FROM iot.telemetry;RAISE EXCEPTION 'Base readable';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
BEGIN DELETE FROM iot.telemetry;RAISE EXCEPTION 'Base writable';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $$;""", 'example_grafana')
        with self.assertRaises(subprocess.CalledProcessError):
            self.query('SELECT * FROM iot.home_server_temperature_samples;', 'example_outsider')

    def test_channel_boundaries_and_literal_label_are_exact(self):
        week = self.rows(*self.windows[2])
        channels = {row['sensor_id'] for row in week if row['device_id'] == 'temperature-a'}
        self.assertTrue({'cpu_core_00_temperature_c', 'cpu_core_09_temperature_c', 'cpu_core_0_temperature_c',
                         'cpu_core_99_temperature_c', 'mainboard_channel_1_temperature_c', 'mainboard_channel_9_temperature_c',
                         'acpi_zone_1_temperature_c', 'acpi_zone_9_temperature_c'}.issubset(channels))
        self.assertTrue(all(row['device_name'] == 'Host A CASE t.device_id' for row in week if row['device_id'] == 'temperature-a'))
        self.assertNotIn("metric.key ~ '" + optimizer.CHANNEL_PATTERN, self.migration)

    def test_rollback_preserves_values_and_metadata(self):
        try:
            self.query(self.rollback)
            self.assertEqual(self.before_metadata, self.metadata())
            for index, window in enumerate(self.windows):
                self.assertEqual(self.before_rows[index], self.rows(*window))
        finally:
            self.query(self.migration)


if __name__ == '__main__':
    unittest.main()
