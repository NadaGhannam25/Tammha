// ===== Student dashboard (dashboard.html) — connected to the API =====
// Projects:  GET /projects (cards: name, progress, last update; the first two are shown)
// Meetings:  GET /meetings/upcoming (all of the student's projects, soonest first)
// Calendar:  GET /tasks?dueFrom&dueTo (deadlines) + GET /meetings?from&to, per day
// Invitations waiting: GET /team-invitations/incoming (a short notice links to the projects page)
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession; const D = window.TammhaDomain;
  const { T, L, esc } = UI;
  // one loading screen over the whole dashboard (header, projects, meetings and calendar) from the
  // first moment until every section has its data; then all sections appear together
  const main = document.querySelector('.main-content');
  const pageLoader = main && window.TammhaLoader ? window.TammhaLoader.show({ target: main, cover: true, label: T('جارٍ تحميل لوحة التحكم…', 'Loading dashboard…'), showSlow: false }) : null;
  if (pageLoader) main.classList.add('is-page-loading');
  function revealPage() {
    if (!pageLoader) return;
    main.classList.remove('is-page-loading');
    pageLoader.done();
  }
  const box = document.getElementById('dashProjects');
  const meetingsBox = document.getElementById('dashMeetings');
  const ICON_ARROW = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"></path></svg>';

  async function projects(inline = true) {
    if (inline) UI.state(box, 'loading');
    try {
      const items = await S.projects(true);
      projectNames = Object.fromEntries(items.map((w) => [w.id, w.name]));
      if (!items.length) {
        UI.state(box, 'empty', { title: T('لا توجد مشاريع بعد', 'No projects yet'), text: T('أنشئ مشروعًا جديدًا بصفتك قائد الفريق، أو انضم إلى مشروع زميلك برمز الدعوة.', 'Create a new project as Team Leader, or join a classmate’s project with an invitation code.'), action: { href: 'projects.html?new=1', label: T('إنشاء مشروع', 'Create a project') } });
        return;
      }
      box.innerHTML = items.slice(0, 2).map((w) => {
        const p = w.project; const pct = Math.round(w.progress?.percent ?? 0);
        const role = w.viewer?.isLeader ? T('قائد الفريق', 'Team Leader') : T('عضو في الفريق', 'Team member');
        return `<article class="project-card"><div aria-hidden="true" class="project-card__visual"></div><div class="project-card__body">
          <div class="project-card__topline"><div><h3>${esc(p.name)}</h3><p>${esc(w.team?.name || '')} · ${esc(role)}</p></div>
          <a aria-label="${esc(T('فتح المشروع', 'Open project'))}" class="round-arrow" href="project-overview.html?project=${encodeURIComponent(p.id)}">${ICON_ARROW}</a></div>
          <div class="progress-row"><div aria-label="${esc(T(`نسبة إنجاز المشروع ${pct} بالمئة`, `Project completion ${pct} percent`))}" class="progress-track"><span style="width: ${pct}%"></span></div><strong>${pct}%</strong></div>
          <p class="project-card__date">${esc(T('آخر تحديث:', 'Last updated:'))} ${esc(UI.fmtDate(p.updatedAt))}</p></div></article>`;
      }).join('');
    } catch (e) { UI.state(box, 'error', { error: e, retry: projects }); }
  }

  async function meetings(inline = true) {
    if (inline) UI.state(meetingsBox, 'loading');
    try {
      const page = await Api.get('/meetings/upcoming', { query: { limit: 3 } });
      const items = page.items || page;
      if (!items.length) { UI.state(meetingsBox, 'empty', { title: T('لا توجد اجتماعات قادمة', 'No upcoming meetings'), text: T('تظهر هنا الاجتماعات المجدولة لمشاريعك.', 'Scheduled meetings of your projects appear here.') }); return; }
      meetingsBox.innerHTML = items.map((m, i) => `${i ? '<div class="meeting-divider"></div>' : ''}<article class="meeting-row"><span class="meeting-accent"></span>
        <div class="meeting-info"><h3>${esc(m.title)}</h3><p>${esc(m.description || UI.personName(m.createdBy))}</p></div>
        <div class="meeting-time"><strong>${esc(UI.fmtTime(m.scheduledAt))} - ${esc(UI.fmtTime(m.endsAt))}</strong><span>${esc(UI.fmtDate(m.scheduledAt))}</span></div></article>`).join('');
    } catch (e) { UI.state(meetingsBox, 'error', { error: e, retry: meetings }); }
  }

  // Calendar: tasks (with their status, project and owner) and meetings, per day. The visible
  // month and the months around it are read; a change of month reads the new range.
  const TASK_STATUS = (t) => {
    const late = D && D.isOverdue(t.status, t.dueDate ? UI.isoDay(t.dueDate) : '', UI.isoDay(new Date()));
    const st = (D && D.TASK_STATUSES[t.status]) || { label: [t.status, t.status], cls: 'idle' };
    return late ? { label: T('متأخرة', 'Overdue'), cls: 'overdue' } : { label: L(st.label), cls: st.cls };
  };
  let range = null;
  let projectNames = {};
  let namesReady = Promise.resolve();
  async function calendar(around) {
    const base = around || new Date();
    const from = new Date(base.getFullYear(), base.getMonth() - 1, 1); const to = new Date(base.getFullYear(), base.getMonth() + 2, 0, 23, 59, 59);
    range = { from, to };
    const key = (d) => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`; };
    const map = {};
    const add = (d, item) => { (map[key(d)] = map[key(d)] || []).push(item); };
    try {
      const tasks = []; let page = 1; let pages = 1;
      do {
        const r = await Api.get('/tasks', { query: { dueFrom: UI.isoDay(from), dueTo: UI.isoDay(to), limit: 100, page } });
        tasks.push(...(r.items || [])); pages = r.meta?.totalPages || 1; page += 1;
      } while (page <= pages && page < 10);
      const mts = await Api.get('/meetings', { query: { from: from.toISOString(), to: to.toISOString(), limit: 100 } });
      await namesReady;
      if (range.from !== from) return; // a newer month was asked for meanwhile
      tasks.filter((t) => t.dueDate && t.status !== 'CANCELLED').forEach((t) => {
        const st = TASK_STATUS(t);
        add(t.dueDate, {
          type: 'task', title: t.title, status: st.label, statusCls: st.cls,
          meta: [projectNames[t.projectId], t.assignedStudent ? UI.personName(t.assignedStudent) : T('غير مُسنَدة', 'Unassigned')].filter(Boolean).join(' · '),
          href: `tasks.html?project=${encodeURIComponent(t.projectId)}&task=${encodeURIComponent(t.id)}`
        });
      });
      (mts.items || mts || []).forEach((m) => add(m.scheduledAt, { type: 'meeting', title: m.title, status: T('اجتماع', 'Meeting'), statusCls: 'meeting', meta: `${UI.fmtTime(m.scheduledAt)} - ${UI.fmtTime(m.endsAt)}`, href: 'meetings.html' }));
      window.TammhaCalendar?.setItems(map);
    } catch (e) { window.TammhaCalendar?.setError(Api.message(e)); }
  }
  // a new month in the calendar reads its tasks; tasks added or moved on another page show here too
  if (window.TammhaCalendar) window.TammhaCalendar.onMonthChange = (d) => { if (!range || d < range.from || d > range.to) calendar(d); };
  const refreshCalendar = () => calendar(window.TammhaCalendar?.visibleMonth());
  window.addEventListener('storage', (e) => { if (e.key === 'tammha-tasks-changed') refreshCalendar(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) refreshCalendar(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && range) refreshCalendar(); });

  async function invitations() {
    try {
      const items = (await Api.get('/team-invitations/incoming')).filter((i) => i.status === 'PENDING');
      if (!items.length) return;
      const note = document.createElement('a');
      note.className = 'app-banner'; note.href = 'projects.html#invitations';
      note.textContent = T(`لديك ${items.length} دعوة للانضمام إلى فريق. اضغط لعرضها.`, `You have ${items.length} team invitation(s). Open them.`);
      document.querySelector('.dashboard-grid')?.before(note);
    } catch (e) { /* ignore */ }
  }

  S.ready.then(async () => {
    try {
      namesReady = projects(false); // also gives the calendar the project names
      await Promise.allSettled([namesReady, meetings(false), calendar(), invitations()]);
    } finally {
      revealPage();
    }
  }, () => revealPage());
})();
