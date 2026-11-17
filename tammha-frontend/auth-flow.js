// ===== Account pages connected to the API =====
// forgot-password.html   → POST /auth/forgot-password { email }   (same answer whether the account exists or not)
// reset-link-sent.html   → resend: POST /auth/forgot-password again (60 s apart)
// reset-password.html    → POST /auth/reset-password { token, newPassword }
//   ?mode=activate        → POST /auth/activate-account { token, newPassword } (supervisor accounts)
// verify-email.html      → P17: 6-digit code. POST /auth/verify-email/code { email, code },
//                          POST /auth/verify-email/resend { email } (60 s countdown),
//                          POST /auth/verify-email/change-email { currentEmail, password, newEmail };
//                          ?token=… (links sent before P17) → POST /auth/verify-email { token }
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
        .catch((e) => stop() || set(T('تعذّر تأكيد البريد', 'The email could not be verified'), Api.message(e), `<a class="auth-primary-button" href="verify-email.html?pending=1">${T('إدخال رمز التحقق', 'Enter a verification code')}</a>`));
    } else if (!university) {
      codeScreen();
    } else {
      set(T('تأكيد البريد الجامعي', 'Verify your university email'), T('افتح الرابط المرسل إلى بريدك الجامعي.', 'Open the link sent to your university email.'), `<a class="auth-primary-button" href="login.html">${T('تسجيل الدخول', 'Sign in')}</a>`);
    }
    const note = document.getElementById('verifyNote');

    // ----- P17: verification code screen -----
    function codeScreen() {
      let email = params.get('email') || Api.session()?.user?.email || '';
      const card = verifyBox;
      const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      title.textContent = T('أدخل رمز التحقق', 'Enter the verification code');
      text.innerHTML = '';
      actions.className = 'auth-flow-actions vcode';
      actions.innerHTML = `
        <p class="vcode__sent">${esc(T('أرسلنا رمزًا من 6 أرقام إلى', 'We sent a 6-digit code to'))} <b dir="ltr" id="vcodeEmail"></b></p>
        <form class="vcode__form" id="vcodeForm" novalidate>
          <div class="vcode__boxes" dir="ltr" role="group" aria-label="${esc(T('رمز التحقق', 'Verification code'))}">
            ${[0, 1, 2, 3, 4, 5].map((i) => `<input class="vcode__digit" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" aria-label="${esc(T(`الرقم ${i + 1}`, `Digit ${i + 1}`))}">`).join('')}
          </div>
          <p class="vcode__error" id="vcodeError" role="alert"></p>
          <button class="auth-primary-button vcode__submit" type="submit">${esc(T('تأكيد', 'Verify'))}</button>
        </form>
        <div class="vcode__resend"><button class="vcode__link" type="button" id="vcodeResend" disabled></button></div>
        <p class="vcode__hint">${esc(T('لم تجد الرسالة؟ تحقق من مجلد Junk أو Other. قد تحجب بعض صناديق البريد الجامعي الرسائل، والبريد الشخصي يصل عادة.', 'Not in your inbox? Check the Junk or Other folder. Some university mailboxes block messages; a personal email usually works.'))}</p>
        <button class="vcode__link vcode__other" type="button" id="vcodeOther">${esc(T('ما وصلك الرمز؟ جرّب بريدًا آخر', 'No code? Try another email'))}</button>
        <form class="vcode__change" id="vcodeChange" hidden novalidate>
          <label><span>${esc(T('البريد الجديد', 'New email'))}</span><input type="email" id="vcodeNewEmail" dir="ltr" autocomplete="email" required></label>
          <label><span>${esc(T('كلمة المرور', 'Password'))}</span><input type="password" id="vcodePassword" autocomplete="current-password" required></label>
          <p class="vcode__error" id="vcodeChangeError" role="alert"></p>
          <div class="vcode__change-actions"><button class="auth-secondary-button" type="button" id="vcodeChangeCancel">${esc(T('إلغاء', 'Cancel'))}</button><button class="auth-primary-button" type="submit">${esc(T('إرسال الرمز', 'Send code'))}</button></div>
        </form>`;
      const digits = [...actions.querySelectorAll('.vcode__digit')];
      const errEl = actions.querySelector('#vcodeError');
      const resend = actions.querySelector('#vcodeResend');
      const showEmail = () => { actions.querySelector('#vcodeEmail').textContent = email || T('بريدك الإلكتروني', 'your email'); };
      showEmail();
      card.classList.add('auth-flow-card--code');

      // digit boxes: auto-advance, backspace goes back, paste the whole code
      const fill = (str, from = 0) => { str.replace(/\D/g, '').slice(0, 6 - from).split('').forEach((d, k) => { digits[from + k].value = d; }); };
      const code = () => digits.map((d) => d.value).join('');
      digits.forEach((input, i) => {
        input.addEventListener('input', () => {
          const v = input.value.replace(/\D/g, '');
          if (v.length > 1) { fill(v, i); } else input.value = v;
          errEl.textContent = '';
          const next = digits.findIndex((d) => !d.value);
          if (input.value && i < 5) digits[Math.min(next < 0 ? 5 : next, 5)].focus();
          if (code().length === 6) actions.querySelector('#vcodeForm').requestSubmit();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !input.value && i > 0) { digits[i - 1].value = ''; digits[i - 1].focus(); e.preventDefault(); }
          if (e.key === 'ArrowLeft' && i > 0) digits[i - 1].focus();
          if (e.key === 'ArrowRight' && i < 5) digits[i + 1].focus();
        });
        input.addEventListener('paste', (e) => {
          const t = (e.clipboardData || window.clipboardData).getData('text');
          if (!/\d/.test(t)) return;
          e.preventDefault(); fill(t, 0);
          (digits.find((d) => !d.value) || digits[5]).focus();
          if (code().length === 6) actions.querySelector('#vcodeForm').requestSubmit();
        });
      });
      digits[0].focus();

      // resend with a visible countdown
      let timer = 0;
      const countdown = (sec) => {
        clearInterval(timer);
        let left = Math.max(0, Math.round(sec));
        const paint = () => {
          resend.disabled = left > 0;
          resend.textContent = left > 0 ? T(`إعادة إرسال الرمز خلال ${left} ث`, `Resend code in ${left}s`) : T('إعادة إرسال الرمز', 'Resend code');
        };
        paint();
        timer = setInterval(() => { left -= 1; paint(); if (left <= 0) clearInterval(timer); }, 1000);
      };
      countdown(60);
      resend.addEventListener('click', async () => {
        if (!email) { location.href = 'login.html'; return; }
        resend.disabled = true;
        try {
          const r = await Api.post('/auth/verify-email/resend', { email }, { auth: false });
          note.textContent = T('إذا كان الحساب بحاجة للتأكيد فقد أرسلنا رمزًا جديدًا.', 'If the account still needs verifying, a new code was sent.');
          countdown(r && r.retryAfterSeconds ? r.retryAfterSeconds : 60);
        } catch (err) { note.textContent = Api.message(err); countdown(30); }
      });

      // verify
      actions.querySelector('#vcodeForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = code();
        if (value.length !== 6) { errEl.textContent = T('اكتب الرمز المكوّن من 6 أرقام.', 'Type the 6-digit code.'); (digits.find((d) => !d.value) || digits[0]).focus(); return; }
        if (!email) { errEl.textContent = T('سجّل الدخول أولًا ثم أدخل الرمز.', 'Sign in first, then enter the code.'); return; }
        const btn = actions.querySelector('.vcode__submit'); btn.disabled = true;
        try {
          await Api.post('/auth/verify-email/code', { email, code: value }, { auth: false, loader: { label: T('جارٍ التحقق…', 'Verifying…') } });
          clearInterval(timer);
          if (signedIn) { try { Api.saveUser(await Api.get('/auth/me', { redirectOn401: false })); } catch (x) { /* ignore */ } }
          card.classList.remove('auth-flow-card--code');
          set(T('تم تأكيد البريد', 'Email verified'), T('تم تأكيد بريدك الإلكتروني، ويمكنك الآن استخدام المنصة.', 'Your email is verified. You can now use the platform.'),
            `<a class="auth-primary-button" href="${signedIn ? continueTo() : 'login.html'}">${signedIn ? T('المتابعة', 'Continue') : T('تسجيل الدخول', 'Sign in')}</a>`);
          actions.className = 'auth-flow-actions auth-flow-actions--single';
          note.textContent = '';
        } catch (err) {
          errEl.textContent = err.code === 'VERIFICATION_CODE_INVALID' ? T('الرمز غير صحيح أو انتهت صلاحيته. اطلب رمزًا جديدًا إذا لزم.', 'The code is incorrect or has expired. Ask for a new code if needed.') : Api.message(err);
          digits.forEach((d) => { d.value = ''; }); digits[0].focus();
        } finally { btn.disabled = false; }
      });

      // another address (unverified accounts): new e-mail + password
      const change = actions.querySelector('#vcodeChange');
      const other = actions.querySelector('#vcodeOther');
      other.addEventListener('click', () => { change.hidden = false; other.hidden = true; actions.querySelector('#vcodeNewEmail').focus(); });
      actions.querySelector('#vcodeChangeCancel').addEventListener('click', () => { change.hidden = true; other.hidden = false; });
      change.addEventListener('submit', async (e) => {
        e.preventDefault();
        const cErr = actions.querySelector('#vcodeChangeError'); cErr.textContent = '';
        const newEmail = actions.querySelector('#vcodeNewEmail').value.trim();
        const password = actions.querySelector('#vcodePassword').value;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) { cErr.textContent = T('اكتب بريدًا إلكترونيًا صحيحًا.', 'Enter a valid email address.'); return; }
        if (!password) { cErr.textContent = T('اكتب كلمة المرور.', 'Enter your password.'); return; }
        if (!email) { cErr.textContent = T('سجّل الدخول أولًا.', 'Sign in first.'); return; }
        const btn = change.querySelector('[type="submit"]'); btn.disabled = true;
        try {
          const r = await Api.post('/auth/verify-email/change-email', { currentEmail: email, password, newEmail }, { auth: false, loader: { label: T('جارٍ الإرسال…', 'Sending…') } });
          email = r.email || newEmail;
          const u = Api.session()?.user; if (u) Api.saveUser(Object.assign({}, u, { email }));
          const url = new URL(location.href); url.searchParams.set('email', email); history.replaceState(null, '', url);
          showEmail(); change.hidden = true; other.hidden = false; change.reset();
          digits.forEach((d) => { d.value = ''; }); digits[0].focus();
          note.textContent = T('أرسلنا رمزًا جديدًا إلى البريد الجديد.', 'A new code was sent to the new email.');
          countdown(r.retryAfterSeconds || 60);
        } catch (err) {
          const map = { EMAIL_TAKEN: T('هذا البريد مستخدم في حساب آخر.', 'This email is used by another account.'), EMAIL_UNCHANGED: T('اكتب بريدًا مختلفًا عن الحالي.', 'Enter a different email.'), EMAIL_ALREADY_VERIFIED: T('بريدك مؤكَّد مسبقًا.', 'Your email is already verified.'), SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED: T('حساب المشرف يستخدم البريد الجامعي فقط.', 'Supervisor accounts use a university email only.') };
          cErr.textContent = err.status === 401 ? T('كلمة المرور غير صحيحة.', 'The password is incorrect.') : (map[err.code] || Api.message(err));
        } finally { btn.disabled = false; }
      });
    }
  }

  // password-changed.html?mode=activate: activation wording
  if (params.get('mode') === 'activate') {
    document.querySelectorAll('[data-activate-text]').forEach((el) => { el.textContent = el.dataset.activateText; });
  }
})();
