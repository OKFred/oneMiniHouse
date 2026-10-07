import { readFileSync } from 'node:fs';
import { join } from 'node:path';
try {
  const state=JSON.parse(readFileSync(join(process.env.DATA_DIR??'/app/data','health.json'),'utf8'));
  const heartbeat=state.heartbeat_time_utc??state.utc;
  // External service failures are degraded. Only a stalled scheduler is unhealthy.
  if(!Number.isFinite(Date.parse(heartbeat))||Date.now()-Date.parse(heartbeat)>30000)process.exitCode=1;
}catch{process.exitCode=1;}
