import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IntegrationsConfig,
  readIntegrationsConfig,
} from './integrations.config';

const KEYS = [
  'LIVEKIT_ENABLED',
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_TOKEN_TTL_SECONDS',
  'AI_ENABLED',
  'AI_PROVIDER',
  'AI_REQUEST_TIMEOUT_MS',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'EMAIL_ENABLED',
  'EMAIL_PROVIDER',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_TIMEOUT_MS',
  'EMAIL_FROM',
  'EMAIL_REPLY_TO',
] as const;

export type IntegrationState = 'DISABLED' | 'CONFIGURED';

/**
 * Typed, already-validated integration settings (validation runs at startup in
 * env.validation.ts, so an enabled integration here always has its variables).
 * Secrets stay inside this service and the adapters; they are never logged.
 */
@Injectable()
export class IntegrationsConfigService implements OnModuleInit {
  private readonly logger = new Logger('Integrations');
  readonly config: IntegrationsConfig;

  constructor(configService: ConfigService) {
    const env: Record<string, unknown> = {};
    for (const key of KEYS) env[key] = configService.get<string>(key);
    this.config = readIntegrationsConfig(env).config;
  }

  get livekit() {
    return this.config.livekit;
  }
  get ai() {
    return this.config.ai;
  }
  get email() {
    return this.config.email;
  }

  /** Public, secret-free summary (status endpoint and startup log). */
  summary() {
    const { livekit, ai, email } = this.config;
    const state = (enabled: boolean): IntegrationState =>
      enabled ? 'CONFIGURED' : 'DISABLED';
    return {
      livekit: {
        enabled: livekit.enabled,
        state: state(livekit.enabled),
        provider: livekit.enabled ? ('livekit' as const) : null,
      },
      ai: {
        enabled: ai.enabled,
        state: state(ai.enabled),
        provider: ai.enabled ? ai.provider : null,
        model: ai.enabled ? ai.model : null,
      },
      email: {
        enabled: email.enabled,
        state: state(email.enabled),
        provider: email.enabled ? email.provider : null,
        // the sender address is public (it appears on every e-mail)
        from: email.enabled ? email.from : null,
      },
    };
  }

  onModuleInit() {
    const s = this.summary();
    this.logger.log(
      `LiveKit: ${s.livekit.state.toLowerCase()} · ` +
        `AI: ${s.ai.enabled ? `${s.ai.provider} (${s.ai.model})` : 'disabled'} · ` +
        `Email: ${s.email.enabled ? `smtp (from ${s.email.from})` : 'disabled (in-app notifications only)'}`,
    );
  }
}
