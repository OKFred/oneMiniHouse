import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionGroups, runSchedule } from '../src/scheduler.ts';
import type { DeviceConfig } from '../src/config.ts';

test('blocked BLE round cannot delay repeated miIO reads; same gateway remains serial', async () => {
  const ble: DeviceConfig = { id: 'ble', driver: 'yunmu-v5', address: '00:11:22:33:44:55', protocol: { readPayloadHex: 'b0b8b0' }, intervalSeconds: 60, timeoutSeconds: 60 };
  const miio: DeviceConfig = { id: 'temperature', driver: 'xiaomi-gateway-v3-temperature', host: '127.0.0.1', gatewayDeviceId: 123, sid: 'lumi.00000000000001', credentialsFile: 'unused', intervalSeconds: 0.02, timeoutSeconds: 10 };
  const controller = new AbortController(), groups = collectionGroups([ble, miio, { ...miio, id: 'humidity' }]);
  let reads = 0, active = 0, maxActive = 0, bleFinished = false;
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await Promise.all(groups.map(group => runSchedule(group, async device => {
      if (device.driver === 'yunmu-v5') {
        await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
        bleFinished = true; return;
      }
      assert.equal(bleFinished, false); active++; maxActive = Math.max(active, maxActive);
      await new Promise(resolve => setTimeout(resolve, 2)); active--; reads++;
      if (reads === 6) controller.abort();
    }, () => {}, controller.signal, 5)));
    assert.equal(reads, 6); assert.equal(maxActive, 1); assert.equal(bleFinished, true);
  } finally { clearTimeout(timer); controller.abort(); }
});

test('existing Modbus devices share one serial queue and collector failures propagate', async () => {
  const meter: DeviceConfig = { id: 'meter', driver: 'chint-ddsu666-rtu-tcp', host: '127.0.0.1', port: 8899, slaveId: 88, intervalSeconds: 60, timeoutSeconds: 30 };
  const groups = collectionGroups([meter, { ...meter, id: 'second', slaveId: 101 }]);
  assert.equal(groups.length, 1);
  const controller = new AbortController();
  await assert.rejects(runSchedule(groups[0], async () => { throw new Error('disk full'); }, () => {}, controller.signal), /disk full/);
});
