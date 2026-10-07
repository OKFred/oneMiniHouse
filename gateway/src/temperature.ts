import { spawn } from 'node:child_process';
import type { TemperatureDeviceConfig } from './config.ts';
import type { DriverReading } from './runner.ts';

export const TEMPERATURE_COMMAND = '/usr/local/libexec/one-minihouse-temperatures';

// Select by stable kernel type/chip label, never by the boot-dependent hwmon index.
export function parseTemperatures(text: string, sensors: TemperatureDeviceConfig['sensors']): Record<string, number> {
  if (Buffer.byteLength(text) > 32768) throw new Error('Temperature response too large');
  const lines = text.trimEnd().split('\n');
  if (lines.shift() !== 'one-minihouse-temperatures-v1') throw new Error('Invalid temperature response');
  const found = new Map<string, number[]>();
  for (const line of lines) {
    const [kind, chip, label, raw, ...extra] = line.split('\t');
    if (extra.length || !['thermal','hwmon'].includes(kind) || !chip || !label || !/^-?\d+$/.test(raw ?? '')) throw new Error('Invalid temperature row');
    const key = `${kind}:${chip}:${label}`, values = found.get(key) ?? [];
    values.push(Number(raw) / 1000); found.set(key, values);
  }
  const metrics: Record<string, number> = {};
  for (const sensor of sensors) {
    const values = found.get(sensor.selector);
    if (!values?.length) throw new Error(`Temperature sensor missing: ${sensor.selector}`);
    if (values.length !== 1) throw new Error(`Ambiguous temperature sensor: ${sensor.selector}`);
    const value = values[0];
    if (!Number.isFinite(value) || value < -50 || value > 150) throw new Error(`Temperature out of range: ${sensor.selector}`);
    metrics[sensor.metric] = value;
  }
  return metrics;
}

export function temperatureSshArgs(device: TemperatureDeviceConfig): string[] {
  return ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${device.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UpdateHostKeys=no',
    '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=1', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no',
    '-i', device.identityFile, '-p', String(device.port), `${device.username}@${device.host}`, TEMPERATURE_COMMAND];
}

export function readHostTemperature(device: TemperatureDeviceConfig, signal: AbortSignal,
  command = 'ssh', args = temperatureSshArgs(device)): Promise<DriverReading> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'], windowsHide: true });
    let output = '', bytes = 0, failure: Error | undefined;
    const stop = (reason: string) => { failure ??= new Error(reason); child.kill('SIGKILL'); };
    const abort = () => stop('Cancelled');
    const timer = setTimeout(() => stop('Temperature read timed out'), device.timeoutSeconds * 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32768) stop('Temperature response too large'); else output += chunk.toString('utf8');
    });
    // Do not log arbitrary remote stderr, key paths, login banners or credentials.
    child.stderr.resume();
    child.once('error', () => { failure ??= new Error('Could not start temperature SSH client'); });
    // Resolve only after the SSH process has exited, including cancellation/timeout.
    child.once('close', code => {
      cleanup();
      if (failure || code !== 0) return reject(failure ?? new Error('Temperature SSH read failed'));
      try {
        resolve({ utc: new Date().toISOString(), metrics: parseTemperatures(output, device.sensors),
          source: { driver: device.driver, host: device.host, observation_kind: 'direct_read',
            temperature_source: 'linux_sysfs', sensor_selection: device.sensors.map(s => `${s.metric}=${s.selector}`).join(';') } });
      } catch (error) { reject(error); }
    });
  });
}
