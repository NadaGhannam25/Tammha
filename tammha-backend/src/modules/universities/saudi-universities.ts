import { createHash } from 'crypto';

/**
 * Universities in Saudi Arabia offered at registration (students and academic supervisors),
 * with their English and Arabic names. The registration list shows the name in the language
 * of the interface. A university that is not listed is typed by the user ("Other") and stored
 * once per normalised name (code CUSTOM-…), so everyone who types the same university shares it
 * and the same-university rules keep working.
 *
 * Rows are created at start-up in production (UniversitiesCatalogSeeder): only missing ones are
 * added, existing rows (including the four handbook universities UM, JU, PNU, UT and their
 * e-mail domains) are never changed. A listed university without e-mail domains accepts any
 * non-personal address, which must still be verified.
 */
export type UniversityType = 'PUBLIC' | 'PRIVATE';

export interface CatalogUniversity {
  code: string;
  en: string;
  ar: string;
  type: UniversityType;
  city: string;
}

const pub = (code: string, en: string, ar: string, city: string): CatalogUniversity => ({
  code,
  en,
  ar,
  type: 'PUBLIC',
  city,
});
const priv = (code: string, en: string, ar: string, city: string): CatalogUniversity => ({
  code,
  en,
  ar,
  type: 'PRIVATE',
  city,
});

export const SAUDI_UNIVERSITIES: readonly CatalogUniversity[] = [
  // ---- Public universities ----
  pub('KSU', 'King Saud University', 'جامعة الملك سعود', 'Riyadh'),
  pub('KAU', 'King Abdulaziz University', 'جامعة الملك عبدالعزيز', 'Jeddah'),
  pub('KFUPM', 'King Fahd University of Petroleum and Minerals', 'جامعة الملك فهد للبترول والمعادن', 'Dhahran'),
  pub('IMSIU', 'Imam Mohammad Ibn Saud Islamic University', 'جامعة الإمام محمد بن سعود الإسلامية', 'Riyadh'),
  pub('UQU', 'Umm Al-Qura University', 'جامعة أم القرى', 'Makkah'),
  pub('IUM', 'Islamic University of Madinah', 'الجامعة الإسلامية بالمدينة المنورة', 'Madinah'),
  pub('KFU', 'King Faisal University', 'جامعة الملك فيصل', 'Al-Ahsa'),
  pub('KKU', 'King Khalid University', 'جامعة الملك خالد', 'Abha'),
  pub('QU', 'Qassim University', 'جامعة القصيم', 'Qassim'),
  pub('TAIBAHU', 'Taibah University', 'جامعة طيبة', 'Madinah'),
  pub('TU', 'Taif University', 'جامعة الطائف', 'Taif'),
  pub('UOH', "University of Ha'il", 'جامعة حائل', "Ha'il"),
  pub('JAZANU', 'Jazan University', 'جامعة جازان', 'Jazan'),
  pub('JU', 'Jouf University', 'جامعة الجوف', 'Sakaka'),
  pub('BU', 'Al-Baha University', 'جامعة الباحة', 'Al-Baha'),
  pub('UT', 'University of Tabuk', 'جامعة تبوك', 'Tabuk'),
  pub('NU', 'Najran University', 'جامعة نجران', 'Najran'),
  pub('NBU', 'Northern Border University', 'جامعة الحدود الشمالية', 'Arar'),
  pub('PNU', 'Princess Nourah bint Abdulrahman University', 'جامعة الأميرة نورة بنت عبدالرحمن', 'Riyadh'),
  pub('IAU', 'Imam Abdulrahman Bin Faisal University', 'جامعة الإمام عبدالرحمن بن فيصل', 'Dammam'),
  pub('PSAU', 'Prince Sattam bin Abdulaziz University', 'جامعة الأمير سطام بن عبدالعزيز', 'Al-Kharj'),
  pub('SHU', 'Shaqra University', 'جامعة شقراء', 'Shaqra'),
  pub('MJU', 'Majmaah University', 'جامعة المجمعة', 'Al-Majmaah'),
  pub('SEU', 'Saudi Electronic University', 'الجامعة السعودية الإلكترونية', 'Riyadh'),
  pub('UJ', 'University of Jeddah', 'جامعة جدة', 'Jeddah'),
  pub('UB', 'University of Bisha', 'جامعة بيشة', 'Bisha'),
  pub('UHB', 'University of Hafr Al Batin', 'جامعة حفر الباطن', 'Hafr Al Batin'),
  pub('KSAU-HS', 'King Saud bin Abdulaziz University for Health Sciences', 'جامعة الملك سعود بن عبدالعزيز للعلوم الصحية', 'Riyadh'),
  pub('KAUST', 'King Abdullah University of Science and Technology', 'جامعة الملك عبدالله للعلوم والتقنية', 'Thuwal'),
  pub('NAUSS', 'Naif Arab University for Security Sciences', 'جامعة نايف العربية للعلوم الأمنية', 'Riyadh'),
  // ---- Private universities ----
  priv('UM', 'Almaarefa University', 'جامعة المعرفة', 'Riyadh'),
  priv('PSU', 'Prince Sultan University', 'جامعة الأمير سلطان', 'Riyadh'),
  priv('ALFAISAL', 'Alfaisal University', 'جامعة الفيصل', 'Riyadh'),
  priv('EFFAT', 'Effat University', 'جامعة عفت', 'Jeddah'),
  priv('DAH', 'Dar Al-Hekma University', 'جامعة دار الحكمة', 'Jeddah'),
  priv('PMU', 'Prince Mohammad Bin Fahd University', 'جامعة الأمير محمد بن فهد', 'Al Khobar'),
  priv('YU', 'Al Yamamah University', 'جامعة اليمامة', 'Riyadh'),
  priv('DAU', 'Dar Al Uloom University', 'جامعة دار العلوم', 'Riyadh'),
  priv('REU', 'Riyadh Elm University', 'جامعة رياض العلم', 'Riyadh'),
  priv('UBT', 'University of Business and Technology', 'جامعة الأعمال والتكنولوجيا', 'Jeddah'),
  priv('AOU', 'Arab Open University', 'الجامعة العربية المفتوحة', 'Riyadh'),
  priv('SRU', 'Sulaiman Al Rajhi University', 'جامعة سليمان الراجحي', 'Al Bukayriyah'),
  priv('UPM', 'University of Prince Mugrin', 'جامعة الأمير مقرن بن عبدالعزيز', 'Madinah'),
  priv('UOM', 'Al-Mustaqbal University', 'جامعة المستقبل', 'Buraydah'),
];

