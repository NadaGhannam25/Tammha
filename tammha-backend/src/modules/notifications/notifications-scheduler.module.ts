import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { NotificationsModule } from './notifications.module';
import { readNotificationSettings } from './notifications.config';
import { TaskRemindersService } from './reminders/task-reminders.service';
import { EmailOutboxService, errorCode } from './email/email-outbox.service';

export const REMINDER_JOB = 'task-deadline-reminders';
export const EMAIL_JOB = 'email-dispatch';

/**
 * Background jobs (only in the running app; tests and the read-only E2E suite turn
 * them off with REMINDERS_ENABLED=false):
 *  - deadline reminders every REMINDER_INTERVAL_MINUTES (first run 1 minute after start)
 *  - email dispatch every EMAIL_DISPATCH_INTERVAL_SECONDS, only when email is enabled
 * Each job skips a tick while its previous run is still going. Several app instances
 * are safe: reminders are deduplicated by the database and emails are claimed per row.
 */
@Injectable()
export class NotificationsScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger('NotificationsScheduler');

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly reminders: TaskRemindersService,
    private readonly outbox: EmailOutboxService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    const env = (k: string) => this.config.get<string>(k);
    const { settings } = readNotificationSettings({
      REMINDERS_ENABLED: env('REMINDERS_ENABLED'),
      REMINDER_INTERVAL_MINUTES: env('REMINDER_INTERVAL_MINUTES'),
      EMAIL_DISPATCH_INTERVAL_SECONDS: env('EMAIL_DISPATCH_INTERVAL_SECONDS'),
    });
    if (!settings.remindersEnabled) {
      this.logger.log('background jobs disabled (REMINDERS_ENABLED=false)');
      return;
    }

    const runReminders = () =>
      this.reminders
        .run()
        .catch((e) => this.logger.warn(`reminder run failed: ${errorCode(e)}`));
    const first = setTimeout(runReminders, 60_000);
    first.unref?.();
    this.registry.addTimeout(`${REMINDER_JOB}-first`, first);
    const every = setInterval(
      runReminders,
      settings.reminderIntervalMinutes * 60_000,
    );
    every.unref?.();
    this.registry.addInterval(REMINDER_JOB, every);

    if (this.outbox.isEnabled()) {
      const dispatch = setInterval(
        () =>
          this.outbox
            .dispatch()
            .catch((e) =>
              this.logger.warn(`email dispatch failed: ${errorCode(e)}`),
            ),
        settings.emailDispatchIntervalSeconds * 1000,
      );
      dispatch.unref?.();
      this.registry.addInterval(EMAIL_JOB, dispatch);
    }
    this.logger.log(
      `reminders every ${settings.reminderIntervalMinutes} min; ` +
        `email dispatch ${this.outbox.isEnabled() ? `every ${settings.emailDispatchIntervalSeconds} s` : 'off (email disabled)'}`,
    );
  }
}

@Module({
  imports: [ScheduleModule.forRoot(), NotificationsModule],
  providers: [NotificationsScheduler],
})
export class NotificationsSchedulerModule {}
