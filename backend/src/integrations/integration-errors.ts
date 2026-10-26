import { ServiceUnavailableException } from '@nestjs/common';

export type IntegrationName = 'livekit' | 'ai' | 'email';

const LABEL: Record<IntegrationName, string> = {
  livekit: 'Embedded meetings (LiveKit)',
  ai: 'AI support',
  email: 'Email notifications',
};

const FLAG: Record<IntegrationName, string> = {
  livekit: 'LIVEKIT_ENABLED',
  ai: 'AI_ENABLED',
  email: 'EMAIL_ENABLED',
};

/** 503 — the integration is switched off in the server configuration. */
export function integrationDisabled(name: IntegrationName) {
  return new ServiceUnavailableException({
    code: 'INTEGRATION_DISABLED',
    integration: name,
    message: `${LABEL[name]} is not enabled on this server (${FLAG[name]})`,
  });
}
