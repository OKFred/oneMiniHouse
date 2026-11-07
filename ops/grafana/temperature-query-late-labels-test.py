import importlib.util
import json
import math
import os
import subprocess
import time
import unittest
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


spec = importlib.util.spec_from_file_location('late_labels', Path(__file__).with_name('temperature-query-late-labels.py'))
query = importlib.util.module_from_spec(spec)
spec.loader.exec_module(query)

SERVER = """SELECT t.message_id,t.read_time_utc,t.device_id,
CASE t.device_id WHEN 'host-a'::text THEN 'Example host'::text WHEN 'host-b'::text THEN 'Example host'::text ELSE NULL::text END AS device_name,
metric.key AS sensor_id,
CASE metric.key WHEN 'cpu_temperature_c'::text THEN 'CPU'::text
WHEN 'package_temperature_c'::text THEN 'CPU'::text
ELSE CASE WHEN metric.key ~ '^core_[0-9]+$'::text THEN 'core '::text || "substring"(metric.key,'[0-9]+'::text) ELSE NULL::text END END AS sensor_name,
metric.value::double precision AS temperature_c
FROM iot.telemetry t CROSS JOIN LATERAL jsonb_each(t.metrics) metric(key,value)
WHERE t.site_id='example-site'::text AND (
t.gateway_id='gateway-a'::text AND t.device_id=ANY(ARRAY['host-a'::text,'host-b'::text])
OR t.gateway_id='gateway-b'::text AND t.device_id='host-c'::text
) AND t.quality='ok'::text
UNION ALL
SELECT t.message_id,t.read_time_utc,t.device_id,t.gateway_id AS device_name,metric.key AS sensor_id,
CASE metric.key WHEN 'cpu_temperature_c'::text THEN 'Guest CPU'::text ELSE NULL::text END AS sensor_name,
metric.value::double precision AS temperature_c
FROM iot.telemetry t CROSS JOIN LATERAL jsonb_each(t.metrics) metric(key,value)
WHERE t.site_id='example-site'::text AND ((t.gateway_id,t.device_id) IN(VALUES ('example-guest'::text,'guest-a'::text),('example-guest-2'::text,'guest-b'::text)))
AND t.quality='ok'::text
UNION ALL
SELECT t.message_id,t.read_time_utc,t.device_id,'Example MCU'::text AS device_name,
'cpu_temperature_c'::text AS sensor_id,'MCU'::text AS sensor_name,t.temperature AS temperature_c
FROM iot.telemetry t WHERE t.site_id='example-site'::text AND t.gateway_id='gateway-mcu'::text AND t.device_id='mcu-a'::text;"""


def verified_render(*args, **kwargs):
    return query.render(*args, **kwargs, deterministic_default_collation=True)


def fixture():
    views = [{'name': query.VIEWS[0], 'options': ['security_barrier=true'], 'definition': SERVER}]
    for name, sensor in zip(query.VIEWS[1:], ['Battery', 'CPU package']):
        views.append({'name': name, 'options': ['security_barrier=true', 'security_invoker=false'],
                      'definition': "SELECT read_time_utc,device_id,device_name,'synthetic'::text AS sensor_id,'" + sensor + "'::text AS sensor_name,temperature_c FROM iot.safe_fixture;"})
    sql = "SELECT $__timeGroupAlias(read_time_utc,$__interval,NULL),device_name || ' / ' || sensor_name AS metric,avg(temperature_c) AS value FROM (" + \
        ' UNION ALL '.join('SELECT read_time_utc,device_name,sensor_name,sensor_id,temperature_c FROM iot.' + name for name in query.VIEWS) + \
        ") AS samples WHERE $__timeFilter(read_time_utc) AND (${temperature_category:sqlstring} = 'everything' OR CASE WHEN sensor_id = 'synthetic' THEN 'cpu' ELSE 'other' END = ${temperature_category:sqlstring}) GROUP BY 1,2 ORDER BY 1,2"
    return {'views': views}, {'panels': [{'targets': [{'rawSql': sql}]}]}


