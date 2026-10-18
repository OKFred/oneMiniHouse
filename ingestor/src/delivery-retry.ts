import { RawArchiveError } from './cloud.ts';
import type { DeliveryTarget } from './queue.ts';

/** Target-level delay: rotating through queued records must not bypass quota backoff. */
export function deliveryRetryDelay(target: DeliveryTarget, error: unknown): number {
  if (target !== 'd1' || !(error instanceof RawArchiveError)
    || !['D1_DAILY_READ_LIMIT','D1_DAILY_WRITE_LIMIT','D1_DATABASE_SIZE_LIMIT','D1_ACCOUNT_STORAGE_LIMIT'].includes(error.code)) return 250;
  // Probe at most once per hour during a known limit, allowing an upgrade or
  // recovered capacity to take effect early. The next UTC reset may be sooner.
  return Math.min(error.retryAfterMs ?? 3600000, 3600000);
}
