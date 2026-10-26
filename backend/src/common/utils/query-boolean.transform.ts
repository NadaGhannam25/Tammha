import { Transform } from 'class-transformer';

/**
 * Parses "true"/"false" query strings strictly.
 * (With implicit conversion, Boolean("false") would otherwise become true.)
 * Anything else is left as-is so @IsBoolean() reports it.
 */
export const QueryBoolean = () =>
  Transform(({ obj, key }) => {
    const raw = obj[key];
    if (raw === true || raw === 'true' || raw === '1') return true;
    if (raw === false || raw === 'false' || raw === '0') return false;
    return raw;
  });
