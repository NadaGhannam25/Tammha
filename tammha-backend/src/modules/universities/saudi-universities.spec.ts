import {
  catalogFor,
  customUniversityCode,
  findCatalogUniversity,
  isCustomUniversityCode,
  normalizeUniversityName,
  SAUDI_UNIVERSITIES,
  universityNameKey,
} from './saudi-universities';
import { seedSaudiUniversities } from './universities-catalog.seeder';
import { HANDBOOK_UNIVERSITIES } from '@modules/ai-support/library/handbook-universities';

describe('Saudi universities catalogue', () => {
  it('has unique codes and unique English/Arabic names', () => {
    const codes = SAUDI_UNIVERSITIES.map((u) => u.code);
    const en = SAUDI_UNIVERSITIES.map((u) => universityNameKey(u.en));
    const ar = SAUDI_UNIVERSITIES.map((u) => universityNameKey(u.ar));
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(en).size).toBe(en.length);
    expect(new Set(ar).size).toBe(ar.length);
    expect(SAUDI_UNIVERSITIES.some((u) => u.type === 'PUBLIC')).toBe(true);
    expect(SAUDI_UNIVERSITIES.some((u) => u.type === 'PRIVATE')).toBe(true);
  });

  it('keeps the four handbook universities with their codes and English names', () => {
    for (const h of HANDBOOK_UNIVERSITIES) {
      const u = SAUDI_UNIVERSITIES.find((x) => x.code === h.code);
      expect(u?.en).toBe(h.name.en);
    }
  });

  it('matches typed names in either language and spelling', () => {
    expect(findCatalogUniversity('  king saud   UNIVERSITY ')?.code).toBe('KSU');
    expect(findCatalogUniversity('جامعة الاميرة نوره بنت عبدالرحمن')?.code).toBe('PNU');
    expect(findCatalogUniversity('Unknown Institute of Testing')).toBeNull();
    expect(catalogFor({ code: 'um', name: 'x' })?.ar).toBe('جامعة المعرفة');
  });

  it('gives one stable custom code per typed university', () => {
    const a = customUniversityCode('Example  College of Science');
    expect(a).toBe(customUniversityCode('example college of science'));
    expect(a).not.toBe(customUniversityCode('Another College'));
    expect(isCustomUniversityCode(a)).toBe(true);
    expect(isCustomUniversityCode('KSU')).toBe(false);
    expect(normalizeUniversityName('  A   B ')).toBe('A B');
  });

  it('seeds only missing universities and never changes existing ones', async () => {
    const rows = [
      { id: '1', code: 'UM', name: 'Almaarefa University' },
      { id: '2', code: customUniversityCode('King Saud University'), name: 'King Saud University' },
    ];
    const created: Record<string, unknown>[] = [];
    const updated: { id: string; code: string }[] = [];
    const store = {
      university: {
        findMany: async () => rows,
        create: async ({ data }: { data: Record<string, unknown> }) => created.push(data),
        update: async ({ where, data }: { where: { id: string }; data: { code: string } }) =>
          updated.push({ id: where.id, code: data.code }),
      },
    };
    const result = await seedSaudiUniversities(store);
    expect(result.linked).toBe(1);
    expect(updated).toEqual([{ id: '2', code: 'KSU' }]);
    expect(result.created).toBe(SAUDI_UNIVERSITIES.length - 2);
    expect(created.some((d) => d.code === 'UM')).toBe(false);
  });
});
