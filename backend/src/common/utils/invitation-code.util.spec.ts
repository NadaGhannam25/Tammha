import {
  buildInvitationLink,
  generateInvitationCode,
  INVITATION_CODE_PATTERN,
  normalizeInvitationInput,
} from './invitation-code.util';

describe('invitation-code.util', () => {
  it('generates 8-char codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateInvitationCode();
      expect(code).toMatch(INVITATION_CODE_PATTERN);
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  it('generates varied codes', () => {
    const codes = new Set(Array.from({ length: 1000 }, generateInvitationCode));
    expect(codes.size).toBe(1000);
  });

  it.each([
    ['K7QXM2PA', 'K7QXM2PA'],
    ['k7qxm2pa', 'K7QXM2PA'],
    ['  K7QX-M2PA ', 'K7QXM2PA'],
    ['K7QX M2PA', 'K7QXM2PA'],
    ['https://app.tammha.sa/join/K7QXM2PA', 'K7QXM2PA'],
    ['https://app.tammha.sa/join/k7qx-m2pa/', 'K7QXM2PA'],
    ['https://app.tammha.sa/join?code=K7QXM2PA', 'K7QXM2PA'],
    ['/join/K7QXM2PA', 'K7QXM2PA'],
  ])('normalizes %p', (input, expected) => {
    expect(normalizeInvitationInput(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'ABC',
    'K7QXM2PAX',
    'K7QXM2P0',
    'K7QXM2PI',
    'https://',
    'https://x.y/join/',
    'K7QX_M2PA',
  ])('rejects %p', (input) => {
    expect(normalizeInvitationInput(input)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(normalizeInvitationInput(undefined as unknown as string)).toBeNull();
  });

  it('builds links without double slashes', () => {
    expect(buildInvitationLink('https://app/join/', 'K7QXM2PA')).toBe(
      'https://app/join/K7QXM2PA',
    );
    expect(buildInvitationLink('https://app/join', 'K7QXM2PA')).toBe(
      'https://app/join/K7QXM2PA',
    );
  });
});
