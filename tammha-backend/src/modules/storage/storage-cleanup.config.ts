export const DEFAULT_STORAGE_CLEANUP_INTERVAL_SECONDS = 300;

/**
 * How often failed Storage deletions are retried in the background
 * (STORAGE_CLEANUP_INTERVAL_SECONDS, 30-86400, default 300). The job only runs in the
 * live app (REMINDERS_ENABLED=false turns all background jobs off).
 */
export function readStorageCleanupSettings(env: Record<string, unknown>): {
  intervalSeconds: number;
  errors: string[];
} {
  const raw =
    typeof env.STORAGE_CLEANUP_INTERVAL_SECONDS === 'string'
      ? env.STORAGE_CLEANUP_INTERVAL_SECONDS.trim()
      : '';
  if (!raw) {
    return {
      intervalSeconds: DEFAULT_STORAGE_CLEANUP_INTERVAL_SECONDS,
      errors: [],
    };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 30 || value > 86400) {
    return {
      intervalSeconds: DEFAULT_STORAGE_CLEANUP_INTERVAL_SECONDS,
      errors: [
        'STORAGE_CLEANUP_INTERVAL_SECONDS must be a whole number between 30 and 86400',
      ],
    };
  }
  return { intervalSeconds: value, errors: [] };
}

/** Wait before the next retry: 1, 2, 4 … minutes, at most 60. */
export function storageRetryDelayMs(attempts: number): number {
  const minutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
  return minutes * 60_000;
}
