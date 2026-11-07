import copy
import importlib.util
import json
import os
import re
import subprocess
import time
import unittest
import uuid
from pathlib import Path


spec = importlib.util.spec_from_file_location('presence_panel', Path(__file__).with_name('presence-panel.py'))
panel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(panel)


def fixture():
    elements = {f'panel-{number}': {'kind': 'Panel', 'spec': {'id': number, 'title': f'Example {number}',
        'data': {'kind': 'QueryGroup', 'spec': {'queries': [{'kind': 'PanelQuery', 'spec': {'hidden': False, 'refId': 'A',
            'query': {'kind': 'DataQuery', 'group': 'grafana-postgresql-datasource', 'version': 'v0',
                      'datasource': {'name': 'example-postgres'}, 'spec': {'rawSql': 'SELECT 1', 'format': 'table'}}}}],
            'queryOptions': {}, 'transformations': []}},
        'vizConfig': {'kind': 'VizConfig', 'group': 'timeseries', 'version': '13.2.2', 'spec': {'fieldConfig': {}, 'options': {}}}}}
        for number in range(1, 45)}
    elements['panel-44']['spec']['data']['spec']['queries'][0]['spec']['query']['spec']['rawSql'] = \
        ' UNION ALL '.join('SELECT * FROM iot.' + view for view in panel.TEMPERATURE_VIEWS)
    return {'apiVersion': 'dashboard.grafana.app/v2', 'kind': 'Dashboard',
        'metadata': {'name': 'example-dashboard', 'resourceVersion': '123', 'annotations': {'example': 'preserve'}},
        'spec': {'title': 'Example dashboard', 'timeSettings': {'from': 'now-7d', 'to': 'now'},
            'variables': [{'kind': 'CustomVariable', 'spec': {'name': 'unrelated', 'query': 'a,b'}}],
            'links': [{'url': 'https://example.com', 'title': 'Example'}], 'annotations': [{'example': 'preserve'}],
            'elements': elements, 'layout': {'kind': 'TabsLayout', 'spec': {'tabs': [
                {'kind': 'TabsLayoutTab', 'spec': {'title': 'Example electricity', 'layout': {'kind': 'AutoGridLayout', 'spec': {
                    'items': [{'kind': 'AutoGridLayoutItem', 'spec': {'element': {'kind': 'ElementReference', 'name': f'panel-{number}'}}} for number in range(1, 44)]}}}},
                {'kind': 'TabsLayoutTab', 'spec': {'title': 'Example devices',
                    'variables': [{'kind': 'CustomVariable', 'spec': {'name': 'temperature_category', 'current': {'value': 'all'}, 'query': 'all,cpu'}}],
                    'layout': {'kind': 'AutoGridLayout', 'spec': {'fillScreen': True, 'maxColumnCount': 1,
                        'items': [{'kind': 'AutoGridLayoutItem', 'spec': {'element': {'kind': 'ElementReference', 'name': 'panel-44'}}}]}}}}
            ]}}}}


