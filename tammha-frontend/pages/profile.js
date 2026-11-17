// ===== Settings (profile.html) — connected to the API =====
// Profile:  GET /auth/me (session), PATCH /users/me { firstName, lastName, studentNumber, college, major }
//           (the e-mail is the university account and is not edited here)
// Storage:  GET /users/me/storage (10 GB quota of the student, per project)
// Security: account-security.js (password link, delete account). Sign-out ends this session (POST /auth/logout).
// Language: handled by script.js / i18n.js (one setting for the whole site).
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession;
  const { T, esc } = UI;
  const $ = (id) => document.getElementById(id);

  function fill(u, uniName) {
    $('profileFirst').value = u.firstName || ''; $('profileLast').value = u.lastName || '';
    $('profileEmail').value = u.email || ''; $('profileNumber').value = u.studentNumber || '';
    $('profileUniversity').value = uniName || '';
    // college and major (collected in the first-login onboarding)
    $('profileStudyFields').innerHTML = UI.collegeMajorFields('profile', u);
    paintPhoto(u);
  }

  // ----- profile photo: resized here to a 256 px square JPEG, saved on the account -----
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  function paintPhoto(u) {
    document.querySelectorAll('.profile .profile__avatar, [data-me-avatar]').forEach((el) => UI.paintAvatar(el, u));
    $('profilePhotoRemove').hidden = !UI.avatarUrl(u);
  }
  async function squarePhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
      const size = 256; const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) throw new Error('empty');
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      for (const q of [0.86, 0.75, 0.62, 0.5]) { const data = canvas.toDataURL('image/jpeg', q); if (data.length <= 78000) return data; }
      throw new Error('too-large');
    } finally { URL.revokeObjectURL(url); }
  }
  async function savePhoto(avatar, button) {
    const err = $('profilePhotoError'); err.textContent = '';
    await UI.busy(button, async () => {
      try {
        const u = await Api.patch('/users/me', { avatar }, { loader: { target: err, label: T('جارٍ حفظ الصورة…', 'Saving the photo…') } });
        const merged = Object.assign(S.user, { avatar: u.avatar ?? null });
        Api.saveUser(merged); paintPhoto(merged);
        UI.toast(avatar ? T('حُفظت الصورة الشخصية.', 'Profile photo saved.') : T('أُزيلت الصورة الشخصية.', 'Profile photo removed.'), 'success');
      } catch (er) { err.textContent = Api.message(er); }
    });
  }
  $('profilePhotoFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    const err = $('profilePhotoError'); err.textContent = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { err.textContent = T('اختر صورة بصيغة PNG أو JPG أو WebP.', 'Choose a PNG, JPG or WebP image.'); return; }
    if (file.size > MAX_PHOTO_BYTES) { err.textContent = T('حجم الصورة يتجاوز 5MB. اختر صورة أصغر.', 'The image is larger than 5 MB. Choose a smaller image.'); return; }
    let data;
    try { data = await squarePhoto(file); } catch (er) { err.textContent = T('تعذّرت قراءة الصورة. جرّب صورة أخرى.', 'The image could not be read. Try another image.'); return; }
    await savePhoto(data, document.querySelector('.profile-photo-pick'));
  });
  $('profilePhotoRemove').addEventListener('click', () => savePhoto(null, $('profilePhotoRemove')));
  $('profileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const first = $('profileFirst').value.trim(); const err = $('profileError'); err.textContent = '';
    if (!first) { err.textContent = T('الاسم الأول مطلوب.', 'The first name is required.'); return; }
    const number = $('profileNumber').value.trim();
    if (number && !/^[A-Za-z0-9-]{4,30}$/.test(number)) { err.textContent = T('أدخل الرقم الجامعي كما في بطاقتك الجامعية.', 'Enter the student number as on your university card.'); return; }
    UI.busy(e.target.querySelector('[type="submit"]'), async () => {
      try {
        const u = await Api.patch('/users/me', { firstName: first, lastName: $('profileLast').value.trim() || undefined, studentNumber: number || undefined, college: $('profileCollege') ? $('profileCollege').value.trim() : undefined, major: $('profileMajor') ? $('profileMajor').value.trim() : undefined });
        Api.saveUser(Object.assign({}, S.user, u));
        document.querySelectorAll('.profile__text strong').forEach((el) => { el.textContent = UI.personName(u); });
        UI.toast(T('حُفظت التغييرات.', 'Changes saved.'), 'success');
      } catch (er) { err.textContent = Api.message(er); }
    });
  });

  async function storage() {
    const box = $('storagePanel'); UI.state(box, 'loading');
    try {
      const s = await Api.get('/users/me/storage');
      if (!s.quotaApplies) { UI.state(box, 'empty', { title: T('لا تنطبق حصة التخزين على هذا الحساب.', 'No storage quota applies to this account.') }); return; }
      const pct = Math.min(100, Math.round(s.percentageUsed ?? 0));
      box.innerHTML = `<div class="storage-compact__head"><strong dir="ltr">${esc(UI.fmtSize(s.usedBytes))}</strong><span>${esc(T('مستخدمة من', 'used of'))} <span dir="ltr">${esc(UI.fmtSize(s.quotaBytes))}</span></span><b>${pct}%</b></div>
        <div aria-label="${esc(T(`المساحة المستخدمة ${pct} بالمئة`, `Storage used ${pct} percent`))}" class="storage-compact__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${Math.max(pct, s.usedBytes ? 1 : 0)}%"></span></div>
        <dl class="storage-compact__meta"><div><dt>${esc(T('ملفات المشاريع', 'Project files'))}</dt><dd dir="ltr">${esc(UI.fmtSize(s.breakdown?.documentBytes))}</dd></div>
        <div><dt>${esc(T('أدلة المشاريع', 'Project handbooks'))}</dt><dd dir="ltr">${esc(UI.fmtSize(s.breakdown?.handbookBytes))}</dd></div>
        <div><dt>${esc(T('المتبقي', 'Remaining'))}</dt><dd dir="ltr">${esc(UI.fmtSize(s.remainingBytes))}</dd></div></dl>
        ${(s.projects || []).length ? `<section class="storage-projects" aria-labelledby="storageProjectsTitle"><h3 id="storageProjectsTitle">${esc(T('المساحة حسب المشروع', 'Space by project'))}</h3><ul class="storage-projects__list">${s.projects.map((p) => { const share = s.usedBytes ? Math.round((p.usedBytes / s.usedBytes) * 100) : 0; return `<li><span class="storage-projects__name">${esc(p.projectName)}</span><span class="storage-projects__bar" aria-hidden="true"><i style="width:${Math.max(share, p.usedBytes ? 2 : 0)}%"></i></span><span class="storage-projects__size" dir="ltr">${esc(UI.fmtSize(p.usedBytes))}</span></li>`; }).join('')}</ul></section>` : ''}`;
    } catch (e) { UI.state(box, 'error', { error: e, retry: storage }); }
  }

  // change password and delete account: account-security.js

  S.ready.then(async (u) => {
    let uniName = '';
    try { const list = await Api.get('/universities', { auth: false }); uniName = (list.find((x) => x.id === u.universityId) || {}).name || ''; } catch (e) { /* optional */ }
    fill(u, uniName); storage();
  });
})();
