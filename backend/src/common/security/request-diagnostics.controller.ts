import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';
import { SWAGGER_BEARER_NAME } from '@/app.setup';
import { readSecuritySettings } from '@/config/security.config';
import { resolveClientIp } from './client-ip';

const header = (req: Request, name: string) => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v.join(', ') : v) ?? null;
};

/**
 * P15 — deployment check (ADMIN only): which client IP the rate limiter sees.
 * Used once after deploying behind a proxy (Render) to confirm CLIENT_IP_HEADER /
 * TRUST_PROXY: the IP must be the caller's own address, and a value the caller
 * sends itself in that header must NOT be used. Shows only the caller's own request data.
 */
@Controller('admin/diagnostics')
@ApiTags('Admin - Diagnostics')
@ApiBearerAuth(SWAGGER_BEARER_NAME)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.ADMIN])
export class RequestDiagnosticsController {
  constructor(private readonly config: ConfigService) {}

  @Get('request')
  @ApiOperation({
    summary: 'Client IP used for rate limiting (deployment check, ADMIN)',
  })
  @ApiResponse({ status: 200, description: 'IP resolution for this request' })
  @ApiResponse({ status: 403, description: 'ADMIN only' })
  request(@Req() req: Request) {
    const settings = readSecuritySettings({
      NODE_ENV: this.config.get('NODE_ENV'),
      TRUST_PROXY: this.config.get('TRUST_PROXY'),
      CLIENT_IP_HEADER: this.config.get('CLIENT_IP_HEADER'),
    });
    const resolved = resolveClientIp(req, settings.clientIpHeader);
    return {
      rateLimitClientIp: resolved.ip,
      source: resolved.source,
      clientIpHeader: settings.clientIpHeader,
      trustProxy: settings.trustProxy,
      reqIp: req.ip ?? null,
      xForwardedFor: header(req, 'x-forwarded-for'),
      trueClientIp: header(req, 'true-client-ip'),
      cfConnectingIp: header(req, 'cf-connecting-ip'),
    };
  }
}
