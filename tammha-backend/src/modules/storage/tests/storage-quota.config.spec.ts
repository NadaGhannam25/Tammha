import {
  BYTES_PER_GB,
  readStorageQuotaSettings,
} from '../storage-quota.config';
import { storageStatus } from '../storage-quota.service';

describe('readStorageQuotaSettings', () => {
  it('defaults to 10 GB (10 × 1024³ bytes) when unset or blank', () => {
    expect(readStorageQuotaSettings({})).toEqual({
      studentQuotaBytes: 10 * BYTES_PER_GB,
      errors: [],
    });
    expect(
      readStorageQuotaSettings({ STUDENT_STORAGE_QUOTA_GB: '  ' })
        .studentQuotaBytes,
    ).toBe(10 * BYTES_PER_GB);
  });

  it('reads whole and decimal values', () => {
    expect(
      readStorageQuotaSettings({ STUDENT_STORAGE_QUOTA_GB: '20' })
        .studentQuotaBytes,
    ).toBe(20 * BYTES_PER_GB);
    expect(
      readStorageQuotaSettings({ STUDENT_STORAGE_QUOTA_GB: '0.5' })
        .studentQuotaBytes,
    ).toBe(BYTES_PER_GB / 2);
  });

  it.each(['abc', '0', '-1', '2000', 'NaN'])('rejects %s', (value) => {
    expect(
      readStorageQuotaSettings({ STUDENT_STORAGE_QUOTA_GB: value }).errors,
    ).toHaveLength(1);
  });
});

describe('storageStatus', () => {
  const q = 1000;
  it.each([
    [0, 'NORMAL'],
    [799, 'NORMAL'],
    [800, 'WARNING'],
    [949, 'WARNING'],
    [950, 'CRITICAL'],
    [999, 'CRITICAL'],
    [1000, 'FULL'],
    [1200, 'FULL'],
  ])('%d of 1000 bytes is %s', (used, status) => {
    expect(storageStatus(used, q)).toBe(status);
  });

  it('no quota → NOT_LIMITED', () => {
    expect(storageStatus(5 * BYTES_PER_GB, null)).toBe('NOT_LIMITED');
  });
});