/** Code prefix of universities typed by users ("Other"). */
export const CUSTOM_UNIVERSITY_PREFIX = 'CUSTOM-';

export const isCustomUniversityCode = (code: string) =>
  code.toUpperCase().startsWith(CUSTOM_UNIVERSITY_PREFIX);

/** Display form of a typed name: NFKC, single spaces, trimmed. */
export function normalizeUniversityName(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Comparison key: case, Arabic diacritics/hamza/taa marbuta and punctuation ignored. */
export function universityNameKey(name: string): string {
  return normalizeUniversityName(name)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, 'ا')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0649/g, '\u064A')
    .replace(/[-_'\u2019`.,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The same typed name (in any spelling covered by the key) always gives the same code. */
export function customUniversityCode(name: string): string {
  const hash = createHash('sha1').update(universityNameKey(name)).digest('hex');
  return `${CUSTOM_UNIVERSITY_PREFIX}${hash.slice(0, 12).toUpperCase()}`;
}

/** A listed university whose English or Arabic name matches the typed name. */
export function findCatalogUniversity(name: string): CatalogUniversity | null {
  const key = universityNameKey(name);
  if (!key) return null;
  return (
    SAUDI_UNIVERSITIES.find(
      (u) => universityNameKey(u.en) === key || universityNameKey(u.ar) === key,
    ) ?? null
  );
}

/** Catalogue entry of a database row (by code, else by name). */
export function catalogFor(row: { code: string; name: string }): CatalogUniversity | null {
  const code = row.code.toUpperCase();
  return SAUDI_UNIVERSITIES.find((u) => u.code === code) ?? findCatalogUniversity(row.name);
}
