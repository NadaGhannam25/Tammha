import { Transform } from 'class-transformer';
import { normalizeEmail } from './email.util';

/** DTO decorator: trims and lower-cases an email before validation. */
export const NormalizeEmail = () =>
  Transform(({ value }) => normalizeEmail(value));
