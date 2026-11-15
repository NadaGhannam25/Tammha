/**
 * REAL SMTP smoke test:  npm run email:smoke -- --to you@example.com
 *
 * Uses EMAIL_ENABLED / SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASSWORD /
 * EMAIL_FROM (/ EMAIL_REPLY_TO) from the project's .env and the same SmtpEmailSender as the API.
 *
 * 1. connects and logs in to the SMTP server (no e-mail sent)
 * 2. with --to, sends ONE test e-mail from EMAIL_FROM (e.g. "Tammha <support@tammha.site>")
 *
 * Never prints the SMTP password. Exit codes: 0 = passed, 1 = failed, 2 = NOT RUN.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import { readIntegrationsConfig } from '../src/integrations/integrations.config';
import {
  createSmtpTransport,
  SmtpEmailSender,
} from '../src/integrations/email/smtp-email.sender';

loadEnv({ path: resolve(__dirname, '..', '.env') });

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const { config, errors } = readIntegrationsConfig(process.env);
  const email = config.email;
  if (errors.length > 0) {
    console.error(`✖ Configuration problems:\n  - ${errors.join('\n  - ')}`);
    process.exit(1);
  }
  if (!email.enabled) {
    console.log(
      'NOT RUN: EMAIL_ENABLED is not true. Set EMAIL_ENABLED, SMTP_HOST, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM in .env.',
    );
    process.exit(2);
  }
  const sender = new SmtpEmailSender(email, createSmtpTransport(email));
  console.log(
    `SMTP ${email.host}:${email.port} (${email.secure ? 'TLS' : 'STARTTLS'}) as ${email.user}, from ${email.from}`,
  );
  try {
    await sender.verify();
    console.log('✔ connection and login OK');
    const to = arg('to');
    if (!to) {
      console.log('  (add --to you@example.com to send one test e-mail)');
      return;
    }
    const sent = await sender.send({
      to,
      subject: 'Tammha: e-mail delivery test',
      text:
        'This is a test e-mail from the Tammha backend (npm run email:smoke).\n\n' +
        'If you received it, verification, password reset and notification e-mails can be delivered.',
      tags: ['smoke-test'],
    });
    console.log(
      `✔ sent (message id ${sent.messageId ?? 'n/a'}) — check the inbox of ${to}`,
    );
  } catch (error) {
    console.error(
      `✖ ${(error as { code?: string }).code ?? 'EMAIL_SEND_FAILED'}`,
    );
    process.exitCode = 1;
  } finally {
    sender.close();
  }
}

void main();
