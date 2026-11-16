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

  const statusLabel = (s) => (D && D.PROJECT_STATUSES[s] ? L(D.PROJECT_STATUSES[s].label) : s);
  function render() {
    const p = w.project; const isLeader = !!w.viewer?.isLeader;
    $('overviewProjectName').textContent = p.name;
    document.title = `${T('تممها', 'Tammha')} | ${p.name}`;
    $('ovOverview').textContent = p.overview || p.description || T('لم تُكتب نبذة المشروع بعد.', 'No overview yet.');
    const goals = (p.objectives || []).filter(Boolean);
    $('ovGoals').innerHTML = goals.length ? goals.map((g) => `<li>${esc(g)}</li>`).join('') : `<li class="app-muted">${esc(T('لم تُحدد الأهداف بعد.', 'No objectives yet.'))}</li>`;
    const sup = ((w.supervisors || [])[0] || {}).user || (w.supervisors || [])[0]; // { userId, user } from the API
    const members = w.team?.members || [];
    $('ovStats').innerHTML = [
      [T('تاريخ بدء المشروع', 'Start date'), UI.fmtDate(p.startDate)],
      [T('الإنجاز المتوقع', 'Expected completion'), UI.fmtDate(p.expectedCompletionDate || p.endDate)],
      [T('عدد أعضاء الفريق', 'Team members'), String(members.length)],
      [T('المشرف الأكاديمي', 'Academic supervisor'), sup ? UI.personName(sup) : T('لم يُحدد بعد', 'Not assigned yet')],
      [T('نسبة الإنجاز', 'Completion'), `${Math.round(w.progress?.percent ?? 0)}%`]
    ].map(([k, v]) => `<div class="overview-stat"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
    // team
    const me = S.user;
    $('ovTeam').innerHTML = members.map((m) => {
      const name = UI.personName(m.user); const lead = m.teamRole === 'LEADER';
      const actions = isLeader && !lead ? `<span class="app-inline-form"><button class="app-btn app-btn--ghost" type="button" data-make-leader="${esc(m.userId)}">${esc(T('تعيين قائدًا', 'Make leader'))}</button><button class="app-btn app-btn--ghost" type="button" data-remove="${esc(m.userId)}">${esc(T('إزالة', 'Remove'))}</button></span>` : '';
      return `<div class="team-member"><span class="team-member__avatar">${esc(UI.initial(name))}</span><span class="team-member__name">${esc(name)}${m.userId === me.id ? ` <small class="app-muted">(${esc(T('أنت', 'you'))})</small>` : ''}</span><span class="team-member__role">${esc(lead ? T('قائد الفريق', 'Team Leader') : T('عضو', 'Member'))}</span>${actions}</div>`;
    }).join('');
    $('ovTeamTools').innerHTML = isLeader ? `<div class="app-panel invite-panel"><details class="invite-panel__add"><summary>${esc(T('+ إضافة عضو', '+ Add member'))}</summary>
        <form class="invite-panel__group" id="ovInviteForm" novalidate>
          <label class="invite-panel__label" for="ovInviteValue">${esc(T('دعوة بالرقم الجامعي أو البريد الجامعي', 'Invite by student number or university email'))}</label>
          <div class="invite-panel__row"><input id="ovInviteValue" autocomplete="off" placeholder="${esc(T('مثال: 441234567', 'e.g. 441234567'))}"/><button class="app-btn app-btn--primary" type="submit">${esc(T('إرسال دعوة', 'Send invitation'))}</button></div>
          <small class="app-field-error" id="ovInviteError" role="alert"></small>
        </form></details>
        <div class="invite-panel__group" id="ovInviteCode" aria-live="polite"></div>
        <ul class="app-list invite-panel__sent" id="ovSentInvites"></ul></div>`
      : `<button class="app-btn app-btn--ghost" type="button" data-leave>${esc(T('مغادرة الفريق', 'Leave the team'))}</button>`;
    if (isLeader) { loadInvitationCode(); loadSentInvitations(); }
    renderSetup(); loadSupervision();
  }

  async function loadInvitationCode() {
    try {
      const inv = await Api.get(`/teams/${w.team.id}/invitation`);
      $('ovInviteCode').innerHTML = `<span class="invite-panel__label">${esc(T('رمز الدعوة', 'Invitation code'))}</span>
        <div class="invite-code"><code class="invite-code__value" dir="ltr">${esc(inv.code)}</code>
          <div class="invite-code__actions"><button class="app-btn" type="button" data-copy="${esc(inv.link)}">${esc(T('نسخ رابط الدعوة', 'Copy invitation link'))}</button><button class="app-btn app-btn--ghost" type="button" data-regenerate>${esc(T('إنشاء رمز جديد', 'Generate new code'))}</button></div></div>
        <small class="app-muted">${esc(T('الرمز الجديد يُبطل الرمز والرابط السابقين.', 'A new code makes the previous code and link stop working.'))}</small>`;
    } catch (e) { $('ovInviteCode').textContent = Api.message(e); }
  }
  async function loadSentInvitations() {
    try {
      const items = await Api.get(`/teams/${w.team.id}/student-invitations`);
      const pending = (items || []).filter((i) => i.status === 'PENDING');
      $('ovSentInvites').innerHTML = (pending.length ? `<li class="invite-panel__sent-head">${esc(T('دعوات بانتظار الرد', 'Pending invitations'))}</li>` : '') + pending.map((i) => `<li><span>${esc(i.invitee?.displayName || '')} <span class="app-chip app-chip--muted">${esc(T('بانتظار الرد', 'Pending'))}</span></span><button class="app-btn app-btn--ghost" type="button" data-cancel-invite="${esc(i.id)}">${esc(T('سحب الدعوة', 'Withdraw'))}</button></li>`).join('');
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
    if (sup) { body.innerHTML = `<p>${esc(UI.personName(sup))} · <span dir="ltr">${esc(sup.email || '')}</span></p>`; return; }
    try {
      const reqs = await Api.get(`/projects/${w.id}/supervision-requests`);
      const pending = (reqs || []).find((r) => r.status === 'PENDING');
      const rejected = (reqs || []).filter((r) => r.status === 'REJECTED');
      let html = pending ? `<p>${esc(T('طلب إشراف بانتظار الرد من', 'Supervision request waiting for'))} <strong>${esc(UI.personName(pending.supervisor))}</strong> ${isLeader ? `<button class="app-btn app-btn--ghost" type="button" data-cancel-request="${esc(pending.id)}">${esc(T('إلغاء الطلب', 'Cancel the request'))}</button>` : ''}</p>` : `<p class="app-muted">${esc(T('لا يوجد مشرف للمشروع بعد.', 'The project has no supervisor yet.'))}</p>`;
      if (rejected.length) html += `<p class="app-muted">${esc(T('اعتذر عن الإشراف:', 'Declined:'))} ${rejected.map((r) => esc(UI.personName(r.supervisor))).join('، ')}</p>`;
      if (isLeader && !pending) html += `<form class="app-inline-form" id="ovSupForm"><input id="ovSupEmail" list="ovSupList" type="email" placeholder="${esc(T('البريد الجامعي للمشرف', "Supervisor's university email"))}" aria-label="${esc(T('البريد الجامعي للمشرف', "Supervisor's university email"))}"/><datalist id="ovSupList"></datalist><button class="app-btn app-btn--primary" type="submit">${esc(T('إرسال طلب إشراف', 'Send supervision request'))}</button></form>`;
      body.innerHTML = html;
      if (isLeader && !pending) Api.get('/supervision-requests/supervisors').then((s) => { $('ovSupList').innerHTML = (s || []).map((x) => `<option value="${esc(x.email)}">${esc(UI.personName(x))}</option>`).join(''); }).catch(() => {});
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
      const list = await S.projects();
      S.projectSwitcher(document.querySelector('.project-detail-hero__content'), list, w.id, (id) => { location.href = `project-overview.html?project=${encodeURIComponent(id)}`; });
      render();
    } catch (e) { UI.state(main, 'error', { error: e, retry: () => location.reload() }); }
  });
})();
