import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceConfig } from './config.ts';

// Preserve existing BLE/RTU serialization. miIO uses independent LAN gateways;
// a BLE timeout must not postpone it. Subdevices of one miIO gateway stay serial.
export function collectionGroups(devices: DeviceConfig[]): DeviceConfig[][] {
  const groups = new Map<string, DeviceConfig[]>();
  for (const device of devices) {
    const key = device.driver === 'xiaomi-gateway-v3-temperature' ? `miio:${device.gatewayDeviceId}`
      : device.driver === 'linux-temperature-ssh' ? `temperature:${device.host}:${device.port}` : 'existing-bus';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(device);
  }
  return [...groups.values()];
}

export async function runSchedule(devices: DeviceConfig[], collect: (device: DeviceConfig) => Promise<void>,
  progress: () => void, signal: AbortSignal, tickMs = 250): Promise<void> {
  const next = new Map(devices.map(d => [d.id, 0]));
  while (!signal.aborted) {
    progress();
    for (const device of devices) {
      if (signal.aborted || next.get(device.id)! > performance.now()) continue;
      const started = performance.now();
      await collect(device);
      progress();
      // Schedule against a monotonic clock; NTP adjustments do not change cadence.
      next.set(device.id, Math.max(started + device.intervalSeconds * 1000, performance.now() + tickMs));
      if (device.driver === 'chint-ddsu666-rtu-tcp' || device.driver === 'modbus-light-u32-rtu-tcp') {
        try { await sleep(1000, undefined, { signal }); } catch { return; }
      }
    }
    try { await sleep(tickMs, undefined, { signal }); } catch { return; }
  }
}
