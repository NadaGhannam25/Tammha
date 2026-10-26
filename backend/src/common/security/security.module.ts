import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  RATE_LIMIT_WINDOW_MS,
  readSecuritySettings,
} from '@/config/security.config';
import { AppThrottlerGuard } from './app-throttler.guard';
import { STRICT_RATE_LIMIT_KEY } from './rate-limit.decorator';
import { resolveClientIp } from './client-ip';
import { RequestDiagnosticsController } from './request-diagnostics.controller';

/**
 * P14 — per-IP rate limiting for the whole API (in-memory, per instance).
 * - "default": RATE_LIMIT_PER_MINUTE (300) on every route
 * - "strict":  AUTH_RATE_LIMIT_PER_MINUTE (10) only on routes marked @StrictRateLimit()
 * The AI module keeps its own per-user quotas (P13). Behind a proxy set TRUST_PROXY.
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, Reflector],
      useFactory: (config: ConfigService, reflector: Reflector) => {
        const s = readSecuritySettings({
          NODE_ENV: config.get('NODE_ENV'),
          RATE_LIMIT_ENABLED: config.get('RATE_LIMIT_ENABLED'),
          RATE_LIMIT_PER_MINUTE: config.get('RATE_LIMIT_PER_MINUTE'),
          AUTH_RATE_LIMIT_PER_MINUTE: config.get('AUTH_RATE_LIMIT_PER_MINUTE'),
          CLIENT_IP_HEADER: config.get('CLIENT_IP_HEADER'),
        });
        const disabled = () => !s.rateLimitEnabled;
        return {
          // P15: real client IP behind the hosting proxy (see client-ip.ts)
          getTracker: (req: Record<string, unknown>) =>
            resolveClientIp(req, s.clientIpHeader).ip,
          throttlers: [
            {
              name: 'default',
              ttl: RATE_LIMIT_WINDOW_MS,
              limit: s.rateLimitPerMinute,
              skipIf: disabled,
            },
            {
              name: 'strict',
              ttl: RATE_LIMIT_WINDOW_MS,
              limit: s.authRateLimitPerMinute,
              skipIf: (ctx) =>
                disabled() ||
                !reflector.getAllAndOverride<boolean>(STRICT_RATE_LIMIT_KEY, [
                  ctx.getHandler(),
                  ctx.getClass(),
                ]),
            },
          ],
        };
      },
    }),
  ],
  controllers: [RequestDiagnosticsController],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class SecurityModule {}
