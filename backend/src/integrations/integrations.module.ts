import { Global, Module } from '@nestjs/common';
import { IntegrationsConfigService } from './integrations-config.service';
import { IntegrationsController } from './integrations.controller';
import { MEETING_VIDEO_PROVIDER } from './meetings/meeting-video.provider';
import { AI_TEXT_PROVIDER } from './ai/ai.provider';
import { EMAIL_SENDER } from './email/email.sender';
import {
  createAiTextProvider,
  createEmailSender,
  createMeetingVideoProvider,
} from './provider-factories';

/**
 * External integrations: validated configuration + ports (LiveKit, Gemini, e-mail outbox).
 * Feature modules inject the ports by token:
 *   @Inject(MEETING_VIDEO_PROVIDER) video: MeetingVideoProvider
 *   @Inject(AI_TEXT_PROVIDER) ai: AiTextProvider
 *   @Inject(EMAIL_SENDER) email: EmailSender
 * The implementation for each port is chosen in provider-factories.ts.
 */
@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [
    IntegrationsConfigService,
    {
      provide: MEETING_VIDEO_PROVIDER,
      inject: [IntegrationsConfigService],
      useFactory: (c: IntegrationsConfigService) =>
        createMeetingVideoProvider(c.livekit),
    },
    {
      provide: AI_TEXT_PROVIDER,
      inject: [IntegrationsConfigService],
      useFactory: (c: IntegrationsConfigService) => createAiTextProvider(c.ai),
    },
    {
      provide: EMAIL_SENDER,
      inject: [IntegrationsConfigService],
      useFactory: (c: IntegrationsConfigService) => createEmailSender(c.email),
    },
  ],
  exports: [
    IntegrationsConfigService,
    MEETING_VIDEO_PROVIDER,
    AI_TEXT_PROVIDER,
    EMAIL_SENDER,
  ],
})
export class IntegrationsModule {}
