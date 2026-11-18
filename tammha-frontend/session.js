// ===== Tammha session + shared UI helpers =====
// Loaded after api.js on every signed-in page. The page declares who may open it with
// <body data-app-role="STUDENT | SUPERVISOR | ANY">. This file:
//   - sends visitors without a session to login.html (and back to this page afterwards);
//   - loads the signed-in user (GET /auth/me) and refuses the wrong role (a student on a
//     supervisor page goes to dashboard.html, a supervisor on a student page to supervisor.html);
//   - fills the header with the real name and role, and keeps the notifications badge;
//   - students: shows the first-login welcome (onboarding) once and adds the notifications
//     menu to the header;
//   - keeps the "current project" of a user with several projects (?project=<id> wins);
//   - exposes TammhaUI: escaping, dates in the interface language, toasts and the
//     loading / empty / error states used by every page.
// Nothing here is demonstration data: every value shown comes from the API.
(function () {
  'use strict';
  const Api = window.TammhaApi;
  const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'ar');
  const isEn = () => lang() === 'en';
  const T = (ar, en) => (isEn() ? en : ar);
  const L = (pair) => (Array.isArray(pair) ? pair[isEn() ? 1 : 0] : pair);

  // ---------- UI helpers ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = [['يناير', 'January'], ['فبراير', 'February'], ['مارس', 'March'], ['أبريل', 'April'], ['مايو', 'May'], ['يونيو', 'June'], ['يوليو', 'July'], ['أغسطس', 'August'], ['سبتمبر', 'September'], ['أكتوبر', 'October'], ['نوفمبر', 'November'], ['ديسمبر', 'December']];
  const toDate = (v) => (v instanceof Date ? v : v ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v) : null);
  function fmtDate(v) {
    const d = toDate(v); if (!d || isNaN(d)) return '—';
    const m = MONTHS[d.getMonth()];
    return isEn() ? `${m[1]} ${d.getDate()}, ${d.getFullYear()}` : `${d.getDate()} ${m[0]} ${d.getFullYear()}`;
  }
  function fmtShortDate(v) {
    const d = toDate(v); if (!d || isNaN(d)) return '—';
    const m = MONTHS[d.getMonth()];
    return isEn() ? `${m[1].slice(0, 3)} ${d.getDate()}` : `${d.getDate()} ${m[0]}`;
  }
  function fmtTime(v) {
    const d = toDate(v); if (!d || isNaN(d)) return '';
    const h = d.getHours() % 12 || 12; const mi = String(d.getMinutes()).padStart(2, '0');
    return `${String(h).padStart(2, '0')}:${mi} ${d.getHours() < 12 ? T('ص', 'AM') : T('م', 'PM')}`;
  }
  const fmtDateTime = (v) => (toDate(v) ? `${fmtDate(v)}${isEn() ? ', ' : '، '}${fmtTime(v)}` : '—');
  const isoDay = (v) => { const d = toDate(v); if (!d) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  function fmtSize(bytes) {
    const n = Number(bytes); if (bytes == null || !isFinite(n) || n < 0) return '—'; if (n === 0) return '0 B';
    if (n < 1024) return `${n} B`; if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`; return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }
  // Project setup requirements (backend PROJECT_SETUP_INCOMPLETE → details.missing)
  const SETUP_REQUIREMENTS = {
    UNIVERSITY_IDENTITY_REQUIRED: ['إكمال بيانات الحساب الجامعية', 'complete the university account details'],
    TEAM_NAME_REQUIRED: ['اسم الفريق', 'team name'], TEAM_LEADER_REQUIRED: ['قائد الفريق', 'team leader'],
    PROJECT_NAME_REQUIRED: ['اسم المشروع', 'project name'], PROJECT_DESCRIPTION_REQUIRED: ['الوصف المختصر', 'short description'],
    PROJECT_OVERVIEW_REQUIRED: ['نبذة المشروع', 'project overview'], PROJECT_OBJECTIVES_REQUIRED: ['هدف المشروع', 'project objective'],
    PROJECT_CATEGORY_REQUIRED: ['تصنيف المشروع', 'project category'], PROJECT_ORIGIN_REQUIRED: ['نوع المشروع', 'project type'],
    PROJECT_START_DATE_REQUIRED: ['تاريخ البدء', 'start date'], PROJECT_END_DATE_REQUIRED: ['تاريخ الإنجاز المتوقع', 'expected completion date'],
    PROJECT_DATES_INVALID: ['تواريخ صحيحة (الإنجاز بعد البدء)', 'valid dates (completion after start)'],
    SUPERVISOR_REQUEST_REQUIRED: ['إرسال طلب إشراف', 'a supervision request'], SUPERVISOR_APPROVAL_REQUIRED: ['موافقة المشرف', 'supervisor approval'],
    HANDBOOK_REQUIRED: ['دليل المشروع', 'the project handbook']
  };
  const setupRequirement = (code) => (SETUP_REQUIREMENTS[code] ? L(SETUP_REQUIREMENTS[code]) : code);
  const personName = (u) => (u ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || u.displayName || u.email || '' : '');
  const initial = (name) => (String(name || '').trim()[0] || '؟').toUpperCase();
  // profile photo: a small data URL saved on the account (PATCH /users/me { avatar }); without one
  // the first letter of the name is shown
  const avatarUrl = (u) => (u && typeof u.avatar === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(u.avatar) ? u.avatar : '');
  /** <span> avatar of a person: the photo when there is one, otherwise the first letter */
  function avatarHtml(u, cls = '') {
    const url = avatarUrl(u); const name = personName(u);
    return url ? `<span class="${esc(cls)} app-avatar has-photo" style="background-image:url('${url}')" role="img" aria-label="${esc(name)}"></span>`
      : `<span class="${esc(cls)} app-avatar" aria-hidden="true">${esc(initial(name))}</span>`;
  }
  /** shows the photo (or first letter) of the user in an existing avatar element */
  function paintAvatar(el, u) {
    if (!el) return;
    const url = avatarUrl(u);
    el.classList.add('app-avatar');
    el.classList.toggle('has-photo', !!url);
    el.style.backgroundImage = url ? `url('${url}')` : '';
    el.textContent = url ? '' : initial(personName(u));
  }

  function toast(text, type = 'info') {
    let box = document.querySelector('.app-toasts');
    if (!box) { box = document.createElement('div'); box.className = 'app-toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
    const el = document.createElement('div');
    el.className = `app-toast app-toast--${type}`;
    el.textContent = text;
    box.append(el);
    setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 6000 : 3500);
  }

  /** loading / empty / error state inside a container */
  function state(container, kind, opts = {}) {
    if (!container) return;
    const title = opts.title || (kind === 'error' ? T('تعذّر تحميل البيانات', 'Could not load the data') : kind === 'empty' ? T('لا توجد بيانات بعد', 'Nothing here yet') : T('جارٍ التحميل…', 'Loading…'));
    const text = opts.error ? Api.message(opts.error) : opts.text || '';
    container.innerHTML = `<div class="app-state app-state--${kind}" ${kind === 'error' ? 'role="alert"' : 'role="status"'}>
      <strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}
      ${opts.action ? `<a class="app-state__action" href="${esc(opts.action.href)}">${esc(opts.action.label)}</a>` : ''}
      ${opts.retry ? `<button class="app-state__action" type="button" data-retry>${esc(T('إعادة المحاولة', 'Try again'))}</button>` : ''}</div>`;
    if (opts.retry) container.querySelector('[data-retry]').addEventListener('click', opts.retry);
    // loading: the compact wave loader replaces the text, only if the data takes more than 250 ms
    // (fast answers never flash a loader); it disappears as soon as the area is redrawn
    if (kind === 'loading' && window.TammhaLoader) {
      const box = container.querySelector('.app-state--loading');
      setTimeout(() => {
        if (!box || !box.isConnected) return;
        box.classList.add('app-state--waving');
        window.TammhaLoader.show({ target: box, label: title });
      }, 250);
    }
  }

  /** run an async action from a button: disables it, shows errors as toasts */
  async function busy(button, fn, opts = {}) {
    if (button) { if (button.disabled) return undefined; button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try { return await fn(); } catch (e) {
      if (!opts.silent) toast(Api.message(e), 'error');
      if (opts.rethrow) throw e;
      return undefined;
    } finally { if (button) { button.disabled = false; button.removeAttribute('aria-busy'); } }
  }

  // ---------- session ----------
  const here = () => location.pathname.split('/').pop() || 'dashboard.html';
  const params = new URLSearchParams(location.search);
  let user = null;
  let readyResolve; let readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  ready.catch(() => {});

  function roleLabel(u) {
    if (!u) return '';
    if (u.role === 'SUPERVISOR') return T('مشرف أكاديمي', 'Academic supervisor');
    if (u.role === 'ADMIN') return T('مسؤول النظام', 'Administrator');
    return T('طالب', 'Student');
  }
  function fillShell(u) {
    const name = personName(u);
    document.querySelectorAll('.profile__text strong, [data-me-name]').forEach((el) => { el.textContent = name; });
    document.querySelectorAll('.profile__text small, [data-me-title]').forEach((el) => { el.textContent = roleLabel(u); });
    document.querySelectorAll('[data-me-email]').forEach((el) => { el.textContent = u.email; });
    document.querySelectorAll('.profile .profile__avatar, [data-me-avatar]').forEach((el) => paintAvatar(el, u));
  }

  async function logout() {
    const s = Api.session();
    try { if (s) await Api.post('/auth/logout', { refreshToken: s.refreshToken }, { redirectOn401: false }); } catch (e) { /* the local session ends anyway */ }
    Api.clearSession();
    location.href = 'login.html';
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('.settings-logout, [data-logout]');
    if (!a) return;
    e.preventDefault();
    logout();
  });

  // ---------- notifications (badge for everyone; menu for students) ----------
  // The server writes notification texts in English; in Arabic the title and a short
  // description are taken from the notification type (the English text stays the source).
  const NOTIFICATION_TYPES = {
    TASK_ASSIGNED: ['أُسندت إليك مهمة', 'Task assigned'], TASK_UPDATED: ['تحديث على مهمة', 'Task updated'],
    TASK_DUE_SOON: ['موعد تسليم مهمة يقترب', 'Task due soon'], TASK_OVERDUE: ['مهمة متأخرة', 'Task overdue'],
    MILESTONE_DUE: ['موعد مرحلة يقترب', 'Stage due'], PROJECT_UPDATE: ['تحديث على المشروع', 'Project update'],
    PROJECT_STATUS_CHANGED: ['تغيّرت حالة المشروع', 'Project status changed'],
    MEETING_INVITATION: ['دعوة إلى اجتماع', 'Meeting invitation'], MEETING_UPDATED: ['تعديل على اجتماع', 'Meeting updated'], MEETING_CANCELLED: ['إلغاء اجتماع', 'Meeting cancelled'],
    FEEDBACK_RECEIVED: ['ملاحظة جديدة من المشرف', 'New supervisor feedback'], DOCUMENT_UPLOADED: ['ملف جديد', 'New file'],
    DOCUMENT_SUBMITTED: ['ملف بانتظار المراجعة', 'File submitted for review'], SUBMISSION_STATUS_CHANGED: ['تغيّرت حالة مراجعة ملف', 'File review status changed'],
    TEAM_INVITATION: ['دعوة للانضمام إلى فريق', 'Team invitation'], SUPERVISION_REQUESTED: ['طلب إشراف جديد', 'New supervision request'],
    SUPERVISION_RESPONDED: ['رد على طلب الإشراف', 'Supervision request answered'], HANDBOOK_PROCESSED: ['معالجة دليل المشروع', 'Handbook processed'],
    COMMENT_ADDED: ['تعليق جديد على مهمة', 'New task comment'], SYSTEM: ['إشعار من المنصة', 'Platform notice']
  };
  function notificationText(n) {
    const t = NOTIFICATION_TYPES[n.type];
    return { title: t ? L(t) : n.title || '', text: isEn() || !t ? n.message || '' : T('افتح الإشعار للاطلاع على التفاصيل.', '') };
  }
  function notificationLink(n) {
    const d = n.data || {};
    if (n.type === 'TEAM_INVITATION') return 'projects.html#invitations';
    if (d.taskId) return `tasks.html?${d.projectId ? `project=${encodeURIComponent(d.projectId)}&` : ''}task=${encodeURIComponent(d.taskId)}`;
    if (d.meetingId) return 'meetings.html';
    if (d.documentId) return 'project-files.html' + (d.projectId ? `?project=${encodeURIComponent(d.projectId)}` : '');
    if (d.projectId) return `project-overview.html?project=${encodeURIComponent(d.projectId)}`;
    return '';
  }
  async function refreshBadge() {
    try {
      const r = await Api.get('/notifications/unread-count', { redirectOn401: false });
      const n = Number(r?.unreadCount ?? r?.count ?? 0) || 0;
      document.querySelectorAll('[data-unread]').forEach((el) => { el.textContent = n > 99 ? '99+' : String(n); el.hidden = n === 0; });
      return n;
    } catch (e) { return 0; }
  }
  function mountStudentBell() {
    const bar = document.querySelector('.topbar');
    if (!bar || bar.querySelector('.app-bell')) return;
    const wrap = document.createElement('div');
    wrap.className = 'app-bell';
    wrap.innerHTML = `<button class="app-bell__button" type="button" aria-expanded="false" aria-haspopup="true" aria-label="${esc(T('الإشعارات', 'Notifications'))}">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>
        <span class="app-bell__count" data-unread hidden></span></button>
      <div class="app-bell__panel" hidden role="dialog" aria-label="${esc(T('الإشعارات', 'Notifications'))}">
        <div class="app-bell__head"><strong>${esc(T('الإشعارات', 'Notifications'))}</strong><button type="button" data-read-all>${esc(T('تحديد الكل كمقروء', 'Mark all as read'))}</button></div>
        <div class="app-bell__list"></div></div>`;
    // same arrangement as the supervisor header: [profile (name)] then [bell], in reading order
    let end = bar.querySelector('.app-topbar-end, .sv-topbar-end');
    if (!end) { end = document.createElement('div'); end.className = 'app-topbar-end'; bar.append(end); }
    const profile = bar.querySelector('.profile'); if (profile) end.append(profile);
    end.prepend(wrap);
    const btn = wrap.querySelector('.app-bell__button');
    const panel = wrap.querySelector('.app-bell__panel');
    const list = wrap.querySelector('.app-bell__list');
    // the list is read once when the page opens and refreshed quietly each time the menu opens:
    // what is already known shows at once, without a loading screen
    let loading = null;
    async function load() {
      if (loading) return loading;
      loading = fetchList().finally(() => { loading = null; });
      return loading;
    }
    async function fetchList() {
      try {
        const page = await Api.get('/notifications', { query: { limit: 20 }, redirectOn401: false });
        const items = Array.isArray(page) ? page : page.items || page.data || [];
        if (!items.length) { state(list, 'empty', { title: T('لا توجد إشعارات', 'No notifications') }); return; }
        list.innerHTML = items.map((n) => { const v = notificationText(n); return `<button class="app-bell__item${n.isRead || n.readAt ? '' : ' is-unread'}" type="button" data-id="${esc(n.id)}" data-href="${esc(notificationLink(n))}">
            <strong>${esc(v.title)}</strong><span>${esc(v.text)}</span><small>${esc(fmtDateTime(n.createdAt))}</small></button>`; }).join('');
      } catch (e) { if (!list.children.length) state(list, 'error', { error: e, retry: load }); }
    }
    load();
    btn.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open; btn.setAttribute('aria-expanded', String(open));
      if (open) load();
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    list.addEventListener('click', async (e) => {
      const item = e.target.closest('.app-bell__item'); if (!item) return;
      try { await Api.patch(`/notifications/${encodeURIComponent(item.dataset.id)}/read`); } catch (err) { /* ignore */ }
      item.classList.remove('is-unread'); refreshBadge();
      if (item.dataset.href) location.href = item.dataset.href;
    });
    wrap.querySelector('[data-read-all]').addEventListener('click', async () => {
      try { await Api.patch('/notifications/read-all'); list.querySelectorAll('.is-unread').forEach((x) => x.classList.remove('is-unread')); refreshBadge(); } catch (e) { toast(Api.message(e), 'error'); }
    });
  }

  // ---------- onboarding (students, first sign-in) ----------
  // Three short pages, once per account: welcome → college and major (PATCH /users/me) →
  // a quick tour. Finishing (or "Later") calls POST /users/me/onboarding/complete.
  // College and major can be changed later in Settings.
  function collegeMajorFields(prefix, u) {
    return `<label class="onb-field"><span>${esc(T('الكلية', 'College'))}</span><input id="${prefix}College" maxlength="160" autocomplete="off" placeholder="${esc(T('مثال: كلية الهندسة وعلوم الحاسب', 'e.g. College of Engineering and Computer Science'))}" value="${esc(u.college || '')}"></label>
      <label class="onb-field"><span>${esc(T('التخصص', 'Major'))}</span><input id="${prefix}Major" maxlength="160" autocomplete="off" placeholder="${esc(T('مثال: الذكاء الاصطناعي', 'e.g. Artificial Intelligence'))}" value="${esc(u.major || '')}"></label>`;
  }
  function onboarding(u) {
    if (u.role !== 'STUDENT' || u.onboardingCompleted) return;
    if (document.getElementById('onbDialog')) return;
    const ICON = {
      projects: '<path d="M4 7h16v12H4zM8 7V5h8v2"></path>', tasks: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"></path>',
      meetings: '<rect x="3" y="6" width="13" height="12" rx="3"></rect><path d="m16 10 5-3v10l-5-3"></path>', handbook: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"></path><path d="M5 17a3 3 0 0 1 3-3h10"></path>',
    };
    const item = (k, t, d) => `<li><span class="onb__tour-icon"><svg aria-hidden="true" viewBox="0 0 24 24">${ICON[k]}</svg></span><div><b>${esc(t)}</b><small>${esc(d)}</small></div></li>`;
    const TABS = [T('الكلية والتخصص', 'College & major'), T('المشروع والمهام', 'Project & tasks'), T('الاجتماعات والدليل', 'Meetings & handbook')];
    const later = `<button class="app-btn app-btn--ghost" type="button" data-onb-done>${esc(T('لاحقًا', 'Later'))}</button>`;
    const dlg = document.createElement('div');
    dlg.className = 'app-modal onb'; dlg.id = 'onbDialog';
    dlg.innerHTML = `<div class="app-modal__dialog onb__dialog" role="dialog" aria-modal="true" aria-labelledby="onbWelcomeTitle">
      <section class="onb__welcome" data-onb-step="0">
        <img class="onb__logo" src="assets/tammha-mark.png" alt="">
        <h2 id="onbWelcomeTitle">${u.firstName ? esc(T(`أهلًا ${u.firstName}، مرحبًا بك في تمّمها`, `Hi ${u.firstName}, welcome to Tammha`)) : esc(T('مرحبًا بك في تمّمها', 'Welcome to Tammha'))}</h2>
        <p>${esc(T('مساحة واحدة لمشروع تخرجك: المراحل والمهام والملفات والاجتماعات ودليل المشروع، معك ومع فريقك ومشرفك.', 'One place for your graduation project: stages, tasks, files, meetings and the handbook, with your team and supervisor.'))}</p>
        <div class="onb__actions">${later}<button class="app-btn app-btn--primary" type="button" data-onb-go="1">${esc(T('التالي', 'Next'))}</button></div>
      </section>
      <div class="onb__tabs-wrap" hidden>
        <ol class="onb__dots" aria-label="${esc(T('خطوات التعريف', 'Introduction steps'))}">${TABS.map((t, i) => `<li data-onb-tab="${i + 1}" aria-label="${esc(t)}"></li>`).join('')}</ol>
        <section class="onb__page" data-onb-step="1" hidden>
          <h3>${esc(T('كليتك وتخصصك', 'Your college and major'))}</h3>
          <p>${esc(T('تظهر في ملفك الشخصي، ويمكنك تعديلها لاحقًا من الإعدادات.', 'They appear on your profile; you can change them later in Settings.'))}</p>
          <form class="onb__form" id="onbForm" novalidate>${collegeMajorFields('onb', u)}<p class="app-field-error" id="onbError" role="alert"></p>
          <div class="onb__actions">${later}<button class="app-btn app-btn--primary" type="submit">${esc(T('التالي', 'Next'))}</button></div></form>
        </section>
        <section class="onb__page" data-onb-step="2" hidden>
          <h3>${esc(T('مشروعك وفريقك', 'Your project and team'))}</h3>
          <ul class="onb__tour">${item('projects', T('المشاريع', 'Projects'), T('أنشئ مشروعك بصفتك قائد الفريق، أو انضم إلى مشروع زميلك برمز الدعوة.', 'Create your project as Team Leader, or join a classmate’s project with an invitation code.'))}${item('tasks', T('المهام والمراحل', 'Tasks and stages'), T('وزّع المهام على أعضاء الفريق وتابع تقدّم كل مرحلة.', 'Share the tasks among the team and follow each stage.'))}</ul>
          <div class="onb__actions">${later}<button class="app-btn app-btn--primary" type="button" data-onb-go="3">${esc(T('التالي', 'Next'))}</button></div>
        </section>
        <section class="onb__page" data-onb-step="3" hidden>
          <h3>${esc(T('الاجتماعات والدليل', 'Meetings and the handbook'))}</h3>
          <ul class="onb__tour">${item('meetings', T('الاجتماعات والملاحظات', 'Meetings and notes'), T('اجتمع مع الفريق والمشرف، واحفظ ملاحظاتك الخاصة بعد كل اجتماع.', 'Meet the team and the supervisor, and keep your own notes after each meeting.'))}${item('handbook', T('دليل المشروع', 'Project handbook'), T('اعتمد دليل جامعتك واستفد من المساعد الذكي في تلخيصه واستخراج المهام.', 'Use your university handbook and let the assistant summarise it and suggest tasks.'))}</ul>
          <div class="onb__start"><a class="onb__start-btn onb__start-btn--primary" href="projects.html?new=1" data-onb-done>${esc(T('إنشاء مشروع', 'Create a project'))}</a><a class="onb__start-btn" href="join.html" data-onb-done>${esc(T('الانضمام برمز دعوة', 'Join with a code'))}</a></div>
          <div class="onb__actions">${later}<button class="app-btn app-btn--primary" type="button" data-onb-done>${esc(T('إنهاء', 'Finish'))}</button></div>
        </section>
      </div></div>`;
    document.body.append(dlg);
    const go = (n) => {
      dlg.querySelector('[data-onb-step="0"]').hidden = n !== 0;
      dlg.querySelector('.onb__tabs-wrap').hidden = n === 0;
      dlg.querySelectorAll('.onb__page').forEach((p) => { p.hidden = p.dataset.onbStep !== String(n); });
      dlg.querySelectorAll('[data-onb-tab]').forEach((t) => { const k = +t.dataset.onbTab; t.classList.toggle('is-active', k === n); t.classList.toggle('is-done', k < n); if (k === n) t.setAttribute('aria-current', 'step'); else t.removeAttribute('aria-current'); });
      const f = dlg.querySelector(`[data-onb-step="${n}"] input, [data-onb-step="${n}"] .app-btn--primary`); if (f) f.focus();
    };
    dlg.querySelector('#onbForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const college = dlg.querySelector('#onbCollege').value.trim(); const major = dlg.querySelector('#onbMajor').value.trim();
      const err = dlg.querySelector('#onbError'); err.textContent = '';
      if (!college || !major) { err.textContent = T('اكتب الكلية والتخصص.', 'Enter your college and major.'); return; }
      await busy(e.submitter || dlg.querySelector('#onbForm [type="submit"]'), async () => {
        try { const nu = await Api.patch('/users/me', { college, major }); Object.assign(u, { college: nu.college, major: nu.major }); Api.saveUser(u); go(2); }
        catch (er) { err.textContent = Api.message(er); }
      });
    });
    dlg.addEventListener('click', async (e) => {
      const next = e.target.closest('[data-onb-go]'); if (next) { go(+next.dataset.onbGo); return; }
      const done = e.target.closest('[data-onb-done]'); if (!done) return;
      e.preventDefault();
      // once only: "Later" and "Finish" both close the onboarding for good
      try { await Api.post('/users/me/onboarding/complete', {}); u.onboardingCompleted = true; Api.saveUser(u); } catch (err) { /* shown again next time */ }
      dlg.remove();
      if (done.tagName === 'A' && !location.href.endsWith(done.getAttribute('href'))) location.href = done.getAttribute('href');
    });
  }

  // ---------- projects of the user ----------
  let projectsCache = null;
  const projectKey = () => `tammha-current-project:${user ? user.id : ''}`;
  async function projects(force = false) {
    if (projectsCache && !force) return projectsCache;
    const list = await Api.get(user && user.role === 'SUPERVISOR' ? '/projects/supervised' : '/projects');
    // each item is a project workspace { project, team, leader, supervisors, viewer, progress, … };
    // id / name are copied to the top level for convenience
    projectsCache = (Array.isArray(list) ? list : list.items || []).map((w) => (w && w.project ? Object.assign(w, { id: w.project.id, name: w.project.name }) : w));
    return projectsCache;
  }
  function currentProjectId(list) {
    const fromUrl = params.get('project');
    let id = null;
    try { id = localStorage.getItem(projectKey()); } catch (e) { /* ignore */ }
    if (fromUrl && list.some((p) => p.id === fromUrl)) id = fromUrl;
    if (!id || !list.some((p) => p.id === id)) id = list[0] ? list[0].id : null;
    if (id) setCurrentProject(id);
    return id;
  }
  /**
   * The project this page shows; links keep ?project=<id>. For a student, GET /projects already
   * returns the full workspace of each project, so the first call of a page uses it directly (one
   * request less before the page can draw); later calls (after an action) read it fresh.
   */
  let workspaceServed = false;
  async function currentWorkspace() {
    const first = !workspaceServed;
    workspaceServed = true;
    const list = await projects();
    const id = currentProjectId(list);
    if (!id) return null;
    const url = new URL(location.href);
    if (url.searchParams.get('project') !== id) { url.searchParams.set('project', id); history.replaceState(null, '', url); }
    document.querySelectorAll('.project-tab, [data-project-link]').forEach((a) => { a.href = `${a.getAttribute('href').split('?')[0]}?project=${encodeURIComponent(id)}`; });
    const cached = list.find((p) => p.id === id);
    if (first && cached && cached.team && cached.viewer) return cached;
    const w = await Api.get(`/projects/${encodeURIComponent(id)}`);
    return Object.assign(w, { id: w.project.id, name: w.project.name });
  }
  function setCurrentProject(id) { try { localStorage.setItem(projectKey(), id); } catch (e) { /* ignore */ } }
  /** project selector for users with several projects; calls onChange(id) */
  function projectSwitcher(host, list, current, onChange) {
    if (!host || list.length < 2) return;
    const wrap = document.createElement('label');
    wrap.className = 'app-project-switch';
    wrap.innerHTML = `<span>${esc(T('المشروع', 'Project'))}</span><select>${list.map((p) => `<option value="${esc(p.id)}"${p.id === current ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
    wrap.querySelector('select').addEventListener('change', (e) => { setCurrentProject(e.target.value); onChange(e.target.value); });
    host.append(wrap);
  }

  /** project pages: the completion of the project in the title bar (instead of a project list) */
  function projectHeroProgress(w) {
    const host = document.querySelector('.project-detail-hero__content'); if (!host || !w) return;
    const pct = Math.max(0, Math.min(100, Math.round(w.progress?.percent ?? 0)));
    let el = host.querySelector('.project-hero-progress');
    if (!el) { el = document.createElement('div'); el.className = 'project-hero-progress'; host.append(el); }
    el.innerHTML = `<span class="project-hero-progress__label">${esc(T('نسبة الإنجاز', 'Completion'))}</span>
      <span class="project-hero-progress__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(T(`نسبة إنجاز المشروع ${pct} بالمئة`, `Project completion ${pct} percent`))}"><span style="width:${pct}%"></span></span>
      <strong dir="ltr">${pct}%</strong>`;
  }

  // ---------- start ----------
  async function start() {
    const role = document.body.dataset.appRole;
    if (!role) { readyResolve(null); return; }
    const s = Api.session();
    if (!s || !s.accessToken) {
      location.replace(`login.html?next=${encodeURIComponent(here() + location.search)}`);
      return;
    }
    if (s.user) fillShell(s.user); // last known name while the real one loads
    // the bell is placed at once (from the last known role), so the header does not shift when the account loads
    if (s.user?.role === 'STUDENT' && (!role || role === 'STUDENT')) mountStudentBell();
    try {
      user = await Api.get('/auth/me');
      Api.saveUser(user);
    } catch (e) {
      if (e.status !== 401) {
        document.querySelector('main')?.prepend(Object.assign(document.createElement('div'), { className: 'app-banner app-banner--error', textContent: Api.message(e) }));
      }
      readyReject(e);
      return;
    }
    if (user.role === 'ADMIN') {
      readyReject(new Error('ADMIN'));
      document.body.innerHTML = `<main class="app-standalone"><div class="app-state app-state--empty"><strong>${esc(T('حساب مسؤول النظام', 'Administrator account'))}</strong><p>${esc(T('لا تتضمن واجهة تممها صفحات لمسؤول النظام؛ تُدار حسابات المشرفين وأدلة الجامعات عبر واجهة الـ API وأدوات الخادم.', 'Tammha has no administrator pages; supervisor accounts and university handbooks are managed through the API and the server tools.'))}</p><button class="app-state__action" type="button" data-logout>${esc(T('تسجيل الخروج', 'Sign out'))}</button></div></main>`;
      return;
    }
    if (role === 'STUDENT' && user.role !== 'STUDENT') { location.replace('supervisor.html'); return; }
    if (role === 'SUPERVISOR' && user.role !== 'SUPERVISOR') { location.replace('dashboard.html'); return; }
    if (user.emailVerified === false) { location.replace('verify-email.html?pending=1'); return; }
    fillShell(user);
    if (user.role === 'STUDENT') mountStudentBell();
    refreshBadge();
    readyResolve(user);
    onboarding(user);
  }

  /**
   * People a task can be assigned to: the project's leader (also when it is the signed-in user)
   * and every active team member, read fresh from GET /teams/:id/members; the workspace copy is
   * the fallback. Leader first, then by name. Each item: { userId, user, isLeader, isMe, label }.
   */
  async function assignees(w) {
    let rows = [];
    if (w && w.team && w.team.id) {
      try { rows = await window.TammhaApi.get(`/teams/${encodeURIComponent(w.team.id)}/members`); } catch (e) { rows = []; }
    }
    if (!rows || !rows.length) rows = (w && w.team && w.team.members) || [];
    const byId = new Map();
    rows.forEach((m) => { if (m && m.userId && m.user) byId.set(m.userId, { userId: m.userId, user: m.user, isLeader: m.teamRole === 'LEADER' }); });
    if (w && w.leader && w.leader.id) {
      const cur = byId.get(w.leader.id);
      if (cur) cur.isLeader = true; else byId.set(w.leader.id, { userId: w.leader.id, user: w.leader, isLeader: true });
    }
    const meId = user && user.id;
    return [...byId.values()].map((m) => {
      const isMe = m.userId === meId;
      const tags = [m.isLeader ? T('قائد الفريق', 'Team Leader') : '', isMe ? T('أنت', 'you') : ''].filter(Boolean);
      return { ...m, isMe, label: `${personName(m.user)}${tags.length ? ` (${tags.join(T('، ', ', '))})` : ''}` };
    }).sort((a, b) => (b.isLeader - a.isLeader) || a.label.localeCompare(b.label));
  }

  /** tells other open pages (dashboard calendar) that tasks changed */
  function tasksChanged() { try { localStorage.setItem('tammha-tasks-changed', String(Date.now())); } catch (e) { /* ignore */ } }

  /** Resizes an image file to a JPEG data URL (longest side `max` px, at most `limit` characters). */
  async function imageDataUrl(file, max = 640, limit = 190000) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('type');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k)); const h = Math.max(1, Math.round(img.naturalHeight * k));
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
      for (const q of [0.85, 0.75, 0.62, 0.5, 0.4]) { const data = canvas.toDataURL('image/jpeg', q); if (data.length <= limit) return data; }
      throw new Error('too-large');
    } finally { URL.revokeObjectURL(url); }
  }
  /** A project's image (data URL) for a CSS background, or '' */
  function projectImage(p) { const t = p && p.thumbnail; return typeof t === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(t) ? t : ''; }

  /**
   * Project image on the project cards (dashboard and projects page): the team leader clicks
   * the image area to add or change it. The picture shows at once; it is saved in the
   * background (PATCH /projects/:id { thumbnail }).
   */
  const IMG_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"></rect><circle cx="9" cy="10" r="1.6"></circle><path d="m21 16-5-5-8 8"></path></svg>';
  function projectImageSlot(p, canEdit, cls) {
    const img = projectImage(p);
    const style = img ? ` style="background-image:url('${img}')"` : '';
    const label = img ? T('تغيير صورة المشروع', 'Change project image') : T('إضافة صورة المشروع', 'Add a project image');
    if (!canEdit) return `<div class="${cls} project-image${img ? ' has-image' : ' is-empty'}" aria-hidden="true"${style}>${img ? '' : IMG_ICON}</div>`;
    return `<button class="${cls} project-image project-image--edit${img ? ' has-image' : ' is-empty'}" type="button" data-project-image="${esc(p.id)}" aria-label="${esc(label)}" title="${esc(label)}"${style}>${img ? `<span class="project-image__hint">${IMG_ICON}${esc(T('تغيير', 'Change'))}</span>` : `${IMG_ICON}<span>${esc(T('إضافة صورة', 'Add image'))}</span>`}</button>`;
  }
  document.addEventListener('click', (e) => {
    const slot = e.target.closest('[data-project-image]'); if (!slot) return;
    e.preventDefault(); e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) { toast(T('الصورة أكبر من 5MB.', 'The image is larger than 5 MB.'), 'error'); return; }
      let data;
      try { data = await imageDataUrl(file); } catch (x) { toast(T('اختر صورة PNG أو JPG أو WebP.', 'Choose a PNG, JPG or WebP image.'), 'error'); return; }
      const before = slot.getAttribute('style') || '';
      const beforeHtml = slot.innerHTML; const wasEmpty = slot.classList.contains('is-empty');
      slot.style.backgroundImage = `url('${data}')`; slot.classList.add('has-image'); slot.classList.remove('is-empty');
      slot.innerHTML = `<span class="project-image__hint">${IMG_ICON}${esc(T('تغيير', 'Change'))}</span>`;
      try {
        await Api.patch(`/projects/${encodeURIComponent(slot.dataset.projectImage)}`, { thumbnail: data });
        projectsCache = null;
      } catch (x) {
        slot.setAttribute('style', before); slot.innerHTML = beforeHtml; slot.classList.toggle('is-empty', wasEmpty); slot.classList.toggle('has-image', !wasEmpty);
        toast(Api.message(x), 'error');
      }
    });
    input.click();
  });

  window.TammhaUI = Object.freeze({ setupRequirement, imageDataUrl, projectImage, projectImageSlot, collegeMajorFields, T, L, esc, lang, isEn, fmtDate, fmtShortDate, fmtTime, fmtDateTime, isoDay, fmtSize, personName, initial, avatarUrl, avatarHtml, paintAvatar, toast, state, busy, roleLabel, tasksChanged });
  window.TammhaSession = Object.freeze({
    ready, notificationText, notificationLink,
    get user() { return user; },
    projects, currentProjectId, currentWorkspace, setCurrentProject, projectSwitcher, projectHeroProgress, refreshBadge, logout, assignees,
    invalidateProjects() { projectsCache = null; }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
