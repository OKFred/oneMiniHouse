import test from 'node:test';
import assert from 'node:assert/strict';
import { PresenceSession, encodePresence } from '../src/presence.ts';

const identity = { site_id: 'example-site', gateway_id: 'example-gateway', device_id: 'gateway', reporter_id: 'example-client' };
test('birth/will share one connection, reconnect rotates session and will has no false emission time', () => {
  const p = new PresenceSession(identity);
  const will = p.begin(), birth = p.message('online', true, 'connected');
  assert.equal(will.session_id, birth.session_id);
  assert.equal(will.sequence, null); assert.equal(will.source_time_utc, null); assert.equal(will.uptime_ms, null);
  assert.equal(birth.sequence, 1);
  assert.equal(p.message('heartbeat', true, 'heartbeat').sequence, 2);
  assert.notEqual(p.begin().session_id, birth.session_id);
  assert.ok(Buffer.byteLength(JSON.stringify(birth)) < 1024);
  assert.throws(() => encodePresence({ devices: 'x'.repeat(4096) }), /too large/);
  assert.throws(() => encodePresence({ devices: '温'.repeat(1400) }), /too large/);
});
test('cached gateway state is unknown, three direct failures are bounded and a new read restores readability', () => {
  const p = new PresenceSession(identity); p.begin();
  const cached = p.observation('room-sensor', null)!;
  assert.equal(cached.online, null); assert.equal(cached.reason, 'upstream_unknown');
  assert.equal(p.observation('meter', false), null);
  assert.equal(p.observation('meter', false), null);
  assert.equal(p.observation('meter', false)!.online, false);
  const read = p.observation('meter', true, '2026-11-01T00:00:00.000Z')!;
  assert.equal(read.source_time_utc, '2026-11-01T00:00:00.000Z'); assert.equal(read.reason, 'read_ok');
  assert.equal(p.observation('meter', false), null);
  assert.equal(p.message('heartbeat', true, 'heartbeat').online, true);
});
