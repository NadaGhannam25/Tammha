// ===== Tammha — Supervisor experience =====
// Role: monitor + review + feedback + meetings + guidance.
// The supervisor never creates, assigns, reassigns or deletes student tasks, never manages the team,
// never completes project setup and never applies AI-generated tasks. Those stay with the Team Leader.
// Every list comes from the API (api.js / session.js); every action is a server call followed by a
// reload, so what is shown is always what the server stored. No sample data, no localStorage records.
(function () {
  'use strict';

  // ---------- Language ----------
  const LANG_KEY = 'tammha-settings-language';
  let lang = 'ar';
  try { lang = localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ar'; } catch (e) { /* storage unavailable */ }
  const L = (v) => (Array.isArray(v) ? v[lang === 'en' ? 1 : 0] : v);
  const T = (ar, en) => (lang === 'en' ? en : ar);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MONTHS = [['يناير', 'Jan'], ['فبراير', 'Feb'], ['مارس', 'Mar'], ['أبريل', 'Apr'], ['مايو', 'May'], ['يونيو', 'Jun'], ['يوليو', 'Jul'], ['أغسطس', 'Aug'], ['سبتمبر', 'Sep'], ['أكتوبر', 'Oct'], ['نوفمبر', 'Nov'], ['ديسمبر', 'Dec']];
  const WEEKDAYS = [['الأحد', 'Sun'], ['الاثنين', 'Mon'], ['الثلاثاء', 'Tue'], ['الأربعاء', 'Wed'], ['الخميس', 'Thu'], ['الجمعة', 'Fri'], ['السبت', 'Sat']];
  const parse = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (iso) => { if (!iso) return '—'; const d = parse(iso); return lang === 'en' ? `${L(MONTHS[d.getMonth()])} ${d.getDate()}, ${d.getFullYear()}` : `${d.getDate()} ${L(MONTHS[d.getMonth()])} ${d.getFullYear()}`; };
  const fmtShort = (iso) => { if (!iso) return '—'; const d = parse(iso); return lang === 'en' ? `${L(MONTHS[d.getMonth()])} ${d.getDate()}` : `${d.getDate()} ${L(MONTHS[d.getMonth()])}`; };
  const fmtTime = (hm) => { if (!hm) return ''; const [H, M] = hm.split(':').map(Number); const h = H % 12 || 12; return `${String(h).padStart(2, '0')}:${String(M).padStart(2, '0')} ${H >= 12 ? T('م', 'PM') : T('ص', 'AM')}`; };
  const addMinutes = (hm, mins) => { const [H, M] = hm.split(':').map(Number); const t = H * 60 + M + mins; return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

  // ---------- Session + API ----------
  const Api = window.TammhaApi; const S = window.TammhaSession; const UI = window.TammhaUI;
  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (v) => { if (!v) return ''; const d = new Date(v); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const timeOf = (v) => { const d = new Date(v); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const TODAY = dayOf(new Date());
  const daysFrom = (iso) => Math.round((parse(iso) - parse(TODAY)) / 86400000);
  const relDay = (iso) => {
    if (!iso) return '';
    const n = daysFrom(iso);
    if (n === 0) return T('اليوم', 'Today');
    if (n === 1) return T('غدًا', 'Tomorrow');
    if (n === -1) return T('أمس', 'Yesterday');
    if (n > 1) return lang === 'en' ? `In ${n} days` : (n === 2 ? 'بعد يومين' : n <= 10 ? `بعد ${n} أيام` : `بعد ${n} يومًا`);
    const a = -n; return lang === 'en' ? `${a} days ago` : (a === 2 ? 'قبل يومين' : a <= 10 ? `قبل ${a} أيام` : `قبل ${a} يومًا`);
  };

  const ME = { id: '', name: '' };
  const PEOPLE = {}; // userId -> display name (from the API responses)
  const remember = (u) => { if (u && u.id) PEOPLE[u.id] = UI.personName(u); return u ? u.id : null; };
  // Shared vocabulary (domain.js = the backend's codes). No local status keys.
  const D = window.TammhaDomain;
  const CATEGORY = D.PROJECT_CATEGORIES;
  const ORIGIN = D.PROJECT_ORIGINS;

  let db = { projects: [], files: [], feedback: [], meetings: [], requests: [], notifications: [], unread: 0 };
  const NOTIF_GROUP = (t) => (t === 'SUPERVISION_REQUESTED' ? 'request' : /^(DOCUMENT_|SUBMISSION_)/.test(t) ? 'file' : /^MEETING_/.test(t) ? 'meeting' : t === 'FEEDBACK_RECEIVED' ? 'feedback' : /^(TASK_|COMMENT_)/.test(t) ? 'task' : 'project');
  const items = (r) => (Array.isArray(r) ? r : (r && r.items) || []);

  async function loadProject(pid) {
    const q = `projectId=${encodeURIComponent(pid)}`;
    const [ws, tasks, ms, docs, fb, meets] = await Promise.all([
      Api.get(`/projects/${encodeURIComponent(pid)}`), Api.get(`/tasks?${q}&limit=100`), Api.get(`/milestones?${q}&limit=100`),
      Api.get(`/documents?${q}`), Api.get(`/feedback?${q}&limit=100`), Api.get(`/meetings?${q}&limit=100&includeCancelled=true`)
    ]);
    const pr = ws.project || ws;
    const members = (ws.team && ws.team.members) || [];
    members.forEach((m) => remember(m.user));
    const leader = remember(ws.leader) || (members.find((m) => m.teamRole === 'LEADER') || {}).userId || null;
    const stages = items(ms).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((m) => ({ id: m.id, name: m.title, milestone: m.title, desc: m.description || '', to: dayOf(m.dueDate), status: m.status, progress: (m.progress && m.progress.percent) || 0 }));
    const p = {
      id: pr.id, name: pr.name, status: pr.status, category: pr.category, origin: pr.origin,
      progress: Math.round((ws.progress && ws.progress.percent) || 0),
      start: dayOf(pr.startDate), end: dayOf(pr.expectedCompletionDate || pr.endDate),
      desc: pr.overview || pr.description || '', goals: pr.objectives || [], teamName: ws.team ? ws.team.name : '',
      leader, members: members.filter((m) => m.userId !== leader).map((m) => m.userId), stages,
      tasks: items(tasks).map((t) => ({ id: t.id, title: t.title, description: t.description || '', who: remember(t.assignedStudent) || t.assignedStudentId, priority: t.priority, status: t.status, due: dayOf(t.dueDate), stageName: t.milestone ? t.milestone.title : '' }))
    };
    const files = items(docs).map((d) => ({ id: d.id, project: pid, name: d.title || d.fileName, fileName: d.fileName, status: d.reviewStatus || 'SUBMITTED', by: remember(d.uploadedBy) || d.uploadedById, date: dayOf(d.createdAt), version: d.currentVersion || 1, size: UI.fmtSize(d.fileSize), taskId: d.taskId || null }));
    const feedback = items(fb).map((f) => ({ id: f.id, project: f.projectId || pid, scope: f.documentId ? 'DOCUMENT' : f.taskId ? 'TASK' : 'PROJECT', file: f.documentId, fileName: f.document ? f.document.title || f.document.fileName : '', task: f.taskId, taskName: f.task ? f.task.title : '', status: f.status, by: remember(f.supervisor) || f.supervisorId, date: dayOf(f.createdAt), at: f.createdAt, text: f.comment || '' }));
    const now = Date.now();
    const meetings = items(meets).map((m) => ({ id: m.id, project: m.projectId || pid, title: m.title, agenda: m.description || '', date: dayOf(m.scheduledAt), time: timeOf(m.scheduledAt), duration: m.durationMinutes, status: m.status,
      upcoming: m.status === 'SCHEDULED' && new Date(m.endsAt || m.scheduledAt).getTime() > now, canJoin: !!(m.join && m.join.isOpen && m.isParticipant), canManage: !!m.canManage,
      people: (m.participants || []).map((x) => remember(x.user) || x.userId).filter(Boolean), hasNotes: !!m.hasNotes, scheduledAt: m.scheduledAt }));
    return { p, files, feedback, meetings };
  }

  async function load() {
    const [sup, inc, notes] = await Promise.all([
      Api.get('/projects/supervised'), Api.get('/supervision-requests/incoming'), Api.get('/notifications?limit=100')
    ]);
    const ids = items(sup).map((x) => (x.project ? x.project.id : x.id));
    const parts = await Promise.all(ids.map(loadProject));
    const next = { projects: [], files: [], feedback: [], meetings: [], requests: [], notifications: [], unread: 0 };
    parts.forEach((x) => { next.projects.push(x.p); next.files.push(...x.files); next.feedback.push(...x.feedback); next.meetings.push(...x.meetings); });
    next.feedback.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    next.requests = items(inc).filter((r) => r.status === 'PENDING').map((r) => ({ id: r.id, projectId: r.project && r.project.id, name: r.project ? r.project.name : '', about: (r.project && r.project.description) || '', leader: remember(r.requestedBy), leaderEmail: (r.requestedBy && r.requestedBy.email) || '', date: dayOf(r.createdAt), desc: r.message || '' }));
    next.notifications = items(notes).map((n) => { const v = S.notificationText(n); const d = n.data || {}; return { id: n.id, type: NOTIF_GROUP(n.type), rawType: n.type, title: v.title, text: v.text, project: d.projectId || null, data: d, date: dayOf(n.createdAt), time: timeOf(n.createdAt), at: n.createdAt, read: !!(n.isRead || n.readAt) }; });
    next.unread = Number(notes && notes.unreadCount != null ? notes.unreadCount : next.notifications.filter((n) => !n.read).length);
    db = next;
  }
  // a server action, then a fresh copy of the data and a redraw
  async function act(button, run, done) {
    const go = async () => {
      try { await run(); } catch (e) { UI.toast(Api.message(e), 'error'); return false; }
      try { await load(); } catch (e) { UI.toast(Api.message(e), 'error'); }
      renderShell(); if (done) done(); return true;
    };
    return button ? new Promise((resolve) => UI.busy(button, async () => resolve(await go()))) : go();
  }

  // ---------- Helpers ----------
  const project = (id) => db.projects.find((p) => p.id === id);
  const person = (k) => (k && PEOPLE[k]) || '—';
  const isOverdue = (t) => D.isOverdue(t.status, t.due, TODAY);
  const overdueTasks = (p) => p.tasks.filter(isOverdue);
  const pendingFiles = () => db.files.filter((f) => D.WAITING_REVIEW.includes(f.status) && project(f.project));
  const params = new URLSearchParams(location.search);
  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => [...r.querySelectorAll(s)];
  const ICONS = {
    arrow: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"></path></svg>',
    meet: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 8.5 20 6v12l-5-2.5M4 5h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"></path></svg>',
    flag: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 21V4m0 0h11l-2 4 2 4H5"></path></svg>',
    clock: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path></svg>',
    file: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"></path><path d="M14 3.5v4h4"></path></svg>',
    note: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"></path></svg>',
    task: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect height="16" rx="3" width="16" x="4" y="4"></rect><path d="m8.5 12 2.5 2.5 4.5-5"></path></svg>',
    request: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"></path><circle cx="10" cy="7.5" r="3.5"></circle><path d="M19 8v6M16 11h6"></path></svg>',
    lock: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect height="10" rx="2" width="14" x="5" y="10"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>',
    download: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 4v11m-4-4 4 4 4-4M5 20h14"></path></svg>',
    eye: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
  };
  const fileIcon = (f) => `<img alt="" class="sv-file-icon" src="${esc(window.TammhaDocs ? window.TammhaDocs.icon(f.fileName || f.name) : 'assets/file-txt.png')}"/>`;

  // Project status / stage status (stage OVERDUE is derived from its end date, never stored).
  const STATUS = D.PROJECT_STATUSES;
  const stageStatus = (st) => (st.status !== 'COMPLETED' && st.status !== 'CANCELLED' && st.to && st.to < TODAY ? D.STAGE_STATUSES.OVERDUE : D.STAGE_STATUSES[st.status] || D.STAGE_STATUSES.PENDING);
  const TASK_STATUS = (t) => (isOverdue(t) ? { cls: 'overdue', label: T('متأخرة', 'Overdue') } : { cls: (D.TASK_STATUSES[t.status] || D.TASK_STATUSES.TODO).cls, label: L((D.TASK_STATUSES[t.status] || D.TASK_STATUSES.TODO).label) });
  const PRIORITY = D.PRIORITIES;
  const REVIEW = D.DOCUMENT_STATUSES;
  const SCOPE = D.FEEDBACK_TARGETS;
  // Review tabs on the reviews page group the document statuses.
  const REVIEW_TAB = { pending: D.WAITING_REVIEW, changes: ['CHANGES_REQUESTED', 'REJECTED'], approved: ['APPROVED'] };
  const inReviewTab = (f, k) => k === 'all' || (REVIEW_TAB[k] || []).includes(f.status);

  const pill = (cls, text) => `<span class="task-status task-status--${cls}">${esc(text)}</span>`;
  const reviewPill = (f) => { const r = REVIEW[f.status] || REVIEW.SUBMITTED; return `<span class="sv-review sv-review--${r.cls}">${esc(L(r.label))}</span>`; };
  const bar = (v, done) => `<div class="project-progress__track sv-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}"><span${done ? ' class="is-completed"' : ''} style="width:${v}%"></span></div>`;
  const avatar = (k) => `<span class="sv-avatar" title="${esc(person(k))}">${esc(UI.initial(person(k)))}</span>`;
  // empty states: an icon that matches what is missing (projects, files, dates, tasks, notes, ...)
  const EMPTY_ICONS = {
    folder: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.5h6.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"></path></svg>',
    calendar: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>',
    bell: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z"></path><path d="M10 20a2 2 0 0 0 4 0"></path></svg>',
    stages: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h10M4 12h16M4 18h7"></path><circle cx="18" cy="6" r="2"></circle><circle cx="15" cy="18" r="2"></circle></svg>',
  };
  const emptyIcon = (title) => {
    const t = String(title);
    if (/مشاريع|مشروع|project/i.test(t)) return EMPTY_ICONS.folder;
    if (/ملف|مراجع|file|review/i.test(t)) return ICONS.file;
    if (/مواعيد|dates/i.test(t)) return EMPTY_ICONS.calendar;
    if (/اجتماع|meeting/i.test(t)) return ICONS.meet;
    if (/مراحل|stage/i.test(t)) return EMPTY_ICONS.stages;
    if (/مهام|task/i.test(t)) return ICONS.clock;
    if (/ملاحظات|feedback/i.test(t)) return ICONS.note;
    if (/إشعار|notification/i.test(t)) return EMPTY_ICONS.bell;
    if (/طلب|request/i.test(t)) return ICONS.request;
    return ICONS.task;
  };
  const empty = (title, text) => `<div class="sv-empty"><span aria-hidden="true" class="sv-empty__icon">${emptyIcon(title)}</span><strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}</div>`;

  // ---------- Toast ----------
  function toast(text, kind) {
    if (UI && UI.toast) { UI.toast(text, kind || 'success'); return; }
    let el = qs('#svToast');
    if (!el) { el = document.createElement('div'); el.id = 'svToast'; el.className = 'sv-toast'; el.setAttribute('role', 'status'); document.body.append(el); }
    el.textContent = text; el.classList.add('is-on');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('is-on'), 2600);
  }

  // ---------- Static translations ----------
  function translateStatic() {
    if (lang !== 'en') return;
    qsa('[data-en]').forEach((el) => { el.dataset.ar = el.textContent; el.textContent = el.dataset.en; });
    qsa('[data-en-placeholder]').forEach((el) => { el.placeholder = el.dataset.enPlaceholder; });
    qsa('[data-en-aria-label]').forEach((el) => { el.setAttribute('aria-label', el.dataset.enAriaLabel); });
    qsa('[data-en-title]').forEach((el) => { el.title = el.dataset.enTitle; });
    const tt = qs('title[data-en]'); if (tt) document.title = tt.dataset.en;
  }

  // ---------- Shell: profile name, unread badge ----------
  function renderShell() {
    qsa('[data-me-name]').forEach((el) => { el.textContent = ME.name; });
    qsa('[data-me-title]').forEach((el) => { el.textContent = T('مشرف أكاديمي', 'Academic supervisor'); });
    const unread = db.unread;
    qsa('[data-unread]').forEach((el) => { el.textContent = unread > 99 ? '99+' : unread; el.hidden = unread === 0; });
    const reqs = db.requests.length;
    qsa('[data-requests]').forEach((el) => { el.textContent = reqs; el.hidden = reqs === 0; });
  }

  // ---------- Drawer (task details / file review) ----------
  const drawer = qs('#svDrawer');
  function openDrawer(kicker, title, html) {
    qs('#svDrawerKicker').textContent = kicker;
    qs('#svDrawerTitle').textContent = title;
    qs('#svDrawerBody').innerHTML = html;
    drawer.hidden = false;
    qs('#svDrawerClose').focus();
  }
  const closeDrawer = () => { if (drawer) drawer.hidden = true; };
  if (drawer) {
    qs('#svDrawerClose').addEventListener('click', closeDrawer);
    drawer.addEventListener('click', (e) => { if (e.target === drawer) closeDrawer(); });
  }

  function openTask(p, i) {
    const t = p.tasks[i]; if (!t) return; const s = TASK_STATUS(t);
    const related = db.feedback.filter((f) => f.task === t.id);
    openDrawer(L(p.name), L(t.title), `
      <dl class="task-drawer__facts">
        <div><dt>${T('المسؤول', 'Assigned to')}</dt><dd>${esc(person(t.who))}</dd></div>
        <div><dt>${T('الحالة', 'Status')}</dt><dd>${pill(s.cls, s.label)}</dd></div>
        <div><dt>${T('الأولوية', 'Priority')}</dt><dd>${esc(PRIORITY[t.priority] ? L(PRIORITY[t.priority]) : '—')}</dd></div>
        <div><dt>${T('تاريخ التسليم', 'Due date')}</dt><dd class="${isOverdue(t) ? 'sv-late' : ''}">${fmtDate(t.due)}</dd></div>
        <div><dt>${T('المرحلة', 'Stage')}</dt><dd>${esc(t.stageName || '—')}</dd></div>
      </dl>
      ${t.description ? `<section class="task-drawer__block"><h3>${T('الوصف', 'Description')}</h3><p>${esc(t.description)}</p></section>` : ''}
      <p class="sv-readonly">${ICONS.lock}<span>${T('المهام يديرها قائد الفريق. يمكنك متابعتها وإضافة ملاحظة عليها.', 'Tasks are managed by the Team Leader. You can follow them and add a note.')}</span></p>
      <section class="task-drawer__block"><h3>${T('ملاحظاتك على المهمة', 'Your notes on this task')}</h3>
        ${related.length ? `<ul class="task-drawer__comments">${related.map((f) => `<li><b>${esc(person(f.by))} · ${esc(fmtDate(f.date))}</b><p>${esc(f.text)}</p></li>`).join('')}</ul>` : `<p class="sv-muted">${T('لا توجد ملاحظات بعد.', 'No notes yet.')}</p>`}
        <form class="sv-inline-form" data-task-note="${i}"><label class="visually-hidden" for="svTaskNote">${T('ملاحظة', 'Note')}</label><textarea id="svTaskNote" placeholder="${T('اكتب ملاحظة للفريق عن هذه المهمة…', 'Write a note to the team about this task…')}" rows="3"></textarea><small class="field-error" hidden>${T('اكتب الملاحظة أولًا', 'Write the note first')}</small><button class="sv-btn" type="submit">${T('إرسال الملاحظة', 'Send note')}</button></form>
      </section>`);
    qs('[data-task-note]').addEventListener('submit', (e) => {
      e.preventDefault();
      const ta = qs('#svTaskNote'), err = e.target.querySelector('.field-error');
      const text = ta.value.trim();
      ta.classList.toggle('is-invalid', !text); err.hidden = !!text;
      if (!text) { ta.focus(); return; }
      act(e.target.querySelector('[type="submit"]'), () => addFeedback({ task: t.id, text }), () => {
        const np = project(p.id); if (np) openTask(np, np.tasks.findIndex((x) => x.id === t.id));
        toast(T('أُرسلت الملاحظة إلى الفريق.', 'Your note was sent to the team.'));
        if (openTask.onChange) openTask.onChange();
      });
    });
  }

  // One target per note: a task, a document or the project (the backend refuses two targets).
  function addFeedback({ project: pid, file, task, text, status }) {
    const body = { comment: text || undefined };
    if (task) body.taskId = task; else if (file) body.documentId = file; else body.projectId = pid;
    if (status) body.status = status;
    return Api.post('/feedback', body);
  }

  function openFile(id, onChange) {
    const f = db.files.find((x) => x.id === id);
    if (!f) { toast(T('هذا الملف غير متاح لك أو حُذف.', 'This file is not available to you or was deleted.'), 'error'); return; }
    const p = project(f.project);
    const notes = db.feedback.filter((x) => x.file === f.id);
    const rel = f.taskId && p.tasks.find((t) => t.id === f.taskId);
    const taskName = rel ? rel.title : '—';
    openDrawer(L(p.name), L(f.name), `
      <div class="sv-file-head">${fileIcon(f)}<div><strong>${esc(L(f.name))}</strong><small>${T('النسخة', 'Version')} ${f.version} · <span dir="ltr">${esc(f.size)}</span></small></div>${reviewPill(f)}</div>
      <div class="sv-file-actions"><button class="sv-btn sv-btn--ghost" data-act="view" type="button">${ICONS.eye}${T('عرض الملف', 'View file')}</button><button class="sv-btn sv-btn--ghost" data-act="download" type="button">${ICONS.download}${T('تنزيل', 'Download')}</button></div>
      <dl class="task-drawer__facts">
        <div><dt>${T('رفعه', 'Uploaded by')}</dt><dd>${esc(person(f.by))}</dd></div>
        <div><dt>${T('تاريخ الرفع', 'Uploaded')}</dt><dd>${fmtDate(f.date)}</dd></div>
        <div><dt>${T('المهمة المرتبطة', 'Related task')}</dt><dd>${esc(taskName)}</dd></div>
        <div><dt>${T('النوع', 'Type')}</dt><dd>${esc(window.TammhaDocs ? window.TammhaDocs.type(f.fileName) : '')}</dd></div>
      </dl>
      <section class="task-drawer__block"><h3>${T('النسخ', 'Versions')}</h3>
        <ol class="sv-versions" id="svVersions"><li><small>${T('جارٍ تحميل النسخ…', 'Loading versions…')}</small></li></ol>
      </section>
      <section class="task-drawer__block"><h3>${T('الملاحظات', 'Feedback')}</h3>
        ${notes.length ? `<ul class="task-drawer__comments">${notes.map((n) => `<li><b>${esc(person(n.by))} · ${fmtDate(n.date)}${n.status && REVIEW[n.status] ? ` · ${esc(L(REVIEW[n.status].label))}` : ''}</b>${n.text ? `<p>${esc(n.text)}</p>` : ''}</li>`).join('')}</ul>` : `<p class="sv-muted">${T('لا توجد ملاحظات على هذا الملف بعد.', 'No feedback on this file yet.')}</p>`}
      </section>
      <section class="task-drawer__block"><h3>${T('مراجعتك', 'Your review')}</h3>
        <form class="sv-inline-form" id="svReviewForm"><label class="visually-hidden" for="svReviewNote">${T('ملاحظة', 'Comment')}</label><textarea id="svReviewNote" placeholder="${T('اكتب ملاحظتك على الملف…', 'Write your comment on the file…')}" rows="3"></textarea><small class="field-error" hidden>${T('اكتب ما المطلوب تعديله', 'Explain what needs to change')}</small>
          <div class="sv-review-actions"><button class="sv-btn sv-btn--approve" data-review="APPROVED" type="submit">${T('اعتماد الملف', 'Approve file')}</button><button class="sv-btn sv-btn--ghost" data-review="CHANGES_REQUESTED" type="submit">${T('طلب تعديل', 'Request changes')}</button><button class="sv-btn sv-btn--text" data-review="comment" type="submit">${T('إرسال ملاحظة فقط', 'Comment only')}</button></div>
        </form>
      </section>`);
    qsa('[data-act]', drawer).forEach((b) => b.addEventListener('click', () => {
      window.TammhaDocs.openDocument(f.id, b.dataset.act === 'download').catch((e) => toast(Api.message(e), 'error'));
    }));
    (async () => {
      const box = qs('#svVersions'); if (!box) return;
      try {
        const vs = items(await Api.get(`/documents/${encodeURIComponent(f.id)}/versions`));
        box.innerHTML = vs.length ? vs.map((v, i) => `<li><div><strong>${T('النسخة', 'Version')} ${esc(v.version)}${i === 0 ? ` <em>${T('الحالية', 'current')}</em>` : ''}</strong><small>${fmtDate(dayOf(v.createdAt))} · <span dir="ltr">${esc(v.fileName || '')}</span></small></div>${v.downloadUrl || v.signedUrl ? `<a aria-label="${T('تنزيل النسخة', 'Download version')} ${esc(v.version)}" class="sv-icon-btn" href="${esc(v.downloadUrl || v.signedUrl)}" rel="noopener" target="_blank">${ICONS.download}</a>` : ''}</li>`).join('') : `<li><small>${T('لا توجد نسخ.', 'No versions.')}</small></li>`;
      } catch (e) { box.innerHTML = `<li><small class="sv-late">${esc(Api.message(e))}</small></li>`; }
    })();
    const form = qs('#svReviewForm');
    let action = 'comment';
    qsa('[data-review]', form).forEach((b) => b.addEventListener('click', () => { action = b.dataset.review; }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ta = qs('#svReviewNote'), err = form.querySelector('.field-error');
      const text = ta.value.trim();
      const needsText = action !== 'APPROVED';
      const bad = needsText && !text;
      ta.classList.toggle('is-invalid', bad); err.hidden = !bad;
      if (bad) { err.textContent = action === 'CHANGES_REQUESTED' ? T('اكتب ما المطلوب تعديله', 'Explain what needs to change') : T('اكتب الملاحظة أولًا', 'Write the comment first'); ta.focus(); return; }
      const btn = e.submitter || form.querySelector('[type="submit"]');
      act(btn, () => addFeedback({ file: f.id, text, status: action === 'comment' ? undefined : action }), () => {
        toast(action === 'APPROVED' ? T('اعتُمد الملف وأُبلغ الفريق.', 'File approved and the team was notified.') : action === 'CHANGES_REQUESTED' ? T('طُلب التعديل وأُبلغ الفريق.', 'Changes requested and the team was notified.') : T('أُرسلت الملاحظة.', 'Comment sent.'));
        openFile(id, onChange);
        onChange && onChange();
      });
    });
  }

  // ---------- Feedback modal ----------
  const fbModal = qs('#svFeedbackModal');
  function openFeedback(pid, onDone) {
    const sel = qs('#fbProject');
    sel.innerHTML = db.projects.map((p) => `<option value="${esc(p.id)}"${p.id === pid ? ' selected' : ''}>${esc(L(p.name))}</option>`).join('');
    const fillFiles = () => {
      const files = db.files.filter((f) => f.project === sel.value);
      qs('#fbFile').innerHTML = `<option value="">${T('بدون ملف', 'No file')}</option>` + files.map((f) => `<option value="${esc(f.id)}">${esc(L(f.name))}</option>`).join('');
    };
    const scopeSel = qs('#fbScope'), taskWrap = qs('#fbTaskWrap'), taskSel = qs('#fbTask'), fileSel = qs('#fbFile');
    const fillTasks = () => { const p = project(sel.value); taskSel.innerHTML = (p ? p.tasks : []).map((t) => `<option value="${esc(t.id)}">${esc(L(t.title))}</option>`).join(''); };
    const syncScope = () => { const isTask = scopeSel.value === 'TASK'; if (taskWrap) taskWrap.hidden = !isTask; fileSel.disabled = isTask; if (isTask) fileSel.value = ''; };
    scopeSel.value = 'PROJECT';
    scopeSel.onchange = syncScope;
    sel.onchange = () => { fillFiles(); fillTasks(); }; fillFiles(); fillTasks(); syncScope();
    qs('#fbText').value = ''; qs('#fbText').classList.remove('is-invalid'); qs('#fbTextError').hidden = true;
    fbModal.hidden = false; qs('#fbText').focus();
    fbModal.onDone = onDone;
  }
  if (fbModal) {
    const close = () => { fbModal.hidden = true; };
    qsa('[data-close-feedback]').forEach((b) => b.addEventListener('click', close));
    fbModal.addEventListener('click', (e) => { if (e.target === fbModal) close(); });
    qs('#fbForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const ta = qs('#fbText'); const text = ta.value.trim();
      ta.classList.toggle('is-invalid', !text); qs('#fbTextError').hidden = !!text;
      if (!text) { ta.focus(); return; }
      // One target per note (backend: project, document OR task).
      const isTask = qs('#fbScope').value === 'TASK';
      const file = !isTask && qs('#fbFile').value ? qs('#fbFile').value : undefined;
      const task = isTask && qs('#fbTask').value ? qs('#fbTask').value : undefined;
      if (isTask && !task) { toast(T('لا توجد مهام في هذا المشروع بعد.', 'This project has no tasks yet.'), 'error'); return; }
      act(e.submitter || qs('#fbForm [type="submit"]'), () => addFeedback({ project: qs('#fbProject').value, file, task, text }), () => {
        close(); toast(T('أُرسلت الملاحظة إلى الفريق.', 'Your feedback was sent to the team.'));
        fbModal.onDone && fbModal.onDone();
      });
    });
  }

  // ---------- Confirm dialog ----------
  function confirmBox(title, text, okLabel, onOk, withReason) {
    const box = qs('#svConfirm');
    qs('#svConfirmTitle').textContent = title; qs('#svConfirmText').textContent = text;
    qs('#svConfirmOk').textContent = okLabel;
    const reason = qs('#svConfirmReasonWrap'); reason.hidden = !withReason; qs('#svConfirmReason').value = '';
    box.hidden = false; qs('#svConfirmOk').focus();
    const close = () => { box.hidden = true; };
    qs('#svConfirmCancel').onclick = close;
    box.onclick = (e) => { if (e.target === box) close(); };
    qs('#svConfirmOk').onclick = () => { close(); onOk(qs('#svConfirmReason').value.trim()); };
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeDrawer();
    ['#svFeedbackModal', '#svConfirm', '#svMeetingModal'].forEach((s) => { const el = qs(s); if (el) el.hidden = true; });
  });

  // ---------- Project card ----------
  function projectCard(p) {
    const od = overdueTasks(p).length;
    const nextStage = p.stages.find((s) => s.milestone && s.status !== 'COMPLETED');
    const done = p.status === 'COMPLETED';
    return `<article class="projects-list-card sv-project-card">
      <div class="project-identity"><span class="project-identity__logo"><img alt="" src="assets/tammha-mark.png"/></span><div class="project-identity__text"><h2>${esc(L(p.name))}</h2><p>${T('القائد', 'Leader')}: ${esc(person(p.leader))} · ${T('عدد الأعضاء', 'Members')}: ${p.members.length + (p.leader ? 1 : 0)}</p></div>${pill((STATUS[p.status] || STATUS.PLANNING).cls, L((STATUS[p.status] || STATUS.PLANNING).label))}</div>
      <div class="project-progress"><div class="project-progress__label"><span>${T('نسبة الإنجاز', 'Progress')}</span><strong>${p.progress}%</strong></div>${bar(p.progress, done)}</div>
      <ul class="sv-card-facts">
        ${nextStage ? `<li>${ICONS.flag}<span>${esc(L(nextStage.milestone))}</span><b>${fmtShort(nextStage.to)}</b></li>` : `<li>${ICONS.flag}<span>${p.stages.length ? T('اكتملت كل المراحل', 'All stages completed') : T('لم تُضف مراحل بعد', 'No stages yet')}</span></li>`}
        ${od ? `<li class="sv-late">${ICONS.clock}<span>${lang === 'en' ? `${od} overdue task${od > 1 ? 's' : ''}` : od === 1 ? 'مهمة متأخرة' : od === 2 ? 'مهمتان متأخرتان' : `${od} مهام متأخرة`}</span></li>` : ''}
      </ul>
      <div class="project-card-foot"><span class="sv-team">${avatar(p.leader)}${p.members.map(avatar).join('')}</span><a class="project-card-action" href="supervisor-project.html?p=${encodeURIComponent(p.id)}">${T('فتح المشروع', 'Open project')}${ICONS.arrow}</a></div>
    </article>`;
  }

  // ======================================================================
  // Pages
  // ======================================================================
  const page = document.body.dataset.svPage;

  // ----- Dashboard -----
  function renderDashboard() {
    const reqs = db.requests.length;
    const notice = qs('#svRequestNotice');
    notice.hidden = !reqs;
    if (reqs) notice.innerHTML = `${ICONS.request}<span>${lang === 'en' ? `You have ${reqs} new supervision request${reqs > 1 ? 's' : ''}.` : reqs === 1 ? 'لديك طلب إشراف جديد.' : reqs === 2 ? 'لديك طلبا إشراف جديدان.' : `لديك ${reqs} طلبات إشراف جديدة.`}</span><a href="supervisor-projects.html?view=requests">${T('مراجعة الطلبات', 'Review requests')}</a>`;

    const active = db.projects.filter((p) => p.status !== 'COMPLETED');
    qs('#svDashProjects').innerHTML = active.length ? active.map(projectCard).join('') : empty(T('لا توجد مشاريع نشطة', 'No active projects'), T('عند قبول طلب إشراف سيظهر المشروع هنا.', 'Accepted supervision requests appear here.'));

    const files = pendingFiles();
    qs('#svDashReviews').innerHTML = files.length ? `<ul class="sv-list">${files.map((f) => `<li><button class="sv-list__row" data-file="${esc(f.id)}" type="button">${fileIcon(f)}<span class="sv-list__main"><strong>${esc(L(f.name))}</strong><small>${esc(L(project(f.project).name))} · ${esc(person(f.by))} · ${relDay(f.date)}</small></span><span class="sv-list__go">${T('مراجعة', 'Review')}${ICONS.arrow}</span></button></li>`).join('')}</ul>` : empty(T('لا توجد ملفات بانتظارك', 'Nothing waiting for review'));
    qsa('[data-file]', qs('#svDashReviews')).forEach((b) => b.addEventListener('click', () => openFile(b.dataset.file, renderDashboard)));

    // Agenda: meetings, milestones and stage deadlines in the next weeks
    const agenda = [];
    db.meetings.filter((m) => m.upcoming && project(m.project)).forEach((m) => agenda.push({ date: m.date, kind: 'meet', title: L(m.title), sub: `${L(project(m.project).name)} · ${fmtTime(m.time)}`, href: `supervisor-meetings.html` }));
    db.projects.filter((p) => p.status !== 'COMPLETED').forEach((p) => p.stages.forEach((s) => {
      if (s.status === 'COMPLETED' || s.status === 'CANCELLED' || !s.to || s.to < TODAY) return;
      agenda.push({ date: s.to, kind: 'flag', title: L(s.milestone), sub: L(p.name), href: `supervisor-project.html?p=${encodeURIComponent(p.id)}&tab=stages` });
    }));
    agenda.sort((a, b) => a.date.localeCompare(b.date));
    qs('#svAgenda').innerHTML = agenda.length ? `<ul class="sv-agenda">${agenda.slice(0, 5).map((i) => `<li><a href="${i.href}"><span class="sv-agenda__date"><b>${parse(i.date).getDate()}</b><small>${L(MONTHS[parse(i.date).getMonth()])}</small></span><span class="sv-agenda__icon">${ICONS[i.kind]}</span><span class="sv-list__main"><strong>${esc(i.title)}</strong><small>${esc(i.sub)}</small></span></a></li>`).join('')}</ul>` : empty(T('لا مواعيد قادمة', 'No upcoming dates'));

    const od = [];
    db.projects.forEach((p) => p.tasks.forEach((t, i) => { if (isOverdue(t)) od.push({ p, t, i }); }));
    od.sort((a, b) => String(a.t.due).localeCompare(String(b.t.due)));
    qs('#svOverdue').innerHTML = od.length ? `<ul class="sv-list">${od.map(({ p, t, i }) => `<li><button class="sv-list__row" data-task="${esc(p.id)}|${i}" type="button"><span class="sv-list__main"><strong>${esc(L(t.title))}</strong><small>${esc(L(p.name))} · ${esc(person(t.who))}</small></span><span class="sv-late sv-nowrap">${fmtShort(t.due)}</span></button></li>`).join('')}</ul>` : empty(T('لا توجد مهام متأخرة', 'No overdue tasks'));
    qsa('[data-task]').forEach((b) => b.addEventListener('click', () => { const [pid, i] = b.dataset.task.split('|'); openTask(project(pid), Number(i)); }));

    const fb = db.feedback.filter((f) => project(f.project)).slice(0, 3);
    qs('#svActivity').innerHTML = fb.length ? `<ul class="sv-feed">${fb.map((f) => `<li><div class="sv-feed__meta"><strong>${esc(L(project(f.project).name))}</strong><span>${fmtShort(f.date)}</span></div><p>${esc(f.text || (f.status && REVIEW[f.status] ? L(REVIEW[f.status].label) : ''))}</p></li>`).join('')}</ul>` : empty(T('لا توجد ملاحظات بعد', 'No feedback yet'));
  }

  // ----- Projects + requests -----
  function renderProjects() {
    const tabs = qsa('[data-view]');
    let view = params.get('view') || 'all';
    const VIEW_STATUS = { progress: 'IN_PROGRESS', completed: 'COMPLETED' };
    const counts = { all: db.projects.length, progress: db.projects.filter((p) => p.status === 'IN_PROGRESS').length, completed: db.projects.filter((p) => p.status === 'COMPLETED').length, requests: db.requests.length };
    tabs.forEach((t) => { const c = t.querySelector('[data-count]'); if (c) c.textContent = counts[t.dataset.view]; });
    const draw = () => {
      tabs.forEach((t) => { const on = t.dataset.view === view; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', String(on)); });
      const grid = qs('#svProjectsGrid'), reqs = qs('#svRequests');
      grid.hidden = view === 'requests'; reqs.hidden = view !== 'requests';
      if (view === 'requests') {
        reqs.innerHTML = db.requests.length ? db.requests.map((r) => `<article class="sv-request">
          <div class="project-identity"><span class="project-identity__logo"><img alt="" src="assets/tammha-mark.png"/></span><div class="project-identity__text"><h2>${esc(r.name)}</h2><p>${T('مقدّم الطلب', 'Requested by')}: ${esc(person(r.leader))}</p></div><span class="sv-request__date">${T('أُرسل', 'Sent')} ${fmtDate(r.date)}</span></div>
          ${r.desc ? `<p class="sv-request__desc">${esc(r.desc)}</p>` : ''}
          <p class="sv-muted">${T('تظهر تفاصيل المشروع وفريقه بعد قبول الإشراف.', 'The project details and team appear after you accept supervision.')}</p>
          <div class="sv-request__actions"><button class="sv-btn sv-btn--ghost" data-request-details="${esc(r.id)}" type="button">${T('التفاصيل', 'Details')}</button><button class="sv-btn sv-btn--ghost" data-reject="${esc(r.id)}" type="button">${T('رفض', 'Reject')}</button><button class="sv-btn" data-accept="${esc(r.id)}" type="button">${T('قبول الإشراف', 'Accept supervision')}</button></div>
        </article>`).join('') : empty(T('لا توجد طلبات إشراف', 'No supervision requests'), T('ستظهر هنا طلبات قادة الفرق.', 'Requests from team leaders appear here.'));
        qsa('[data-accept]').forEach((b) => b.addEventListener('click', () => accept(b)));
        qsa('[data-request-details]').forEach((b) => b.addEventListener('click', () => openRequest(b.dataset.requestDetails)));
        qsa('[data-reject]').forEach((b) => b.addEventListener('click', () => reject(b.dataset.reject)));
      } else {
        const list = db.projects.filter((p) => view === 'all' || p.status === VIEW_STATUS[view]);
        grid.innerHTML = list.length ? list.map(projectCard).join('') : empty(T('لا توجد مشاريع هنا', 'No projects here'));
      }
    };
    function recount() {
      Object.assign(counts, { all: db.projects.length, progress: db.projects.filter((p) => p.status === 'IN_PROGRESS').length, completed: db.projects.filter((p) => p.status === 'COMPLETED').length, requests: db.requests.length });
      tabs.forEach((t) => { const c = t.querySelector('[data-count]'); if (c) c.textContent = counts[t.dataset.view]; });
    }
    function accept(b) {
      const r = db.requests.find((x) => x.id === b.dataset.accept);
      if (!r) return;
      act(b, () => Api.post(`/supervision-requests/${encodeURIComponent(r.id)}/accept`, {}), () => {
        closeDrawer(); view = 'all'; recount(); draw();
        toast(T(`قبلت الإشراف على "${r.name}"، وأصبح ضمن مشاريعك.`, `You now supervise "${r.name}".`));
      });
    }
    function reject(id) {
      const r = db.requests.find((x) => x.id === id); if (!r) return;
      confirmBox(T(`رفض طلب "${r.name}"؟`, `Reject "${r.name}"?`), T('سيُبلَّغ قائد الفريق بالرفض ليختار مشرفًا آخر.', 'The Team Leader will be told so they can choose another supervisor.'), T('رفض الطلب', 'Reject request'), (reason) => {
        act(null, () => Api.post(`/supervision-requests/${encodeURIComponent(r.id)}/reject`, reason ? { note: reason } : {}), () => {
          closeDrawer(); recount(); draw(); toast(T('رُفض الطلب وأُبلغ قائد الفريق.', 'Request rejected and the Team Leader was notified.'));
        });
      }, true);
    }
    // a supervision request opens in a side panel with its details (also from the bell: ?request=<id>)
    function openRequest(id) {
      const r = db.requests.find((x) => x.id === id); if (!r) return;
      const row = (label, value) => (value ? `<div class="sv-req-detail"><dt>${esc(label)}</dt><dd>${value}</dd></div>` : '');
      openDrawer(T('طلب إشراف', 'Supervision request'), r.name, `<dl class="sv-req-details">
          ${row(T('المشروع', 'Project'), esc(r.name))}
          ${row(T('مقدّم الطلب', 'Requested by'), `${esc(person(r.leader))}${r.leaderEmail ? `<small dir="ltr">${esc(r.leaderEmail)}</small>` : ''}`)}
          ${row(T('تاريخ الطلب', 'Sent on'), esc(fmtDate(r.date)))}
          ${row(T('وصف المشروع', 'About the project'), esc(r.about))}
          ${row(T('رسالة الفريق', 'Message from the team'), esc(r.desc))}
        </dl>
        <div class="sv-request__actions sv-req-actions"><button class="sv-btn sv-btn--ghost" data-reject-one type="button">${T('رفض', 'Reject')}</button><button class="sv-btn" data-accept="${esc(r.id)}" data-accept-one type="button">${T('قبول الإشراف', 'Accept supervision')}</button></div>`);
      const body = qs('#svDrawerBody');
      body.querySelector('[data-accept-one]').addEventListener('click', (e) => accept(e.currentTarget));
      body.querySelector('[data-reject-one]').addEventListener('click', () => reject(r.id));
    }
    tabs.forEach((t) => t.addEventListener('click', () => { view = t.dataset.view; draw(); }));
    draw();
    if (params.get('request')) openRequest(params.get('request'));
  }

  // ----- Project page -----
  function renderProject() {
    let p = project(params.get('p')) || db.projects[0];
    if (!p) {
      const main = qs('#svTabPanel') || qs('main');
      if (main) main.innerHTML = empty(T('لا توجد مشاريع تحت إشرافك بعد', 'No projects under your supervision yet'), T('عند قبول طلب إشراف سيظهر المشروع هنا.', 'Accepted supervision requests appear here.'));
      qs('#svProjName').textContent = T('لا يوجد مشروع', 'No project'); qs('#svProjMeta').textContent = '';
      ['#svAddFeedback', '#svAskAi', '#svScheduleMeeting'].forEach((sel) => { const el = qs(sel); if (el) el.hidden = true; });
      return;
    }
    qs('#svProjName').textContent = L(p.name);
    qs('#svProjMeta').textContent = `${CATEGORY[p.category] ? L(CATEGORY[p.category]) : ''}${p.category ? ' · ' : ''}${T('القائد', 'Leader')}: ${person(p.leader)}`;
    qs('#svProjProgress').innerHTML = `<span>${p.progress}%</span>${bar(p.progress, p.status === 'COMPLETED')}`;
    qs('#svAskAi').href = `supervisor-assistant.html?p=${encodeURIComponent(p.id)}`;
    qs('#svAddFeedback').addEventListener('click', () => openFeedback(p.id, () => show('feedback')));
    qs('#svScheduleMeeting').href = `supervisor-meetings.html?new=${encodeURIComponent(p.id)}`;
    openTask.onChange = () => { p = project(p.id) || p; };
    document.title = L(p.name);
    const tabs = qsa('[data-tab]');
    const body = qs('#svTabPanel');
    const panels = {
      overview() {
        const od = overdueTasks(p);
        const next = p.stages.find((s) => s.status !== 'COMPLETED');
        return `<div class="sv-overview">
          <div class="sv-overview__main">
            <article class="overview-panel"><h2>${T('نبذة عن المشروع', 'About the project')}</h2><p>${esc(p.desc || T('لم يُضف وصف بعد.', 'No description yet.'))}</p></article>
            ${p.goals.length ? `<article class="overview-panel"><h2>${T('الأهداف', 'Objectives')}</h2><ul class="overview-goals">${p.goals.map((g) => `<li>${esc(L(g))}</li>`).join('')}</ul></article>` : ''}
            <section class="overview-stats sv-facts" aria-label="${T('بيانات المشروع', 'Project details')}">
              <div class="overview-stat"><span>${T('التصنيف', 'Category')}</span><strong>${esc(CATEGORY[p.category] ? L(CATEGORY[p.category]) : '—')}</strong></div>
              <div class="overview-stat"><span>${T('نوع المشروع', 'Project origin')}</span><strong>${esc(ORIGIN[p.origin] ? L(ORIGIN[p.origin]) : '—')}</strong></div>
              <div class="overview-stat"><span>${T('تاريخ البدء', 'Start date')}</span><strong>${fmtDate(p.start)}</strong></div>
              <div class="overview-stat"><span>${T('الإنجاز المتوقع', 'Expected completion')}</span><strong>${fmtDate(p.end)}</strong></div>
              <div class="overview-stat overview-stat--status"><span>${T('الحالة', 'Status')}</span><strong>${esc(L((STATUS[p.status] || STATUS.PLANNING).label))}</strong></div>
            </section>
          </div>
          <aside class="sv-overview__side">
            <section class="overview-panel"><h2>${T('الفريق', 'Team')}${p.teamName ? ` · ${esc(p.teamName)}` : ''}</h2><ul class="sv-team-list">${[p.leader, ...p.members].filter(Boolean).map((k, i) => `<li>${avatar(k)}<strong>${esc(person(k))}</strong><small>${i === 0 ? T('قائد الفريق', 'Team Leader') : T('عضو', 'Member')}</small></li>`).join('')}</ul></section>
            <section class="overview-panel"><h2>${T('يحتاج انتباهك', 'Needs attention')}</h2><ul class="sv-attn">
              ${next ? `<li>${ICONS.flag}<span>${esc(L(next.milestone || next.name))}</span><b>${fmtShort(next.to)}</b></li>` : ''}
              ${!next && !od.length && !db.files.some((f) => f.project === p.id && D.WAITING_REVIEW.includes(f.status)) ? `<li>${ICONS.task}<span>${T('لا يوجد ما يحتاج انتباهك الآن.', 'Nothing needs your attention now.')}</span></li>` : ''}
              ${od.map((t) => `<li class="sv-late">${ICONS.clock}<span>${esc(L(t.title))}</span><b>${fmtShort(t.due)}</b></li>`).join('')}
              ${db.files.filter((f) => f.project === p.id && D.WAITING_REVIEW.includes(f.status)).map((f) => `<li>${ICONS.file}<span>${esc(L(f.name))}</span><b>${T('مراجعة', 'Review')}</b></li>`).join('')}
            </ul></section>
          </aside>
        </div>`;
      },
      stages() {
        if (!p.stages.length) return empty(T('لم يضف قائد الفريق مراحل بعد', 'The Team Leader has not added stages yet'));
        return `<div class="sv-table" role="table" aria-label="${T('مراحل المشروع', 'Project stages')}">
          <div class="sv-row sv-row--head sv-row--stages" role="row"><span role="columnheader">${T('المرحلة', 'Stage')}</span><span role="columnheader">${T('تاريخ الاستحقاق', 'Due date')}</span><span role="columnheader">${T('الوصف', 'Description')}</span><span role="columnheader">${T('الحالة', 'Status')}</span><span role="columnheader">${T('الإنجاز', 'Progress')}</span></div>
          ${p.stages.map((s, i) => `<div class="sv-row sv-row--stages" role="row"><span role="cell"><b class="sv-step${s.status === 'COMPLETED' ? ' is-done' : s.status === 'IN_PROGRESS' ? ' is-now' : ''}">${s.status === 'COMPLETED' ? '✓' : i + 1}</b><strong>${esc(L(s.name))}</strong></span><span role="cell">${fmtDate(s.to)}</span><span role="cell">${s.desc ? esc(s.desc) : '—'}</span><span role="cell">${pill(stageStatus(s).cls, L(stageStatus(s).label))}</span><span role="cell" class="sv-row__bar">${bar(s.progress, s.status === 'COMPLETED')}<b>${s.progress}%</b></span></div>`).join('')}
        </div>`;
      },
      tasks() {
        const rows = p.tasks.map((t, i) => ({ t, i })).sort((a, b) => Number(isOverdue(b.t)) - Number(isOverdue(a.t)) || String(a.t.due).localeCompare(String(b.t.due)));
        return `<p class="sv-readonly">${ICONS.lock}<span>${T('عرض للمتابعة فقط. إنشاء المهام وإسنادها من صلاحيات قائد الفريق.', 'Read-only view. Creating and assigning tasks is done by the Team Leader.')}</span></p>
          ${p.tasks.length ? `<div class="tasks-table sv-tasks" role="table" aria-label="${T('مهام المشروع', 'Project tasks')}">
          <div class="tasks-row tasks-row--head sv-task-row" role="row"><span role="columnheader">${T('المهمة', 'Task')}</span><span role="columnheader">${T('المسؤول', 'Assigned to')}</span><span role="columnheader">${T('الأولوية', 'Priority')}</span><span role="columnheader">${T('الحالة', 'Status')}</span><span role="columnheader">${T('تاريخ التسليم', 'Due date')}</span><span role="columnheader"><span class="visually-hidden">${T('عرض', 'View')}</span></span></div>
          ${rows.map(({ t, i }) => { const s = TASK_STATUS(t); return `<div class="tasks-row sv-task-row" role="row"><div class="tasks-row__main" role="cell"><strong>${esc(L(t.title))}</strong><small>${esc(t.stageName || '—')}</small></div><span role="cell">${esc(person(t.who))}</span><span role="cell">${esc(PRIORITY[t.priority] ? L(PRIORITY[t.priority]) : '—')}</span><span role="cell">${pill(s.cls, s.label)}</span><span class="${isOverdue(t) ? 'tasks-row__due--late' : ''}" role="cell">${fmtDate(t.due)}</span><span role="cell"><button class="tasks-row__open" data-open-task="${i}" type="button">${T('عرض', 'View')}${ICONS.arrow}</button></span></div>`; }).join('')}
          </div>` : empty(T('لم يضف قائد الفريق مهامًا بعد', 'The Team Leader has not added tasks yet'))}`;
      },
      files() {
        const files = db.files.filter((f) => f.project === p.id);
        return files.length ? fileTable(files, false) : empty(T('لا توجد ملفات في هذا المشروع', 'No files in this project'));
      },
      feedback() {
        const list = db.feedback.filter((f) => f.project === p.id);
        return `<div class="sv-section-head"><h2>${T('ملاحظاتك للفريق', 'Your feedback to the team')}</h2><button class="sv-btn" data-new-feedback type="button">${T('+ ملاحظة جديدة', '+ New feedback')}</button></div>
          ${list.length ? `<ul class="sv-feed sv-feed--full">${list.map(feedItem).join('')}</ul>` : empty(T('لا توجد ملاحظات بعد', 'No feedback yet'))}`;
      },
      meetings() {
        const list = db.meetings.filter((m) => m.project === p.id).sort((a, b) => b.date.localeCompare(a.date));
        return `<div class="sv-section-head"><h2>${T('اجتماعات المشروع', 'Project meetings')}</h2><a class="sv-btn" href="supervisor-meetings.html?new=${encodeURIComponent(p.id)}">${T('+ جدولة اجتماع', '+ Schedule meeting')}</a></div>
          ${list.length ? meetingTable(list) : empty(T('لا توجد اجتماعات بعد', 'No meetings yet'))}`;
      }
    };
    function show(tab) {
      p = project(p.id) || p;
      tabs.forEach((t) => { const on = t.dataset.tab === tab; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', String(on)); });
      body.innerHTML = panels[tab]();
      qsa('[data-open-task]', body).forEach((b) => b.addEventListener('click', () => openTask(p, Number(b.dataset.openTask))));
      qsa('[data-file]', body).forEach((b) => b.addEventListener('click', () => openFile(b.dataset.file, () => show(tab))));
      qsa('[data-new-feedback]', body).forEach((b) => b.addEventListener('click', () => openFeedback(p.id, () => show('feedback'))));
      bindMeetingActions(body, () => show(tab));
      history.replaceState(null, '', `?p=${encodeURIComponent(p.id)}&tab=${tab}`);
    }
    tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
    show(panels[params.get('tab')] ? params.get('tab') : 'overview');
  }

  const feedItem = (f) => {
    const scope = f.scope === 'DOCUMENT' ? `${L(SCOPE.DOCUMENT)}: ${f.fileName || '—'}` : f.scope === 'TASK' ? `${L(SCOPE.TASK)}: ${f.taskName || '—'}` : L(SCOPE.PROJECT);
    const decision = f.status && REVIEW[f.status] ? ` · ${L(REVIEW[f.status].label)}` : '';
    const pr = project(f.project);
    return `<li><div class="sv-feed__meta"><strong>${esc(person(f.by))}</strong><span>${fmtDate(f.date)}</span><span class="sv-feed__scope">${esc(pr ? L(pr.name) : '')} · ${esc(scope)}${esc(decision)}</span></div>${f.text ? `<p>${esc(f.text)}</p>` : ''}</li>`;
  };

  function fileTable(files, withProject) {
    return `<div class="sv-table" role="table" aria-label="${T('الملفات', 'Files')}">
      <div class="sv-row sv-row--head sv-row--files${withProject ? ' sv-row--files-p' : ''}" role="row"><span role="columnheader">${T('الملف', 'File')}</span>${withProject ? `<span role="columnheader">${T('المشروع', 'Project')}</span>` : ''}<span role="columnheader">${T('رفعه', 'Uploaded by')}</span><span role="columnheader">${T('النسخة', 'Version')}</span><span role="columnheader">${T('التاريخ', 'Date')}</span><span role="columnheader">${T('حالة المراجعة', 'Review status')}</span><span role="columnheader"><span class="visually-hidden">${T('مراجعة', 'Review')}</span></span></div>
      ${files.map((f) => `<div class="sv-row sv-row--files${withProject ? ' sv-row--files-p' : ''}" role="row"><span role="cell" class="sv-row__file">${fileIcon(f)}<strong>${esc(L(f.name))}</strong></span>${withProject ? `<span role="cell">${esc(L(project(f.project).name))}</span>` : ''}<span role="cell">${esc(person(f.by))}</span><span role="cell">v${esc(f.version)}</span><span role="cell">${fmtDate(f.date)}</span><span role="cell">${reviewPill(f)}</span><span role="cell"><button class="tasks-row__open" data-file="${esc(f.id)}" type="button">${D.WAITING_REVIEW.includes(f.status) ? T('مراجعة', 'Review') : T('عرض', 'View')}${ICONS.arrow}</button></span></div>`).join('')}
    </div>`;
  }

  // ----- Reviews -----
  function renderReviews() {
    let filter = 'pending';
    const sel = qs('#svReviewProject');
    sel.innerHTML = `<option value="">${T('كل المشاريع', 'All projects')}</option>` + db.projects.map((p) => `<option value="${esc(p.id)}">${esc(L(p.name))}</option>`).join('');
    const tabs = qsa('[data-review-filter]');
    const draw = () => {
      const base = db.files.filter((f) => project(f.project) && (!sel.value || f.project === sel.value));
      tabs.forEach((t) => {
        const k = t.dataset.reviewFilter; const on = k === filter;
        t.classList.toggle('is-active', on); t.setAttribute('aria-selected', String(on));
        t.querySelector('[data-count]').textContent = base.filter((f) => inReviewTab(f, k)).length;
      });
      const list = base.filter((f) => inReviewTab(f, filter)).sort((a, b) => b.date.localeCompare(a.date));
      qs('#svReviewTable').innerHTML = list.length ? fileTable(list, true) : empty(filter === 'pending' ? T('لا توجد ملفات بانتظار مراجعتك', 'Nothing is waiting for your review') : T('لا توجد ملفات هنا', 'No files here'));
      qsa('[data-file]', qs('#svReviewTable')).forEach((b) => b.addEventListener('click', () => openFile(b.dataset.file, draw)));
    };
    tabs.forEach((t) => t.addEventListener('click', () => { filter = t.dataset.reviewFilter; draw(); }));
    sel.addEventListener('change', draw);
    draw();
    if (params.get('file')) openFile(params.get('file'), draw);
  }

  // ----- Meetings -----
  // Same list structure and icons as the student Meetings page (meetings.html), with supervisor actions.
  const KIND_VIDEO = '<svg viewBox="0 0 24 24"><rect height="12" rx="3" width="12" x="3" y="6"></rect><path d="m15 10 5-3v10l-5-3"></path></svg>';
  const KIND_TEAM = '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="3"></circle><circle cx="16" cy="8" r="3"></circle><path d="M3 19c.7-3.2 2.5-5 5-5s4.3 1.8 5 5M11 19c.6-2.7 2.2-4.4 5-4.4 2.5 0 4.3 1.6 5 4.4"></path></svg>';
  function meetingTable(list) {
    return `<div class="meetings-list sv-meetings-list" role="table" aria-label="${T('الاجتماعات', 'Meetings')}">
      <div class="meeting-table-header" role="row"><span class="meeting-table-header__icon" role="columnheader"><span class="visually-hidden">${T('النوع', 'Type')}</span></span><span role="columnheader">${T('اسم الاجتماع', 'Meeting')}</span><span role="columnheader">${T('المشروع', 'Project')}</span><span role="columnheader">${T('التاريخ', 'Date')}</span><span role="columnheader">${T('الوقت', 'Time')}</span><span role="columnheader">${T('الإجراء', 'Action')}</span></div>
      ${list.map((m) => {
        const p = project(m.project) || { name: '', members: [], leader: null };
        const team = (m.people || []).length >= p.members.length + 1;
        const manage = m.canManage ? `<button aria-label="${T('تعديل', 'Edit')}" class="sv-icon-btn" data-edit-meeting="${esc(m.id)}" title="${T('تعديل', 'Edit')}" type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"></path></svg></button><button aria-label="${T('إلغاء الاجتماع', 'Cancel meeting')}" class="sv-icon-btn sv-icon-btn--danger" data-cancel-meeting="${esc(m.id)}" title="${T('إلغاء الاجتماع', 'Cancel meeting')}" type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>` : '';
        const join = m.canJoin ? `<a class="meeting-action-button meeting-action-button--join" href="meeting-prejoin.html?id=${encodeURIComponent(m.id)}">${T('انضمام', 'Join')}</a>` : `<span class="sv-meeting-state" title="${T('يُفتح الانضمام قبل الموعد بقليل', 'Joining opens shortly before the start')}">${T('مجدول', 'Scheduled')}</span>`;
        const action = m.status === 'CANCELLED' ? `<span class="sv-meeting-state sv-meeting-state--cancelled">${T('ملغي', 'Cancelled')}</span>`
          : m.upcoming ? `${join}${manage}`
          : `<button class="meeting-action-button meeting-action-button--notes" data-notes="${esc(m.id)}" type="button">${T('عرض الملاحظات', 'View notes')}</button>`;
        return `<article class="meeting-list-card meeting-list-card--table${m.status === 'CANCELLED' ? ' is-cancelled' : ''}" role="row"><div class="meeting-list-card__kind" role="cell"><span class="meeting-kind-line"></span><span class="meeting-kind-icon" title="${team ? T('اجتماع الفريق', 'Team meeting') : T('اجتماع مرئي', 'Video meeting')}">${team ? KIND_TEAM : KIND_VIDEO}</span></div><div class="meeting-list-card__name" role="cell">${esc(L(m.title))}${m.agenda ? `<small>${esc(m.agenda)}</small>` : ''}</div><div class="meeting-list-card__supervisor" role="cell">${esc(L(p.name))}</div><div class="meeting-list-card__date" role="cell">${fmtDate(m.date)}</div><div class="meeting-list-card__time" role="cell">${fmtTime(m.time)} - ${fmtTime(addMinutes(m.time, m.duration))}</div><div class="meeting-list-card__action" role="cell">${action}</div></article>`;
      }).join('')}
    </div>`;
  }
  function bindMeetingActions(root, redraw) {
    qsa('[data-edit-meeting]', root).forEach((b) => b.addEventListener('click', () => openMeeting(db.meetings.find((m) => m.id === b.dataset.editMeeting), null, redraw)));
    qsa('[data-cancel-meeting]', root).forEach((b) => b.addEventListener('click', () => {
      const m = db.meetings.find((x) => x.id === b.dataset.cancelMeeting);
      confirmBox(T(`إلغاء "${m.title}"؟`, `Cancel "${m.title}"?`), T('سيصل إشعار بالإلغاء إلى المشاركين.', 'Participants will be notified of the cancellation.'), T('إلغاء الاجتماع', 'Cancel meeting'), (reason) => {
        act(null, () => Api.post(`/meetings/${encodeURIComponent(m.id)}/cancel`, reason ? { reason } : {}), () => {
          redraw(); toast(T('أُلغي الاجتماع وأُبلغ الفريق.', 'Meeting cancelled and the team was notified.'));
        });
      }, true);
    }));
    qsa('[data-notes]', root).forEach((b) => b.addEventListener('click', () => openNotes(b.dataset.notes)));
  }
  // Meeting notes: GET / PUT /meetings/:id/notes (the supervisor's own notes; shared with the team, read-only for students)
  async function openNotes(id) {
    const m = db.meetings.find((x) => x.id === id);
    if (!m) return;
    const pr = project(m.project);
    openDrawer(pr ? L(pr.name) : '', L(m.title), `<dl class="task-drawer__facts"><div><dt>${T('التاريخ', 'Date')}</dt><dd>${fmtDate(m.date)}</dd></div><div><dt>${T('الوقت', 'Time')}</dt><dd>${fmtTime(m.time)}</dd></div></dl>${m.agenda ? `<section class="task-drawer__block"><h3>${T('جدول الأعمال', 'Agenda')}</h3><p>${esc(m.agenda)}</p></section>` : ''}<section class="task-drawer__block"><h3>${T('ملاحظاتي على الاجتماع', 'My meeting notes')}</h3><p class="sv-muted sv-notes-hint">${T('تظهر ملاحظاتك لطلاب الفريق للقراءة فقط، وملاحظات الطلاب خاصة بهم.', 'The team students can read your notes (read-only); their own notes stay private.')}</p><p id="svNotesText" style="white-space:pre-line">${T('جارٍ التحميل…', 'Loading…')}</p><small class="sv-muted" id="svNotesMeta"></small>
      <form class="sv-inline-form" id="svNotesForm" hidden><label class="visually-hidden" for="svNotesInput">${T('ملاحظات الاجتماع', 'Meeting notes')}</label><textarea id="svNotesInput" maxlength="20000" rows="5"></textarea><small class="field-error" hidden>${T('اكتب الملاحظات أولًا', 'Write the notes first')}</small><div class="sv-review-actions"><button class="sv-btn" type="submit">${T('حفظ', 'Save')}</button><button class="sv-btn sv-btn--text" data-notes-cancel type="button">${T('إلغاء', 'Cancel')}</button></div></form>
      <button class="sv-btn sv-btn--ghost" id="svNotesEdit" type="button" hidden>${T('تعديل الملاحظات', 'Edit notes')}</button></section><section class="task-drawer__block"><h3>${T('المشاركون', 'Participants')}</h3><p>${m.people.map(person).map(esc).join(T('، ', ', ')) || '—'}</p></section>`);
    const form = qs('#svNotesForm'), input = qs('#svNotesInput'), editBtn = qs('#svNotesEdit'), text = qs('#svNotesText'), meta = qs('#svNotesMeta');
    let current = '';
    try {
      const n = await Api.get(`/meetings/${encodeURIComponent(id)}/notes`);
      current = (n && n.exists && n.content) || '';
      text.textContent = current || T('لم تُكتب ملاحظات بعد.', 'No notes yet.');
      meta.textContent = n && n.exists ? `${T('آخر تحديث', 'Last updated')}: ${fmtDate(dayOf(n.updatedAt))}` : '';
      editBtn.hidden = m.status === 'CANCELLED';
    } catch (e) { text.textContent = Api.message(e); }
    editBtn.addEventListener('click', () => { input.value = current; form.hidden = false; editBtn.hidden = true; input.focus(); });
    qs('[data-notes-cancel]', form).addEventListener('click', () => { form.hidden = true; editBtn.hidden = false; });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim(); const err = form.querySelector('.field-error');
      input.classList.toggle('is-invalid', !v); err.hidden = !!v;
      if (!v) { input.focus(); return; }
      act(form.querySelector('[type="submit"]'), () => Api.put(`/meetings/${encodeURIComponent(id)}/notes`, { content: v }), () => {
        openNotes(id); toast(T('حُفظت ملاحظات الاجتماع.', 'Meeting notes saved.'));
      });
    });
  }

  const mModal = qs('#svMeetingModal');
  function openMeeting(m, pid, redraw) {
    const editing = !!m;
    qs('#mHeading').textContent = editing ? T('تعديل الاجتماع', 'Edit meeting') : T('جدولة اجتماع', 'Schedule a meeting');
    qs('#mSubmit').textContent = editing ? T('حفظ التعديلات', 'Save changes') : T('جدولة الاجتماع', 'Schedule meeting');
    const projSel = qs('#mProject');
    projSel.innerHTML = db.projects.filter((p) => p.status !== 'COMPLETED' || (m && m.project === p.id)).map((p) => `<option value="${esc(p.id)}">${esc(L(p.name))}</option>`).join('');
    if (!projSel.options.length) { toast(T('لا توجد مشاريع نشطة تحت إشرافك.', 'There are no active projects under your supervision.'), 'error'); return; }
    projSel.value = m ? m.project : (pid && project(pid) ? pid : projSel.value);
    projSel.disabled = editing; // the project of a meeting cannot be changed
    const fillPeople = (checked) => {
      const p = project(projSel.value);
      const ids = p ? [p.leader, ...p.members].filter(Boolean) : [];
      qs('#mPeople').innerHTML = ids.length ? ids.map((k) => `<label class="sv-check"><input type="checkbox" value="${esc(k)}"${!checked || checked.includes(k) ? ' checked' : ''}/><span>${esc(person(k))}</span></label>`).join('') : `<small class="sv-muted">${T('لا يوجد أعضاء في الفريق بعد.', 'The team has no members yet.')}</small>`;
    };
    projSel.onchange = () => fillPeople(null);
    fillPeople(m ? m.people : null);
    qs('#mTitle').value = m ? m.title : '';
    qs('#mAgenda').value = m ? m.agenda : '';
    qs('#mDuration').value = String(m ? m.duration : 60);
    const date = qs('#mDate'), time = qs('#mTime');
    date.dataset.iso = m ? m.date : ''; date.value = m ? fmtDate(m.date) : '';
    time.dataset.time = m ? m.time : ''; time.value = m ? fmtTime(m.time) : '';
    qsa('.is-invalid', mModal).forEach((el) => el.classList.remove('is-invalid'));
    qsa('.field-error', mModal).forEach((el) => { el.hidden = true; });
    const formErr = qs('#mFormError'); if (formErr) formErr.textContent = '';
    mModal.hidden = false; qs('#mTitle').focus();
    mModal.onSave = () => {
      const title = qs('#mTitle').value.trim(); const iso = date.dataset.iso || ''; const hm = time.dataset.time || '';
      const people = qsa('#mPeople input:checked').map((c) => c.value);
      const checks = [[qs('#mTitle'), !!title, '#mTitleError'], [date, !!iso, '#mDateError'], [time, !!hm, '#mTimeError']];
      checks.forEach(([el, ok, err]) => { el.classList.toggle('is-invalid', !ok); qs(err).hidden = ok; });
      const peopleOk = people.length > 0; qs('#mPeopleError').hidden = peopleOk;
      if (checks.some((c) => !c[1]) || !peopleOk) return;
      const when = new Date(`${iso}T${hm}:00`);
      if (!editing && when.getTime() < Date.now()) { time.classList.add('is-invalid'); const te = qs('#mTimeError'); te.textContent = T('اختر وقتًا لم يمضِ بعد', 'Choose a time that has not passed'); te.hidden = false; return; }
      const agendaText = qs('#mAgenda').value.trim();
      // the supervisor stays a participant (the server always keeps the organiser only)
      const body = { title, description: agendaText || (editing ? '' : undefined), durationMinutes: Number(qs('#mDuration').value), participantIds: [...new Set([ME.id, ...people])] };
      if (!editing || new Date(m.scheduledAt).getTime() !== when.getTime()) body.scheduledAt = when.toISOString();
      const submit = qs('#mSubmit');
      UI.busy(submit, async () => {
        try {
          if (editing) await Api.patch(`/meetings/${encodeURIComponent(m.id)}`, body);
          else await Api.post('/meetings', { projectId: projSel.value, ...body });
        } catch (e) {
          const msg = Api.message(e);
          if (formErr) formErr.textContent = msg; else toast(msg, 'error');
          return;
        }
        mModal.hidden = true;
        try { await load(); } catch (e) { /* the list keeps the old copy */ }
        renderShell(); redraw && redraw();
        toast(editing ? T('حُدّث الاجتماع وأُبلغ المشاركون.', 'Meeting updated and participants were notified.') : T('جُدول الاجتماع وأُرسلت الدعوات.', 'Meeting scheduled and invitations were sent.'));
      });
    };
  }
  if (mModal) {
    const close = () => { mModal.hidden = true; };
    qsa('[data-close-meeting]').forEach((b) => b.addEventListener('click', close));
    mModal.addEventListener('click', (e) => { if (e.target === mModal) close(); });
    qs('#mForm').addEventListener('submit', (e) => { e.preventDefault(); mModal.onSave && mModal.onSave(); });
  }

  function renderMeetings() {
    let tab = 'upcoming';
    const tabs = qsa('[data-meet-tab]');
    const draw = () => {
      const groups = {
        upcoming: db.meetings.filter((m) => m.upcoming && project(m.project)).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt))),
        previous: db.meetings.filter((m) => m.status !== 'CANCELLED' && !m.upcoming && project(m.project)).sort((a, b) => String(b.scheduledAt).localeCompare(String(a.scheduledAt))),
        cancelled: db.meetings.filter((m) => m.status === 'CANCELLED' && project(m.project))
      };
      tabs.forEach((t) => { const on = t.dataset.meetTab === tab; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', String(on)); t.querySelector('[data-count]').textContent = groups[t.dataset.meetTab].length; });
      const list = groups[tab];
      const head = qs('#svMeetingsHeading'); if (head) head.textContent = { upcoming: T('الاجتماعات المجدولة', 'Scheduled meetings'), previous: T('الاجتماعات السابقة', 'Previous meetings'), cancelled: T('الاجتماعات الملغاة', 'Cancelled meetings') }[tab];
      qs('#svMeetingsTable').innerHTML = list.length ? meetingTable(list) : empty(tab === 'upcoming' ? T('لا توجد اجتماعات قادمة', 'No upcoming meetings') : T('لا توجد اجتماعات هنا', 'No meetings here'));
      bindMeetingActions(qs('#svMeetingsTable'), draw);
    };
    tabs.forEach((t) => t.addEventListener('click', () => { tab = t.dataset.meetTab; draw(); }));
    qs('#svNewMeeting').addEventListener('click', () => openMeeting(null, null, () => { tab = 'upcoming'; draw(); }));
    draw();
    if (params.get('new')) openMeeting(null, params.get('new'), () => { tab = 'upcoming'; draw(); });
    if (params.get('ended')) {
      const ended = db.meetings.find((m) => m.id === params.get('ended'));
      history.replaceState(null, '', location.pathname);
      if (ended) { toast(T(`غادرت اجتماع "${ended.title}". يمكنك تدوين الملاحظات الآن.`, `You left "${ended.title}". You can write the notes now.`)); openNotes(ended.id); }
    }
  }

  // ----- Notifications -----
  function renderNotifications() {
    let filter = 'all';
    const TYPE_ICON = { request: 'request', file: 'file', deadline: 'clock', feedback: 'note', task: 'task', meeting: 'meet', project: 'flag' };
    const target = (n) => {
      const d = n.data || {}; const pq = d.projectId ? `p=${encodeURIComponent(d.projectId)}` : '';
      if (n.rawType === 'SUPERVISION_REQUESTED') return 'supervisor-projects.html?view=requests';
      if (d.documentId) return `supervisor-reviews.html?file=${encodeURIComponent(d.documentId)}`;
      if (d.meetingId) return 'supervisor-meetings.html';
      if (d.taskId && pq) return `supervisor-project.html?${pq}&tab=tasks`;
      if (pq && project(d.projectId)) return `supervisor-project.html?${pq}`;
      return '#';
    };
    const groups = { all: () => true, unread: (n) => !n.read, request: (n) => n.type === 'request', file: (n) => n.type === 'file', meeting: (n) => n.type === 'meeting' };
    const tabs = qsa('[data-notif]');
    const draw = () => {
      tabs.forEach((t) => { const on = t.dataset.notif === filter; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', String(on)); t.querySelector('[data-count]').textContent = db.notifications.filter(groups[t.dataset.notif]).length; });
      const list = db.notifications.filter(groups[filter]).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      qs('#svNotifList').innerHTML = list.length ? `<ul class="sv-notifs">${list.map((n) => `<li class="${n.read ? '' : 'is-unread'}"><a data-notif-id="${esc(n.id)}" href="${esc(target(n))}"><span class="sv-agenda__icon">${ICONS[TYPE_ICON[n.type]] || ICONS.flag}</span><span class="sv-list__main"><strong>${esc(n.title)}</strong>${n.text ? `<span class="sv-notif__text">${esc(n.text)}</span>` : ''}<small>${n.project && project(n.project) ? `${esc(L(project(n.project).name))} · ` : ''}${relDay(n.date)} · ${fmtTime(n.time)}</small></span>${n.read ? '' : `<span class="visually-hidden">${T('غير مقروء', 'Unread')}</span>`}</a></li>`).join('')}</ul>` : empty(T('لا توجد إشعارات هنا', 'No notifications here'));
      qsa('[data-notif-id]').forEach((a) => a.addEventListener('click', async (e) => {
        const n = db.notifications.find((x) => x.id === a.dataset.notifId);
        if (!n || n.read) return;
        e.preventDefault();
        try { await Api.patch(`/notifications/${encodeURIComponent(n.id)}/read`, {}); } catch (err) { /* opening still works */ }
        n.read = true; db.unread = Math.max(0, db.unread - 1);
        if (a.getAttribute('href') !== '#') location.href = a.href; else { renderShell(); draw(); }
      }));
      qs('#svMarkAll').disabled = !db.notifications.some((n) => !n.read);
    };
    tabs.forEach((t) => t.addEventListener('click', () => { filter = t.dataset.notif; draw(); }));
    qs('#svMarkAll').addEventListener('click', () => act(qs('#svMarkAll'), () => Api.patch('/notifications/read-all', {}), draw));
    draw();
  }

  // ----- AI assistant (supervisor scope: guidance only; no task actions) -----
  function renderAssistant() {
    const sel = qs('#svAiProject');
    sel.innerHTML = db.projects.map((p) => `<option value="${esc(p.id)}">${esc(L(p.name))}</option>`).join('');
    if (project(params.get('p'))) sel.value = params.get('p');
    const thread = qs('#svAiThread');
    if (!db.projects.length) {
      thread.innerHTML = empty(T('لا توجد مشاريع تحت إشرافك بعد', 'No projects under your supervision yet'), T('يعمل المساعد على مشاريعك المعتمدة فقط.', 'The assistant works only on projects you supervise.'));
      qsa('#svAiForm input, #svAiForm textarea, #svAiForm button, #svAiProject').forEach((el) => { el.disabled = true; });
      return;
    }
    const PROMPTS = [
      ['summary', ['لخّص وضع المشروع', 'Summarize the project status']],
      ['overdue', ['ما المهام المتأخرة وما أثرها؟', 'Which tasks are overdue and why does it matter?']],
      ['agenda', ['اقترح نقاطًا للاجتماع القادم', 'Suggest points for the next meeting']],
      ['handbook', ['هل يغطي المشروع متطلبات الدليل؟', 'Does the project cover the handbook requirements?']]
    ];
    // No task-suggestion prompt: supervisors follow the project; creating and assigning tasks
    // belongs to the team (the backend also refuses TASK_BREAKDOWN for supervisors).
    qs('#svAiPrompts').innerHTML = PROMPTS.map(([k, t]) => `<button class="sv-chip" data-ai="${k}" type="button">${esc(L(t))}</button>`).join('');
    const say = (who, html) => {
      thread.insertAdjacentHTML('beforeend', `<div class="sv-msg sv-msg--${who}">${html}</div>`);
      // answers can be in either language: each line takes its own direction
      thread.lastElementChild.querySelectorAll('p, li, span.hb-quote').forEach((el) => el.setAttribute('dir', 'auto'));
      thread.scrollTop = thread.scrollHeight;
    };
    // Real answers from POST /ai-support/requests (PROJECT_QUESTION), built by the server from the
    // project records and the handbook. Supervisor answers never carry task suggestions, and nothing
    // here creates, assigns or changes anything: the answer is advice only.
    const render = (r) => {
      const g = r.guidance || {};
      const list = (arr, fn) => (arr && arr.length ? `<ul>${arr.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>` : '');
      let html = '';
      if (g.answer) html += `<p>${esc(g.answer)}</p>`;
      if (g.summary && g.summary !== g.answer) html += `<p>${esc(g.summary)}</p>`;
      if ((g.recommendations || []).length) html += `<p><b>${T('توصيات', 'Recommendations')}</b></p>` + list(g.recommendations, (x) => `<b>${esc(x.title)}</b>${x.detail ? ` — ${esc(x.detail)}` : ''}`);
      if ((g.nextSteps || []).length) html += `<p><b>${T('خطوات مقترحة للنقاش مع الفريق', 'Points to discuss with the team')}</b></p>` + list(g.nextSteps, (x) => esc(x));
      if ((g.risks || []).length) html += `<p><b>${T('مخاطر محتملة', 'Possible risks')}</b></p>` + list(g.risks, (x) => esc(x));
      if ((g.handbookReferences || []).length) html += `<p><b>${T('من دليل المشروع', 'From the project handbook')}</b></p>` + list(g.handbookReferences, (x) => `${x.page ? `${T('صفحة', 'Page')} ${esc(x.page)}: ` : ''}<span class="hb-quote">${esc(x.quote)}</span>`);
      if (!html) html = `<p>${T('لم يُرجع المساعد إجابة يمكن عرضها. أعد صياغة السؤال.', 'The assistant returned no answer that can be shown. Rephrase the question.')}</p>`;
      return html + `<p class="sv-muted"><small>${T('إجابة إرشادية من الذكاء الاصطناعي، لا تغيّر أي بيانات ولا تُعد تقييمًا. تحقّق من القرارات المهمة مع الدليل.', 'AI guidance only: it changes no data and is not an evaluation. Check important decisions against the handbook.')}</small></p>`;
    };
    let busy = false;
    const ask = async (text) => {
      if (busy) return; busy = true;
      say('me', `<p>${esc(text)}</p>`);
      const typing = document.createElement('div'); typing.className = 'sv-msg sv-msg--ai sv-msg--typing'; typing.innerHTML = '<span></span><span></span><span></span>'; thread.append(typing); thread.scrollTop = thread.scrollHeight;
      const send = qs('#svAiForm [type="submit"]'); if (send) send.disabled = true;
      try {
        const r = await Api.post('/ai-support/requests', { projectId: sel.value, kind: 'PROJECT_QUESTION', question: text, language: lang }, { timeout: Api.aiTimeout || 100000 });
        typing.remove();
        if (r.status && r.status !== 'COMPLETED') say('ai', `<p class="sv-late">${esc(Api.message({ code: r.errorCode || 'AI_PROVIDER_UNAVAILABLE' }))}</p>`);
        else say('ai', render(r));
      } catch (e) {
        typing.remove(); say('ai', `<p class="sv-late">${esc(Api.message(e))}</p>`);
      } finally { busy = false; if (send) send.disabled = false; }
    };
    const greet = () => { thread.innerHTML = ''; say('ai', `<p>${T(`يقدّم المساعد إجابات مستندة إلى بيانات مشروع "${esc(L(project(sel.value).name))}"، ومنها الأهداف والمراحل والمهام والمواعيد وبيانات الملفات والملاحظات السابقة ودليل المشروع. اختر أحد الأسئلة المقترحة أو اكتب سؤالك.`, `The assistant answers from the records of "${esc(L(project(sel.value).name))}", including its objectives, stages, tasks, dates, file details, previous feedback and the project handbook. Choose a suggested question or type your own.`)}</p>`); };
    qsa('[data-ai]').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
    sel.addEventListener('change', greet);
    qs('#svAiForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = qs('#svAiInput'); const text = input.value.trim(); if (!text) return;
      if (text.length < 2) return;
      input.value = ''; ask(text);
    });
    greet();
  }

  // ----- Settings -----
  function renderSettings() {
    const u = S.user || {};
    qs('#sFirst').value = u.firstName || ''; qs('#sLast').value = u.lastName || ''; qs('#sEmail').value = u.email || '';
    qsa('.language-option').forEach((b) => b.addEventListener('click', () => {
      const next = b.dataset.language === 'en' ? 'en' : 'ar';
      if (next === lang) return;
      try { localStorage.setItem(LANG_KEY, next); } catch (e) { /* storage unavailable */ }
      location.reload();
    }));
    qs('#sProfileForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const first = qs('#sFirst').value.trim(); const err = qs('#sProfileError'); err.textContent = '';
      if (!first) { err.textContent = T('الاسم الأول مطلوب.', 'The first name is required.'); qs('#sFirst').focus(); return; }
      UI.busy(e.submitter || qs('#sProfileForm [type="submit"]'), async () => {
        try {
          const nu = await Api.patch('/users/me', { firstName: first, lastName: qs('#sLast').value.trim() || undefined });
          Api.saveUser(Object.assign({}, S.user, nu)); ME.name = UI.personName(nu); renderShell();
          toast(T('حُفظت التغييرات.', 'Changes saved.'));
        } catch (er) { err.textContent = Api.message(er); }
      });
    });
    // change password and delete account: account-security.js
  }

  // ---------- Boot ----------
  translateStatic();
  const PAGES = { dashboard: renderDashboard, projects: renderProjects, project: renderProject, reviews: renderReviews, meetings: renderMeetings, notifications: renderNotifications, assistant: renderAssistant, settings: renderSettings };
  S.ready.then(async (u) => {
    if (!u) return;
    ME.id = u.id; ME.name = UI.personName(u); remember(u);
    renderShell();
    if (page === 'settings') { renderSettings(); }
    // the page-wide loading screen (session.js) covers this first load: no second loader
    try { await load(); } catch (e) {
      const host = qs('main') || document.body;
      const box = document.createElement('div'); box.className = 'app-banner app-banner--error'; box.setAttribute('role', 'alert');
      box.innerHTML = `${esc(Api.message(e))} <button class="app-state__action" type="button">${T('إعادة المحاولة', 'Try again')}</button>`;
      box.querySelector('button').addEventListener('click', () => location.reload());
      host.prepend(box);
      return;
    }
    renderShell();
    if (page !== 'settings') (PAGES[page] || (() => {}))();
  });
})();