class LateLabelTests(unittest.TestCase):
    def test_query_reads_only_existing_safe_views_and_labels_materialized_aggregates(self):
        snapshot, dashboard = fixture()
        sql = verified_render(snapshot, dashboard)
        self.assertNotIn('iot.telemetry', sql)
        self.assertNotIn('iot.safe_fixture', sql)
        self.assertNotIn('GRANT', sql)
        self.assertNotIn('CREATE', sql)
        self.assertEqual(sql.count(' AS MATERIALIZED ('), 5)
        self.assertEqual(sql.count('sum(temperature_c)'), 3)
        self.assertEqual(sql.count('count(temperature_c)'), 3)
        self.assertIn('($__interval_ms)::double precision / 1000.0', sql)
        self.assertIn('$__timeGroupAlias(bucket,$__interval,NULL)', sql)
        self.assertIn('sum(temperature_sum)/NULLIF(sum(temperature_count),0)', sql)
        aggregates, labels = sql.split('temperature_label_keys_0 AS MATERIALIZED (')
        self.assertNotIn('sensor_name', aggregates)
        self.assertNotIn('substring', aggregates)
        self.assertIn('substring', labels)
        self.assertNotIn('t.device_id', labels)
        self.assertNotIn('metric.key', labels)
        self.assertIn('SELECT DISTINCT device_id,device_name,sensor_id FROM temperature_buckets_0', labels)
        self.assertIn('JOIN temperature_label_lookup_0 l USING(device_id,sensor_id)', labels)
        self.assertIn('b.device_name IS NOT DISTINCT FROM l.device_name', labels)
        self.assertEqual(sql.count(' COLLATE "C" AS '), 3)
        self.assertIn(') COLLATE "default" AS metric', labels)
        self.assertIn('${temperature_category:sqlstring}', labels)
        self.assertIn("device_name || ' / '", labels)

    def test_snapshot_expressions_are_quote_aware_and_unknown_shapes_fail_closed(self):
        self.assertEqual(query.label("SELECT 'sensor AS sensor_id'::text AS sensor_id,'AS sensor_name t.device_id UNION ALL'::text AS sensor_name FROM safe"), "'AS sensor_name t.device_id UNION ALL'::text")
        for changed in [SERVER.replace('t.gateway_id', 't.unexpected', 1), SERVER.replace("'Example MCU'::text AS device_name", "t.gateway_id AS device_name")]:
            with self.assertRaises(ValueError):
                query.server_label(changed)
        with self.assertRaisesRegex(ValueError, 'nullable server sensor identity'):
            query.server_label(SERVER.replace('metric.key AS sensor_id', 'NULL::text AS sensor_id', 1))
        with self.assertRaisesRegex(ValueError, 'Overlapping output identities'):
            query.server_label(SERVER.replace("'example-guest'::text,'guest-a'::text", "'Example host'::text,'host-a'::text"))
        snapshot, dashboard = fixture()
        snapshot['views'][0]['options'] = []
        with self.assertRaisesRegex(ValueError, 'security barrier'):
            verified_render(snapshot, dashboard)
        for unsafe in ['SELECT secret FROM forbidden', 'metric.other', 'sensor_id; DELETE FROM other', 'pg_read_file(sensor_id)']:
            with self.assertRaises(ValueError):
                query.expression(unsafe)
        for before, after in [('avg(temperature_c)', 'sum(temperature_c)'), ('temperature_c FROM iot.home_phone', 'temperature_c,other FROM iot.home_phone'), ('FROM iot.home_phone_temperature_samples', 'FROM iot.home_phone_temperature_samples WHERE temperature_c>0')]:
            snapshot, dashboard = fixture()
            target = dashboard['panels'][0]['targets'][0]
            target['rawSql'] = target['rawSql'].replace(before, after)
            with self.assertRaises(ValueError):
                verified_render(snapshot, dashboard)

    def test_fixed_benchmark_preserves_inclusive_end_and_current_all_category_value(self):
        snapshot, dashboard = fixture()
        end = datetime(2026, 11, 7, 20, 16, 51, tzinfo=timezone.utc)
        sql = verified_render(snapshot, dashboard, 600, end - timedelta(days=7), end)
        self.assertIn('make_interval(secs => 600)', sql)
        self.assertIn("BETWEEN TIMESTAMPTZ '2026-10-31T20:16:51+00:00' AND TIMESTAMPTZ '2026-11-07T20:16:51+00:00'", sql)
        self.assertIn("'everything' = 'everything'", sql)
        self.assertNotIn('$__', sql)
        self.assertNotIn('${', sql)
        for bad in [0, -1, 0.5, True]:
            with self.assertRaises(ValueError):
                verified_render(snapshot, dashboard, bad)

    def test_c_grouping_requires_verified_deterministic_default_and_unmodified_source_collation(self):
        snapshot, dashboard = fixture()
        for unverified in (None, False, 1, 'true'):
            with self.assertRaisesRegex(ValueError, 'deterministic default collation'):
                query.render(snapshot, dashboard, deterministic_default_collation=unverified)
        snapshot['views'][0]['definition'] = SERVER.replace('t.device_id,', 't.device_id COLLATE "C",', 1)
        with self.assertRaisesRegex(ValueError, 'explicit source collation'):
            verified_render(snapshot, dashboard)

    def test_partial_sums_keep_weighted_alias_collisions_and_all_null_buckets(self):
        # Two raw identities share a display label; their sample counts differ.
        rows = [(0, 'a', 'CPU', 10), (0, 'a', 'CPU', None), (0, 'b', 'CPU', 20), (0, 'b', 'CPU', 30),
                (0, 'null-a', None, None), (0, 'null-b', None, None), (600, 'zero', 'CPU', 0)]
        expected, grouped = defaultdict(list), defaultdict(list)
        for bucket, identity, label, value in rows:
            expected[bucket, label].append(value)
            grouped[bucket, identity, label].append(value)
        merged = defaultdict(lambda: [0, 0])
        for (bucket, _, label), values in grouped.items():
            valid = [value for value in values if value is not None]
            merged[bucket, label][0] += sum(valid)
            merged[bucket, label][1] += len(valid)
        for key, values in expected.items():
            valid = [value for value in values if value is not None]
            actual_sum, actual_count = merged[key]
            self.assertEqual(actual_sum / actual_count if actual_count else None, sum(valid) / len(valid) if valid else None)
        self.assertEqual(merged[0, 'CPU'][0] / merged[0, 'CPU'][1], 20)

    def test_epoch_floor_reference_covers_negative_time_and_exact_boundaries(self):
        for stride in [1, 15, 60, 300, 600, 86400]:
            width = stride * 1000000
            for micros in [-width - 1, -width, -width + 1, -1, 0, 1, width - 1, width, width + 1]:
                expected = (micros // width) * width
                self.assertEqual(math.floor(micros / width) * width, expected)
                self.assertTrue(expected <= micros < expected + width)
        sql = Path(__file__).with_name('temperature-query-buckets-test.sql').read_text()
        self.assertIn('1969-12-31T23:59:59.999999Z', sql)
        self.assertIn('mismatched_buckets', sql)


@unittest.skipUnless(os.environ.get('LATE_LABELS_POSTGRES') == '1', 'Set LATE_LABELS_POSTGRES=1 for the guarded local PostgreSQL fixture')
class LookupPostgresTests(unittest.TestCase):
    def test_lookup_preserves_aliases_null_names_labels_and_empty_windows(self):
        def docker(*arguments, data=None):
            return subprocess.check_output(['docker', '--context', 'desktop-linux', *arguments], input=data,
                text=True, encoding='utf-8', stderr=subprocess.PIPE, timeout=45).strip()
        context = json.loads(docker('context', 'inspect', 'desktop-linux'))[0]
        self.assertEqual(context['Endpoints']['docker']['Host'], 'npipe:////./pipe/dockerDesktopLinuxEngine')
        self.assertEqual(docker('info', '--format', '{{.OperatingSystem}}'), 'Docker Desktop')
        container, name = None, 'one-minihouse-label-lookup-' + uuid.uuid4().hex[:8] + '-test'
        try:
            container = docker('run', '--detach', '--name', name, '--label', 'one-minihouse.disposable-test=label-lookup',
                '--network', 'none', '--memory', '256m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data',
                '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17')
            state = json.loads(docker('inspect', container))[0]
            self.assertEqual(state['HostConfig']['NetworkMode'], 'none')
            self.assertFalse(state['HostConfig'].get('PortBindings'))
            self.assertFalse(any(mount['Type'] in ('bind', 'volume') for mount in state['Mounts']))
            for attempt in range(40):
                try:
                    if docker('exec', container, 'psql', '-X', '-qAt', '-U', 'postgres', '-c', 'SHOW listen_addresses;') == '*':
                        break
                except subprocess.CalledProcessError:
                    if attempt == 39:
                        raise
                time.sleep(0.25)
            else:
                raise RuntimeError('Disposable PostgreSQL did not finish bootstrap')
            def sql(statement, user='postgres'):
                return docker('exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', 'postgres', data=statement)
            sql("""CREATE SCHEMA iot;CREATE ROLE example_grafana LOGIN;CREATE TABLE iot.telemetry(secret text);
CREATE VIEW iot.home_server_temperature_samples WITH(security_barrier=true) AS SELECT * FROM(VALUES
 (TIMESTAMPTZ '2026-11-07T00:01:00Z','host-a'::text,'Example host'::text,'cpu_temperature_c'::text,'CPU'::text,10::double precision),
 ('2026-11-07T00:02:00Z','host-a','Example host','cpu_temperature_c','CPU',NULL),
 ('2026-11-07T00:03:00Z','host-b','Example host','cpu_temperature_c','CPU',20),
 ('2026-11-07T00:04:00Z','host-b','Example host','package_temperature_c','CPU',30),
 ('2026-11-07T00:05:00Z','host-c',NULL,'cpu_temperature_c','CPU',7),
 ('2026-11-07T00:06:00Z','host-a','Example host','unmapped',NULL,9),
 ('2026-11-07T00:10:00Z','host-a','Example host','unmapped-null',NULL,NULL),
 ('2026-11-07T00:20:00Z','host-a','Example host','cpu_temperature_c','CPU',0),
 ('2026-11-07T00:30:00Z','host-a','example-guest','cpu_temperature_c','Guest CPU',50),
 ('2026-11-07T00:40:00Z','mcu-a','Example MCU','cpu_temperature_c','MCU',33)
)v(read_time_utc,device_id,device_name,sensor_id,sensor_name,temperature_c);
CREATE VIEW iot.home_phone_temperature_samples WITH(security_barrier=true) AS
 SELECT TIMESTAMPTZ '2026-11-07T00:01:00Z' AS read_time_utc,'phone-a'::text AS device_id,'Example phone'::text AS device_name,
 'synthetic'::text AS sensor_id,'Battery'::text AS sensor_name,31::double precision AS temperature_c;
CREATE VIEW iot.home_host_health_temperature_samples WITH(security_barrier=true) AS
 SELECT TIMESTAMPTZ '2026-11-07T00:01:00Z' AS read_time_utc,'health-a'::text AS device_id,'Example health'::text AS device_name,
 'synthetic'::text AS sensor_id,'CPU package'::text AS sensor_name,49::double precision AS temperature_c;
GRANT USAGE ON SCHEMA iot TO example_grafana;
GRANT SELECT ON iot.home_server_temperature_samples,iot.home_phone_temperature_samples,iot.home_host_health_temperature_samples TO example_grafana;""")
            snapshot, dashboard = fixture()
            snapshot['views'][0]['definition'] = SERVER.replace("'guest-a'::text", "'host-a'::text")
            start = datetime(2026, 11, 7, tzinfo=timezone.utc)
            for lower, upper, seconds in [(start, start + timedelta(hours=1), 600), (start, start + timedelta(hours=1), 300),
                                           (start - timedelta(days=7), start - timedelta(days=6), 300)]:
                candidate = verified_render(snapshot, dashboard, seconds, lower, upper).rstrip().rstrip(';')
                union = ' UNION ALL '.join('SELECT read_time_utc,device_name,sensor_name,temperature_c FROM iot.' + name for name in query.VIEWS)
                reference = f"SELECT to_timestamp((floor(extract(epoch FROM read_time_utc)/{seconds})*{seconds})::double precision) AS time,device_name || ' / ' || sensor_name AS metric,avg(temperature_c) AS value FROM(" + union + ")s WHERE read_time_utc BETWEEN TIMESTAMPTZ '" + lower.isoformat() + "' AND TIMESTAMPTZ '" + upper.isoformat() + "' GROUP BY 1,2 ORDER BY 1,2"
                def values(statement):
                    return json.loads(sql("SELECT coalesce(json_agg(t ORDER BY time,metric),'[]') FROM(" + statement + ')t;', 'example_grafana'))
                old, new = values(reference), values(candidate)
                self.assertEqual(sql("SELECT pg_collation_for(t.metric)::regcollation='pg_catalog.default'::regcollation FROM(" + candidate + ')t WHERE metric IS NOT NULL LIMIT 1;', 'example_grafana'), 't' if lower == start else '')
                self.assertEqual([(row['time'], row['metric']) for row in old], [(row['time'], row['metric']) for row in new])
                for expected, actual in zip(old, new):
                    if expected['value'] is None:
                        self.assertIsNone(actual['value'])
                    else:
                        self.assertAlmostEqual(expected['value'], actual['value'], delta=1e-10)
                if lower == start:
                    self.assertTrue(any(row['metric'] is None and row['value'] is None for row in new))
                    self.assertTrue(any(row['metric'] is None and row['value'] == 8 for row in new))
                    self.assertTrue(any(row['metric'] == 'Example host / CPU' and row['value'] == 20 for row in new))
                    self.assertTrue(any(row['metric'] == 'example-guest / Guest CPU' and row['value'] == 50 for row in new))
                    self.assertTrue(any(row['value'] == 0 for row in new))
                else:
                    self.assertEqual(new, [])
            with self.assertRaises(subprocess.CalledProcessError):
                sql('SELECT * FROM iot.telemetry;', 'example_grafana')
        finally:
            if container:
                state = json.loads(docker('inspect', container))[0]
                if state['Id'] != container or state['Name'] != '/' + name or state['Config']['Labels'].get('one-minihouse.disposable-test') != 'label-lookup':
                    raise RuntimeError('Refusing cleanup after disposable identity change')
                docker('rm', '--force', container)


if __name__ == '__main__':
    unittest.main()
