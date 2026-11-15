/**
 * Settings for reminders and email dispatch (P11). All optional, with safe defaults.
 * One pure function serves startup validation (env.validation.ts) and runtime.
 */
export interface NotificationSettings {
  /** Run the scheduled reminder + email jobs in this process */
  remindersEnabled: boolean;
  /** How often the deadline reminder job runs */
  reminderIntervalMinutes: number;
  /** Overdue tasks older than this are not reported for the first time anymore */
  overdueLookbackDays: number;
  /** How often pending emails are sent */
  emailDispatchIntervalSeconds: number;
  /** Attempts per email before it is marked FAILED */
  emailMaxAttempts: number;
}

export const NOTIFICATION_DEFAULTS: NotificationSettings = {
  remindersEnabled: true,
  reminderIntervalMinutes: 60,
  overdueLookbackDays: 7,
  emailDispatchIntervalSeconds: 60,
  emailMaxAttempts: 3,
};

export function readNotificationSettings(env: Record<string, unknown>): {
  settings: NotificationSettings;
  errors: string[];
} {
  const errors: string[] = [];
  const str = (key: string) =>
    typeof env[key] === 'string' ? (env[key] as string).trim() : '';

  const int = (key: string, min: number, max: number, fallback: number) => {
    const raw = str(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };

  const flag = (key: string, fallback: boolean) => {
    const raw = str(key).toLowerCase();
    if (!raw) return fallback;
    if (['true', '1', 'yes'].includes(raw)) return true;
    if (['false', '0', 'no'].includes(raw)) return false;
    errors.push(`${key} must be true or false`);
    return fallback;
  };

  const d = NOTIFICATION_DEFAULTS;
  return {
    settings: {
      remindersEnabled: flag('REMINDERS_ENABLED', d.remindersEnabled),
      reminderIntervalMinutes: int(
        'REMINDER_INTERVAL_MINUTES',
        5,
        1440,
        d.reminderIntervalMinutes,
      ),
      overdueLookbackDays: int(
        'OVERDUE_LOOKBACK_DAYS',
        1,
        90,
        d.overdueLookbackDays,
      ),
      emailDispatchIntervalSeconds: int(
        'EMAIL_DISPATCH_INTERVAL_SECONDS',
        10,
        3600,
        d.emailDispatchIntervalSeconds,
      ),
      emailMaxAttempts: int('EMAIL_MAX_ATTEMPTS', 1, 10, d.emailMaxAttempts),
    },
    errors,
  };
}
