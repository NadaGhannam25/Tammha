// ===== Join a team (join.html) =====
// join.html?code=K7QXM2PA is the invitation link (backend INVITATION_LINK_BASE_URL ends with "?code=").
// GET /teams/invitations/:code → preview (project, team, leader); POST /teams/join { code } → member.
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession;
  const { T, esc } = UI;
  const form = document.getElementById('joinForm'); const input = document.getElementById('joinCode');
  const err = document.getElementById('joinError'); const preview = document.getElementById('joinPreview'); const btn = document.getElementById('joinButton');
  let previewed = null;
  const code = () => input.value.replace(/[\s-]/g, '').toUpperCase();
  // a wrong, used-up or expired code gets one clear sentence
  const BAD_CODE = /^INVITATION_|^TEAM_INVITATION|NOT_FOUND|EXPIRED|INVALID|MALFORMED|VALIDATION_ERROR/;
  const codeMessage = (e) => (e && (BAD_CODE.test(e.code || '') || [400, 404, 410].includes(e.status))
    ? T('رمز الدعوة غير صحيح أو منتهي الصلاحية.', 'The invitation code is invalid or has expired.')
    : Api.message(e));
  async function show() {
    err.textContent = ''; preview.innerHTML = ''; previewed = null; btn.textContent = T('الانضمام إلى المشروع', 'Join the project');
    if (!code()) { err.textContent = T('أدخل رمز الدعوة.', 'Enter the invitation code.'); return; }
    try {
      const p = await Api.get(`/teams/invitations/${encodeURIComponent(code())}`, { loader: { label: T('جارٍ التحقق من الدعوة…', 'Checking the invitation…') } });
      previewed = code();
      const team = p.team || p; const project = p.project || {};
      const leader = p.leader ? UI.personName(p.leader) : '';
      preview.innerHTML = `<strong>${esc(project.name || team.projectName || '')}</strong><br>${esc(T('الفريق', 'Team'))}: ${esc(team.name || '')}${leader ? `<br>${esc(T('قائد الفريق', 'Team Leader'))}: ${esc(leader)}` : ''}`;
      btn.textContent = T('الانضمام إلى الفريق', 'Join the team');
    } catch (e) { err.textContent = codeMessage(e); }
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!previewed || previewed !== code()) { await show(); return; }
    btn.disabled = true;
    try {
      const r = await Api.post('/teams/join', { code: previewed }, { loader: { label: T('جارٍ الانضمام…', 'Joining…') } });
      S.invalidateProjects();
      const pid = r?.project?.id || r?.projectId || r?.team?.projectId;
      location.href = pid ? `project-overview.html?project=${encodeURIComponent(pid)}` : 'projects.html';
    } catch (e2) { err.textContent = codeMessage(e2); } finally { btn.disabled = false; }
  });
  input.addEventListener('input', () => { if (previewed && previewed !== code()) { previewed = null; preview.innerHTML = ''; btn.textContent = T('الانضمام إلى المشروع', 'Join the project'); } });
  S.ready.then(() => {
    const c = new URLSearchParams(location.search).get('code');
    if (c) { input.value = c; show(); }
  });
})();
