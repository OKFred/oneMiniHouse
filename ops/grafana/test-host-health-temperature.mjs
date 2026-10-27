import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Only a newly-created local Docker Desktop instance, never the runtime database.
const context = 'desktop-linux';
const run = (args, input) => execFileSync('docker', ['--context', context, ...args], {
  input, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
const metadata = JSON.parse(run(['context', 'inspect', context]))[0];
if (!/^npipe:\/\/\/\/\.\/pipe\/dockerDesktopLinuxEngine$/.test(metadata.Endpoints?.docker?.Host || '')
  || run(['info', '--format', '{{.OperatingSystem}}']) !== 'Docker Desktop') {
  throw new Error('Refusing non-local Docker Desktop endpoint');
}
const name = `one-minihouse-host-health-view-${randomUUID().slice(0, 8)}-test`;
let container;
try {
  container = run(['run', '--detach', '--name', name, '--label', 'one-minihouse.disposable-test=host-health-temperature',
    '--network', 'none', '--memory', '256m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17']);
  const state = JSON.parse(run(['inspect', container]))[0];
  if (state.HostConfig.NetworkMode !== 'none' || Object.keys(state.HostConfig.PortBindings || {}).length
    || state.Mounts.some(m => m.Type === 'bind' || m.Type === 'volume')) throw new Error('PostgreSQL isolation guard failed');
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { run(['exec', container, 'pg_isready', '-U', 'postgres']); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL not ready');
  for (const file of ['014-host-health-temperature-view.example.sql', 'host-health-temperature-view.test.sql']) {
    run(['cp', fileURLToPath(new URL(file, import.meta.url)), `${container}:/tmp/${file}`]);
  }
  const output = run(['exec', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres',
    '-f', '/tmp/host-health-temperature-view.test.sql']);
  if (!output.includes('host-health-temperature-view: all assertions passed')) throw new Error('SQL assertions did not complete');
  const reader = run(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'example_grafana', '-d', 'postgres'], `
    SELECT current_user;
    SELECT count(*) FROM iot.home_host_health_temperature_samples;
    SELECT count(*) FROM iot.home_host_health_temperature_samples WHERE temperature_c=0;
    SELECT count(*) FROM iot.home_electricity_samples;
    DO $$ BEGIN
      BEGIN PERFORM 1 FROM iot.telemetry; RAISE EXCEPTION 'Base readable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      BEGIN PERFORM 1 FROM iot.telemetry_observation_compat; RAISE EXCEPTION 'Internal readable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      BEGIN DELETE FROM iot.telemetry; RAISE EXCEPTION 'Base writable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END $$;
  `).split(/\r?\n/);
  if (reader[0] !== 'example_grafana' || reader[1] !== '6' || reader[2] !== '1' || reader[3] !== '3') throw new Error('Actual reader values differ');
  const outsider = run(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'example_outsider', '-d', 'postgres'], `
    DO $$ BEGIN
      BEGIN PERFORM 1 FROM iot.home_host_health_temperature_samples; RAISE EXCEPTION 'Public reader access leaked';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END $$;
  `);
  console.log(JSON.stringify({ ok: true, database: 'PostgreSQL 17', temperatures: 6, actual_reader_login: true,
    real_zero: true, missing_not_zero: true, repeated_migration: true, old_view_metadata_and_values_preserved: true,
    base_and_internal_denied: true, public_denied: true, production_accessed: false }));
} finally {
  if (container) {
    const state = JSON.parse(run(['inspect', container]))[0];
    if (state.Id !== container || state.Name !== `/${name}` || state.Config.Labels?.['one-minihouse.disposable-test'] !== 'host-health-temperature') {
      throw new Error('Refusing cleanup after disposable identity changed');
    }
    run(['rm', '--force', container]);
  }
}
