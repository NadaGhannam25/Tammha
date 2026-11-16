import { IntegrationsConfig } from './integrations.config';
import { LiveKitMeetingVideoProvider } from './meetings/livekit-meeting-video.provider';
import { GeminiAiTextProvider } from './ai/gemini-ai.provider';
import { integrationDisabled } from './integration-errors';
import {
  MeetingJoinCredentials,
  MeetingVideoProvider,
} from './meetings/meeting-video.provider';
import { AiTextProvider, AiTextResult } from './ai/ai.provider';
import { EmailSendResult, EmailSender } from './email/email.sender';
import { ResendEmailSender } from './email/resend-email.sender';
import {
  createSmtpTransport,
  SmtpEmailSender,
  SmtpSettings,
  SmtpTransport,
} from './email/smtp-email.sender';

/**
 * Implementations of the three ports:
 *  - meetings: LiveKit (local token signing) when LIVEKIT_ENABLED=true
 *  - AI:       Gemini when AI_ENABLED=true
 *  - e-mail:   SMTP or Resend when EMAIL_ENABLED=true; otherwise disabled and the outbox stays idle
 * A disabled integration answers 503 INTEGRATION_DISABLED and never contacts a provider.
 */
export function createMeetingVideoProvider(
  config: IntegrationsConfig['livekit'],
): MeetingVideoProvider {
  if (config.enabled) return new LiveKitMeetingVideoProvider(config);
  return {
    name: 'disabled',
    isEnabled: () => false,
    createJoinCredentials: async (): Promise<MeetingJoinCredentials> => {
      throw integrationDisabled('livekit');
    },
  };
}

export function createAiTextProvider(
  config: IntegrationsConfig['ai'],
): AiTextProvider {
  if (config.enabled) return new GeminiAiTextProvider(config);
  return {
    name: 'disabled',
    model: null,
    isEnabled: () => false,
    generateText: async (): Promise<AiTextResult> => {
      throw integrationDisabled('ai');
    },
  };
}

export function createEmailSender(
  config: IntegrationsConfig['email'],
  transportFactory: (
    settings: SmtpSettings,
  ) => SmtpTransport = createSmtpTransport,
): EmailSender {
  if (config.enabled && config.provider === 'resend')
    return new ResendEmailSender(config);
  if (config.enabled && config.provider === 'smtp')
    return new SmtpEmailSender(config, transportFactory(config));
  return {
    name: 'disabled',
    isEnabled: () => false,
    send: async (): Promise<EmailSendResult> => {
      throw integrationDisabled('email');
    },
  };
}
