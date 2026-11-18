// ===== Settings → Privacy & security (profile.html and supervisor-settings.html) =====
//   [data-password-link]  POST /auth/me/password-link   e-mails a password link; within 5 minutes
//                         of the last one nothing is re-sent (alreadySent=true) and the dialog says so
//   [data-delete-account] POST /auth/me/delete/request  warning, then a 6-digit code is e-mailed
//                         POST /auth/me/delete/confirm  { code }  deletes the account (a goodbye e-mail
//                         is sent); 409 ACCOUNT_DELETION_BLOCKED while leading a team with members or
//                         supervising projects
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession;
  const { T, esc } = UI;

  const ICONS = {
    warning: '<svg aria-hidden="true" viewBox="0 0 48 48"><path d="M24 7 43 40H5L24 7Z"></path><path d="M24 19v10M24 34v.5"></path></svg>',
  };

  // ----- one small centred dialog, reused -----
  let dialog = null;
  function openDialog({ icon = '', image = '', tone = '', title, body, actions, locked = false }) {
    closeDialog();
    dialog = document.createElement('div');
    dialog.className = 'tm-dialog';
    dialog.innerHTML = `<div class="tm-dialog__box ${tone ? `tm-dialog__box--${tone}` : ''}" role="dialog" aria-modal="true" aria-labelledby="tmDialogTitle">
      ${locked ? '' : `<button class="tm-dialog__close" type="button" data-close aria-label="${esc(T('إغلاق', 'Close'))}">×</button>`}
      ${image ? `<img class="tm-dialog__image" src="${image}" alt="">` : icon ? `<span class="tm-dialog__icon">${icon}</span>` : ''}
      <h2 id="tmDialogTitle">${esc(title)}</h2>
      <div class="tm-dialog__body">${body}</div>
      <div class="tm-dialog__actions">${actions}</div></div>`;
    document.body.append(dialog);
    if (locked) dialog.dataset.locked = '1';
    else dialog.addEventListener('click', (e) => { if (e.target === dialog || e.target.closest('[data-close]')) closeDialog(); });
    const first = dialog.querySelector('input, .tm-dialog__actions button');
    if (first) first.focus();
    return dialog;
  }
  function closeDialog() { if (dialog) { dialog.remove(); dialog = null; } }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dialog && !dialog.dataset.locked) closeDialog(); });
  const minutes = (sec) => Math.max(1, Math.ceil(sec / 60));

  // ----- change password -----
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-password-link]'); if (!btn) return;
    UI.busy(btn, async () => {
      let r;
      try { r = await Api.post('/auth/me/password-link', {}); }
      catch (err) { UI.toast(Api.message(err), 'error'); return; }
      const email = `<p class="tm-dialog__email" dir="ltr">${esc(r.email)}</p>`;
      if (r.alreadySent) {
        openDialog({
          image: 'assets/password-link-sent.png', title: T('الرابط مُرسل مسبقًا', 'Link already sent'),
          body: `<p>${esc(T('أرسلنا رابط تغيير كلمة المرور إلى بريدك الإلكتروني قبل قليل:', 'We already sent a password link to your email a moment ago:'))}</p>${email}<p class="tm-dialog__muted">${esc(T(`تحقق من صندوق الوارد أو الرسائل غير المرغوب فيها. يمكنك طلب رابط جديد بعد ${minutes(r.retryAfterSeconds)} دقيقة.`, `Check your inbox or spam folder. You can ask for a new link in ${minutes(r.retryAfterSeconds)} min.`))}</p>`,
          actions: `<button class="tm-dialog__btn tm-dialog__btn--primary" type="button" data-close>${esc(T('حسنًا', 'OK'))}</button>`,
        });
        return;
      }
      openDialog({
        image: 'assets/password-link-sent.png', title: T('تم إرسال الرابط', 'Link sent'),
        body: `<p>${esc(T('أرسلنا رابط تغيير كلمة المرور إلى بريدك الإلكتروني:', 'We sent a password link to your email:'))}</p>${email}<p class="tm-dialog__muted">${esc(T('الرابط صالح لمدة 30 دقيقة ويُستخدم مرة واحدة.', 'The link is valid for 30 minutes and can be used once.'))}</p>`,
        actions: `<button class="tm-dialog__btn tm-dialog__btn--primary" type="button" data-close>${esc(T('حسنًا', 'OK'))}</button>`,
      });
    });
  });

  // ----- delete account -----
  function blockedText(err) {
    const list = (err.details && err.details.blockers) || [];
    const items = list.map((b) => `<li>${esc(b.code === 'SUPERVISOR'
      ? T(`تشرف على مشروع "${b.name}"`, `You supervise the project "${b.name}"`)
      : T(`أنت قائد فريق "${b.name}" وفيه أعضاء آخرون`, `You lead the team "${b.name}", which has other members`))}</li>`).join('');
    return `<p>${esc(T('لا يمكن حذف الحساب الآن:', 'The account cannot be deleted yet:'))}</p><ul class="tm-dialog__list">${items}</ul><p class="tm-dialog__muted">${esc(T('انقل قيادة الفريق إلى عضو آخر من صفحة المشروع (أو أنهِ الإشراف) ثم أعد المحاولة.', 'Hand the team leadership to another member from the project page (or end the supervision), then try again.'))}</p>`;
  }
  function askCode(info) {
    const d = openDialog({
      tone: 'danger', title: T('أدخل رمز التأكيد', 'Enter the confirmation code'),
      body: `<p>${esc(T('أرسلنا رمزًا من 6 أرقام إلى بريدك الإلكتروني:', 'We sent a 6-digit code to your email:'))}</p><p class="tm-dialog__email" dir="ltr">${esc(info.email)}</p>
        <label class="tm-dialog__code"><span class="visually-hidden">${esc(T('رمز التأكيد', 'Confirmation code'))}</span><input id="tmDeleteCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" placeholder="••••••"></label>
        <p class="tm-dialog__error" id="tmDeleteError" role="alert"></p><p class="tm-dialog__muted">${esc(T('الرمز صالح لمدة 15 دقيقة.', 'The code is valid for 15 minutes.'))}</p>`,
      actions: `<button class="tm-dialog__btn" type="button" data-close>${esc(T('إلغاء', 'Cancel'))}</button><button class="tm-dialog__btn tm-dialog__btn--danger" type="button" id="tmDeleteConfirm">${esc(T('حذف الحساب نهائيًا', 'Delete account permanently'))}</button>`,
    });
    const input = d.querySelector('#tmDeleteCode'); const errEl = d.querySelector('#tmDeleteError');
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); errEl.textContent = ''; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') d.querySelector('#tmDeleteConfirm').click(); });
    d.querySelector('#tmDeleteConfirm').addEventListener('click', (e) => {
      const code = input.value.trim();
      if (!/^\d{6}$/.test(code)) { errEl.textContent = T('اكتب الرمز المكوّن من 6 أرقام.', 'Type the 6-digit code.'); input.focus(); return; }
      UI.busy(e.currentTarget, async () => {
        try { await Api.post('/auth/me/delete/confirm', { code }); }
        catch (err) {
          errEl.textContent = err.code === 'DELETION_CODE_INVALID' ? T('الرمز غير صحيح أو انتهت صلاحيته.', 'The code is incorrect or has expired.') : Api.message(err);
          if (err.code === 'ACCOUNT_DELETION_BLOCKED') openDialog({ icon: ICONS.warning, tone: 'danger', title: T('تعذّر حذف الحساب', 'The account cannot be deleted'), body: blockedText(err), actions: `<button class="tm-dialog__btn tm-dialog__btn--primary" type="button" data-close>${esc(T('حسنًا', 'OK'))}</button>` });
          return;
        }
        Api.clearSession();
        openDialog({
          locked: true, image: 'assets/account-deleted.png', title: T('تم حذف حسابك', 'Your account has been deleted'),
          body: `<p>${esc(T('شكرًا لأنك كنت جزءًا من تمّمها. حذفنا حسابك وبياناتك الشخصية كما طلبت، وأرسلنا لك رسالة تأكيد على بريدك.', 'Thank you for being part of Tammha. Your account and personal data have been deleted as you asked, and a confirmation was sent to your email.'))}</p><p>${esc(T('نتمنى لك كل التوفيق في مشروعك ومسيرتك، وبابنا مفتوح لك متى ما رجعت.', 'We wish you every success with your project and your studies. You are always welcome back.'))}</p>`,
          actions: `<a class="tm-dialog__btn tm-dialog__btn--primary" href="index.html">${esc(T('العودة إلى الصفحة الرئيسية', 'Back to the home page'))}</a>`,
        });
      });
    });
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete-account]'); if (!btn) return;
    const d = openDialog({
      icon: ICONS.warning, tone: 'danger', title: T('حذف الحساب نهائيًا؟', 'Delete your account permanently?'),
      body: `<p>${esc(T('سيُحذف حسابك وبياناتك الشخصية نهائيًا ولا يمكن استرجاعها، وتخرج من جميع الأجهزة. تبقى مساهماتك في مشاريع الفريق باسم "حساب محذوف".', 'Your account and personal data are deleted permanently and cannot be restored, and you are signed out everywhere. Your contributions to team projects remain as "Deleted account".'))}</p><p class="tm-dialog__muted">${esc(T('للتأكيد نرسل رمزًا إلى بريدك الإلكتروني.', 'To confirm, we will email you a code.'))}</p>`,
      actions: `<button class="tm-dialog__btn" type="button" data-close>${esc(T('إلغاء', 'Cancel'))}</button><button class="tm-dialog__btn tm-dialog__btn--danger" type="button" id="tmDeleteSend">${esc(T('إرسال رمز التأكيد', 'Send confirmation code'))}</button>`,
    });
    d.querySelector('#tmDeleteSend').addEventListener('click', (ev) => UI.busy(ev.currentTarget, async () => {
      try { askCode(await Api.post('/auth/me/delete/request', {})); }
      catch (err) {
        if (err.code === 'ACCOUNT_DELETION_BLOCKED') { openDialog({ icon: ICONS.warning, tone: 'danger', title: T('تعذّر حذف الحساب', 'The account cannot be deleted'), body: blockedText(err), actions: `<button class="tm-dialog__btn tm-dialog__btn--primary" type="button" data-close>${esc(T('حسنًا', 'OK'))}</button>` }); return; }
        if (err.code === 'DELETION_CODE_RECENTLY_SENT') { askCode({ email: (S.user && S.user.email) || '' }); return; }
        UI.toast(Api.message(err), 'error');
      }
    }));
  });
})();
