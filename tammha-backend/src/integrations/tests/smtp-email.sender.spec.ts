import { createEmailSender } from '../provider-factories';
import {
  createSmtpTransport,
  SmtpEmailSender,
  smtpErrorCode,
} from '../email/smtp-email.sender';
import { FakeSmtpTransport } from '@/testing/fake-smtp-transport';

const settings = {
  host: 'smtp.mail-provider.test',
  port: 587,
  secure: false,
  user: 'support@tammha.site',
  password: 'smtp-secret-value',
  from: 'Tammha <support@tammha.site>',
  replyTo: null,
  timeoutMs: 15000,
};

describe('SMTP e-mail sender', () => {
  it('sends from the project mailbox to the given recipient', async () => {
    const smtp = new FakeSmtpTransport();
    const sender = new SmtpEmailSender(settings, smtp);
    const result = await sender.send({
      to: 'noor@gmail.test',
      subject: 'Tammha: New feedback',
      text: 'Your supervisor left feedback.',
      html: '<p>Your supervisor left feedback.</p>',
      tags: ['FEEDBACK_RECEIVED'],
    });
    expect(smtp.sent).toEqual([
      {
        from: 'Tammha <support@tammha.site>',
        to: 'noor@gmail.test',
        subject: 'Tammha: New feedback',
        text: 'Your supervisor left feedback.',
        html: '<p>Your supervisor left feedback.</p>',
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Tammha-Category': 'FEEDBACK_RECEIVED',
        },
      },
    ]);
    expect(result).toMatchObject({
      provider: 'smtp',
      messageId: '<fake-1@tammha.site>',
    });
    expect(sender.isEnabled()).toBe(true);
  });

  it('attaches the approved Tammha email banner inline when HTML references the CID', async () => {
    const smtp = new FakeSmtpTransport();
    const sender = new SmtpEmailSender(settings, smtp);
    await sender.send({
      to: 'student@example.test',
      subject: 'Verification',
      text: 'Verify',
      html: '<img src="cid:tammha-banner@tammha.site" alt="Tammha">',
    });
    expect(smtp.sent[0].attachments).toEqual([
      expect.objectContaining({
        filename: 'tammha-banner.png',
        cid: 'tammha-banner@tammha.site',
        contentType: 'image/png',
        contentDisposition: 'inline',
      }),
    ]);
  });

  it('uses EMAIL_REPLY_TO when configured', async () => {
    const smtp = new FakeSmtpTransport();
    await new SmtpEmailSender(
      { ...settings, replyTo: 'support@tammha.site' },
      smtp,
    ).send({ to: 'a@b.test', subject: 's', text: 't' });
    expect(smtp.sent[0].replyTo).toBe('support@tammha.site');
  });

  it('maps SMTP failures to short codes and never keeps the provider message', async () => {
    const cases: [object, string][] = [
      [{ code: 'EAUTH', responseCode: 535 }, 'EMAIL_AUTH_FAILED'],
      [{ code: 'ETIMEDOUT' }, 'EMAIL_TIMEOUT'],
      [{ code: 'ECONNECTION' }, 'EMAIL_CONNECTION_FAILED'],
      [{ code: 'EENVELOPE', responseCode: 550 }, 'EMAIL_RECIPIENT_REJECTED'],
      [{ responseCode: 451 }, 'EMAIL_TEMPORARY_FAILURE'],
      [{ code: 'EMESSAGE' }, 'EMAIL_MESSAGE_REJECTED'],
      [{}, 'EMAIL_SEND_FAILED'],
    ];
    for (const [error, code] of cases) {
      const smtp = new FakeSmtpTransport();
      smtp.failNext(error);
      const err = await new SmtpEmailSender(settings, smtp)
        .send({ to: 'a@b.test', subject: 's', text: 't' })
        .catch((e) => e);
      expect(err.code).toBe(code);
      expect(String(err.message)).not.toContain('SMTP-SECRET');
      expect(smtpErrorCode(error)).toBe(code);
    }
  });

  it('a message accepted for nobody is a failure', async () => {
    const sender = new SmtpEmailSender(settings, {
      sendMail: async () => ({ accepted: [], rejected: ['a@b.test'] }),
    });
    await expect(
      sender.send({ to: 'a@b.test', subject: 's', text: 't' }),
    ).rejects.toMatchObject({ code: 'EMAIL_RECIPIENT_REJECTED' });
  });

  it('factory: disabled when EMAIL_ENABLED=false, SMTP sender otherwise', async () => {
    const off = createEmailSender({ enabled: false });
    expect(off.isEnabled()).toBe(false);
    await expect(
      off.send({ to: 'a@b.test', subject: 's', text: 't' }),
    ).rejects.toMatchObject({ response: { code: 'INTEGRATION_DISABLED' } });

    const smtp = new FakeSmtpTransport();
    const factory = jest.fn(() => smtp);
    const on = createEmailSender(
      { enabled: true, provider: 'smtp', ...settings },
      factory,
    );
    expect(on.name).toBe('smtp');
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ host: settings.host }),
    );
  });

  it('real nodemailer transport: TLS required on 587, implicit TLS on 465, pooled', () => {
    const starttls = createSmtpTransport(settings) as unknown as {
      options: Record<string, unknown>;
      close(): void;
    };
    expect(starttls.options).toMatchObject({
      host: 'smtp.mail-provider.test',
      port: 587,
      secure: false,
      requireTLS: true,
      pool: true,
    });
    starttls.close();
    const tls = createSmtpTransport({
      ...settings,
      port: 465,
      secure: true,
    }) as unknown as {
      options: Record<string, unknown>;
      close(): void;
    };
    expect(tls.options).toMatchObject({
      port: 465,
      secure: true,
      requireTLS: false,
    });
    tls.close();
  });
});
