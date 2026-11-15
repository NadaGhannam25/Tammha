// ===== Account pages connected to the API =====
// forgot-password.html   → POST /auth/forgot-password { email }   (same answer whether the account exists or not)
// reset-link-sent.html   → resend: POST /auth/forgot-password again (60 s apart)
// reset-password.html    → POST /auth/reset-password { token, newPassword }
//   ?mode=activate        → POST /auth/activate-account { token, newPassword } (supervisor accounts)
// verify-email.html      → POST /auth/verify-email { token }; ?pending=1 → resend link (signed in)
// verify-university-email.html → POST /auth/verify-university-email { token }
// Password rule = backend: 8–128 characters with at least one letter and one digit.
(() => {
  'use strict';
  const Api = window.TammhaApi;
  const EMAIL_KEY = 'tammha_reset_email';
  const isEn = () => document.documentElement.lang === 'en';
  const T = (ar, en) => (isEn() ? en : ar);
  const params = new URLSearchParams(location.search);
  const readResetEmail = () => { try { return sessionStorage.getItem(EMAIL_KEY) || ''; } catch (e) { return ''; } };
  const writeResetEmail = (value) => { try { sessionStorage.setItem(EMAIL_KEY, value); } catch (e) { /* ignore */ } };

  document.querySelectorAll('[data-reset-email]').forEach((node) => {
    node.textContent = readResetEmail() || T('البريد الإلكتروني المُدخل', 'the email you entered');
  });

  // ----- forgot password -----
  const forgotForm = document.getElementById('forgotPasswordForm');
  if (forgotForm) {
    const input = document.getElementById('resetEmail');
    const error = document.getElementById('resetEmailError');
    forgotForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = (input?.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        input?.classList.add('is-invalid');
        if (error) error.textContent = T('أدخل بريدًا إلكترونيًا صحيحًا.', 'Enter a valid email address.');
        return;
      }
      input?.classList.remove('is-invalid');
      if (error) error.textContent = '';
      const btn = forgotForm.querySelector('button[type="submit"]'); btn.disabled = true;
      try {
        await Api.post('/auth/forgot-password', { email }, { auth: false, loader: { label: T('جارٍ الإرسال…', 'Sending…') } });
        writeResetEmail(email);
        window.location.href = 'reset-link-sent.html';
      } catch (e) {
        if (error) error.textContent = Api.message(e);
      } finally { btn.disabled = false; }
    });
  }

  // ----- link sent: resend after a countdown -----
  const resendButton = document.getElementById('resendResetLink');
  const resendTimer = document.getElementById('resendTimer');
  if (resendButton && resendTimer) {
    let seconds = 60; let interval = 0;
    const paint = () => {
      resendTimer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      resendTimer.hidden = seconds <= 0;
      resendButton.disabled = seconds > 0;
    };
    const countdown = () => { clearInterval(interval); seconds = 60; paint(); interval = setInterval(() => { seconds -= 1; paint(); if (seconds <= 0) clearInterval(interval); }, 1000); };
    countdown();
    resendButton.addEventListener('click', async () => {
      const email = readResetEmail();
      if (resendButton.disabled || !email) { if (!email) location.href = 'forgot-password.html'; return; }
      resendButton.disabled = true;
      try { await Api.post('/auth/forgot-password', { email }, { auth: false }); countdown(); }
      catch (e) { resendButton.disabled = false; resendTimer.hidden = false; resendTimer.textContent = Api.message(e); }
    });
  }

  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.passwordToggle || '');
      if (!target) return;
      const hidden = target.type === 'password';
      target.type = hidden ? 'text' : 'password';
      button.classList.toggle('is-visible', hidden);
      const icon = button.querySelector('img');
      if (icon) icon.src = hidden ? 'assets/eye-open.png' : 'assets/eye-toggle.png';
      const label = hidden ? T('إخفاء كلمة المرور', 'Hide password') : T('إظهار كلمة المرور', 'Show password');
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    });
  });

  // ----- reset password / activate supervisor account -----
  const resetForm = document.getElementById('resetPasswordForm');
  if (resetForm) {
    const activate = params.get('mode') === 'activate';
    const token = params.get('token') || '';
    const password = document.getElementById('newPassword');
    const confirmation = document.getElementById('confirmPassword');
    const formError = document.getElementById('resetPasswordError');
    const rule = (name) => document.querySelector(`[data-rule="${name}"]`);
    if (!token && formError) formError.textContent = T('الرابط غير مكتمل. افتح الرابط من رسالة البريد مباشرة.', 'The link is incomplete. Open it directly from the email.');
    const evaluate = () => {
      const value = password?.value || '';
      const rules = { length: value.length >= 8 && value.length <= 128, case: /[A-Za-z؀-ۿ]/.test(value), number: /\d/.test(value) };
      Object.entries(rules).forEach(([k, ok]) => rule(k)?.classList.toggle('is-valid', ok));
      return rules.length && rules.case && rules.number;
    };
    password?.addEventListener('input', evaluate);
    confirmation?.addEventListener('input', () => {
      confirmation.classList.toggle('is-invalid', !!confirmation.value && confirmation.value !== password?.value);
    });
    resetForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const rulesOkay = evaluate();
      const match = (password?.value || '') === (confirmation?.value || '') && !!confirmation?.value;
      password?.classList.toggle('is-invalid', !rulesOkay);
      confirmation?.classList.toggle('is-invalid', !match);
      if (!rulesOkay) { formError.textContent = T('تأكد من استيفاء جميع شروط كلمة المرور.', 'Make sure the password meets every rule.'); return; }
      if (!match) { formError.textContent = T('كلمتا المرور غير متطابقتين.', 'The passwords do not match.'); return; }
      if (!token) return;
      formError.textContent = '';
      const btn = resetForm.querySelector('button[type="submit"]'); btn.disabled = true;
      try {
        await Api.post(activate ? '/auth/activate-account' : '/auth/reset-password', { token, newPassword: password.value }, { auth: false, loader: { label: T('جارٍ الحفظ…', 'Saving…') } });
        Api.clearSession();
        window.location.href = activate ? 'password-changed.html?mode=activate' : 'password-changed.html';
      } catch (e) {
        formError.textContent = Api.message(e);
      } finally { btn.disabled = false; }
    });
  }

  // ----- e-mail verification -----
  const verifyBox = document.getElementById('verifyState');
  if (verifyBox) {
    const university = document.body.dataset.verify === 'university';
    const token = params.get('token');
    const title = document.getElementById('verifyTitle');
    const text = document.getElementById('verifyText');
    const actions = document.getElementById('verifyActions');
    const set = (t, p, html) => { title.textContent = t; text.textContent = p; actions.innerHTML = html || ''; };
    const signedIn = !!(Api.session() && Api.session().accessToken);
    const continueTo = () => { const u = Api.session()?.user; return u && u.role === 'SUPERVISOR' ? 'supervisor.html' : 'dashboard.html'; };
    if (token) {
      // while the link is checked: the same title / text / actions area, with the small wave
      // loader in the actions row (no layout change; closed on success and on failure)
      set(T('جارٍ تأكيد البريد…', 'Verifying the email…'), T('لحظات، نتحقق من رابط التأكيد.', 'One moment, the verification link is being checked.'));
      actions.setAttribute('aria-busy', 'true');
      const wave = window.TammhaLoader ? window.TammhaLoader.show({ target: actions, label: '' }) : null;
      const stop = () => { actions.removeAttribute('aria-busy'); if (wave) wave.done(); };
      Api.post(university ? '/auth/verify-university-email' : '/auth/verify-email', { token }, { auth: false })
        .then(async () => {
          stop();
          if (signedIn) { try { Api.saveUser(await Api.get('/auth/me', { redirectOn401: false })); } catch (e) { /* ignore */ } }
          set(T('تم تأكيد البريد', 'Email verified'), university ? T('تم تأكيد بريدك الجامعي.', 'Your university email is verified.') : T('تم تأكيد بريدك الإلكتروني، ويمكنك الآن استخدام المنصة.', 'Your email is verified. You can now use the platform.'),
            `<a class="auth-primary-button" href="${signedIn ? continueTo() : 'login.html'}">${signedIn ? T('المتابعة', 'Continue') : T('تسجيل الدخول', 'Sign in')}</a>`);
        })
        .catch((e) => stop() || set(T('تعذّر تأكيد البريد', 'The email could not be verified'), Api.message(e), signedIn ? `<button class="auth-primary-button" type="button" data-resend>${T('إرسال رابط جديد', 'Send a new link')}</button>` : `<a class="auth-primary-button" href="login.html">${T('تسجيل الدخول', 'Sign in')}</a>`));
    } else {
      const email = params.get('email') || Api.session()?.user?.email || '';
      set(T('أكّد بريدك الإلكتروني', 'Verify your email'), T(`أرسلنا رابط التأكيد إلى ${email || 'بريدك الجامعي'}. افتح الرابط لتفعيل الحساب، وتحقق من مجلد الرسائل غير المرغوب فيها إن لم تجد الرسالة.`, `A verification link was sent to ${email || 'your university email'}. Open it to activate the account; check the spam folder if it is not in the inbox.`),
        signedIn ? `<button class="auth-primary-button" type="button" data-check>${T('أكّدت البريد، المتابعة', 'I have verified it, continue')}</button><button class="auth-secondary-button" type="button" data-resend>${T('إعادة إرسال الرابط', 'Resend the link')}</button>` : `<a class="auth-primary-button" href="login.html">${T('تسجيل الدخول', 'Sign in')}</a>`);
    }
    const note = document.getElementById('verifyNote');
    actions.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-resend], [data-check]');
      if (!btn || btn.disabled) return;
      btn.disabled = true; btn.setAttribute('aria-busy', 'true');
      try { await handle(btn); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    });
    async function handle(btn) {
      if (btn.matches('[data-resend]')) {
        try { await Api.post('/auth/resend-verification', {}); note.textContent = T('أُرسل رابط جديد.', 'A new link was sent.'); }
        catch (err) { note.textContent = Api.message(err); }
      }
      if (btn.matches('[data-check]')) {
        try {
          const me = await Api.get('/auth/me');
          Api.saveUser(me);
          if (me.emailVerified) location.href = continueTo();
          else note.textContent = T('لم يُؤكَّد البريد بعد. افتح الرابط من رسالة البريد أولًا.', 'The email is not verified yet. Open the link from the email first.');
        } catch (err) { note.textContent = Api.message(err); }
      }
    }
  }

  // password-changed.html?mode=activate: activation wording
  if (params.get('mode') === 'activate') {
    document.querySelectorAll('[data-activate-text]').forEach((el) => { el.textContent = el.dataset.activateText; });
  }
})();
