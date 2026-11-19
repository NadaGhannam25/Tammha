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
    const p = w.project; const isLeader = !!w.viewer?.isLeader;
    $('overviewProjectName').textContent = p.name;
    document.title = p.name;
    S.projectHeroProgress(w); // the completion, once, in the title bar
    $('ovOverview').textContent = p.overview || p.description || T('لم تُكتب نبذة المشروع بعد.', 'No overview yet.');
    const goals = (p.objectives || []).filter(Boolean);
    $('ovGoals').innerHTML = goals.length ? goals.map((g) => `<li>${esc(g)}</li>`).join('') : `<li class="app-muted">${esc(T('لم تُحدد الأهداف بعد.', 'No objectives yet.'))}</li>`;
    const members = w.team?.members || [];
    // team: the Team Leader (who created the project, or received the leadership) first with the
    // badge; under the leader's name the leader sees two small options: add a member, invitation code
    const me = S.user;
    const sorted = [...members].sort((a, b) => (b.teamRole === 'LEADER') - (a.teamRole === 'LEADER'));
    $('ovTeam').innerHTML = sorted.map((m) => {
      const name = UI.personName(m.user); const lead = m.teamRole === 'LEADER';
      const you = m.userId === me.id ? ` <small class="app-muted">(${esc(T('أنت', 'you'))})</small>` : '';
      const tools = isLeader && lead ? `<span class="team-member__tools">
          <button class="team-link" type="button" data-team-tool="ovInviteForm" aria-controls="ovInviteForm" aria-expanded="false">${esc(T('+ إضافة عضو', '+ Add member'))}</button>
          <button class="team-link" type="button" data-team-tool="ovInviteCode" aria-controls="ovInviteCode" aria-expanded="false">${esc(T('رمز الدعوة', 'Invitation code'))}</button></span>` : '';
      const actions = isLeader && !lead ? `<span class="team-member__tools"><button class="team-link" type="button" data-make-leader="${esc(m.userId)}">${esc(T('تعيين قائدًا', 'Make leader'))}</button><button class="team-link team-link--danger" type="button" data-remove="${esc(m.userId)}">${esc(T('إزالة', 'Remove'))}</button></span>` : '';
      return `<div class="team-member${lead ? ' is-leader' : ''}">${UI.avatarHtml(m.user, 'team-member__avatar')}
        <div class="team-member__info"><span class="team-member__line"><span class="team-member__name">${esc(name)}${you}</span>${lead ? `<span class="team-badge">${esc(T('قائد الفريق', 'Team Leader'))}</span>` : ''}</span>${tools}${actions}</div></div>`;
    }).join('');
    $('ovTeamTools').innerHTML = isLeader ? `<form class="team-tool" id="ovInviteForm" hidden novalidate>
          <label class="team-tool__label" for="ovInviteValue">${esc(T('الرقم الجامعي أو البريد الجامعي للزميل', "Classmate's student number or university email"))}</label>
          <div class="team-tool__row"><input id="ovInviteValue" autocomplete="off" placeholder="${esc(T('مثال: 441234567', 'e.g. 441234567'))}"/><button class="app-btn app-btn--primary" type="submit">${esc(T('إرسال دعوة', 'Send invitation'))}</button></div>
          <small class="app-field-error" id="ovInviteError" role="alert"></small>
        </form>
        <div class="team-tool" id="ovInviteCode" hidden aria-live="polite"></div>
        <ul class="team-pending" id="ovSentInvites"></ul>`
      : `<button class="team-link team-link--danger" type="button" data-leave>${esc(T('مغادرة الفريق', 'Leave the team'))}</button>`;
    if (isLeader) loadSentInvitations();
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

  async function renderSetup() {
    const box = $('ovSetup');
    if (w.project.setup?.completed) { box.innerHTML = ''; return; }
    try {
      const st = await Api.get(`/projects/${w.id}/setup`);
      const missing = st.readiness?.missingRequirements || [];
      // the academic supervisor is optional: only real missing items make the setup incomplete
      box.innerHTML = `<div class="app-panel"><h2>${esc(missing.length ? T('إعداد المشروع غير مكتمل', 'Project setup is not complete') : T('الإعداد جاهز للإكمال', 'The setup is ready to complete'))}</h2>
        ${missing.length ? `<p class="app-muted">${esc(T('المتبقي:', 'Still needed:'))}</p><ul class="overview-goals">${missing.map((m) => `<li>${esc(UI.setupRequirement(m))}</li>`).join('')}</ul>` : `<p class="app-muted">${esc(T('اكتملت المتطلبات، ويمكن لقائد الفريق إكمال الإعداد.', 'Every requirement is met; the Team Leader can complete the setup.'))}</p>`}
        ${missing.includes('HANDBOOK_REQUIRED') ? `<a class="app-btn" href="guide.html?project=${encodeURIComponent(w.id)}">${esc(T('اختيار دليل المشروع', 'Choose the project handbook'))}</a>` : ''}
        ${w.viewer?.isLeader ? ` <button class="app-btn app-btn--primary" type="button" data-complete-setup ${missing.length ? 'disabled' : ''}>${esc(T('إكمال الإعداد', 'Complete the setup'))}</button>` : ''}</div>`;
    } catch (e) { UI.state(box, 'error', { error: e }); }
  }

  async function loadSupervision() {
    const body = $('ovSupBody'); const isLeader = !!w.viewer?.isLeader;
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
    if ('leave' in d && confirmAction(T('مغادرة فريق هذا المشروع؟', "Leave this project's team?"))) UI.busy(t, async () => { await Api.del(`/teams/${w.team.id}/members/${S.user.id}`); S.invalidateProjects(); location.href = 'projects.html'; });
    if (d.cancelRequest) UI.busy(t, async () => { await Api.post(`/supervision-requests/${d.cancelRequest}/cancel`, {}); await reload(); });
    if ('completeSetup' in d) UI.busy(t, async () => { await Api.post(`/projects/${w.id}/setup/complete`, {}); UI.toast(T('اكتمل إعداد المشروع.', 'Project setup completed.'), 'success'); await reload(); });
  });
  // a native confirm keeps the page simple and works in both languages
  function confirmAction(text) { return window.confirm(text); }

  S.ready.then(async () => {
    const main = document.querySelector('.overview-layout');
    try {
      w = await S.currentWorkspace();
      if (!w) { UI.state(main, 'empty', { title: T('لا توجد مشاريع بعد', 'No projects yet'), action: { href: 'projects.html?new=1', label: T('إنشاء مشروع', 'Create a project') } }); return; }
      render();
    } catch (e) { UI.state(main, 'error', { error: e, retry: () => location.reload() }); }
  });
})();
