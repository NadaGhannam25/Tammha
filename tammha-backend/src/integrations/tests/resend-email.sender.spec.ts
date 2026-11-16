import { ResendEmailSender } from '../email/resend-email.sender';
import { TAMMHA_EMAIL_BANNER_CID } from '@/common/email/email-layout';

const settings = {
  apiKey: 're_test_only_not_real',
  from: 'Tammha <notifications@tammha.site>',
  replyTo: 'support@tammha.site',
  timeoutMs: 1000,
};

describe('Resend email sender (mocked HTTP only)', () => {
  it('sends transactional emails through HTTPS with the correct sender', async () => {
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> =
      [];
    const request: typeof fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'resend-message-test' }), {
        status: 200,
      });
    };
    const sender = new ResendEmailSender(settings, request);
    const result = await sender.send({
      to: 'recipient@example.test',
      subject: 'Invitation',
      text: 'Hello',
      html: '<p>Hello</p>',
      tags: ['PROJECT_INVITE'],
    });
    expect(result).toMatchObject({
      provider: 'resend',
      messageId: 'resend-message-test',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    const options = calls[0].init as RequestInit;
    const body = JSON.parse(String(options.body));
    expect(body).toMatchObject({
      from: settings.from,
      to: ['recipient@example.test'],
      subject: 'Invitation',
      text: 'Hello',
      html: '<p>Hello</p>',
      reply_to: 'support@tammha.site',
      tags: [{ name: 'category', value: 'PROJECT_INVITE' }],
    });
    expect(options.headers).toMatchObject({
      Authorization: `Bearer ${settings.apiKey}`,
    });
  });

  it('attaches the approved email banner as a base64 CID image', async () => {
    let payload: { attachments?: Array<Record<string, string>> } = {};
    const request: typeof fetch = async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'banner-test' }), {
        status: 200,
      });
    };
    await new ResendEmailSender(settings, request).send({
      to: 'recipient@example.test',
      subject: 'Verify',
      text: 'Verify',
      html: `<img src="cid:${TAMMHA_EMAIL_BANNER_CID}">`,
    });
    expect(payload.attachments?.[0]).toMatchObject({
      filename: 'tammha-banner.png',
      content_type: 'image/png',
      content_id: TAMMHA_EMAIL_BANNER_CID,
    });
    expect(
      Buffer.from(payload.attachments?.[0]?.content ?? '', 'base64').length,
    ).toBeGreaterThan(100);
  });

  it.each([
    [401, 'EMAIL_AUTH_FAILED'],
    [422, 'EMAIL_MESSAGE_REJECTED'],
    [429, 'EMAIL_TEMPORARY_FAILURE'],
    [500, 'EMAIL_TEMPORARY_FAILURE'],
  ])(
    'maps HTTP %s to %s without leaking provider details',
    async (status, code) => {
      const request: typeof fetch = async () =>
        new Response('potentially sensitive message', { status });
      const error = await new ResendEmailSender(settings, request)
        .send({ to: 'a@b.test', subject: 's', text: 't' })
        .catch((e) => e);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain('sensitive');
    },
  );

  it('rejects an empty provider receipt', async () => {
    const request: typeof fetch = async () =>
      new Response('{}', { status: 200 });
    await expect(
      new ResendEmailSender(settings, request).send({
        to: 'a@b.test',
        subject: 's',
        text: 't',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_SEND_FAILED' });
  });
});
