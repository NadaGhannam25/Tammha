/**
 * The universities offered for graduation-project handbooks (the student handbook page and
 * the project selection). Exactly these four, in this order — the frontend lists the same keys
 * in handbooks-data.js. A university is matched to its database row by `code` (or, for a row
 * created with another code, by its English or Arabic name). Only the official handbook PDF of
 * these universities is offered; other universities in the database are not listed.
 *
 * Adding the real PDFs needs no code change: create the universities once
 * (`npm run handbook -- setup-universities`), then upload each PDF
 * (`npm run handbook -- upload --university almaarefa --file <pdf> --title "..."`,
 *  or PUT /api/v1/admin/universities/:universityId/handbook).
 */
export const HANDBOOK_UNIVERSITIES = [
  {
    key: 'almaarefa',
    code: 'UM',
    name: { en: 'Almaarefa University', ar: 'جامعة المعرفة' },
  },
  {
    key: 'jouf',
    code: 'JU',
    name: { en: 'Jouf University', ar: 'جامعة الجوف' },
  },
  {
    key: 'pnu',
    code: 'PNU',
    name: {
      en: 'Princess Nourah bint Abdulrahman University',
      ar: 'جامعة الأميرة نورة بنت عبدالرحمن',
    },
  },
  {
    key: 'tabuk',
    code: 'UT',
    name: { en: 'University of Tabuk', ar: 'جامعة تبوك' },
  },
] as const;

export type HandbookUniversityKey =
  (typeof HANDBOOK_UNIVERSITIES)[number]['key'];
export const HANDBOOK_UNIVERSITY_KEYS = HANDBOOK_UNIVERSITIES.map(
  (u) => u.key,
) as HandbookUniversityKey[];

export const handbookUniversity = (key: string) =>
  HANDBOOK_UNIVERSITIES.find((u) => u.key === key) ?? null;

const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/** True when a database university row is the given handbook university. */
export function matchesHandbookUniversity(
  def: (typeof HANDBOOK_UNIVERSITIES)[number],
  row: { code: string; name: string },
): boolean {
  return (
    norm(row.code) === norm(def.code) ||
    norm(row.name) === norm(def.name.en) ||
    norm(row.name) === norm(def.name.ar)
  );
}
