/**
 * Meeting join window (P12). Optional settings, validated at startup.
 * A participant can get a LiveKit token from MEETING_JOIN_EARLY_MINUTES before the start
 * until MEETING_JOIN_GRACE_MINUTES after the planned end.
 */
export interface MeetingSettings {
  joinEarlyMinutes: number;
  joinGraceMinutes: number;
}

export const MEETING_DEFAULTS: MeetingSettings = {
  joinEarlyMinutes: 15,
  joinGraceMinutes: 30,
};

export const MEETING_LIMITS = {
  MIN_DURATION: 5,
  MAX_DURATION: 480,
  DEFAULT_DURATION: 60,
  MAX_PARTICIPANTS: 50,
} as const;

export function readMeetingSettings(env: Record<string, unknown>): {
  settings: MeetingSettings;
  errors: string[];
} {
  const errors: string[] = [];
  const int = (key: string, min: number, max: number, fallback: number) => {
    const raw = typeof env[key] === 'string' ? (env[key] as string).trim() : '';
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  return {
    settings: {
      joinEarlyMinutes: int(
        'MEETING_JOIN_EARLY_MINUTES',
        0,
        120,
        MEETING_DEFAULTS.joinEarlyMinutes,
      ),
      joinGraceMinutes: int(
        'MEETING_JOIN_GRACE_MINUTES',
        0,
        240,
        MEETING_DEFAULTS.joinGraceMinutes,
      ),
    },
    errors,
  };
}
