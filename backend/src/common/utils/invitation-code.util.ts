import { randomInt } from 'crypto';

/**
 * Invitation codes use an unambiguous alphabet (no I, O, 0, 1)
 * so they are easy to read aloud and type.
 * 32 symbols ^ 8 characters ≈ 1.1 trillion combinations.
 */
export const INVITATION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITATION_CODE_LENGTH = 8;
export const INVITATION_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

/** Generates a cryptographically random invitation code. */
export function generateInvitationCode(): string {
  let code = '';
  for (let i = 0; i < INVITATION_CODE_LENGTH; i++) {
    code +=
      INVITATION_CODE_ALPHABET[randomInt(INVITATION_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Accepts either a raw code ("ABCD2345", "abcd-2345") or a shareable link
 * ("https://app/join/ABCD2345", "https://app/join?code=ABCD2345").
 * Returns the normalized code, or null if the input is not a well-formed code.
 */
export function normalizeInvitationInput(input: string): string | null {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      raw =
        url.searchParams.get('code') ??
        url.pathname.split('/').filter(Boolean).pop() ??
        '';
    } catch {
      return null;
    }
  } else if (raw.includes('/')) {
    raw = raw.split('/').filter(Boolean).pop() ?? '';
  }

  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return INVITATION_CODE_PATTERN.test(code) ? code : null;
}

/** Builds the shareable link: <baseUrl>/<code> */
export function buildInvitationLink(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${code}`;
}
