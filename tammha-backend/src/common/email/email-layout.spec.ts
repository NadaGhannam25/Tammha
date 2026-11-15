import { emailLanguage, renderTammhaMail } from './email-layout';

describe('Tammha bilingual email layout', () => {
  it('supports RTL Arabic and escapes all recipient/content markup', () => {
    const result = renderTammhaMail({
      language: 'ar',
      subject: 'تأكيد البريد',
      recipientName: '<script>alert(1)</script>',
      body: 'مشروع <Test>',
      buttonLabel: 'تأكيد البريد',
      actionUrl: 'https://tammha.site/verify-email.html?token=abc',
    });
    expect(result.html).toContain('dir="rtl"');
    expect(result.html).toContain('cid:tammha-banner@tammha.site');
    expect(result.html).toContain('max-width:600px');
    expect(result.html).toContain('font-size:14px');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('مشروع &lt;Test&gt;');
    expect(result.text).toContain(
      'https://tammha.site/verify-email.html?token=abc',
    );
  });

  it('renders an English LTR email', () => {
    const result = renderTammhaMail({
      language: 'en',
      subject: 'Tammha | Verify',
      recipientName: 'Sara',
      body: 'Please confirm your address.',
      actionUrl: 'https://tammha.site/verify-email.html?token=abc',
      buttonLabel: 'Verify Email',
    });
    expect(result.html).toContain('dir="ltr"');
    expect(result.text).toContain('Hello Sara,');
    expect(result.html).toContain('Verify Email');
  });

  it('drops unsafe links and defaults unsupported languages to Arabic', () => {
    const result = renderTammhaMail({
      language: emailLanguage('fr'),
      subject: 'Test',
      body: 'Check',
      actionUrl: 'javascript:alert(1)',
    });
    expect(result.html).toContain('dir="rtl"');
    expect(result.html).toContain('cid:tammha-banner@tammha.site');
    expect(result.html).toContain('max-width:600px');
    expect(result.html).toContain('font-size:14px');
    expect(result.html).not.toContain('javascript:');
  });
});