class PanelTests(unittest.TestCase):
    def test_only_one_element_and_target_layout_control_scope_change(self):
        before = fixture()
        frozen = copy.deepcopy(before)
        after, scope = panel.render(before)
        self.assertEqual(before, frozen)
        self.assertEqual(scope['before_elements'], 44)
        self.assertEqual(scope['after_elements'], 45)
        self.assertEqual(scope['existing_elements_unchanged'], 44)
        self.assertEqual(after['metadata'], before['metadata'])
        self.assertEqual(after['spec']['layout']['spec']['tabs'][0], before['spec']['layout']['spec']['tabs'][0])
        self.assertEqual(after['spec']['elements']['panel-44'], before['spec']['elements']['panel-44'])
        rows = after['spec']['layout']['spec']['tabs'][1]['spec']['layout']['spec']['rows']
        self.assertEqual(list(panel.references(rows[0])), [scope['new_element']])
        self.assertEqual(rows[1]['spec']['variables'], before['spec']['layout']['spec']['tabs'][1]['spec']['variables'])
        self.assertEqual(rows[1]['spec']['layout'], before['spec']['layout']['spec']['tabs'][1]['spec']['layout'])
        self.assertFalse(rows[1]['spec']['hideHeader'])

    def test_native_v2_transform_keeps_only_one_non_time_field_per_device(self):
        after, scope = panel.render(fixture())
        element = after['spec']['elements'][scope['new_element']]['spec']
        data = element['data']['spec']
        self.assertEqual(data['queryOptions'], {})
        self.assertEqual(data['transformations'], [{'kind': 'Transformation', 'group': 'partitionByValues',
            'spec': {'options': {'fields': ['device_name'], 'keepFields': False, 'naming': {'asLabels': True}}}}])
        query = data['queries'][0]['spec']['query']
        self.assertEqual(query['datasource'], {'name': 'example-postgres'})
        self.assertEqual(query['spec']['format'], 'table')
        self.assertEqual(query['spec']['rawSql'], panel.QUERY)
        self.assertNotIn('temperature_category', panel.QUERY)
        self.assertNotIn('telemetry', panel.QUERY)
        self.assertEqual(panel.QUERY.count('$__timeFrom()'), 1)
        self.assertEqual(panel.QUERY.count('$__timeTo()'), 1)
        self.assertIn('p.end_time_utc AS time_end', panel.QUERY)
        self.assertIn('count(DISTINCT physical_device_id)', panel.QUERY)

    def test_color_only_multiline_mappings_preserve_native_tooltip_evidence(self):
        after, scope = panel.render(fixture())
        viz = after['spec']['elements'][scope['new_element']]['spec']['vizConfig']
        self.assertEqual(viz['group'], 'state-timeline')
        mappings = viz['spec']['fieldConfig']['defaults']['mappings']
        for mapping, status in zip(mappings, ('在线', '离线', '失联', '未知')):
            self.assertEqual(set(mapping['options']['result']), {'color'})
            self.assertRegex(status + '\n依据：示例\n实例：example-session', mapping['options']['pattern'])
            self.assertFalse(re.search(mapping['options']['pattern'], 'unrecognized'))
        self.assertEqual(viz['spec']['options']['showValue'], 'never')
        self.assertFalse(viz['spec']['options']['legend']['showLegend'])
        self.assertEqual(viz['spec']['options']['perPage'], 0)
        self.assertEqual(viz['spec']['options']['tooltip']['mode'], 'single')
        self.assertIn('截至该区间结束', panel.DESCRIPTION)
        self.assertIn('失联不等于关机', panel.DESCRIPTION)

    def test_existing_or_ambiguous_shapes_fail_closed(self):
        original = fixture()
        after, _ = panel.render(original)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            panel.render(after)
        for mutate in (
            lambda value: value['spec']['elements']['panel-43']['spec']['data'].update(copy.deepcopy(value['spec']['elements']['panel-44']['spec']['data'])),
            lambda value: value['spec']['layout']['spec']['tabs'][1]['spec'].update(variables=[]),
            lambda value: value['spec']['elements']['panel-44']['spec']['data']['spec']['queries'][0]['spec']['query'].update(group='unsupported'),
            lambda value: value['spec']['layout']['spec']['tabs'][1]['spec']['layout']['spec']['items'].append(copy.deepcopy(value['spec']['layout']['spec']['tabs'][1]['spec']['layout']['spec']['items'][0]))):
            changed = copy.deepcopy(original)
            mutate(changed)
            with self.assertRaises(ValueError):
                panel.render(changed)
        for height in (0, 11, 41, True, 18.5):
            with self.assertRaises(ValueError):
                panel.render(original, height)

    def test_scope_assertion_detects_other_panel_metadata_or_control_mutation(self):
        before = fixture()
        for mutate in (
            lambda value: value['spec']['elements']['panel-1']['spec'].update(title='changed'),
            lambda value: value['metadata'].update(resourceVersion='changed'),
            lambda value: value['spec']['timeSettings'].update(to='now-1h'),
            lambda value: value['spec']['layout']['spec']['tabs'][0]['spec'].update(title='changed'),
            lambda value: value['spec']['layout']['spec']['tabs'][1]['spec']['layout']['spec']['rows'][1]['spec']['variables'][0]['spec'].update(query='changed')):
            after, scope = panel.render(before)
            mutate(after)
            with self.assertRaises(ValueError):
                panel.verify_scope(before, after, scope['new_element'], 'panel-44', 1, 18)


