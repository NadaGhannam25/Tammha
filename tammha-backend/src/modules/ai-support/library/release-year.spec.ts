import { releaseYear } from './handbook-library.service';

describe('releaseYear (handbook edition shown to students)', () => {
  it('takes the year written in the version label', () => {
    expect(releaseYear('2024')).toBe(2024);
    expect(releaseYear('2024-2025')).toBe(2024);
    expect(releaseYear('Edition 2023')).toBe(2023);
  });
  it('is null when the label has no year', () => {
    expect(releaseYear('1')).toBeNull();
    expect(releaseYear(null)).toBeNull();
    expect(releaseYear('12024')).toBeNull();
  });
});
