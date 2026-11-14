/** Decimal bytes: the per-file limit is 100 GB, not 100 GiB or a session cap. */
export const MAX_FILE_BYTES = 100_000_000_000;
export const MAX_BATCH_FILES = 500;

/** Reject fractional, negative, non-numeric and unsafe wire sizes before allocation. */
export function isValidFileSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_FILE_BYTES;
}
