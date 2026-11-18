// ===== Tasks page (tasks.html) — connected to the API =====
// Compact task rows; "عرض" opens a details panel. Everything comes from the backend:
//   GET    /tasks?projectId=…            tasks of the selected project (all pages)
//   PATCH  /tasks/:id                    status (assignee or Team Leader); the leader also edits owner / date / stage
//   POST   /tasks                        new task (Team Leader)          DELETE /tasks/:id (Team Leader)
//   GET/POST /tasks/:id/comments, PATCH/DELETE /tasks/:id/comments/:commentId
//   GET    /tasks/:id/feedback           written supervisor feedback (read-only here)
//   GET/POST /tasks/:id/attachments, DELETE /tasks/:id/attachments/:id  project files linked to the task
//          (Team Leader or the task's owner link them; everyone in the project opens them)
// The rules shown here (allowed status changes, who may change what) mirror the backend, which
// checks them again: an error from the server is shown and nothing is changed locally.
(function () {
  'use strict';
  const body = document.getElementById('tasksBody');
  if (!body) return;
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession; const D = window.TammhaDomain;
  const { T, L, esc } = UI;
  const $ = (id) => document.getElementById(id);

  let w = null; let isLeader = false; let me = null; let members = []; let stages = [];
  let tasks = [];
  const todayIso = UI.isoDay(new Date());
  const label = (code) => L((D.TASK_STATUSES[code] || D.TASK_STATUSES.TODO).label);
  const isOverdue = (t) => D.isOverdue(t.status, t.due, todayIso);
  const pill = (code) => `<span class="task-status task-status--${(D.TASK_STATUSES[code] || D.TASK_STATUSES.TODO).cls}">${esc(label(code))}</span>`;
  const late = `<span class="task-status task-status--overdue">${esc(T('متأخرة', 'Overdue'))}</span>`;
  const pillFor = (t) => (isOverdue(t) ? late : pill(t.status));
  const drawerPill = (t) => `${pill(t.status)}${isOverdue(t) ? ` ${late}` : ''}`;
  const FILTERS = {
    all: () => true,
    open: (t) => D.isOpenTask(t.status) && t.status !== 'IN_REVIEW',
    IN_REVIEW: (t) => t.status === 'IN_REVIEW',
    COMPLETED: (t) => t.status === 'COMPLETED',
    overdue: isOverdue
  };
  const toView = (t) => ({
    id: t.id, name: t.title, description: t.description || '', status: t.status, priority: t.priority,
    due: t.dueDate ? UI.isoDay(t.dueDate) : '', assigneeId: t.assignedStudentId || null,
    assignee: t.assignedStudent ? UI.personName(t.assignedStudent) : T('لم يُحدَّد', 'Not assigned'),
    stageId: t.milestone?.id || null, stage: t.milestone?.title || '', source: t.source
  });

  let filter = 'all';
  let query = '';
  function render() {
    const visible = tasks.filter((task) => (FILTERS[filter] || FILTERS.all)(task) && (!query || `${task.name} ${task.description} ${task.assignee}`.toLowerCase().includes(query)));
    body.innerHTML = visible.map((task) => `
      <div class="tasks-row" role="row">
        <div class="tasks-row__main" role="cell"><strong>${esc(task.name)}</strong><small>${esc(task.description)}</small></div>
        <span role="cell">${esc(task.assignee)}</span>
        <span role="cell">${pillFor(task)}</span>
        <span class="${isOverdue(task) ? 'tasks-row__due--late' : ''}" role="cell">${esc(task.due ? UI.fmtDate(task.due) : '—')}</span>
        <span role="cell"><button class="tasks-row__open" data-task-open="${esc(task.id)}" type="button">${esc(T('عرض', 'View'))}<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"></path></svg></button></span>
      </div>`).join('');
    body.closest('.tasks-table')?.classList.toggle('is-empty', visible.length === 0);
    $('tasksEmpty').hidden = visible.length !== 0;
    $('tasksEmpty').textContent = tasks.length ? T('لا توجد مهام في هذا القسم.', 'No tasks in this section.') : T('لا توجد مهام لهذا المشروع بعد.', 'This project has no tasks yet.');
    document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = tasks.filter(FILTERS[el.dataset.count] || FILTERS.all).length; });
  }

  async function loadTasks() {
    UI.state(body, 'loading');
    $('tasksEmpty').hidden = true;
    try {
      const all = []; let page = 1; let pages = 1;
      do {
        const r = await Api.get('/tasks', { query: { projectId: w.id, limit: 100, page, sortBy: 'dueDate', sortOrder: 'asc' } });
        all.push(...(r.items || [])); pages = r.meta?.totalPages || 1; page += 1;
      } while (page <= pages && page < 20);
      tasks = all.map(toView);
      render();
    } catch (e) { UI.state(body, 'error', { error: e, retry: loadTasks }); }
  }

  document.querySelectorAll('[data-task-filter]').forEach((button) => button.addEventListener('click', () => {
    filter = button.dataset.taskFilter;
    document.querySelectorAll('[data-task-filter]').forEach((b) => { const active = b === button; b.classList.toggle('is-active', active); b.setAttribute('aria-selected', String(active)); });
    render();
  }));
  $('tasksSearch')?.addEventListener('input', (event) => { query = event.target.value.trim().toLowerCase(); render(); });

  // ----- Details panel -----
  const drawer = $('taskDrawer'); const statusForm = $('taskStatusForm'); const statusSelect = $('taskStatusSelect'); const statusHint = $('taskStatusHint');
  const commentForm = $('taskCommentForm'); const commentText = $('taskCommentText'); const commentError = $('taskCommentError');
  let current = null; let comments = []; let editing = null;

  function renderStatus(task) {
    $('taskDrawerStatus').innerHTML = drawerPill(task);
    const canChange = task.assigneeId === me.id || isLeader;
    const options = canChange ? D.nextTaskStatuses(task.status, isLeader) : [];
    // one clear action to finish the task, next to the full status list
    $('taskComplete').hidden = !options.includes('COMPLETED');
    statusForm.hidden = options.length === 0;
    statusSelect.innerHTML = `<option disabled selected value="">${esc(T('اختر الحالة الجديدة', 'Choose the new status'))}</option>` + options.map((code) => `<option value="${code}">${esc(label(code))}</option>`).join('');
    statusHint.textContent = !canChange ? T(`يغيّر الحالة المسؤول عن المهمة (${task.assignee}) أو قائد الفريق.`, `The task owner (${task.assignee}) or the Team Leader changes the status.`)
      : options.length === 0 ? T('لا توجد حالة يمكن الانتقال إليها.', 'There is no status to move to.')
      : !isLeader && (D.TASK_TRANSITIONS[task.status] || []).some((c) => D.LEADER_ONLY_TASK_STATUSES.includes(c)) ? T('إلغاء المهمة لقائد الفريق فقط.', 'Only the Team Leader can cancel a task.') : '';
    statusHint.hidden = !statusHint.textContent;
  }
  function renderLeaderTools(task) {
    const box = $('taskLeaderTools');
    if (!isLeader) { box.hidden = true; return; }
    box.hidden = false;
    $('taskEditAssignee').innerHTML = `<option value="">${esc(T('غير مُسنَدة', 'Unassigned'))}</option>` + members.map((m) => `<option value="${esc(m.userId)}"${m.userId === task.assigneeId ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
    $('taskEditStage').innerHTML = `<option value="">${esc(T('بدون مرحلة', 'No stage'))}</option>` + stages.map((s) => `<option value="${esc(s.id)}"${s.id === task.stageId ? ' selected' : ''}>${esc(s.title)}</option>`).join('');
    $('taskEditDue').value = task.due || '';
  }
  async function renderFeedback(task) {
    const list = $('taskFeedbackList');
    list.innerHTML = `<li class="task-drawer__none">${esc(T('جارٍ التحميل…', 'Loading…'))}</li>`;
    try {
      const r = await Api.get(`/tasks/${task.id}/feedback`);
      const items = r.items || r || [];
      list.innerHTML = items.length ? items.map((f) => `<li><div class="task-comment__meta"><b>${esc(UI.personName(f.givenBy || f.author || f.supervisor))}</b><time>${esc(UI.fmtDateTime(f.createdAt))}</time></div><p>${esc(f.comment || f.content || '')}</p></li>`).join('')
        : `<li class="task-drawer__none">${esc(T('لم يكتب المشرف ملاحظات على هذه المهمة.', 'The supervisor has not written feedback on this task.'))}</li>`;
    } catch (e) { list.innerHTML = `<li class="task-drawer__none">${esc(Api.message(e))}</li>`; }
  }
  function renderComments() {
    $('taskCommentCount').textContent = comments.length ? `(${comments.length})` : '';
    $('taskDrawerComments').innerHTML = comments.length ? comments.map((c) => {
      const mine = c.isMine; const canDelete = mine || isLeader;
      if (editing === c.id) {
        return `<li class="task-comment is-editing"><form data-edit-form="${esc(c.id)}"><label class="visually-hidden" for="editComment">${esc(T('تعديل التعليق', 'Edit the comment'))}</label><textarea id="editComment" maxlength="2000" rows="2">${esc(c.content)}</textarea><div class="task-comment__actions"><button data-save-edit type="submit">${esc(T('حفظ', 'Save'))}</button><button data-cancel-edit type="button">${esc(T('إلغاء', 'Cancel'))}</button></div></form></li>`;
      }
      return `<li class="task-comment"><div class="task-comment__meta"><b>${esc(UI.personName(c.author))}</b><time>${esc(UI.fmtDateTime(c.createdAt))}</time>${c.edited ? `<em>(${esc(T('معدَّل', 'edited'))})</em>` : ''}</div><p>${esc(c.content)}</p>${mine || canDelete ? `<div class="task-comment__actions">${mine ? `<button data-edit-comment="${esc(c.id)}" type="button">${esc(T('تعديل', 'Edit'))}</button>` : ''}${canDelete ? `<button class="is-danger" data-delete-comment="${esc(c.id)}" type="button">${esc(T('حذف', 'Delete'))}</button>` : ''}</div>` : ''}</li>`;
    }).join('') : `<li class="task-drawer__none">${esc(T('لا توجد تعليقات.', 'No comments.'))}</li>`;
    const ta = $('editComment'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  async function loadComments(task) {
    $('taskDrawerComments').innerHTML = `<li class="task-drawer__none">${esc(T('جارٍ التحميل…', 'Loading…'))}</li>`;
    try { const r = await Api.get(`/tasks/${task.id}/comments`, { query: { limit: 100 } }); comments = r.items || r || []; renderComments(); }
    catch (e) { $('taskDrawerComments').innerHTML = `<li class="task-drawer__none">${esc(Api.message(e))}</li>`; }
  }
  // ----- attachments: files of the project linked to the task -----
  const canEditTask = (task) => isLeader || task.assigneeId === me.id;
  let projectDocs = null;
  async function renderAttachments(task) {
    const list = $('taskDrawerFiles'); const form = $('taskAttachForm'); const hint = $('taskAttachHint');
    list.innerHTML = `<li class="task-drawer__none">${esc(T('جارٍ التحميل…', 'Loading…'))}</li>`;
    form.hidden = true; hint.hidden = true;
    let items = [];
    try { items = await Api.get(`/tasks/${encodeURIComponent(task.id)}/attachments`); }
    catch (e) { if (current === task) list.innerHTML = `<li class="task-drawer__none">${esc(Api.message(e))}</li>`; return; }
    if (current !== task) return;
    const edit = canEditTask(task);
    list.innerHTML = items.length ? items.map((a) => `<li class="task-file"><img alt="" src="assets/${/\.pdf$/i.test(a.fileName) ? 'file-pdf' : 'file-txt'}.png"/><span class="task-file__name"><strong dir="auto">${esc(a.title)}</strong><small dir="auto">${esc(a.fileName)} · ${esc(UI.fmtSize(a.fileSize))}</small></span>
        <button class="team-link" type="button" data-open-doc="${esc(a.documentId)}">${esc(T('فتح', 'Open'))}</button>${edit ? `<button class="team-link team-link--danger" type="button" data-detach="${esc(a.id)}">${esc(T('إزالة', 'Remove'))}</button>` : ''}</li>`).join('')
      : `<li class="task-drawer__none">${esc(T('لا توجد مرفقات لهذه المهمة.', 'This task has no attachments.'))}</li>`;
    if (!edit) return;
    try {
      if (!projectDocs) { const r = await Api.get('/documents', { query: { projectId: w.id } }); projectDocs = Array.isArray(r) ? r : r.items || []; }
    } catch (e) { projectDocs = null; return; }
    if (current !== task) return;
    const linked = new Set(items.map((a) => a.documentId));
    const free = projectDocs.filter((d) => !linked.has(d.id));
    form.hidden = free.length === 0;
    $('taskAttachSelect').innerHTML = `<option value="">${esc(T('اختر ملفًا من ملفات المشروع', 'Choose a project file'))}</option>` + free.map((d) => `<option value="${esc(d.id)}">${esc(d.title)} — ${esc(d.fileName || '')}</option>`).join('');
    hint.hidden = free.length !== 0;
    hint.innerHTML = projectDocs.length ? esc(T('أُرفقت كل ملفات المشروع بهذه المهمة.', 'Every project file is already attached.'))
      : `${esc(T('لإرفاق ملف، ارفعه أولًا في ملفات المشروع.', 'To attach a file, first upload it to the project files.'))} <a href="project-files.html?project=${encodeURIComponent(w.id)}">${esc(T('ملفات المشروع', 'Project files'))}</a>`;
  }
  async function openDocument(id, button) {
    // the tab opens at the click (no pop-up blocker), the signed link is set when it arrives
    const tab = window.open('', '_blank');
    await UI.busy(button, async () => {
      try {
        const d = await Api.get(`/documents/${encodeURIComponent(id)}`);
        if (!d.signedUrl) throw new Api.ApiError({ code: 'STORAGE_ERROR' });
        if (tab) { tab.opener = null; tab.location.href = d.signedUrl; } else window.location.href = d.signedUrl;
      } catch (e) { if (tab) tab.close(); throw e; }
    });
  }
  $('taskDrawerFiles').addEventListener('click', (event) => {
    const task = current; if (!task) return;
    const open = event.target.closest('[data-open-doc]'); const detach = event.target.closest('[data-detach]');
    if (open) openDocument(open.dataset.openDoc, open);
    if (detach) UI.busy(detach, async () => { await Api.del(`/tasks/${encodeURIComponent(task.id)}/attachments/${encodeURIComponent(detach.dataset.detach)}`); UI.toast(T('أُزيل المرفق.', 'Attachment removed.'), 'success'); renderAttachments(task); });
  });
  $('taskAttachForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const task = current; const documentId = $('taskAttachSelect').value;
    if (!task || !documentId) { $('taskAttachSelect').focus(); return; }
    UI.busy(event.target.querySelector('button'), async () => { await Api.post(`/tasks/${encodeURIComponent(task.id)}/attachments`, { documentId }); UI.toast(T('أُرفق الملف بالمهمة.', 'File attached to the task.'), 'success'); renderAttachments(task); });
  });

  function openTask(id) {
    const task = tasks.find((t) => t.id === id); if (!task) return;
    current = task; editing = null; comments = [];
    $('taskDrawerProject').textContent = w.name;
    $('taskDrawerTitle').textContent = task.name;
    $('taskDrawerAssignee').textContent = task.assignee;
    $('taskDrawerDue').textContent = task.due ? UI.fmtDate(task.due) : '—';
    $('taskDrawerStage').textContent = task.stage || (task.source === 'AI_SUGGESTION' ? T('من دليل المشروع', 'From the project handbook') : '—');
    $('taskDrawerDescription').textContent = task.description || T('لا يوجد وصف.', 'No description.');
    renderStatus(task); renderLeaderTools(task); renderFeedback(task); loadComments(task); renderAttachments(task);
    commentText.value = ''; setCommentError(false);
    drawer.hidden = false;
    $('closeTaskDrawer').focus();
  }
  const closeDrawer = () => { drawer.hidden = true; current = null; editing = null; };
  body.addEventListener('click', (event) => { const button = event.target.closest('[data-task-open]'); if (button) openTask(button.dataset.taskOpen); });
  $('closeTaskDrawer').addEventListener('click', closeDrawer);
  drawer.addEventListener('click', (event) => { if (event.target === drawer) closeDrawer(); });
  function replace(t) { const v = toView(t); const i = tasks.findIndex((x) => x.id === v.id); if (i >= 0) tasks[i] = v; else tasks.unshift(v); current = v; return v; }

  statusForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const task = current; const to = statusSelect.value;
    if (!task || !to || !D.canChangeTaskStatus(task.status, to, isLeader)) { statusSelect.focus(); return; }
    UI.busy(statusForm.querySelector('button'), async () => {
      const v = replace(await Api.patch(`/tasks/${task.id}`, { status: to }));
      renderStatus(v); render(); UI.tasksChanged(); UI.toast(T('حُفظت الحالة.', 'Status saved.'), 'success');
    });
  });
  // "mark as completed": saved on the server, then the panel, the list and the counters update at once
  $('taskComplete').addEventListener('click', () => {
    const task = current;
    if (!task || !D.canChangeTaskStatus(task.status, 'COMPLETED', isLeader)) return;
    UI.busy($('taskComplete'), async () => {
      const v = replace(await Api.patch(`/tasks/${task.id}`, { status: 'COMPLETED' }));
      renderStatus(v); render(); UI.tasksChanged(); UI.toast(T('اكتملت المهمة.', 'Task completed.'), 'success');
    });
  });
  $('taskLeaderForm').addEventListener('submit', (event) => {
    event.preventDefault(); const task = current; if (!task) return;
    UI.busy(event.target.querySelector('[type="submit"]'), async () => {
      const v = replace(await Api.patch(`/tasks/${task.id}`, { assignedStudentId: $('taskEditAssignee').value || null, milestoneId: $('taskEditStage').value || null, dueDate: $('taskEditDue').value || null }));
      openTask(v.id); render(); UI.tasksChanged(); UI.toast(T('حُفظت المهمة.', 'Task saved.'), 'success');
    });
  });
  $('taskDelete').addEventListener('click', () => {
    const task = current; if (!task || !window.confirm(T(`حذف المهمة «${task.name}»؟`, `Delete the task “${task.name}”?`))) return;
    UI.busy($('taskDelete'), async () => { await Api.del(`/tasks/${task.id}`); tasks = tasks.filter((t) => t.id !== task.id); closeDrawer(); render(); UI.tasksChanged(); UI.toast(T('حُذفت المهمة.', 'Task deleted.'), 'success'); });
  });

  function setCommentError(on) { commentText.classList.toggle('is-invalid', on); commentText.setAttribute('aria-invalid', String(on)); commentError.hidden = !on; }
  commentText.addEventListener('input', () => { if (commentText.value.trim()) setCommentError(false); });
  commentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const task = current; const text = commentText.value.trim();
    if (!text) { setCommentError(true); commentText.focus(); return; }
    UI.busy(commentForm.querySelector('button'), async () => {
      comments.push(await Api.post(`/tasks/${task.id}/comments`, { content: text }));
      commentText.value = ''; renderComments();
    });
  });
  $('taskDrawerComments').addEventListener('click', (event) => {
    const task = current; if (!task) return;
    const edit = event.target.closest('[data-edit-comment]'); const del = event.target.closest('[data-delete-comment]');
    if (edit) { editing = edit.dataset.editComment; renderComments(); }
    if (event.target.closest('[data-cancel-edit]')) { editing = null; renderComments(); }
    if (del) UI.busy(del, async () => { await Api.del(`/tasks/${task.id}/comments/${del.dataset.deleteComment}`); comments = comments.filter((c) => c.id !== del.dataset.deleteComment); renderComments(); });
  });
  $('taskDrawerComments').addEventListener('submit', (event) => {
    event.preventDefault();
    const task = current; const form = event.target.closest('[data-edit-form]'); if (!task || !form) return;
    const text = form.querySelector('textarea').value.trim();
    if (!text) { form.querySelector('textarea').classList.add('is-invalid'); return; }
    UI.busy(form.querySelector('[type="submit"]'), async () => {
      const updated = await Api.patch(`/tasks/${task.id}/comments/${form.dataset.editForm}`, { content: text });
      comments = comments.map((c) => (c.id === updated.id ? updated : c)); editing = null; renderComments();
    });
  });

  // ----- Add task (Team Leader) -----
  const modal = $('taskModal'); const form = $('taskForm'); const nameInput = $('taskName'); const nameError = $('taskNameError');
  const showModal = async () => {
    members = await S.assignees(w); // fresh: a member who just joined can be chosen
    $('taskAssignee').innerHTML = `<option value="">${esc(T('غير مُسنَدة', 'Unassigned'))}</option>` + members.map((m) => `<option value="${esc(m.userId)}">${esc(m.label)}</option>`).join('');
    $('taskStage').innerHTML = `<option value="">${esc(T('بدون مرحلة', 'No stage'))}</option>` + stages.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('');
    modal.hidden = false; nameInput.focus();
  };
  const hideModal = () => { modal.hidden = true; form.reset(); setNameError(false); };
  function setNameError(on) { nameInput.classList.toggle('is-invalid', on); nameInput.setAttribute('aria-invalid', String(on)); nameError.hidden = !on; }
  $('openTaskModal').addEventListener('click', showModal);
  $('closeTaskModal').addEventListener('click', hideModal);
  $('cancelTaskModal').addEventListener('click', hideModal);
  modal.addEventListener('click', (event) => { if (event.target === modal) hideModal(); });
  nameInput.addEventListener('input', () => { if (nameInput.value.trim()) setNameError(false); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (name.length < 3) { setNameError(true); nameInput.focus(); return; }
    const due = $('taskDue').dataset.iso || $('taskDue').value || undefined;
    UI.busy(form.querySelector('[type="submit"]'), async () => {
      const t = await Api.post('/tasks', {
        projectId: w.id, title: name, description: $('taskDescription').value.trim() || undefined,
        assignedStudentId: $('taskAssignee').value || undefined, milestoneId: $('taskStage').value || undefined,
        status: $('taskStatus').value, priority: $('taskPriority').value, dueDate: due
      });
      replace(t); hideModal(); render(); UI.tasksChanged(); UI.toast(T('أُضيفت المهمة.', 'Task added.'), 'success');
    });
  });
  document.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; if (!modal.hidden) hideModal(); else closeDrawer(); });

  function pickProject(list) {
    document.querySelector('.tasks-toolbar').hidden = true;
    document.querySelector('.tasks-table').hidden = true;
    const box = document.createElement('section');
    box.className = 'tasks-pick'; box.setAttribute('aria-labelledby', 'tasksPickTitle');
    box.innerHTML = `<h2 id="tasksPickTitle">${esc(T('اختر المشروع', 'Choose a project'))}</h2><p>${esc(T('اختر المشروع لعرض مهامه.', 'Choose a project to see its tasks.'))}</p>
      <div class="tasks-pick__list">${list.map((x) => { const pct = Math.round(x.progress?.percent ?? 0); return `<a class="tasks-pick__item" href="tasks.html?project=${encodeURIComponent(x.id)}">
        ${UI.projectImageSlot(x.project, false, 'tasks-pick__img')}<span class="tasks-pick__text"><b>${esc(x.name)}</b><small>${esc(x.team?.name || '')}</small></span>
        <span class="tasks-pick__pct">${pct}%</span></a>`; }).join('')}</div>`;
    document.querySelector('.tasks-toolbar').before(box);
  }

  S.ready.then(async () => {
    me = S.user;
    try {
      // no project chosen yet (and more than one project): choose the project first,
      // then its tasks are shown
      if (!new URLSearchParams(location.search).get('project')) {
        const list = await S.projects();
        if (list.length > 1) { pickProject(list); return; }
      }
      w = await S.currentWorkspace();
      if (!w) { UI.state(body, 'empty', { title: T('لا توجد مشاريع بعد', 'No projects yet'), text: T('تظهر المهام بعد إنشاء مشروع أو الانضمام إليه.', 'Tasks appear once you create or join a project.'), action: { href: 'projects.html?new=1', label: T('إنشاء مشروع', 'Create a project') } }); $('openTaskModal').hidden = true; return; }
      isLeader = !!w.viewer?.isLeader;
      $('openTaskModal').hidden = !isLeader;
      S.projectSwitcher(document.querySelector('.tasks-section .projects-hero__content'), await S.projects(), w.id, (id) => { location.href = `tasks.html?project=${encodeURIComponent(id)}`; });
      // independent requests run together (not one after another)
      const [m, st] = await Promise.all([
        S.assignees(w), // leader (also yourself) + every active member, from the API
        Api.get('/milestones', { query: { projectId: w.id, limit: 100 } }).then((r) => r.items || []).catch(() => []),
        loadTasks()
      ]);
      members = m; stages = st;
      const open = new URLSearchParams(location.search).get('task'); if (open) openTask(open);
    } catch (e) { UI.state(body, 'error', { error: e, retry: () => location.reload() }); }
  });
})();
