/** 1 GB = 1024³ bytes (the unit the frontend uses for "7.2 GB of 10 GB"). */
export const BYTES_PER_GB = 1024 ** 3;
export const DEFAULT_STUDENT_STORAGE_QUOTA_GB = 10;

/** Warning thresholds (fraction of the quota) — the frontend never re-implements them. */
export const STORAGE_WARNING_AT = 0.8;
export const STORAGE_CRITICAL_AT = 0.95;

/**
 * The ONE source of the student storage quota: STUDENT_STORAGE_QUOTA_GB (default 10).
 * A maximum allowed usage, not reserved space. Decimals allowed (e.g. 0.5); 0.001-1024.
 */
export function readStorageQuotaSettings(env: Record<string, unknown>): {
  studentQuotaBytes: number;
  errors: string[];
} {
  const raw =
    typeof env.STUDENT_STORAGE_QUOTA_GB === 'string'
      ? env.STUDENT_STORAGE_QUOTA_GB.trim()
      : '';
  if (!raw) {
    return {
      studentQuotaBytes: DEFAULT_STUDENT_STORAGE_QUOTA_GB * BYTES_PER_GB,
      errors: [],
    };
  }
  const gb = Number(raw);
  if (!Number.isFinite(gb) || gb < 0.001 || gb > 1024) {
    return {
      studentQuotaBytes: DEFAULT_STUDENT_STORAGE_QUOTA_GB * BYTES_PER_GB,
      errors: [
        'STUDENT_STORAGE_QUOTA_GB must be a number between 0.001 and 1024',
      ],
    };
  }
  return { studentQuotaBytes: Math.floor(gb * BYTES_PER_GB), errors: [] };
}
