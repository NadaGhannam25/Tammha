import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import {
  readSecuritySettings,
  SecuritySettings,
} from './config/security.config';

export const SWAGGER_BEARER_NAME = 'jwt';

/**
 * Global HTTP configuration shared by main.ts and the integration tests,
 * so tests run with exactly the same prefix, CORS, validation and error format.
 */
const SECURITY_ENV_KEYS = [
  'NODE_ENV',
  'CORS_ORIGINS',
  'FRONTEND_ORIGIN',
  'RATE_LIMIT_ENABLED',
  'RATE_LIMIT_PER_MINUTE',
  'AUTH_RATE_LIMIT_PER_MINUTE',
  'SWAGGER_ENABLED',
  'TRUST_PROXY',
  'CLIENT_IP_HEADER',
  'BCRYPT_ROUNDS',
];

export function getSecuritySettings(app: INestApplication): SecuritySettings {
  const config = app.get(ConfigService);
  const env: Record<string, unknown> = {};
  for (const key of SECURITY_ENV_KEYS) env[key] = config.get(key);
  return readSecuritySettings(env);
}

/** API responses are JSON only: nothing may be loaded, framed or executed from them. */
const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Swagger UI needs its own scripts/styles (served from this API) and inline styles. */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Global HTTP configuration shared by main.ts and the integration tests,
 * so tests run with exactly the same prefix, CORS, headers, validation and error format.
 */
export function configureApp(app: INestApplication): { apiPrefix: string } {
  const config = app.get(ConfigService);
  const apiPrefix = `api/${config.get<string>('API_VERSION', 'v1')}`;
  const security = getSecuritySettings(app);

  app.setGlobalPrefix(apiPrefix);

  // Behind a reverse proxy (Render, Railway, Nginx...) req.ip must be the real client
  // for rate limiting; TRUST_PROXY is a hop count (never "trust everyone").
  const express = app.getHttpAdapter().getInstance() as {
    set?: (key: string, value: unknown) => void;
    disable?: (key: string) => void;
  };
  express.set?.('trust proxy', security.trustProxy);
  express.disable?.('x-powered-by');

  // P14: security headers (helmet). CSP is set per route type below.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      // The API is called cross-origin by the frontend (with CORS)
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity:
        security.nodeEnv === 'production'
          ? { maxAge: 31536000, includeSubDomains: true }
          : false,
    }),
  );
  const docsPath = `/${apiPrefix}/docs`;
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isDocs =
      req.path === docsPath ||
      req.path.startsWith(`${docsPath}/`) ||
      req.path.startsWith(`${docsPath}-json`);
    res.setHeader('Content-Security-Policy', isDocs ? DOCS_CSP : API_CSP);
    if (!isDocs) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // P14: exact origins only (FRONTEND_ORIGIN + CORS_ORIGINS). Auth uses the
  // Authorization header (no cookies), so credentials are not allowed.
  app.enableCors({
    origin: security.corsOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Retry-After', 'Content-Disposition'],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  return { apiPrefix };
}

/** Builds the OpenAPI document (used by main.ts and by tests). */
export function createSwaggerDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Tammha Backend API')
    .setDescription('Graduation Project Management System - REST API')
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Paste the accessToken from /auth/login',
      },
      SWAGGER_BEARER_NAME,
    )
    .addTag('Health', 'Health check')
    .addTag('Universities', 'Universities available for registration')
    .addTag(
      'Auth',
      'Registration, login, tokens, email verification, forgot/reset password',
    )
    .addTag(
      'Projects',
      'Project workspace, details, stages and first-project setup (leader)',
    )
    .addTag(
      'Teams',
      'Teams, members, invite links and direct invitations by student number (leader)',
    )
    .addTag(
      'Supervision Requests',
      'Supervisor requests (sent by the team leader; supervisors accept or reject)',
    )
    .addTag(
      'Users',
      'My profile, onboarding and student search by student number',
    )
    .addTag(
      'Tasks',
      'Project tasks: leader manages and assigns; members update their own status',
    )
    .addTag('Milestones', 'Project milestones with progress')
    .addTag(
      'Documents',
      'Project documents in private Supabase Storage (max 25 MB, versioned, signed URLs)',
    )
    .addTag(
      'Feedback',
      'Supervisor written feedback (projects, documents, tasks) and submission status',
    )
    .addTag(
      'Meetings',
      'Project meetings embedded with LiveKit: schedule, update, cancel, join token',
    )
    .addTag(
      'Notifications',
      'In-app notifications of the current user (list, unread count, mark read)',
    )
    .addTag(
      'Dashboard',
      'Student and supervisor dashboards; deterministic progress and readiness (no AI)',
    )
    .addTag(
      'Integrations',
      'Status of LiveKit, AI and email integrations (no secrets)',
    )
    .addTag(
      'AI Support',
      'Advisory AI guidance (Gemini): project questions, next steps, tasks, milestones, handbook',
    )
    .addTag(
      'AI Conversations',
      'Project-scoped AI side chat: create, list, open and continue conversations',
    )
    .addTag(
      'AI Task Suggestions',
      'Leader-only: apply selected (and edited) AI task suggestions as real tasks',
    )
    .addTag(
      'Project Handbook',
      "The project's handbook (a university's official PDF or the team's own upload), its seven-topic AI summary and AI task extraction",
    )
    .addTag(
      'Admin - Diagnostics',
      'ADMIN: deployment checks (client IP seen by the rate limiter)',
    )
    .addTag(
      'University Handbooks',
      "The four handbook universities (almaarefa, najran, pnu, tabuk) and their official handbook PDF (real file name, or null when not available); any of them can be chosen without changing the user's university",
    )
    .addTag(
      'Reference',
      'Public lists of statuses / categories (database codes and labels) shared with the frontend',
    )
    .addTag(
      'Admin - Supervisors',
      'ADMIN: create supervisor accounts (activation e-mail); supervisors cannot self-register',
    )
    .addTag(
      'Admin - Handbooks',
      'ADMIN: upload, replace or remove the official handbook PDF of a university',
    )
    .build();
  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication, apiPrefix: string) {
  SwaggerModule.setup(`${apiPrefix}/docs`, app, createSwaggerDocument(app), {
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
    },
  });
}
