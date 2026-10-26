import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureApp, getSecuritySettings, setupSwagger } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  const config = app.get(ConfigService);
  const port = Number(config.get<string>('PORT', '3000'));
  const nodeEnv = config.get<string>('NODE_ENV', 'development');

  const { apiPrefix } = configureApp(app);
  const security = getSecuritySettings(app);

  // Swagger UI: on outside production; in production only with SWAGGER_ENABLED=true
  if (security.swaggerEnabled) {
    setupSwagger(app, apiPrefix);
  }

  await app.listen(port);

  // Render sets RENDER_EXTERNAL_URL (https://<service>.onrender.com)
  const publicUrl = (
    config.get<string>('PUBLIC_BASE_URL') ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${port}`
  ).replace(/\/+$/, '');
  const base = `${publicUrl}/${apiPrefix}`;
  logger.log(`Environment: ${nodeEnv}`);
  logger.log(`API base:    ${base}`);
  logger.log(`Health:      ${base}/health`);
  logger.log(
    security.swaggerEnabled
      ? `Swagger UI:  ${base}/docs`
      : 'Swagger UI:  disabled',
  );
  logger.log(
    `CORS origins: ${security.corsOrigins.join(', ') || '(none: cross-origin browser calls blocked)'}`,
  );
  for (const warning of security.warnings) logger.warn(warning);
  logger.log(
    `Rate limit:  ${security.rateLimitEnabled ? `${security.rateLimitPerMinute}/min per IP (strict ${security.authRateLimitPerMinute}/min)` : 'disabled'}`,
  );
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  // Message only: the env validator never puts secret values in its messages
  console.error(
    'Failed to start server:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
