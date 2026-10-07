import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Opt in with a disposable PostgreSQL container; never uses runtime database credentials.
const container = process.env.PG_TEST_CONTAINER;
test('Grafana keeps filtered view access across observation-time migration and repair', {
  skip: !container && 'Set PG_TEST_CONTAINER to a disposable PostgreSQL container ending in -test',
}, () => {
  assert.match(container!, /^one-minihouse-[a-z0-9-]+-test$/);
  const database = 'one_minihouse_acl_test_' + randomUUID().replaceAll('-', '');
  const run = (sql: string, db = database) => execFileSync('docker', [
    'exec', '-i', container!, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db,
  ], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const migration = (name: string) => readFileSync(new URL('../sql/' + name, import.meta.url), 'utf8');
  const asGrafana = (sql: string) => run('SET ROLE example_grafana; ' + sql);
  const snapshot = `SELECT jsonb_build_object(
    'electricity',(SELECT jsonb_agg(to_jsonb(v) ORDER BY device_id) FROM iot.home_electricity_samples v),
    'light',(SELECT jsonb_agg(to_jsonb(v) ORDER BY device_id) FROM iot.home_environment_samples v),
    'temperature',(SELECT jsonb_agg(to_jsonb(v) ORDER BY device_id) FROM iot.home_temperature_samples v));`;
  const metadata = `SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',c.relowner,
    'options',CASE WHEN c.relname='telemetry_observation_compat' THEN NULL ELSE c.reloptions END,
    'acl',c.relacl,'rls',c.relrowsecurity,'definition',CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,true) END)
    ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='iot';`;
  try {
    run(`CREATE DATABASE ${database};`, 'postgres');
    run(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='example_ingestor') THEN CREATE ROLE example_ingestor; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='example_grafana') THEN CREATE ROLE example_grafana; END IF;
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='example_grafana' AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'Test Grafana role must be unprivileged'; END IF;
    END $$;`);
    for (const file of ['001-telemetry.sql','002-layered-storage.sql','003-derived-views.sql','004-chinese-comments.sql']) {
      if (file === '003-derived-views.sql') assert.throws(() => run(migration(file)), /Set one_min_house.ingestor_role/);
      run("SET one_min_house.ingestor_role='example_ingestor'; " + migration(file));
    }
    run(`INSERT INTO iot.telemetry(message_id,schema_version,site_id,gateway_id,device_id,sample_time_utc,
      receive_time_utc,quality,metrics,payload,payload_sha256,processor_id,processor_version,output_key)
      SELECT gen_random_uuid(),1,site,'example-gateway',device,'2026-09-27T12:00:00Z',
        '2026-09-27T12:00:01Z','ok',metrics,
        CASE WHEN device='temperature-room' THEN '{"source":{"driver":"xiaomi-gateway-v3-temperature"}}'::jsonb ELSE '{}'::jsonb END,
        repeat('0',64),'iot-telemetry','1','telemetry'
      FROM (VALUES
        ('example-home','meter-test','{"energy_kwh":123.4,"power_w":175.9}'::jsonb),
        ('example-home','light-test','{"illuminance_lux":0.062}'::jsonb),
        ('example-home','temperature-room','{"temperature_c":29.18,"humidity_pct":83.32}'::jsonb),
        ('other-site','meter-test','{"energy_kwh":999999}'::jsonb),
        ('example-home','private-device','{"private_value":123}'::jsonb)
      ) fixture(site,device,metrics);
      CREATE VIEW iot.home_electricity_samples WITH(security_barrier=true) AS
        SELECT device_id,sample_time_utc,metrics->'energy_kwh' AS energy_kwh,metrics->'power_w' AS power_w
        FROM iot.telemetry WHERE site_id='example-home' AND device_id='meter-test';
      CREATE VIEW iot.home_environment_samples WITH(security_barrier=true) AS
        SELECT device_id,sample_time_utc,metrics->'illuminance_lux' AS illuminance_lux
        FROM iot.telemetry WHERE site_id='example-home' AND device_id='light-test';
      CREATE VIEW iot.home_temperature_samples WITH(security_barrier=true) AS
        SELECT device_id,sample_time_utc,metrics->'temperature_c' AS temperature_c,metrics->'humidity_pct' AS humidity_pct
        FROM iot.telemetry WHERE site_id='example-home' AND device_id='temperature-room';
      GRANT USAGE ON SCHEMA iot TO example_grafana;
      GRANT SELECT ON iot.home_electricity_samples,iot.home_environment_samples,iot.home_temperature_samples
        TO example_grafana;`);
    const before = JSON.parse(asGrafana(snapshot));
    assert.equal(before.electricity.length, 1);
    assert.equal(before.electricity[0].energy_kwh, 123.4);
    assert.equal(before.light[0].illuminance_lux, 0.062);
    assert.equal(before.temperature[0].temperature_c, 29.18);

    const current = migration('005-observation-times.sql');
    // Reproduce the deployed regression using PostgreSQL's actual nested-view permission checks.
    assert.ok(current.includes('WITH (security_invoker=false)'));
    run(current.replace('WITH (security_invoker=false)', 'WITH (security_invoker=true)'));
    assert.throws(() => asGrafana(snapshot), /permission denied for table telemetry/);
    const beforeRepairMetadata = JSON.parse(run(metadata));
    for (let i=0; i<2; i++) {
      run(migration('006-grafana-compat-permissions.sql'));
      assert.deepEqual(JSON.parse(asGrafana(snapshot)), before);
      assert.deepEqual(JSON.parse(run(metadata)), beforeRepairMetadata);
    }
    // A subsequent normal migration must not reintroduce the fault.
    for (let i=0; i<2; i++) {
      run(current);
      assert.deepEqual(JSON.parse(asGrafana(snapshot)), before);
    }
    for (const relation of ['telemetry','telemetry_observation_compat']) {
      assert.throws(() => asGrafana(`SELECT * FROM iot.${relation} LIMIT 1;`), /permission denied/);
    }
    assert.equal(run(`SELECT bool_and(sample_time_utc IS NULL AND read_time_utc IS NOT NULL) FROM iot.telemetry;`), 't');
    assert.equal(run("SELECT observation_kind FROM iot.telemetry WHERE device_id='temperature-room';"), 'gateway_cached_state');
    // The current temperature view already distinguishes reads from sensor measurements.
    run('DROP VIEW iot.home_temperature_samples;');
    run(readFileSync(new URL('../../ops/grafana/010-temperature-view.example.sql', import.meta.url), 'utf8'));
    run(`INSERT INTO iot.telemetry(message_id,schema_version,site_id,gateway_id,device_id,read_time_utc,
      receive_time_utc,quality,metrics,payload_sha256,processor_id,processor_version,output_key,observation_kind)
      VALUES(gen_random_uuid(),2,'example-home','example-gateway','temperature-room','2026-09-27T12:01:00Z',
        '2026-09-27T12:01:01Z','ok','{"temperature_c":29.2,"humidity_pct":83.3}',repeat('1',64),
        'iot-telemetry','2','telemetry','gateway_cached_state');`);
    const temperatureQuery = 'SELECT jsonb_agg(to_jsonb(v) ORDER BY read_time_utc) FROM iot.home_temperature_samples v;';
    const temperatureBefore = JSON.parse(asGrafana(temperatureQuery));
    assert.ok(temperatureBefore.every((r: {sensor_sample_time_utc: unknown}) => r.sensor_sample_time_utc === null));
    run(current);
    assert.deepEqual(JSON.parse(asGrafana(temperatureQuery)), temperatureBefore);
    // Host temperature has its own gateway/channel scope, without changing existing displays.
    const oldDisplays = asGrafana(snapshot);
    run(`INSERT INTO iot.telemetry(message_id,schema_version,site_id,gateway_id,device_id,read_time_utc,
      receive_time_utc,quality,metrics,payload_sha256,processor_id,processor_version,output_key,observation_kind)
      SELECT gen_random_uuid(),2,site,gateway,'temperature-router','2026-09-27T12:02:00Z',
        '2026-09-27T12:03:03Z','ok',metrics,repeat('2',64),'collectd-temperature','1','temperature','direct_read'
      FROM (VALUES
        ('example-home','example-router','{"cpu_temperature_c":45.625}'::jsonb),
        ('example-home','example-router','{"gpu_temperature_c":46.25}'::jsonb),
        ('other-site','example-router','{"cpu_temperature_c":99}'::jsonb),
        ('example-home','private-gateway','{"cpu_temperature_c":99}'::jsonb),
        ('example-home','example-router','{"private_value":99}'::jsonb)
      ) fixture(site,gateway,metrics);`);
    const hostView = readFileSync(new URL('../../ops/grafana/011-server-temperature-view.example.sql', import.meta.url), 'utf8');
    for(let i=0;i<2;i++) {
      run(hostView); run(current);
      const hosts=JSON.parse(asGrafana('SELECT jsonb_agg(to_jsonb(v) ORDER BY sensor_id) FROM iot.home_server_temperature_samples v;'));
      assert.equal(hosts.length,2);
      assert.deepEqual(hosts.map((r:{temperature_c:number})=>r.temperature_c),[45.625,46.25]);
      assert.ok(hosts.every((r:{sample_time_utc:unknown;read_time_utc:string})=>r.sample_time_utc===null&&r.read_time_utc.startsWith('2026-09-27T12:02:00')));
      assert.equal(asGrafana(snapshot),oldDisplays);
      assert.throws(()=>asGrafana('SELECT * FROM iot.telemetry LIMIT 1;'),/permission denied/);
    }
    // Local MQTT hosts use their own gateway identities, with filtered channel names.
    run(`INSERT INTO iot.telemetry(message_id,schema_version,site_id,gateway_id,device_id,read_time_utc,
      receive_time_utc,quality,metrics,payload_sha256,processor_id,processor_version,output_key,observation_kind)
      SELECT gen_random_uuid(),2,site,gateway,device,'2026-09-27T12:04:00Z',
        '2026-09-27T12:04:01Z','ok',metrics,repeat('3',64),'iot-telemetry','1','telemetry','direct_read'
      FROM (VALUES
        ('example-home','example-host','temperature-host','{"cpu_temperature_c":54,"ddr_temperature_c":55,"fan_rpm":0,"private_value":999}'::jsonb),
        ('example-home','private-gateway','temperature-host','{"cpu_temperature_c":99,"ddr_temperature_c":99}'::jsonb),
        ('other-site','example-host','temperature-host','{"cpu_temperature_c":99,"ddr_temperature_c":99}'::jsonb),
        ('example-home','example-host','private-device','{"cpu_temperature_c":99}'::jsonb),
        ('example-home','example-host','temperature-host-b','{"cpu_temperature_c":99}'::jsonb),
        ('example-home','example-host','temperature-host','{"fan_rpm":999}'::jsonb),
        ('example-home','example-host-b','temperature-host-b','{"cpu_package_temperature_c":52,"cpu_core_4_temperature_c":50,"nvme_a_temperature_c":45.85,"mainboard_channel_2_temperature_c":47,"acpi_zone_1_temperature_c":27.8,"private_value":999}'::jsonb),
        ('example-home','example-host-b','private-device','{"cpu_package_temperature_c":99}'::jsonb),
        ('other-site','example-host-b','temperature-host-b','{"cpu_package_temperature_c":99}'::jsonb)
      ) fixture(site,gateway,device,metrics);`);
    // Keep older readings collected through the shared gateway visible after a host starts publishing locally.
    run(`INSERT INTO iot.telemetry(message_id,schema_version,site_id,gateway_id,device_id,read_time_utc,
      receive_time_utc,quality,metrics,payload_sha256,processor_id,processor_version,output_key,observation_kind)
      VALUES(gen_random_uuid(),2,'example-home','example-gateway','temperature-host','2026-09-27T12:03:00Z',
        '2026-09-27T12:03:01Z','ok','{"cpu_temperature_c":53,"ddr_temperature_c":54}',repeat('4',64),
        'iot-telemetry','1','telemetry','direct_read');`);
    const hostMetadata=run(metadata);
    for(let i=0;i<2;i++) {
      run(hostView); run(current);
      const localHost=JSON.parse(asGrafana("SELECT jsonb_agg(to_jsonb(v) ORDER BY sensor_id) FROM iot.home_server_temperature_samples v WHERE device_id='temperature-host' AND read_time_utc='2026-09-27T12:04:00Z';"));
      assert.equal(localHost.length,2);
      assert.deepEqual(localHost.map((r:{sensor_id:string;sensor_name:string;temperature_c:number})=>[r.sensor_id,r.sensor_name,r.temperature_c]),[
        ['cpu_temperature_c','CPU',54],['ddr_temperature_c','DDR',55],
      ]);
      assert.ok(localHost.every((r:{sample_time_utc:unknown;read_time_utc:string;receive_time_utc:string;observation_kind:string})=>
        r.sample_time_utc===null&&r.read_time_utc.startsWith('2026-09-27T12:04:00')&&
        r.receive_time_utc.startsWith('2026-09-27T12:04:01')&&r.observation_kind==='direct_read'));
      assert.deepEqual(JSON.parse(asGrafana("SELECT jsonb_agg(temperature_c ORDER BY sensor_id) FROM iot.home_server_temperature_samples WHERE device_id='temperature-host' AND read_time_utc='2026-09-27T12:03:00Z';")),[53,54]);
      assert.equal(asGrafana('SELECT count(*) FROM iot.home_server_temperature_samples;'),'11');
      const hosts=JSON.parse(asGrafana("SELECT jsonb_agg(to_jsonb(v) ORDER BY sensor_id) FROM iot.home_server_temperature_samples v WHERE device_id='temperature-host-b';"));
      assert.equal(hosts.length,5);
      assert.deepEqual(hosts.map((r:{sensor_name:string})=>r.sensor_name),['ACPI 区域 1','CPU 核心 4','CPU 封装','主板通道 2','NVMe A · 综合']);
      assert.deepEqual(hosts.map((r:{temperature_c:number})=>r.temperature_c),[27.8,50,52,47,45.85]);
      assert.equal(run(metadata),hostMetadata);
      assert.equal(asGrafana(snapshot),oldDisplays);
      for(const relation of ['telemetry','telemetry_observation_compat']) assert.throws(()=>asGrafana(`SELECT * FROM iot.${relation} LIMIT 1;`),/permission denied/);
    }
    run('DROP VIEW iot.home_electricity_samples,iot.home_environment_samples,iot.home_temperature_samples; DROP VIEW iot.telemetry_observation_compat;');
    run(migration('006-grafana-compat-permissions.sql')); // A cloud database without Grafana views is a no-op.
  } finally {
    run(`DROP DATABASE IF EXISTS ${database};`, 'postgres');
  }
});
