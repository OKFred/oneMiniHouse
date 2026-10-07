// BLE-only acceptance tool; never publishes or invents a reading.
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { drivers } from './runner.ts';
const c = loadConfig();
const count = Number(process.env.COUNT ?? 1);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('COUNT must be a positive integer');
const abort = new AbortController();
process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
let failures = 0;
for (let i = 0; i < count && !abort.signal.aborted; i++) {
  const started = Date.now();
  for (const d of c.devices) {
    try {
      const row = await drivers[d.driver].read(d, c.adapter, abort.signal);
      console.log(JSON.stringify({ round: i + 1, device_id: d.id, utc: row.utc, ...row.metrics, ...row.source, ...row.diagnostics }));
    } catch (e) { failures++; console.log(JSON.stringify({ round: i + 1, device_id: d.id, error: String(e) })); }
  }
  if (i + 1 < count) await sleep(Math.max(0, c.devices[0].intervalSeconds * 1000 - (Date.now()-started)));
}
process.exitCode = failures ? 1 : 0;
