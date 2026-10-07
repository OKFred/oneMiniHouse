import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const container = process.env.PG_TEST_CONTAINER;
test('PostgreSQL quality view preserves raw data, NULL gaps, units and read-only permissions', {
  skip: !container && 'Run ops/check.ps1 -Postgres to use a disposable PostgreSQL fixture',
}, () => {
  assert.match(container!, /^one-minihouse-[a-z0-9-]+-test$/);
  const database = 'one_minihouse_quality_test_' + randomUUID().replaceAll('-', '');
  const run = (sql: string, db = database) => execFileSync('docker', [
    'exec', '-i', container!, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db,
  ], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const fixture = readFileSync(new URL('./metric-quality-view.test.sql', import.meta.url), 'utf8');
  const include = /^\\ir \.\.\/\.\.\/ops\/grafana\/010-temperature-view\.example\.sql\r?$/gm;
  assert.equal([...fixture.matchAll(include)].length, 2, 'Both SQL migration runs must be included');
  const view = readFileSync(new URL('../../ops/grafana/010-temperature-view.example.sql', import.meta.url), 'utf8');
  const sql = fixture.replace(include, () => view);
  assert.doesNotMatch(sql, /^\\i(?:r)?\s/m, 'All file includes must resolve without runtime config');
  run(`CREATE DATABASE ${database};`, 'postgres');
  try {
    run(sql);
  } finally {
    run(`DROP DATABASE ${database};`, 'postgres');
  }
});
