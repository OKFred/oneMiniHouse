import { readFileSync } from 'node:fs';
import { join } from 'node:path';
try {
  const h = JSON.parse(readFileSync(join(process.env.DATA_DIR ?? '/app/data', 'health.json'), 'utf8'));
  if (Date.now() - Date.parse(h.utc) > 20000 || Date.now() - h.scheduler_progress_ms > h.scheduler_deadline_ms) process.exit(1);
} catch { process.exit(1); }
