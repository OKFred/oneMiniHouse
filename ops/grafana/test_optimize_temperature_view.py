import importlib.util
import re
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location('optimizer', Path(__file__).with_name('optimize-temperature-view.py'))
optimizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(optimizer)

BASE = """SELECT t.message_id,t.read_time_utc,metric.key,t.metrics
FROM iot.telemetry t CROSS JOIN LATERAL jsonb_each(t.metrics) metric(key,value)
WHERE t.site_id = 'example-home'::text AND (
t.gateway_id = 'gateway-old'::text AND (t.device_id = ANY (ARRAY['temperature-a'::text, 'temperature-b'::text]))
OR t.gateway_id = 'host-a'::text AND t.device_id = 'temperature-a'::text
OR t.gateway_id = 'gpu-vm'::text AND t.device_id = 'temperature-gpu'::text AND metric.key = 'gpu_temperature_c'::text
) AND t.quality = 'ok'::text AND jsonb_typeof(metric.value) = 'number'::text
UNION ALL
SELECT message_id,read_time_utc,'unchanged UNION ALL'::text,metrics FROM iot.telemetry WHERE device_id='other'::text;"""


class SourceRewriteTests(unittest.TestCase):
    def test_disjoint_sources_and_other_projections_are_preserved(self):
        branches, count, original = optimizer.source_branches(BASE)
        self.assertEqual(count, 4)
        self.assertEqual(len(branches), 5)
        self.assertEqual(branches[-1], original[-1])
        self.assertIn("t.device_id = 'temperature-b'::text", branches[1])
        self.assertIn("metric.key = 'gpu_temperature_c'::text", branches[3])
        self.assertNotIn('metric.key =', branches[2])
        for branch in branches[:4]:
            self.assertIn("t.quality = 'ok'::text", branch)
            self.assertIn("jsonb_typeof(metric.value) = 'number'::text", branch)
            self.assertNotIn('ANY (ARRAY', branch)

    def test_overlap_is_rejected_instead_of_duplicating_rows(self):
        duplicated = BASE.replace("'host-a'::text", "'gateway-old'::text")
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            optimizer.source_branches(duplicated)

    def test_sql_literals_and_nested_parentheses_do_not_split(self):
        sql = "SELECT 'a UNION ALL b', (SELECT 'OR') UNION ALL SELECT 'x''y'"
        self.assertEqual(len(optimizer.split_top_level(sql, 'UNION ALL')), 2)
        with self.assertRaisesRegex(ValueError, 'Unbalanced'):
            optimizer.split_top_level("SELECT ('unterminated", 'UNION ALL')

    def test_security_options_are_preserved_or_rejected(self):
        view = {'options': ['security_barrier=true', 'security_invoker=false']}
        result = optimizer.render(view, 'SELECT 1;')
        self.assertIn('WITH (security_barrier=true,security_invoker=false)', result)
        self.assertNotIn('DROP ', result)
        self.assertNotIn('GRANT ', result)
        with self.assertRaisesRegex(ValueError, 'security barrier'):
            optimizer.render({'options': []}, 'SELECT 1')
        with self.assertRaisesRegex(ValueError, 'Unsupported view option'):
            optimizer.render({'options': ['security_barrier=true', 'unexpected=setting']}, 'SELECT 1')

    def test_unsupported_shapes_fail_closed(self):
        with self.assertRaisesRegex(ValueError, 'Every branch'):
            optimizer.source_branches(BASE.replace("t.gateway_id = 'host-a'::text", "t.gateway_id LIKE 'host%'::text"))
        with self.assertRaisesRegex(ValueError, 'pg_get_viewdef'):
            optimizer.source_branches('DELETE FROM iot.telemetry')

    def test_specialization_preserves_columns_identity_predicates_and_quoted_labels(self):
        projection = BASE.replace('SELECT t.message_id,', "SELECT t.device_id,CASE t.device_id WHEN 'temperature-a'::text "
                                  "THEN 'label CASE t.device_id and it''s quoted'::text END AS \"CASE t.device_id\",t.message_id,")
        projection = projection.replace(") AND t.quality", ") AND (t.device_id = 'temperature-a'::text OR metric.key = 'gpu_temperature_c'::text) AND t.quality")
        branches, count, _ = optimizer.source_branches(projection)
        for branch in branches[:count]:
            self.assertTrue(branch.startswith('SELECT t.device_id,CASE '))
            self.assertIn("'label CASE t.device_id and it''s quoted'::text", branch)
            self.assertIn('AS "CASE t.device_id"', branch)
            self.assertNotIn('CASE t.device_id WHEN', branch)
            self.assertEqual(branch.count('t.device_id'), 4)  # Original column, two labels and indexed equality.
        self.assertIn("t.device_id = 'temperature-b'::text", branches[1])
        self.assertIn("AND ('temperature-b'::text = 'temperature-a'::text OR", branches[1])

    def test_only_canonical_channel_regex_becomes_exact_128_keys(self):
        regex = "metric.key ~ '" + optimizer.CHANNEL_PATTERN + "'::text"
        suffix = ') AND (' + regex + ") AND metric.key ~ '^cpu_core_[0-9]+_temperature_c$'::text"
        _, specialized = optimizer.specialize_source('SELECT t.device_id', suffix, "'temperature-a'::text")
        keys = re.findall(r"'([a-z0-9_]+_temperature_c)'::text", specialized)
        self.assertEqual(len(keys), 128)
        self.assertEqual(len(set(keys)), 128)
        for number in ('00', '09', '0', '99'):
            self.assertIn('cpu_core_' + number + '_temperature_c', keys)
        for key in ('cpu_core_100_temperature_c', 'cpu_core_١_temperature_c', 'cpu_core_９_temperature_c',
                    'cpu_core_9_temperature_c_bad', 'mainboard_channel_0_temperature_c', 'acpi_zone_10_temperature_c'):
            self.assertNotIn(key, keys)
        self.assertIn("metric.key ~ '^cpu_core_[0-9]+_temperature_c$'::text", specialized)

    def test_replacements_never_enter_single_or_double_quotes(self):
        quoted = "'CASE t.device_id, t.device_id, it''s literal',\"CASE t.device_id\",CASE t.device_id"
        result = optimizer.replace_code(quoted, r'\bt\.device_id\b', "'known'::text")
        self.assertEqual(result, "'CASE t.device_id, t.device_id, it''s literal',\"CASE t.device_id\",CASE 'known'::text")
        regex = "metric.key ~ '" + optimizer.CHANNEL_PATTERN + "'::text"
        escaped = "'" + regex.replace("'", "''") + "'"
        self.assertEqual(optimizer.specialize_source('', ') AND ' + escaped, "'known'::text")[1], ') AND ' + escaped)


if __name__ == '__main__':
    unittest.main()
