import { releaseYear } from './handbook-library.service';

describe('releaseYear (handbook edition shown to students)', () => {
  const added = new Date('2026-03-01T00:00:00Z');
  it('takes the year written in the version label', () => {
    expect(releaseYear('2024', added)).toBe(2024);
    expect(releaseYear('2024-2025', added)).toBe(2024);
    expect(releaseYear('Edition 2023', added)).toBe(2023);
  });
  it('falls back to the year the handbook was added', () => {
    expect(releaseYear('1', added)).toBe(2026);
    expect(releaseYear(null, added)).toBe(2026);
    expect(releaseYear('12024', added)).toBe(2026);
  });
});
