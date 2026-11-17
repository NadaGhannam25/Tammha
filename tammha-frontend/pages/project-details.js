// ===== Project stages (project-details.html) — connected to the API =====
// Stages are the backend milestones: GET /milestones?projectId=… (with task progress),
// POST /milestones (Team Leader: title, description, due date, status), PATCH /milestones/:id
// (status), DELETE /milestones/:id. The "المهام" link opens the project's tasks.
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession; const D = window.TammhaDomain;
  const { T, L, esc } = UI;
  const $ = (id) => document.getElementById(id);
  const body = $('stagesBody');
  let w = null; let stages = [];
  const CLS = { COMPLETED: 'completed', IN_PROGRESS: 'progress', PENDING: 'pending', OVERDUE: 'pending', CANCELLED: 'pending' };
  const stateLabel = (s) => L((D.STAGE_STATUSES && D.STAGE_STATUSES[s] && D.STAGE_STATUSES[s].label) || [s, s]);

  function summary() {
    const p = w.project; const sup = ((w.supervisors || [])[0] || {}).user || (w.supervisors || [])[0]; /* { userId, user } from the API */
    $('projectName').textContent = p.name;
    document.querySelector('.project-summary').innerHTML = `<div class="summary-item"><span>${esc(T('تاريخ البدء', 'Start date'))}</span><strong>${esc(UI.fmtDate(p.startDate))}</strong></div>
      <div class="summary-item"><span>${esc(T('أعضاء الفريق', 'Team members'))}</span><strong>${esc(String((w.team?.members || []).length))}</strong></div>
      <div class="summary-item"><span>${esc(T('المشرف الأكاديمي', 'Academic supervisor'))}</span><strong>${esc(sup ? UI.personName(sup) : T('لم يُحدد بعد', 'Not assigned yet'))}</strong></div>`;
    // the completion is shown once, in the title bar
    S.projectHeroProgress(w);
  }
  function render() {
    const isLeader = !!w.viewer?.isLeader;
    if (!stages.length) { UI.state(body, 'empty', { title: T('لا توجد مراحل بعد', 'No stages yet'), text: isLeader ? T('أضف مراحل المشروع من زر «إضافة مرحلة».', 'Add the project stages with “Add stage”.') : T('يضيف قائد الفريق مراحل المشروع.', 'The Team Leader adds the project stages.') }); return; }
    // the current stage = the first one in order that is in progress (the backend starts the
    // first stage automatically when the stages are created)
    const current = stages.find((s) => s.status === 'IN_PROGRESS');
    const head = current
      ? `<p class="stages-current" role="status">${esc(T('المرحلة الحالية:', 'Current stage:'))} <strong>${esc(current.title)}</strong></p>`
      : stages.some((s) => s.status !== 'COMPLETED' && s.status !== 'CANCELLED')
        ? `<p class="stages-current" role="status">${esc(isLeader ? T('لم تبدأ أي مرحلة بعد؛ اختر «قيد التنفيذ» للمرحلة التي بدأ الفريق العمل عليها.', 'No stage has started yet; set the stage the team is working on to “In progress”.') : T('لم تبدأ أي مرحلة بعد.', 'No stage has started yet.'))}</p>` : '';
    body.innerHTML = head + stages.map((s, i) => {
      const status = s.isOverdue && s.status !== 'COMPLETED' ? 'OVERDUE' : s.status;
      const pr = s.progress || {};
      const tools = isLeader ? `<select class="stages-row__status" data-stage-status="${esc(s.id)}" aria-label="${esc(T('حالة المرحلة', 'Stage status'))}">${['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].map((c) => `<option value="${c}"${c === s.status ? ' selected' : ''}>${esc(stateLabel(c))}</option>`).join('')}</select><button class="app-btn app-btn--ghost" type="button" data-stage-delete="${esc(s.id)}">${esc(T('حذف', 'Delete'))}</button>` : '';
      return `<div class="stages-row stages-row--${CLS[status] || 'pending'}" role="row"${s.status === 'IN_PROGRESS' ? ' aria-current="step"' : ''}>
        <div class="stages-row__stage" role="cell"><span class="stages-row__step">${s.status === 'COMPLETED' ? '' : i + 1}</span><div><strong>${esc(s.title)}${current && s.id === current.id ? ` <span class="stage-current-tag">${esc(T('الحالية', 'Current'))}</span>` : ''}</strong><small>${esc(s.description || '')}</small></div></div>
        <span role="cell"><span class="stage-state stage-state--${CLS[status] || 'pending'}">${esc(stateLabel(status))}</span>${pr.totalTasks ? `<small>${esc(String(pr.percent ?? 0))}%</small>` : ''}</span>
        <span role="cell">${esc(T('حتى', 'Due'))} ${esc(UI.fmtDate(s.dueDate))}</span>
        <span role="cell">${esc(T(`${pr.completedTasks || 0} من ${pr.totalTasks || 0}`, `${pr.completedTasks || 0} of ${pr.totalTasks || 0}`))}</span>
        <span role="cell"><a class="stages-row__link" href="tasks.html?project=${encodeURIComponent(w.id)}">${esc(T('المهام', 'Tasks'))}</a>${tools}</span></div>`;
    }).join('');
  }
  async function load() {
    UI.state(body, 'loading');
    try {
      const r = await Api.get('/milestones', { query: { projectId: w.id, limit: 100 } });
      stages = (r.items || r || []).sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.dueDate).localeCompare(String(b.dueDate)));
      render();
    } catch (e) { UI.state(body, 'error', { error: e, retry: load }); }
  }
  body.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-stage-status]'); if (!sel) return;
    UI.busy(sel, async () => { await Api.patch(`/milestones/${sel.dataset.stageStatus}`, { status: sel.value }); await load(); });
  });
  body.addEventListener('click', (e) => {
    const del = e.target.closest('[data-stage-delete]'); if (!del) return;
    if (!window.confirm(T('حذف هذه المرحلة؟ تبقى مهامها في المشروع دون مرحلة.', 'Delete this stage? Its tasks stay in the project without a stage.'))) return;
    UI.busy(del, async () => { await Api.del(`/milestones/${del.dataset.stageDelete}`); await load(); });
  });

  // ----- add stage (Team Leader) -----
  const modal = $('stageModal'); const form = $('stageForm'); const name = $('stageName'); const err = $('stageNameError');
  const setErr = (on) => { name.classList.toggle('is-invalid', on); name.setAttribute('aria-invalid', String(on)); err.hidden = !on; };
  const open = () => { modal.hidden = false; $('stageFormError').textContent = ''; name.focus(); };
  const close = () => { modal.hidden = true; form.reset(); setErr(false); $('stageDueError').hidden = true; };
  $('openStageModal').addEventListener('click', open);
  $('closeStageModal').addEventListener('click', close); $('cancelStageModal').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
  name.addEventListener('input', () => { if (name.value.trim()) setErr(false); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = name.value.trim(); const due = $('stageDue').dataset.iso || $('stageDue').value;
    if (!title) { setErr(true); name.focus(); return; }
    if (!due) { $('stageDueError').hidden = false; return; }
    UI.busy(form.querySelector('[type="submit"]'), async () => {
      try {
        await Api.post('/milestones', { projectId: w.id, title, description: $('stageDescription').value.trim() || undefined, dueDate: due, status: $('stageStatus').value, order: stages.length + 1 });
        close(); UI.toast(T('أُضيفت المرحلة.', 'Stage added.'), 'success'); load();
      } catch (er) { $('stageFormError').textContent = Api.message(er); }
    });
  });

  S.ready.then(async () => {
    try {
      w = await S.currentWorkspace();
      if (!w) { UI.state(body, 'empty', { title: T('لا توجد مشاريع بعد', 'No projects yet'), action: { href: 'projects.html?new=1', label: T('إنشاء مشروع', 'Create a project') } }); $('openStageModal').hidden = true; return; }
      $('openStageModal').hidden = !w.viewer?.isLeader;
      summary(); load();
    } catch (e) { UI.state(body, 'error', { error: e, retry: () => location.reload() }); }
  });
})();