@unittest.skipUnless(os.environ.get('PRESENCE_PANEL_POSTGRES') == '1', 'Set PRESENCE_PANEL_POSTGRES=1 for the guarded local PostgreSQL fixture')
class PostgresPanelTests(unittest.TestCase):
    def test_four_typed_columns_duplicate_labels_and_unknown_evidence(self):
        def docker(*arguments, data=None):
            return subprocess.check_output(['docker', '--context', 'desktop-linux', *arguments], input=data,
                text=True, encoding='utf-8', stderr=subprocess.PIPE, timeout=45).strip()
        context = json.loads(docker('context', 'inspect', 'desktop-linux'))[0]
        self.assertEqual(context['Endpoints']['docker']['Host'], 'npipe:////./pipe/dockerDesktopLinuxEngine')
        self.assertEqual(docker('info', '--format', '{{.OperatingSystem}}'), 'Docker Desktop')
        container, name = None, 'one-minihouse-presence-panel-' + uuid.uuid4().hex[:8] + '-test'
        try:
            container = docker('run', '--detach', '--name', name, '--label', 'one-minihouse.disposable-test=presence-panel',
                '--network', 'none', '--memory', '256m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data',
                '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17')
            state = json.loads(docker('inspect', container))[0]
            self.assertEqual(state['HostConfig']['NetworkMode'], 'none')
            self.assertFalse(state['HostConfig'].get('PortBindings'))
            self.assertFalse(any(mount['Type'] in ('bind', 'volume') for mount in state['Mounts']))
            for attempt in range(40):
                try:
                    # The entrypoint's short-lived bootstrap server also answers pg_isready.
                    listen = docker('exec', container, 'psql', '-X', '-qAt', '-U', 'postgres', '-c', 'SHOW listen_addresses;')
                    if listen == '*':
                        break
                except subprocess.CalledProcessError:
                    if attempt == 39:
                        raise
                time.sleep(0.25)
            else:
                raise RuntimeError('Disposable PostgreSQL did not finish bootstrap')
            def sql(text, user='postgres'):
                return docker('exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', 'postgres', data=text)
            sql("""CREATE SCHEMA iot;CREATE ROLE example_grafana LOGIN;
CREATE FUNCTION iot.home_presence_display_timeline(p_from timestamptz,p_to timestamptz)
RETURNS TABLE(start_time_utc timestamptz,end_time_utc timestamptz,physical_device_id text,device_name text,kind text,state text,basis text,
last_heartbeat_time_utc timestamptz,last_heartbeat_source_time_utc timestamptz,last_observed_time_utc timestamptz,
reporter_id text,boot_id text,session_id uuid,observer_client_id text,observer_session_id uuid,parent_id text,
history_read_time_utc timestamptz,history_receive_time_utc timestamptz)
LANGUAGE sql STABLE AS $function$
 SELECT p_from,p_to,'example-device-'||n,CASE WHEN n<=2 THEN 'Example physical' ELSE 'Example physical '||n END,
 'direct',state,basis,CASE WHEN n<=4 THEN p_from-interval '1 second' END,
 CASE WHEN n<=4 THEN p_from-interval '2 seconds' END,CASE WHEN n<=4 THEN p_from END,
 CASE WHEN n<>5 THEN 'example-reporter' END,CASE WHEN n<>5 THEN 'example-boot' END,
 CASE WHEN n<>5 THEN '00000000-0000-4000-8000-000000000001'::uuid END,'example-observer',
 '00000000-0000-4000-8000-000000000002'::uuid,NULL::text,
 CASE WHEN n=9 THEN p_from-interval '2 seconds' END,CASE WHEN n=9 THEN p_from+interval '1 second' END
 FROM(VALUES(1,'online','fresh_heartbeat'),(2,'offline','lwt_observed'),(3,'offline','heartbeat_expired'),
 (4,'offline','read_failed'),(5,'unknown','no_observation'),(6,'unknown','cached_only'),
 (7,'unknown','pending_candidate_session'),(8,'unknown','parent_unknown'),(9,'online','历史上报推断'),(10,'unknown','历史无直接证据'))v(n,state,basis)
$function$;
REVOKE ALL ON FUNCTION iot.home_presence_display_timeline(timestamptz,timestamptz) FROM PUBLIC;
GRANT USAGE ON SCHEMA iot TO example_grafana;
GRANT EXECUTE ON FUNCTION iot.home_presence_display_timeline(timestamptz,timestamptz) TO example_grafana;""")
            query = panel.QUERY.replace('$__timeFrom()', "'2026-11-08T00:00:00Z'").replace('$__timeTo()', "'2026-11-08T01:00:00Z'").rstrip(';')
            rows = json.loads(sql('SELECT json_agg(t) FROM(' + query + ')t;', 'example_grafana'))
            self.assertEqual(len(rows), 10)
            self.assertTrue(all(set(row) == {'time', 'time_end', 'device_name', 'presence'} for row in rows))
            self.assertEqual(len({row['device_name'] for row in rows}), 10)
            self.assertEqual(sorted(row['presence'].split('\n')[0] for row in rows), sorted(['在线', '离线', '失联', '失联', '未知', '未知', '未知', '未知', '在线（历史推断）', '未知']))
            unseen = next(row for row in rows if row['device_name'] == 'Example physical 5')
            self.assertIn('最后心跳（UTC）：无证据', unseen['presence'])
            self.assertIn('报告实例：未知 / 未知 / 未知', unseen['presence'])
            historical = next(row for row in rows if row['device_name'] == 'Example physical 9')
            self.assertIn('历史最后直接读取（UTC）：2026-11-07T23:59:58.000Z', historical['presence'])
            self.assertIn('历史实例：未记录，不推断', historical['presence'])
            self.assertNotIn('example-boot', historical['presence'])
            self.assertEqual(sql('SELECT pg_typeof(t.time)::text,pg_typeof(t.time_end)::text FROM(' + query + ')t LIMIT 1;', 'example_grafana'),
                             'timestamp with time zone|timestamp with time zone')
        finally:
            if container:
                state = json.loads(docker('inspect', container))[0]
                if state['Id'] != container or state['Name'] != '/' + name or state['Config']['Labels'].get('one-minihouse.disposable-test') != 'presence-panel':
                    raise RuntimeError('Refusing cleanup after disposable identity change')
                docker('rm', '--force', container)


if __name__ == '__main__':
    unittest.main()
