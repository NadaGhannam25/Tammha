// ===== Student dashboard (dashboard.html) — connected to the API =====
// Projects:  GET /projects (cards: name, progress, last update; the first two are shown)
// Meetings:  GET /meetings/upcoming (all of the student's projects, soonest first)
// Calendar:  GET /tasks?dueFrom&dueTo (deadlines) + GET /meetings?from&to, per day
// Invitations waiting: GET /team-invitations/incoming (a short notice links to the projects page)
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession;
  const { T, esc } = UI;
  const box = document.getElementById('dashProjects');
  const meetingsBox = document.getElementById('dashMeetings');
  const ICON_ARROW = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"></path></svg>';

  async function projects(showInlineLoader = true) {
    if (showInlineLoader) UI.state(box, 'loading');
    try {
      const items = await S.projects(true);
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

  async function meetings(showInlineLoader = true) {
    if (showInlineLoader) UI.state(meetingsBox, 'loading');
    try {
      const page = await Api.get('/meetings/upcoming', { query: { limit: 3 } });
      const items = page.items || page;
      if (!items.length) { UI.state(meetingsBox, 'empty', { title: T('لا توجد اجتماعات قادمة', 'No upcoming meetings'), text: T('تظهر هنا الاجتماعات المجدولة لمشاريعك.', 'Scheduled meetings of your projects appear here.') }); return; }
      meetingsBox.innerHTML = items.map((m, i) => `${i ? '<div class="meeting-divider"></div>' : ''}<article class="meeting-row"><span class="meeting-accent"></span>
        <div class="meeting-info"><h3>${esc(m.title)}</h3><p>${esc(m.description || UI.personName(m.createdBy))}</p></div>
        <div class="meeting-time"><strong>${esc(UI.fmtTime(m.scheduledAt))} - ${esc(UI.fmtTime(m.endsAt))}</strong><span>${esc(UI.fmtDate(m.scheduledAt))}</span></div></article>`).join('');
    } catch (e) { UI.state(meetingsBox, 'error', { error: e, retry: meetings }); }
  }

  async function calendar() {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - 2, 1); const to = new Date(now.getFullYear(), now.getMonth() + 4, 0);
    const key = (d) => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`; };
    const map = {};
    const add = (d, item) => { (map[key(d)] = map[key(d)] || []).push(item); };
    try {
      const [tasks, mts] = await Promise.all([
        Api.get('/tasks', { query: { dueFrom: UI.isoDay(from), dueTo: UI.isoDay(to), limit: 100 } }),
        Api.get('/meetings', { query: { from: from.toISOString(), to: to.toISOString(), limit: 100 } })
      ]);
      (tasks.items || []).filter((t) => t.dueDate && !['COMPLETED', 'CANCELLED'].includes(t.status)).forEach((t) => add(t.dueDate, { type: 'task', title: t.title, meta: T('موعد التسليم', 'Due date') }));
      (mts.items || mts || []).forEach((m) => add(m.scheduledAt, { type: 'meeting', title: m.title, meta: `${UI.fmtTime(m.scheduledAt)} - ${UI.fmtTime(m.endsAt)}` }));
      window.TammhaCalendar?.setItems(map);
    } catch (e) { /* the calendar stays empty; the rest of the page still works */ }
  }

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
    const loader = window.TammhaLoader?.show({ label: T('جارٍ تحميل لوحة التحكم…', 'Loading dashboard…'), showSlow: false });
    try {
      await Promise.allSettled([projects(false), meetings(false), calendar(), invitations()]);
    } finally { loader?.done(); }
  });
})();
