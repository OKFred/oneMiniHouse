import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';

const require = createRequire(import.meta.url);
const dbusRequire = createRequire(require.resolve('dbus-next'));
const { Parser, Builder } = dbusRequire('xml2js');
const ProxyObject = require('dbus-next/lib/client/proxy-object.js');
const dbus = require('dbus-next');

test('D-Bus XML dependency preserves special element names without changing object prototypes', async () => {
  const parsed = await new Parser().parseStringPromise(
    '<node><__proto__><polluted>true</polluted></__proto__></node>',
  );
  assert.equal(Object.getPrototypeOf(parsed.node), Object.prototype);
  assert.equal(Object.hasOwn(parsed.node, '__proto__'), true);
  assert.equal(parsed.node.polluted, undefined);
  assert.equal(parsed.node.constructor, Object);
});

test('D-Bus introspection still builds and parses BlueZ methods, properties, signals and child paths', async () => {
  const xml = new Builder({ headless: true }).buildObject({ node: {
    node: [{ $: { name: 'service0001' } }],
    interface: [{ $: { name: 'org.bluez.GattCharacteristic1' },
      property: [{ $: { name: 'Value', type: 'ay', access: 'read' } }],
      method: [{ $: { name: 'ReadValue' }, arg: [
        { $: { type: 'a{sv}', direction: 'in' } }, { $: { type: 'ay', direction: 'out' } },
      ] }],
      signal: [{ $: { name: 'Changed' }, arg: [{ $: { type: 'ay' } }] }],
    }],
  } });
  const calls: any[] = [];
  const bus = Object.assign(new EventEmitter(), {
    _nameOwners: {}, _signals: new EventEmitter(),
    call: async (message: any) => {
      calls.push(message);
      return { body: message.member === 'GetNameOwner' ? [':1.1'] : [Buffer.from([1, 2, 3])] };
    },
  });
  const object = new ProxyObject(bus, 'org.bluez', '/org/bluez/hci0');
  await object._init(xml);
  assert.deepEqual(object.nodes, ['/org/bluez/hci0/service0001']);
  const characteristic = object.getInterface('org.bluez.GattCharacteristic1');
  assert.deepEqual(characteristic.$properties, [{ name: 'Value', type: 'ay', access: 'read' }]);
  assert.deepEqual(characteristic.$signals, [{ name: 'Changed', signature: 'ay' }]);
  assert.deepEqual(await characteristic.ReadValue({}), Buffer.from([1, 2, 3]));
  assert.equal(calls.at(-1).signature, 'a{sv}');
  assert.equal(calls.at(-1).interface, 'org.bluez.GattCharacteristic1');
  await assert.rejects(new ProxyObject(bus, 'org.bluez', '/')._init('<node>'), /Unclosed/);
  // Requiring the selected backend must not need native builds or patch-package.
  assert.equal(typeof require('@stoprocent/noble/lib/dbus/bindings.js'), 'function');
});

test('private D-Bus daemon round-trips introspection, byte arrays, variants and signals', {
  skip: !process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_TEST_REQUIRED
    && 'Run under dbus-run-session (mandatory in CI and the gateway Docker build)',
  timeout: 10_000,
}, async () => {
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, 'A private test session bus is required');
  const service = dbus.sessionBus();
  const client = dbus.sessionBus();
  const { Interface } = dbus.interface;
  class Fixture extends Interface {
    constructor() { super('org.example.Telemetry'); }
    Echo(value: unknown) { return value; }
    Changed(value: unknown) { return value; }
  }
  Fixture.configureMembers({
    methods: { Echo: { inSignature: 'a{sv}', outSignature: 'a{sv}' } },
    signals: { Changed: { signature: 'a{sv}' } },
  });
  const fixture = new Fixture();
  try {
    await service.requestName('org.example.MinihouseTest', 0);
    service.export('/org/example/telemetry', fixture);
    const object = await client.getProxyObject('org.example.MinihouseTest', '/org/example/telemetry');
    const proxy = object.getInterface('org.example.Telemetry');
    const values = {
      bytes: new dbus.Variant('ay', Buffer.from([0, 1, 127, 255])),
      powered: new dbus.Variant('b', true),
      counter: new dbus.Variant('t', 123456789012345n),
      temperature: new dbus.Variant('d', -12.5),
    };
    const reply = await proxy.Echo(values);
    assert.deepEqual(reply, values);
    const changed = once(proxy, 'Changed');
    // AddMatch must complete before emitting the fixture signal.
    await client._addMatch("type='signal',interface='org.example.Telemetry'");
    fixture.Changed(values);
    assert.deepEqual((await changed)[0], values);
    proxy.removeAllListeners('Changed');
  } finally {
    client.disconnect();
    service.disconnect();
  }
});
