import importlib.util
import math
import unittest
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
        sql = query.render(snapshot, dashboard)
        self.assertNotIn('iot.telemetry', sql)
        self.assertNotIn('iot.safe_fixture', sql)
        self.assertNotIn('GRANT', sql)
        self.assertNotIn('CREATE', sql)
        self.assertEqual(sql.count(' AS MATERIALIZED ('), 3)
        self.assertEqual(sql.count('sum(temperature_c)'), 3)
        self.assertEqual(sql.count('count(temperature_c)'), 3)
        self.assertIn('($__interval_ms)::double precision / 1000.0', sql)
        self.assertIn('$__timeGroupAlias(bucket,$__interval,NULL)', sql)
        self.assertIn('sum(temperature_sum)/NULLIF(sum(temperature_count),0)', sql)
        aggregates, labels = sql.split('temperature_labels AS (')
        self.assertNotIn('sensor_name', aggregates)
        self.assertNotIn('substring', aggregates)
        self.assertIn('substring', labels)
        self.assertNotIn('t.device_id', labels)
        self.assertNotIn('metric.key', labels)
        self.assertIn('${temperature_category:sqlstring}', labels)
        self.assertIn("device_name || ' / '", labels)

    def test_snapshot_expressions_are_quote_aware_and_unknown_shapes_fail_closed(self):
        self.assertEqual(query.label("SELECT 'sensor AS sensor_id'::text AS sensor_id,'AS sensor_name t.device_id UNION ALL'::text AS sensor_name FROM safe"), "'AS sensor_name t.device_id UNION ALL'::text")
        for changed in [SERVER.replace('t.gateway_id', 't.unexpected', 1), SERVER.replace("'Example MCU'::text AS device_name", "t.gateway_id AS device_name")]:
            with self.assertRaises(ValueError):
                query.server_label(changed)
        with self.assertRaisesRegex(ValueError, 'Overlapping output identities'):
            query.server_label(SERVER.replace("'example-guest'::text,'guest-a'::text", "'Example host'::text,'host-a'::text"))
        snapshot, dashboard = fixture()
        snapshot['views'][0]['options'] = []
        with self.assertRaisesRegex(ValueError, 'security barrier'):
            query.render(snapshot, dashboard)
        for unsafe in ['SELECT secret FROM forbidden', 'metric.other', 'sensor_id; DELETE FROM other', 'pg_read_file(sensor_id)']:
            with self.assertRaises(ValueError):
                query.expression(unsafe)
        for before, after in [('avg(temperature_c)', 'sum(temperature_c)'), ('temperature_c FROM iot.home_phone', 'temperature_c,other FROM iot.home_phone'), ('FROM iot.home_phone_temperature_samples', 'FROM iot.home_phone_temperature_samples WHERE temperature_c>0')]:
            snapshot, dashboard = fixture()
            target = dashboard['panels'][0]['targets'][0]
            target['rawSql'] = target['rawSql'].replace(before, after)
            with self.assertRaises(ValueError):
                query.render(snapshot, dashboard)

    def test_fixed_benchmark_preserves_inclusive_end_and_current_all_category_value(self):
        snapshot, dashboard = fixture()
        end = datetime(2026, 11, 7, 20, 16, 51, tzinfo=timezone.utc)
        sql = query.render(snapshot, dashboard, 600, end - timedelta(days=7), end)
        self.assertIn('make_interval(secs => 600)', sql)
        self.assertIn("BETWEEN TIMESTAMPTZ '2026-10-31T20:16:51+00:00' AND TIMESTAMPTZ '2026-11-07T20:16:51+00:00'", sql)
        self.assertIn("'everything' = 'everything'", sql)
        self.assertNotIn('$__', sql)
        self.assertNotIn('${', sql)
        for bad in [0, -1, 0.5, True]:
            with self.assertRaises(ValueError):
                query.render(snapshot, dashboard, bad)

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
        for stride in [1, 15, 60, 600, 86400]:
            width = stride * 1000000
            for micros in [-width - 1, -width, -width + 1, -1, 0, 1, width - 1, width, width + 1]:
                expected = (micros // width) * width
                self.assertEqual(math.floor(micros / width) * width, expected)
                self.assertTrue(expected <= micros < expected + width)
        sql = Path(__file__).with_name('temperature-query-buckets-test.sql').read_text()
        self.assertIn('1969-12-31T23:59:59.999999Z', sql)
        self.assertIn('mismatched_buckets', sql)


if __name__ == '__main__':
    unittest.main()
