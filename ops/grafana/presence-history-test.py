"""Synthetic history/display checks in a guarded local PostgreSQL 17 container."""

import json
import os
import subprocess
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CUTOVER = datetime(2026, 11, 8, tzinfo=timezone.utc)


def at(seconds):
    return (CUTOVER + timedelta(seconds=seconds)).isoformat()


def literal(value):
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"


class HistoryTests(unittest.TestCase):
    container = None

    @classmethod
    def docker(cls, *arguments, data=None):
        return subprocess.check_output(['docker', '--context', 'desktop-linux', *arguments], input=data,
            text=True, encoding='utf-8', stderr=subprocess.PIPE, timeout=90).strip()

    @classmethod
    def sql(cls, text, database='history_local', role='postgres'):
        try:
            return cls.docker('exec', '-i', cls.container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', role, '-d', database, data=text)
        except subprocess.CalledProcessError as error:
            raise RuntimeError(error.stderr) from error

    @classmethod
    def install(cls, database, scale=False):
        cls.sql('CREATE SCHEMA iot;CREATE TABLE iot.telemetry(message_id uuid PRIMARY KEY,site_id text,gateway_id text,device_id text,processor_id text,quality text,observation_kind text,read_time_utc timestamptz,receive_time_utc timestamptz,lineage jsonb);'
                + 'CREATE INDEX telemetry_device_read_time ON iot.telemetry(site_id,gateway_id,device_id,read_time_utc DESC) WHERE read_time_utc IS NOT NULL;', database)
        settings = "SET one_min_house.ingestor_role='example_ingestor';SET one_min_house.grafana_role='example_grafana';"
        registry = (ROOT / 'ops/grafana/presence-registry.example.sql').read_text(encoding='utf-8')
        if scale:
            registry = "CREATE VIEW iot.home_presence_registry WITH(security_barrier=true,security_invoker=false) AS SELECT 'scale-'||n AS physical_device_id,'Example physical '||n AS device_name,'example-home'::text AS site_id,'direct'::text AS kind,NULL::text AS parent_id,true AS visible,'example-presence-reader'::text AS observer_client_id,300::integer AS freshness_seconds FROM generate_series(0,19)n;"
        else:
            registry = registry.replace(") registry(", ",\n('example-islands','Example islands','example-home','direct',NULL,true,'example-presence-reader',300),\n('example-slow','Example slow','example-home','proxy','example-host',true,'example-presence-reader',1800),\n('example-clock','Example clock','example-home','direct',NULL,true,'example-presence-reader',300)\n) registry(")
        cls.sql(settings + (ROOT / 'ingestor/sql/007-device-presence.sql').read_text(encoding='utf-8') + registry
                + (ROOT / 'ops/grafana/presence-reader-views.sql').read_text(encoding='utf-8')
                + (ROOT / 'ops/grafana/presence-timeline.sql').read_text(encoding='utf-8'), database)
        seed = (ROOT / 'ops/grafana/presence-history-sources.example.sql').read_text(encoding='utf-8')
        if scale:
            seed = "CREATE VIEW iot.home_presence_history_policy WITH(security_barrier=true,security_invoker=false) AS SELECT TIMESTAMPTZ '" + at(0) + "' AS cutover_utc;CREATE VIEW iot.home_presence_history_sources WITH(security_barrier=true,security_invoker=false) AS SELECT 'scale-'||n AS physical_device_id,'example-home'::text AS site_id,'scale-gateway-'||n AS gateway_id,'scale-telemetry-'||n AS device_id,'iot-telemetry'::text AS processor_id,300::integer AS freshness_seconds,NULL::text AS required_source_driver,NULL::text AS required_source_integrity FROM generate_series(0,19)n;REVOKE ALL ON iot.home_presence_history_policy,iot.home_presence_history_sources FROM PUBLIC;"
        else:
            seed = seed.replace(") sources(", ",\n('example-islands','example-home','example-islands-gateway','example-islands-telemetry','iot-telemetry',300,NULL,NULL),\n('example-slow','example-home','example-slow-gateway','example-slow-telemetry','iot-telemetry',1800,NULL,NULL),\n('example-clock','example-home','example-clock-gateway','example-clock-telemetry','iot-telemetry',300,NULL,NULL)\n) sources(")
        cls.sql(seed, database)
        migration = (ROOT / 'ops/grafana/presence-history-reader.sql').read_text(encoding='utf-8')
        cls.sql(settings + migration, database)
        cls.sql(settings + migration, database)

    @classmethod
    def proof(cls, database, device, read, receive=None, **options):
        receive = read + 1 if receive is None and isinstance(read, (int, float)) else receive
        read = at(read) if isinstance(read, (int, float)) else read
        receive = at(receive) if isinstance(receive, (int, float)) else receive
        source = {key: options[key] for key in ('driver', 'integrity') if key in options}
        values = [str(uuid.uuid4()), options.get('site', 'example-home'), 'example-' + device + '-gateway', 'example-' + device + '-telemetry',
                  options.get('processor', 'iot-telemetry'), options.get('quality', 'ok'), options.get('observation', 'direct_read'), read, receive,
                  json.dumps({'source': source})]
        cls.sql('INSERT INTO iot.telemetry VALUES(' + ','.join(literal(value) for value in values) + ');', database)

    @classmethod
    def populate(cls, database):
        for read in (-900, -700, -400, -80):
            cls.proof(database, 'islands', read)
        cls.proof(database, 'slow', -1200)
        cls.proof(database, 'host', -600, driver='esp32.raw_temperature')
        cls.proof(database, 'host', -500, driver='rs485.modbus.sht20', integrity='crc_verified')
        cls.proof(database, 'host', -100, driver='rs485.modbus.sht20', integrity='crc_failed')
        cls.proof(database, 'host', -50, driver='rs485.modbus.sht20')
        cls.proof(database, 'host', -150, 100, driver='rs485.modbus.sht20', integrity='crc_verified')
        cls.proof(database, 'clock', -600, -600.499)
        cls.proof(database, 'clock', -200, -200.500)
        cls.proof(database, 'clock', -55, -55.501)
        cls.proof(database, 'clock', -350, 0)
        cls.proof(database, 'clock', -250, processor='legacy-history')
        cls.proof(database, 'clock', -260, observation='gateway_cached_state')
        cls.proof(database, 'clock', -270, quality='error')
        cls.proof(database, 'clock', -280, site='wrong-example-site')
        cls.proof(database, 'clock', 'infinity', 'infinity')
        cls.proof(database, 'clock', None, at(-290))
        cls.proof(database, 'clock', -295, 'infinity')
        cls.proof(database, 'clock', at(-290), None)
        cls.proof(database, 'clock', at(-291), '294276-12-31 23:59:59.999999+00')
        cls.proof(database, 'clock', '294276-12-31 23:59:59.999999+00', at(-292))
        cls.proof(database, 'host', -6 * 86400 + 100, driver='esp32.raw_temperature')
        for read in (30, 60, 180, 250):
            cls.proof(database, 'host', read, driver='rs485.modbus.sht20', integrity='crc_verified')
        cls.sql("""INSERT INTO iot.device_presence_events(result_id,raw_id,processor_id,record_kind,event_id,physical_device_id,device_name,kind,parent_id,site_id,visible,
observer_client_id,observer_session_id,observed_time_utc,observation_order,event,reporter_id,boot_id,session_id,sequence,source_time_utc,uptime_ms,
online,reason,retained,qos,duplicate,applied,state_after,decision,freshness_seconds,valid_until_utc,coverage_until_utc,payload_sha256,result_sha256)
SELECT md5('presence-result-'||n)::uuid,md5('presence-raw-'||n)::uuid,CASE WHEN n=1 THEN 'device-presence' ELSE 'presence-observer' END,
CASE WHEN n=1 THEN 'device' ELSE 'observer' END,md5('presence-event-'||n)::uuid,
CASE WHEN n=1 THEN 'example-host' END,CASE WHEN n=1 THEN '示例主机' END,CASE WHEN n=1 THEN 'direct' END,NULL,'example-home',n=1,
'example-presence-reader','00000000-0000-4000-8000-000000000001',TIMESTAMPTZ '2026-11-08T00:00:00Z'+make_interval(secs=>CASE n WHEN 1 THEN 10 WHEN 2 THEN 0 ELSE 30 END),
n,CASE n WHEN 1 THEN 'online' WHEN 2 THEN 'coverage_start' ELSE 'coverage_heartbeat' END,
CASE WHEN n=1 THEN 'example-publisher' END,CASE WHEN n=1 THEN 'example-boot' END,
CASE WHEN n=1 THEN '00000000-0000-4000-8000-000000000002'::uuid END,n,NULL,NULL,n=1,
CASE WHEN n=1 THEN 'connected' ELSE 'observer_connected' END,false,1,false,true,CASE WHEN n=1 THEN 'online' ELSE 'unknown' END,'accepted',
CASE WHEN n=1 THEN 300 END,CASE WHEN n=1 THEN TIMESTAMPTZ '2026-11-08T00:05:10Z' END,
CASE WHEN n<>1 THEN TIMESTAMPTZ '2026-11-08T00:00:00Z'+make_interval(secs=>CASE n WHEN 2 THEN 90 ELSE 120 END) END,
repeat('a',64),repeat('b',64) FROM generate_series(1,3)n;""", database)

    @classmethod
    def setUpClass(cls):
        context = json.loads(cls.docker('context', 'inspect', 'desktop-linux'))[0]
        if context['Endpoints']['docker']['Host'] != 'npipe:////./pipe/dockerDesktopLinuxEngine' or cls.docker('info', '--format', '{{.OperatingSystem}}') != 'Docker Desktop':
            raise RuntimeError('Refusing a non-local Docker endpoint')
        cls.name = 'one-minihouse-presence-history-' + uuid.uuid4().hex[:8] + '-test'
        try:
            cls.container = cls.docker('run', '--detach', '--name', cls.name, '--label', 'one-minihouse.disposable-test=presence-history',
                '--network', 'none', '--memory', '768m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data',
                '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17')
            state = json.loads(cls.docker('inspect', cls.container))[0]
            assert state['HostConfig']['NetworkMode'] == 'none' and not state['HostConfig'].get('PortBindings')
            assert not any(mount['Type'] in ('bind', 'volume') for mount in state['Mounts'])
            for attempt in range(40):
                try:
                    if cls.docker('exec', cls.container, 'psql', '-X', '-qAt', '-U', 'postgres', '-c', 'SHOW listen_addresses;') == '*':
                        break
                except subprocess.CalledProcessError:
                    if attempt == 39:
                        raise
                time.sleep(0.25)
            else:
                raise RuntimeError('Disposable PostgreSQL bootstrap did not finish')
            cls.sql('CREATE ROLE example_ingestor LOGIN;CREATE ROLE example_grafana LOGIN;CREATE ROLE example_outsider LOGIN;CREATE DATABASE history_local;CREATE DATABASE history_cloud;CREATE DATABASE history_scale;', 'postgres')
            for database in ('history_local', 'history_cloud'):
                cls.install(database)
                cls.populate(database)
            cls.sql("DELETE FROM iot.telemetry WHERE receive_time_utc<TIMESTAMPTZ '2026-11-08T00:00:00Z'-interval '48 hours';DELETE FROM iot.device_presence_events;", 'history_cloud')
        except BaseException:
            cls.cleanup()
            raise

    @classmethod
    def cleanup(cls):
        if cls.container:
            state = json.loads(cls.docker('inspect', cls.container))[0]
            if state['Id'] != cls.container or state['Name'] != '/' + cls.name or state['Config']['Labels'].get('one-minihouse.disposable-test') != 'presence-history':
                raise RuntimeError('Refusing cleanup after disposable identity change')
            cls.docker('rm', '--force', cls.container)
            cls.container = None

    @classmethod
    def tearDownClass(cls):
        cls.cleanup()

    @classmethod
    def rows(cls, start=-1000, end=400, database='history_local'):
        return json.loads(cls.sql('SELECT coalesce(json_agg(t ORDER BY physical_device_id,start_time_utc),\'[]\') FROM iot.home_presence_display_timeline('
            + literal(at(start)) + ',' + literal(at(end)) + ')t;', database, 'example_grafana'))

    def state(self, rows, physical, second):
        point = CUTOVER + timedelta(seconds=second)
        found = [row for row in rows if row['physical_device_id'] == physical and datetime.fromisoformat(row['start_time_utc']) <= point < datetime.fromisoformat(row['end_time_utc'])]
        self.assertEqual(len(found), 1)
        return found[0]

    def test_overlap_adjacency_gap_partial_ttl_and_all_registered_rows(self):
        rows = self.rows()
        self.assertEqual(len({row['physical_device_id'] for row in rows}), 7)
        self.assertFalse(any(row['physical_device_id'] == 'example-reporter' for row in rows))
        for physical in {row['physical_device_id'] for row in rows}:
            segments = [row for row in rows if row['physical_device_id'] == physical]
            self.assertEqual(datetime.fromisoformat(segments[0]['start_time_utc']), CUTOVER - timedelta(seconds=1000))
            self.assertEqual(datetime.fromisoformat(segments[-1]['end_time_utc']), CUTOVER + timedelta(seconds=400))
            for previous, current in zip(segments, segments[1:]):
                self.assertEqual(previous['end_time_utc'], current['start_time_utc'])
        island = self.state(rows, 'example-islands', -500)
        self.assertEqual(datetime.fromisoformat(island['start_time_utc']), CUTOVER - timedelta(seconds=900))
        self.assertEqual(datetime.fromisoformat(island['end_time_utc']), CUTOVER - timedelta(seconds=100))
        self.assertEqual(self.state(rows, 'example-islands', -90)['state'], 'unknown')
        self.assertEqual(self.state(rows, 'example-slow', -999)['state'], 'online')
        self.assertTrue(all(row['state'] == 'unknown' for row in rows if row['physical_device_id'] in ('example-cache', 'example-unseen')))

    def test_shared_parent_identity_requires_crc_and_driver_for_child(self):
        rows = self.rows()
        self.assertEqual(self.state(rows, 'example-host', -600)['state'], 'online')
        self.assertEqual(self.state(rows, 'example-sensor', -600)['state'], 'unknown')
        self.assertEqual(self.state(rows, 'example-sensor', -300)['state'], 'online')
        self.assertEqual(self.state(rows, 'example-sensor', -175)['state'], 'unknown')
        proof = self.state(rows, 'example-sensor', -100)
        self.assertEqual(proof['basis'], '历史上报推断')
        self.assertEqual(datetime.fromisoformat(proof['history_receive_time_utc']), CUTOVER + timedelta(seconds=100))
        self.assertTrue(all(proof[key] is None for key in ('boot_id', 'session_id', 'reporter_id', 'observer_session_id', 'last_heartbeat_time_utc', 'last_observed_time_utc')))

    def test_clock_boundaries_stale_legacy_and_cached_proofs_are_filtered(self):
        evidence = json.loads(self.sql("SELECT json_agg(read_time_utc ORDER BY read_time_utc) FROM iot.home_presence_history_evidence WHERE physical_device_id='example-clock';", role='example_grafana'))
        self.assertEqual([datetime.fromisoformat(value) for value in evidence], [CUTOVER - timedelta(seconds=600), CUTOVER - timedelta(seconds=200)])
        self.assertEqual(self.state(self.rows(), 'example-clock', -250)['state'], 'unknown')

    def test_late_legacy_proofs_never_fill_new_observer_gap_and_cutover_is_exact(self):
        rows = self.rows()
        self.assertEqual(self.state(rows, 'example-host', 0)['state'], 'unknown')
        self.assertEqual(self.state(rows, 'example-host', 10)['state'], 'online')
        self.assertEqual(self.state(rows, 'example-host', 119)['state'], 'online')
        self.assertEqual(self.state(rows, 'example-host', 120)['state'], 'unknown')
        self.assertEqual(self.state(rows, 'example-host', 200)['state'], 'unknown')
        self.assertTrue(all(row['basis'] != '历史上报推断' for row in rows if datetime.fromisoformat(row['start_time_utc']) >= CUTOVER))
        self.assertTrue(all(row['state'] != 'offline' for row in rows if datetime.fromisoformat(row['end_time_utc']) <= CUTOVER))
        clipped = self.rows(-850, -650)
        self.assertEqual(self.state(clipped, 'example-islands', -700)['history_read_time_utc'], at(-700))

    def test_cloud48h_has_unknown_prefix_and_fixed_cutover_after_new_events_deleted(self):
        local = self.rows(-7 * 86400, 400)
        cloud = self.rows(-7 * 86400, 400, 'history_cloud')
        old = -6 * 86400 + 150
        self.assertEqual(self.state(local, 'example-host', old)['state'], 'online')
        self.assertEqual(self.state(cloud, 'example-host', old)['state'], 'unknown')
        self.assertEqual(self.state(cloud, 'example-host', -100)['state'], 'online')
        self.assertEqual(self.state(cloud, 'example-host', 10)['state'], 'unknown')
        self.assertEqual(self.sql('SELECT cutover_utc FROM iot.home_presence_history_policy;', 'history_cloud', 'example_grafana'), '2026-11-08 00:00:00+00')

    def test_restricted_reader_and_public_have_no_base_or_private_source_access(self):
        for role, query in [('example_grafana', 'SELECT * FROM iot.telemetry;'), ('example_grafana', 'SELECT * FROM iot.home_presence_history_sources;'),
                            ('example_outsider', "SELECT * FROM iot.home_presence_display_timeline(now()-interval '1 hour',now());")]:
            with self.assertRaisesRegex(RuntimeError, 'permission denied'):
                self.sql(query, role=role)

    def test_unknown_period_or_cached_source_cannot_be_enabled_as_historical_proof(self):
        original = self.sql("SELECT pg_get_viewdef('iot.home_presence_history_sources'::regclass,true);")
        try:
            self.sql('CREATE OR REPLACE VIEW iot.home_presence_history_sources WITH(security_barrier=true,security_invoker=false) AS '
                     + original.rstrip().rstrip(';') + " UNION ALL SELECT 'example-cache','example-home','example-cache-gateway','example-cache-telemetry','iot-telemetry',NULL::integer,NULL::text,NULL::text;")
            with self.assertRaisesRegex(RuntimeError, 'known TTL'):
                self.sql("SET one_min_house.grafana_role='example_grafana';" + (ROOT / 'ops/grafana/presence-history-reader.sql').read_text(encoding='utf-8'))
        finally:
            self.sql('CREATE OR REPLACE VIEW iot.home_presence_history_sources WITH(security_barrier=true,security_invoker=false) AS ' + original)

    def test_history_only_range_also_rejects_duplicate_physical_registry_ids(self):
        original = self.sql("SELECT pg_get_viewdef('iot.home_presence_registry'::regclass,true);")
        body = original.rstrip().rstrip(';')
        try:
            self.sql('CREATE OR REPLACE VIEW iot.home_presence_registry WITH(security_barrier=true,security_invoker=false) AS '
                     + body + ' UNION ALL SELECT * FROM(' + body + ")duplicate WHERE physical_device_id='example-host';")
            with self.assertRaisesRegex(RuntimeError, 'unique and bounded'):
                self.rows(-1000, -1)
        finally:
            self.sql('CREATE OR REPLACE VIEW iot.home_presence_registry WITH(security_barrier=true,security_invoker=false) AS ' + original)

    @unittest.skipUnless(os.environ.get('PRESENCE_HISTORY_SCALE') == '1', 'Set PRESENCE_HISTORY_SCALE=1 for the 20-device seven-day budget')
    def test_scale20_seven_days_stays_under_five_seconds_without_temperature_expansion(self):
        self.install('history_scale', scale=True)
        self.sql("INSERT INTO iot.telemetry SELECT md5('scale-'||n||'-'||s)::uuid,'example-home','scale-gateway-'||n,'scale-telemetry-'||n,'iot-telemetry','ok','direct_read',"
                 + "TIMESTAMPTZ '2026-11-01T00:00:00Z'+make_interval(secs=>s*60),TIMESTAMPTZ '2026-11-01T00:00:01Z'+make_interval(secs=>s*60),'{}'::jsonb FROM generate_series(0,19)n CROSS JOIN generate_series(0,10079)s;ANALYZE iot.telemetry;", 'history_scale')
        plan = json.loads(self.sql("SET statement_timeout='15s';EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT count(*) FROM iot.home_presence_display_timeline('2026-11-01T00:00:00Z','2026-11-08T00:00:00Z');", 'history_scale', 'example_grafana'))[0]
        self.assertEqual(plan['Plan']['Plans'][0]['Actual Rows'], 20)
        self.assertLess(plan['Execution Time'], 5000)
        print(json.dumps({'historical_scale_devices': 20, 'days': 7, 'proofs': 201600, 'execution_ms': plan['Execution Time'],
                          'intervals': 20, 'one_cpu': True, 'memory_mib': 768, 'production_accessed': False}))


if __name__ == '__main__':
    unittest.main()
