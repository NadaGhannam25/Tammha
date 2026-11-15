import { Transform } from 'class-transformer';

/** P16: student numbers are 3-20 letters, digits or dashes; stored upper-case. */
export const STUDENT_NUMBER_PATTERN = /^[A-Z0-9-]{3,20}$/;

export function normalizeStudentNumber(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

/** class-transformer decorator: trims and upper-cases a student number. */
export const NormalizeStudentNumber = () =>
  Transform(({ value }) => normalizeStudentNumber(value));
