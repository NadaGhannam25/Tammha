import { Transform } from 'class-transformer';

/** Trims string input before validation (other types pass through). */
export const Trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
