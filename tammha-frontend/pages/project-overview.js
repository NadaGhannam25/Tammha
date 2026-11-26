// ===== Project overview (project-overview.html) — connected to the API =====
// Project:      GET /projects/:id (workspace: project, team, leader, supervisors, viewer, progress, setupReadiness)
// Setup:        GET /projects/:id/setup → missing requirements; POST /projects/:id/setup/complete (team leader)
// Team (leader): GET /teams/:id/invitation (code + link), POST …/invitation/regenerate,
//               POST /teams/:id/student-invitations { studentNumber | universityEmail }, GET … (sent),
//               POST /team-invitations/:id/cancel, DELETE /teams/:id/members/:userId, PATCH /teams/:id/leader
// Member:       DELETE /teams/:id/members/<own id> = leave the team
// Supervision:  GET /projects/:id/supervision-requests, POST … { supervisorEmail } (leader), POST /supervision-requests/:id/cancel
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession; const D = window.TammhaDomain;
  const { T, L, esc } = UI;
  const $ = (id) => document.getElementById(id);
  let w = null;

  function render() {
    document.querySelectorAll('.overview-editor').forEach((x) => x.remove());
    $('ovOverview').hidden = false; $('ovGoals').hidden = false;
    const p = w.project;
    // every student of the team manages the project alike; the owner (the team LEADER)
    // also hands the ownership over and deletes the project
    const canManage = !!(w.viewer?.canManage ?? w.viewer?.isLeader); const isOwner = !!w.viewer?.isLeader;
    $('overviewProjectName').textContent = p.name;
    document.title = p.name;
    S.projectHeroProgress(w); // the completion, once, in the title bar
    // nothing written yet: the section stays empty (renderSetup shows what is missing)
    $('ovOverview').textContent = p.overview || p.description || '';
    // project details: the category and the type, each with its label (edited with the pencil)
    const D = window.TammhaDomain || {}; const lbl = (o) => (o ? T(o[0], o[1]) : '');
    const cat = lbl((D.PROJECT_CATEGORIES || {})[p.category]); const org = lbl((D.PROJECT_ORIGINS || {})[p.origin]);
    $('ovDetails').hidden = !(cat || org);
    $('ovDetails').innerHTML = `<div class="ov-sup__col"><span class="ov-sup__label">${esc(T('تصنيف المشروع', 'Project category'))}</span><b>${esc(cat || '—')}</b></div>
      <div class="ov-sup__col"><span class="ov-sup__label">${esc(T('نوع المشروع', 'Project type'))}</span><b>${esc(org || '—')}</b></div>`;
    const goals = (p.objectives || []).filter(Boolean);
    $('ovGoals').innerHTML = goals.length ? goals.map((g) => `<li>${esc(g)}</li>`).join('') : '';
    // a pencil (top-left) edits the idea and the objectives, for every student of the team
    document.querySelectorAll('[data-edit-panel]').forEach((b) => { b.hidden = !canManage; });
    const members = w.team?.members || [];
    // team: the Team Leader (who created the project, or received the leadership) first with the
    // badge; under the leader's name the leader sees two small options: add a member, invitation code
    const me = S.user;
    const sorted = [...members].sort((a, b) => (b.teamRole === 'LEADER') - (a.teamRole === 'LEADER'));
    $('ovTeam').innerHTML = sorted.map((m) => {
      const name = UI.personName(m.user); const lead = m.teamRole === 'LEADER';
      const tools = canManage && lead ? `<span class="team-member__tools">
          <button class="team-link" type="button" data-team-tool="ovInviteForm" aria-controls="ovInviteForm" aria-expanded="false">${esc(T('+ إضافة عضو', '+ Add member'))}</button>
          <button class="team-link" type="button" data-team-tool="ovInviteCode" aria-controls="ovInviteCode" aria-expanded="false">${esc(T('رمز الدعوة', 'Invitation code'))}</button></span>` : '';
      const actions = canManage && !lead && m.userId !== me.id ? `<span class="team-member__tools">${isOwner ? `<button class="team-link" type="button" data-make-leader="${esc(m.userId)}">${esc(T('تعيين قائدًا', 'Make leader'))}</button>` : ''}<button class="team-link team-link--danger" type="button" data-remove="${esc(m.userId)}">${esc(T('إزالة', 'Remove'))}</button></span>` : '';
      return `<div class="team-member${lead ? ' is-leader' : ''}">${UI.avatarHtml(m.user, 'team-member__avatar')}
        <div class="team-member__info"><span class="team-member__line"><span class="team-member__name">${esc(name)}</span>${lead ? `<span class="team-badge">${esc(T('قائد الفريق', 'Team Leader'))}</span>` : ''}</span>${tools}${actions}</div></div>`;
    }).join('');
    $('ovTeamTools').innerHTML = (canManage ? `<form class="team-tool" id="ovInviteForm" hidden novalidate>
          <label class="team-tool__label" for="ovInviteValue">${esc(T('الرقم الجامعي أو البريد الجامعي للزميل', "Classmate's student number or university email"))}</label>
          <div class="team-tool__row"><input id="ovInviteValue" autocomplete="off" placeholder="${esc(T('مثال: 441234567', 'e.g. 441234567'))}"/><button class="app-btn app-btn--primary" type="submit">${esc(T('إرسال دعوة', 'Send invitation'))}</button></div>
          <small class="app-field-error" id="ovInviteError" role="alert"></small>
        </form>
        <div class="team-tool" id="ovInviteCode" hidden aria-live="polite"></div>
        <ul class="team-pending" id="ovSentInvites"></ul>` : '') +
      // leave the project (not the last student) and, for the owner, delete it
      `<div class="team-exit">${members.length > 1 ? `<button class="team-exit__btn" type="button" data-leave>${esc(T('مغادرة المشروع', 'Leave the project'))}</button>` : ''}${isOwner ? `<button class="team-exit__btn team-exit__btn--danger" type="button" data-delete-project>${esc(T('حذف المشروع', 'Delete the project'))}</button>` : ''}</div>`;
    if (canManage) loadSentInvitations();
    renderSetup(); loadSupervision();
  }

  // the two leader options open one compact panel at a time under the team list
  function toggleTool(id) {
    document.querySelectorAll('[data-team-tool]').forEach((b) => {
      const open = b.dataset.teamTool === id && b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', String(open));
      const panel = $(b.dataset.teamTool); if (panel) panel.hidden = !open;
      if (open && id === 'ovInviteForm') $('ovInviteValue').focus();
      if (open && id === 'ovInviteCode') loadInvitationCode();
    });
  }

  async function loadInvitationCode() {
    const box = $('ovInviteCode'); if (!box) return;
    try {
      const inv = await Api.get(`/teams/${w.team.id}/invitation`);
      box.innerHTML = `<span class="team-tool__label">${esc(T('شارك الرمز أو الرابط مع زميلك', 'Share the code or the link with your classmate'))}</span>
        <div class="team-code"><code class="team-code__value" dir="ltr">${esc(inv.code)}</code>
          <button class="team-icon-btn" type="button" data-copy="${esc(inv.link)}" title="${esc(T('نسخ رابط الدعوة', 'Copy the invitation link'))}" aria-label="${esc(T('نسخ رابط الدعوة', 'Copy the invitation link'))}"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path></svg></button><button class="team-icon-btn" type="button" data-regenerate title="${esc(T('إنشاء رمز جديد', 'Create a new code'))}" aria-label="${esc(T('إنشاء رمز جديد', 'Create a new code'))}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"></path><path d="M4 3v5h5"></path><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"></path><path d="M20 21v-5h-5"></path></svg></button></div>
        <small class="app-muted">${esc(T('الرمز الجديد يُبطل الرمز والرابط السابقين.', 'A new code makes the previous code and link stop working.'))}</small>`;
    } catch (e) { box.textContent = Api.message(e); }
  }
  async function loadSentInvitations() {
    try {
      const items = await Api.get(`/teams/${w.team.id}/student-invitations`);
      const pending = (items || []).filter((i) => i.status === 'PENDING');
      $('ovSentInvites').innerHTML = (pending.length ? `<li class="team-pending__head">${esc(T('دعوات بانتظار الرد', 'Pending invitations'))}</li>` : '') + pending.map((i) => `<li><span>${esc(i.invitee?.displayName || '')}</span><button class="team-link" type="button" data-cancel-invite="${esc(i.id)}">${esc(T('سحب الدعوة', 'Withdraw'))}</button></li>`).join('');
    } catch (e) { /* the list is optional */ }
  }

  // No "setup is not complete" panel: whatever is still missing is shown in its own section
  // ("not complete yet"). When nothing is missing the setup is completed quietly.
  const SECTION_OF = {
    PROJECT_OVERVIEW_REQUIRED: 'idea', PROJECT_DESCRIPTION_REQUIRED: 'idea',
    PROJECT_OBJECTIVES_REQUIRED: 'goals',
    SUPERVISOR_REQUEST_REQUIRED: 'supervisor', SUPERVISOR_APPROVAL_REQUIRED: 'supervisor',
    TEAM_LEADER_REQUIRED: 'team', EMAIL_NOT_VERIFIED: 'team', UNIVERSITY_IDENTITY_REQUIRED: 'team', TEAM_NAME_REQUIRED: 'team',
    HANDBOOK_REQUIRED: 'handbook', HANDBOOK_PROCESSING: 'handbook', HANDBOOK_FAILED: 'handbook',
    PROJECT_CATEGORY_REQUIRED: 'details', PROJECT_ORIGIN_REQUIRED: 'details',
  };
  const SECTION_EL = { idea: '.overview-panel--idea', goals: '.overview-panel--goals', details: '.overview-panel--details', supervisor: '#ovSupervision', team: '.overview-team' };
  async function renderSetup() {
    const box = $('ovSetup'); box.innerHTML = '';
    document.querySelectorAll('.ov-empty').forEach((x) => x.remove());
    if (w.project.setup?.completed) return;
    let missing = [];
    try { missing = (await Api.get(`/projects/${w.id}/setup`)).readiness?.missingRequirements || []; }
    catch (e) { return; } // nothing to mark; the sections still show their content
    const canManage = !!(w.viewer?.canManage ?? w.viewer?.isLeader);
    if (!missing.length) {
      if (canManage) Api.post(`/projects/${w.id}/setup/complete`, {}).then(() => { w.project.setup = { ...(w.project.setup || {}), completed: true }; S.invalidateProjects(); }).catch(() => {});
      return;
    }
    const groups = {};
    missing.forEach((m) => { const k = SECTION_OF[m] || 'details'; (groups[k] = groups[k] || []).push(m); });
    // an empty-state card inside the section: what is missing, and the way to add it
    const ADD = {
      idea: [T('أضف فكرة المشروع ليتعرّف عليها الفريق والمشرف.', 'Add the project idea for the team and the supervisor.'), 'idea'],
      goals: [T('أضف أهداف المشروع، هدفًا في كل سطر.', 'Add the project objectives, one per line.'), 'goals'],
      details: [T('اختر تصنيف المشروع ونوعه.', 'Choose the project category and type.'), 'details'],
      supervisor: [T('أرسل طلب إشراف إلى مشرفك الأكاديمي من الحقل أدناه.', 'Send a supervision request to your academic supervisor below.')],
      handbook: [T('اختر دليل المشروع من المكتبة أو ارفع دليل جامعتك.', "Choose the project handbook from the library or upload your university's.")],
    };
    const card = (k, codes) => {
      const [text, edit] = ADD[k] || [codes.map((c) => UI.setupRequirement(c)).join('، ')];
      const action = edit && canManage
        ? `<button class="ov-empty__btn" type="button" data-edit-panel="${edit}">${esc(T('إضافة', 'Add'))}</button>`
        : k === 'handbook' ? `<a class="ov-empty__btn" href="guide.html?project=${encodeURIComponent(w.id)}">${esc(T('اختيار الدليل', 'Choose'))}</a>` : '';
      return `<div class="ov-empty" role="note"><div class="ov-empty__body"><strong>${esc(T('لم يكتمل بعد', 'Not complete yet'))}</strong><span>${esc(text)}</span></div>${action}</div>`;
    };
    Object.entries(groups).forEach(([k, codes]) => {
      const el = SECTION_EL[k] && document.querySelector(SECTION_EL[k]);
      const h = el && el.querySelector('h2');
      if (h) {
        if (k === 'idea') $('ovOverview').hidden = true;
        if (k === 'goals') $('ovGoals').hidden = true;
        if (k === 'details') $('ovDetails').hidden = true;
        h.insertAdjacentHTML('afterend', card(k, codes)); return;
      }
      // sections that are not on this page: the handbook and the project details
      const title = k === 'handbook' ? T('دليل المشروع', 'Project handbook') : T('بيانات المشروع', 'Project details');
      box.insertAdjacentHTML('beforeend', `<article class="overview-panel ov-missing"><h2>${esc(title)}</h2>${card(k, codes)}</article>`);
    });
  }

  async function loadSupervision() {
    const body = $('ovSupBody'); const isLeader = !!(w.viewer?.canManage ?? w.viewer?.isLeader); // every student of the team
    const sup = ((w.supervisors || [])[0] || {}).user || (w.supervisors || [])[0]; // { userId, user } from the API
    // with a supervisor: two columns (title + name, e-mail label + e-mail); the section title
    // is the first column's label, so the heading itself is kept for screen readers only
    $('ovSupTitle').classList.toggle('visually-hidden', !!sup);
    if (sup) {
      body.innerHTML = `<div class="ov-sup"><div class="ov-sup__col"><span class="ov-sup__label">${esc(T('المشرف الأكاديمي', 'Academic supervisor'))}</span><b>${esc(UI.personName(sup))}</b></div>
        <div class="ov-sup__col"><span class="ov-sup__label">${esc(T('البريد الإلكتروني للمشرف', "Supervisor's email"))}</span><a dir="ltr" href="mailto:${esc(sup.email || '')}">${esc(sup.email || '')}</a></div></div>`;
      return;
    }
    try {
      const reqs = await Api.get(`/projects/${w.id}/supervision-requests`);
      const pending = (reqs || []).find((r) => r.status === 'PENDING');
      const rejected = (reqs || []).filter((r) => r.status === 'REJECTED');
      let html = pending ? `<p>${esc(T('طلب إشراف بانتظار الرد من', 'Supervision request waiting for'))} <strong>${esc(UI.personName(pending.supervisor))}</strong> ${isLeader ? `<button class="app-btn app-btn--ghost" type="button" data-cancel-request="${esc(pending.id)}">${esc(T('إلغاء الطلب', 'Cancel the request'))}</button>` : ''}</p>` : `<p class="app-muted">${esc(T('لا يوجد مشرف للمشروع بعد.', 'The project has no supervisor yet.'))}</p>`;
      if (rejected.length) html += `<p class="app-muted">${esc(T('اعتذر عن الإشراف:', 'Declined:'))} ${rejected.map((r) => esc(UI.personName(r.supervisor))).join('، ')}</p>`;
      if (isLeader && !pending) html += `<form class="app-inline-form" id="ovSupForm"><input id="ovSupEmail" type="email" autocomplete="off" placeholder="${esc(T('البريد الجامعي للمشرف', "Supervisor's university email"))}" aria-label="${esc(T('البريد الجامعي للمشرف', "Supervisor's university email"))}"/><button class="app-btn app-btn--primary" type="submit">${esc(T('إرسال طلب إشراف', 'Send supervision request'))}</button></form>`;
      body.innerHTML = html;
    } catch (e) { UI.state(body, 'error', { error: e }); }
  }

  async function reload() { w = await S.currentWorkspace(); render(); }

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'ovInviteForm') {
      e.preventDefault();
      const v = $('ovInviteValue').value.trim(); const err = $('ovInviteError'); err.textContent = '';
      if (!v) { err.textContent = T('اكتب الرقم الجامعي أو البريد الجامعي.', 'Enter the student number or university email.'); $('ovInviteValue').focus(); return; }
      UI.busy(e.target.querySelector('button'), async () => {
        try {
          await Api.post(`/teams/${w.team.id}/student-invitations`, /@/.test(v) ? { universityEmail: v } : { studentNumber: v });
        } catch (er) { err.textContent = Api.message(er); return; }
        $('ovInviteValue').value = ''; UI.toast(T('أُرسلت الدعوة.', 'Invitation sent.'), 'success'); loadSentInvitations();
      });
    }
    if (e.target.id === 'ovSupForm') {
      e.preventDefault();
      const v = $('ovSupEmail').value.trim(); if (!v) return;
      UI.busy(e.target.querySelector('button'), async () => {
        await Api.post(`/projects/${w.id}/supervision-requests`, { supervisorEmail: v });
        UI.toast(T('أُرسل طلب الإشراف.', 'Supervision request sent.'), 'success'); await reload();
      });
    }
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.teamTool) { toggleTool(d.teamTool); return; }
    if (t.classList.contains('team-icon-btn')) { t.classList.add('is-done'); setTimeout(() => t.classList.remove('is-done'), 1500); }
    if (d.copy) { navigator.clipboard?.writeText(d.copy).then(() => UI.toast(T('نُسخ الرابط.', 'Link copied.'), 'success'), () => UI.toast(d.copy)); }
    if ('regenerate' in d) UI.busy(t, async () => { await Api.post(`/teams/${w.team.id}/invitation/regenerate`, {}); loadInvitationCode(); });
    if (d.cancelInvite) UI.busy(t, async () => { await Api.post(`/team-invitations/${d.cancelInvite}/cancel`, {}); loadSentInvitations(); });
    if (d.remove && confirmAction(T('إزالة هذا العضو من الفريق؟', 'Remove this member from the team?'))) UI.busy(t, async () => { await Api.del(`/teams/${w.team.id}/members/${d.remove}`); await reload(); });
    if (d.makeLeader && confirmAction(T('نقل قيادة الفريق إلى هذا العضو؟ ستصبح عضوًا في الفريق.', 'Hand the team leadership to this member? You become a member.'))) UI.busy(t, async () => { await Api.patch(`/teams/${w.team.id}/leader`, { userId: d.makeLeader }); S.invalidateProjects(); await reload(); });
    if (d.editPanel) editPanel(d.editPanel, t);
    if (d.panelCancel) render();
    if (d.panelSave) savePanel(d.panelSave, t);
    if ('leave' in d) confirmLeave();
    if ('deleteProject' in d) confirmDeleteProject();
    if (d.cancelRequest) UI.busy(t, async () => { await Api.post(`/supervision-requests/${d.cancelRequest}/cancel`, {}); await reload(); });
    if ('completeSetup' in d) UI.busy(t, async () => { await Api.post(`/projects/${w.id}/setup/complete`, {}); UI.toast(T('اكتمل إعداد المشروع.', 'Project setup completed.'), 'success'); await reload(); });
  });
  // a native confirm keeps the page simple and works in both languages
  function confirmAction(text) { return window.confirm(text); }

  // ----- edit the project idea / objectives in place -----
  function editPanel(kind, btn) {
    const panel = btn.closest('.overview-panel'); btn.hidden = true;
    panel.querySelector('.ov-empty')?.remove(); const pen = panel.querySelector('.overview-edit'); if (pen) pen.hidden = true;
    const p = w.project;
    if (kind === 'details') {
      const D = window.TammhaDomain || {};
      const opts = (map, cur) => `<option value="">${esc(T('اختر', 'Choose'))}</option>` + Object.entries(map || {}).map(([k, l]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(T(l[0], l[1]))}</option>`).join('');
      $('ovDetails').hidden = true; panel.querySelector('.overview-editor')?.remove();
      panel.insertAdjacentHTML('beforeend', `<div class="overview-editor ov-details-editor">
        <label><span>${esc(T('تصنيف المشروع', 'Project category'))}</span><select id="ovEdit_category">${opts(D.PROJECT_CATEGORIES, p.category)}</select></label>
        <label><span>${esc(T('نوع المشروع', 'Project type'))}</span><select id="ovEdit_origin">${opts(D.PROJECT_ORIGINS, p.origin)}</select></label>
        <div class="overview-editor__actions"><button class="app-btn app-btn--primary" type="button" data-panel-save="details">${esc(T('حفظ', 'Save'))}</button><button class="app-btn" type="button" data-panel-cancel="1">${esc(T('إلغاء', 'Cancel'))}</button></div></div>`);
      $('ovEdit_category').focus();
      return;
    }
    const value = kind === 'idea' ? (p.overview || p.description || '') : (p.objectives || []).filter(Boolean).join('\n');
    const target = kind === 'idea' ? $('ovOverview') : $('ovGoals');
    target.hidden = true;
    panel.querySelector('.overview-editor')?.remove();
    panel.insertAdjacentHTML('beforeend', `<div class="overview-editor">
      <textarea id="ovEdit_${kind}" rows="${kind === 'idea' ? 4 : 5}" maxlength="${kind === 'idea' ? 5000 : 3100}" placeholder="${esc(kind === 'idea' ? T('اكتب فكرة المشروع', 'Write the project idea') : T('هدف واحد في كل سطر', 'One objective per line'))}">${esc(value)}</textarea>
      ${kind === 'goals' ? `<small class="app-muted">${esc(T('اكتب كل هدف في سطر مستقل (حتى 10 أهداف).', 'Write each objective on its own line (up to 10).'))}</small>` : ''}
      <div class="overview-editor__actions"><button class="app-btn app-btn--primary" type="button" data-panel-save="${kind}">${esc(T('حفظ', 'Save'))}</button><button class="app-btn" type="button" data-panel-cancel="1">${esc(T('إلغاء', 'Cancel'))}</button></div></div>`);
    const ta = panel.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function savePanel(kind, btn) {
    let body;
    if (kind === 'details') {
      const category = $('ovEdit_category').value; const origin = $('ovEdit_origin').value;
      if (!category || !origin) { UI.toast(T('اختر تصنيف المشروع ونوعه.', 'Choose the project category and type.'), 'error'); return; }
      body = { category, origin };
    }
    const text = kind === 'details' ? '' : $(`ovEdit_${kind}`).value.trim();
    if (kind === 'details') { /* body is ready */ }
    else if (kind === 'idea') {
      if (!text) { UI.toast(T('اكتب فكرة المشروع.', 'Write the project idea.'), 'error'); return; }
      body = { overview: text };
    } else {
      const list = text.split(/\n+/).map((x) => x.replace(/^[\s\-•*\d.)]+/, '').trim()).filter(Boolean);
      if (!list.length) { UI.toast(T('اكتب هدفًا واحدًا على الأقل.', 'Write at least one objective.'), 'error'); return; }
      if (list.length > 10) { UI.toast(T('الحد الأقصى 10 أهداف.', 'Up to 10 objectives.'), 'error'); return; }
      if (list.some((x) => x.length > 300)) { UI.toast(T('كل هدف 300 حرف بحد أقصى.', 'Each objective is up to 300 characters.'), 'error'); return; }
      body = { objectives: list };
    }
    UI.busy(btn, async () => {
      try { await Api.patch(`/projects/${w.id}`, body); }
      catch (err) { UI.toast(Api.message(err), 'error'); return; }
      UI.toast(T('تم الحفظ.', 'Saved.'), 'success');
      S.invalidateProjects(); await reload();
    });
  }

  // ----- leave the project: a warning, then the student leaves -----
  const Dlg = () => window.TammhaDialog;
  const btnRow = (cancel, okId, okLabel) => `<button class="tm-dialog__btn" type="button" data-close>${esc(cancel)}</button><button class="tm-dialog__btn tm-dialog__btn--danger" type="button" id="${okId}">${esc(okLabel)}</button>`;
  function confirmLeave() {
    const owner = !!w.viewer?.isLeader;
    const d = Dlg().open({
      image: 'assets/account-warning.png', tone: 'danger',
      title: T('مغادرة المشروع؟', 'Leave the project?'),
      body: `<p>${esc(T(`ستغادر مشروع "${w.project.name}" ولن تتمكن من الوصول إليه بعد ذلك. تُلغى إسنادات مهامك غير المكتملة، وتبقى مساهماتك السابقة في المشروع.`, `You will leave the project "${w.project.name}" and will no longer have access to it. Your unfinished tasks are unassigned; your earlier contributions stay in the project.`))}</p>` +
        (owner ? `<p>${esc(T('بما أنك صاحب المشروع، تنتقل ملكيته إلى أقدم عضو في الفريق.', 'As the project owner, the ownership passes to the earliest member of the team.'))}</p>` : '') +
        `<p class="tm-dialog__muted">${esc(T('يمكنك الانضمام مجددًا برمز الدعوة إذا أرسله لك أحد أعضاء الفريق.', 'You can join again with the invitation code from a team member.'))}</p>`,
      actions: btnRow(T('إلغاء', 'Cancel'), 'ovLeaveOk', T('مغادرة المشروع', 'Leave the project')),
    });
    d.querySelector('#ovLeaveOk').addEventListener('click', (ev) => UI.busy(ev.currentTarget, async () => {
      try { await Api.del(`/teams/${w.team.id}/members/${S.user.id}`); }
      catch (err) { Dlg().close(); UI.toast(Api.message(err), 'error'); return; }
      S.invalidateProjects(); location.href = 'projects.html';
    }));
  }

  // ----- delete the project (owner): a warning, a 6-digit code by e-mail, then deleted -----
  function confirmDeleteProject() {
    const d = Dlg().open({
      image: 'assets/project-warning.png', tone: 'danger',
      title: T('حذف المشروع نهائيًا؟', 'Delete the project permanently?'),
      body: `<p>${esc(T(`سيُحذف مشروع "${w.project.name}" نهائيًا مع جميع مراحله ومهامه وملفاته واجتماعاته وملاحظات المشرف عليه، ولا يمكن استرجاعه.`, `The project "${w.project.name}" is deleted permanently with all of its stages, tasks, files, meetings and supervisor feedback, and cannot be restored.`))}</p>` +
        `<p>${esc(T('يخرج جميع أعضاء الفريق من المشروع، وتصلهم رسالة على بريدهم الإلكتروني بحذفه. للتأكيد نرسل رمزًا إلى بريدك الإلكتروني.', 'Every team member leaves the project and receives an email about it. To confirm, we send a code to your email.'))}</p>`,
      actions: btnRow(T('إلغاء', 'Cancel'), 'ovDeleteSend', T('إرسال رمز التأكيد', 'Send confirmation code')),
    });
    d.querySelector('#ovDeleteSend').addEventListener('click', (ev) => UI.busy(ev.currentTarget, async () => {
      try { await Api.post(`/projects/${w.id}/deletion/request`, {}); }
      catch (err) {
        if (err.code !== 'DELETION_CODE_RECENTLY_SENT') { UI.toast(Api.message(err), 'error'); return; }
      }
      askProjectCode();
    }));
  }
  function askProjectCode() {
    const d = Dlg().open({
      image: 'assets/account-code.png', tone: 'danger', title: T('أدخل رمز التأكيد', 'Enter the confirmation code'),
      body: `<p>${esc(T('أرسلنا رمزًا من 6 أرقام إلى بريدك الإلكتروني:', 'We sent a 6-digit code to your email:'))}</p><p class="tm-dialog__email" dir="ltr">${esc((S.user && S.user.email) || '')}</p>
        <label class="tm-dialog__code"><span class="visually-hidden">${esc(T('رمز التأكيد', 'Confirmation code'))}</span><input id="ovDeleteCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" placeholder="••••••"></label>
        <p class="tm-dialog__error" id="ovDeleteError" role="alert"></p><p class="tm-dialog__muted">${esc(T('الرمز صالح لمدة 15 دقيقة.', 'The code is valid for 15 minutes.'))}</p>`,
      actions: btnRow(T('إلغاء', 'Cancel'), 'ovDeleteConfirm', T('حذف المشروع نهائيًا', 'Delete the project permanently')),
    });
    const input = d.querySelector('#ovDeleteCode'); const errEl = d.querySelector('#ovDeleteError');
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); errEl.textContent = ''; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') d.querySelector('#ovDeleteConfirm').click(); });
    d.querySelector('#ovDeleteConfirm').addEventListener('click', (ev) => {
      const code = input.value.trim();
      if (!/^\d{6}$/.test(code)) { errEl.textContent = T('اكتب الرمز المكوّن من 6 أرقام.', 'Type the 6-digit code.'); input.focus(); return; }
      UI.busy(ev.currentTarget, async () => {
        try { await Api.post(`/projects/${w.id}/deletion/confirm`, { code }); }
        catch (err) { errEl.textContent = err.code === 'DELETION_CODE_INVALID' ? T('الرمز غير صحيح أو انتهت صلاحيته.', 'The code is incorrect or has expired.') : Api.message(err); return; }
        S.invalidateProjects();
        Dlg().open({
          locked: true, image: 'assets/account-goodbye.png', title: T('تم حذف المشروع', 'The project has been deleted'),
          body: `<p>${esc(T(`تم حذف مشروع "${w.project.name}" وجميع بياناته نهائيًا، وأُبلغ أعضاء الفريق بذلك عبر البريد الإلكتروني.`, `The project "${w.project.name}" and all of its data have been deleted permanently, and the team members were told by email.`))}</p>`,
          actions: `<a class="tm-dialog__btn tm-dialog__btn--primary" href="projects.html">${esc(T('العودة إلى المشاريع', 'Back to projects'))}</a>`,
        });
      });
    });
  }

  S.ready.then(async () => {
    const main = document.querySelector('.overview-layout');
    try {
      w = await S.currentWorkspace();
      if (!w) { UI.state(main, 'empty', { title: T('لا توجد مشاريع بعد', 'No projects yet'), action: { href: 'projects.html?new=1', label: T('إنشاء مشروع', 'Create a project') } }); return; }
      render();
    } catch (e) { UI.state(main, 'error', { error: e, retry: () => location.reload() }); }
  });
})();
