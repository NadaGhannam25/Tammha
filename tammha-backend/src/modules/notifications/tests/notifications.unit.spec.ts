import { SchedulerRegistry } from '@nestjs/schedule';
import {
  NOTIFICATION_DEFAULTS,
  readNotificationSettings,
} from '../notifications.config';
import { renderNotificationEmail } from '../email/email-templates';
import { EmailOutboxService, errorCode } from '../email/email-outbox.service';
import {
  EMAIL_JOB,
  NotificationsScheduler,
  REMINDER_JOB,
} from '../notifications-scheduler.module';
import { validateEnv } from '@/config/env.validation';
import { TEST_ENV } from '@/testing/test-env';

describe('Notification settings', () => {
  it('defaults', () => {
    expect(readNotificationSettings({})).toEqual({
      settings: NOTIFICATION_DEFAULTS,
      errors: [],
    });
    expect(NOTIFICATION_DEFAULTS).toMatchObject({
      remindersEnabled: true,
      reminderIntervalMinutes: 60,
      overdueLookbackDays: 7,
      emailMaxAttempts: 3,
    });
  });

  it('bounds and flags are validated at startup', () => {
    const { errors } = readNotificationSettings({
      REMINDERS_ENABLED: 'sometimes',
      REMINDER_INTERVAL_MINUTES: '1',
      EMAIL_MAX_ATTEMPTS: '0',
    });
    expect(errors).toEqual([
      'REMINDERS_ENABLED must be true or false',
      'REMINDER_INTERVAL_MINUTES must be an integer between 5 and 1440',
      'EMAIL_MAX_ATTEMPTS must be an integer between 1 and 10',
    ]);
    expect(() =>
      validateEnv({ ...TEST_ENV, REMINDER_INTERVAL_MINUTES: '2' }),
    ).toThrow(/REMINDER_INTERVAL_MINUTES must be an integer/);
    // the task reminder is always 24 hours before the deadline (no setting)
    expect(readNotificationSettings({}).settings).not.toHaveProperty(
      'taskReminderHoursBefore',
    );
  });
});

describe('Email templates and error codes', () => {
  it('HTML is escaped; text is plain', () => {
    const e = renderNotificationEmail({
      language: 'en',
      title: 'Meeting <scheduled>',
      message: '"<script>alert(1)</script>" & more',
    });
    expect(e.subject).toBe('Tammha | Meeting <scheduled>');
    expect(e.html).toContain(
      '&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot; &amp; more',
    );
    expect(e.html).not.toContain('<script>');
    expect(e.text.includes('"<script>alert(1)</script>" & more')).toBe(true);
  });

  it('errorCode keeps a short code and never the provider message', () => {
    const secret = 'password=hunter2 apikey=re_123';
    expect(errorCode(Object.assign(new Error(secret), { code: 'EAUTH' }))).toBe(
      'EAUTH',
    );
    expect(errorCode({ response: { code: 'INTEGRATION_DISABLED' } })).toBe(
      'INTEGRATION_DISABLED',
    );
    expect(errorCode({ status: 429 })).toBe('HTTP_429');
    expect(errorCode(new Error(secret))).toBe('SEND_FAILED');
    expect(errorCode({ code: 'weird code <x>' })).toBe('weirdcodex');
  });
});

describe('NotificationsScheduler', () => {
  const make = (env: Record<string, string>, emailEnabled: boolean) => {
    const registry = new SchedulerRegistry();
    const scheduler = new NotificationsScheduler(
      registry,
      { run: jest.fn().mockResolvedValue({}) } as never,
      {
        isEnabled: () => emailEnabled,
        dispatch: jest.fn(),
      } as unknown as EmailOutboxService,
      { get: (k: string) => env[k] } as never,
    );
    return { registry, scheduler };
  };
  const cleanup = (registry: SchedulerRegistry) => {
    for (const name of registry.getIntervals()) registry.deleteInterval(name);
    for (const name of registry.getTimeouts()) registry.deleteTimeout(name);
  };

  it('REMINDERS_ENABLED=false registers nothing', () => {
    const { registry, scheduler } = make({ REMINDERS_ENABLED: 'false' }, true);
    scheduler.onApplicationBootstrap();
    expect(registry.getIntervals()).toEqual([]);
    expect(registry.getTimeouts()).toEqual([]);
  });

  it('enabled: reminder job; email job only when email is enabled', () => {
    const off = make({ REMINDERS_ENABLED: 'true' }, false);
    off.scheduler.onApplicationBootstrap();
    expect(off.registry.getIntervals()).toEqual([REMINDER_JOB]);
    cleanup(off.registry);

    const on = make(
      { REMINDERS_ENABLED: 'true', EMAIL_DISPATCH_INTERVAL_SECONDS: '30' },
      true,
    );
    on.scheduler.onApplicationBootstrap();
    expect(on.registry.getIntervals().sort()).toEqual(
      [EMAIL_JOB, REMINDER_JOB].sort(),
    );
    cleanup(on.registry);
  });
});
