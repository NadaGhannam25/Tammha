/** Tests: the 6-digit code in a verification-code e-mail (P17), or null. */
export function verificationCodeIn(text: string | undefined | null) {
  if (
    !text ||
    !/verification code|verify your e-mail|رمز التحقق|تأكيد بريدك/i.test(text)
  ) {
    return null;
  }
  return /(?:^|\n)(\d{6})(?:\n|$)/.exec(text)?.[1] ?? null;
}
