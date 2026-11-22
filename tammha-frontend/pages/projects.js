// ===== Projects page (projects.html) — connected to the API =====
// List:        GET /projects (every project of the student, one workspace each)
// Invitations: GET /team-invitations/incoming, POST /team-invitations/:id/accept | decline
// Wizard "إنشاء مشروع جديد" (the student becomes Team Leader), in this order:
//   1. POST  /projects                                  name, description, team name, dates
//   2. PATCH /projects/:id                              overview, objectives, category, origin, expected end, image (thumbnail)
//   3. POST  /milestones                                one per chosen stage, in order (the first becomes current)
//   4. PUT   /projects/:id/handbook/university-selection { universityKey }   or   PUT /projects/:id/handbook (PDF)
//   5. POST  /teams/:teamId/student-invitations         one per classmate (optional)
//   6. POST  /projects/:id/supervision-requests         { supervisorEmail } (optional: a supervisor can be invited later)
//   7. POST  /projects/:id/setup/complete               the backend checks every requirement (422 lists what is missing)
// A step that fails is reported; the steps before it stay saved and can be finished on the project page.
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession; const D = window.TammhaDomain;
  const { T, L, esc } = UI;
  const $ = (id) => document.getElementById(id);
  const list = document.querySelector('.projects-list');
  const STATUS_CLASS = { PLANNING: 'progress', IN_PROGRESS: 'progress', REVIEW: 'progress', COMPLETED: 'completed', ARCHIVED: 'archived' };
  let universities = [];
  let wizardImage = null; // the project image chosen in the wizard (resized data URL)

  function card(w) {
    const p = w.project; const pct = Math.round(w.progress?.percent ?? 0);
    const sup = w.supervisors && w.supervisors[0] ? UI.personName(w.supervisors[0].user || w.supervisors[0]) : '';
    const members = w.team?.memberCount ?? (w.team?.members || []).length;
    const role = w.viewer?.isLeader ? T('قائد الفريق', 'Team Leader') : T('عضو', 'Member');
    const meta = [sup ? T(`المشرف: ${sup}`, `Supervisor: ${sup}`) : T('بانتظار المشرف', 'No supervisor yet'), T(`${members} أعضاء`, `${members} members`), role].join(' · ');
    // plain text only (no coloured box); an optional supervisor never makes the setup incomplete
    const missing = (w.setupReadiness && w.setupReadiness.missingRequirements) || [];
    const setup = p.setup && !p.setup.completed && missing.length ? `<span class="project-setup-note">${esc(T('الإعداد غير مكتمل', 'Setup incomplete'))}</span>` : '';
    return `<article class="projects-list-card" data-status="${esc(p.status)}">
      <div class="project-identity">${UI.projectImageSlot(p, !!(w.viewer?.canManage ?? w.viewer?.isLeader), 'project-identity__image')}
        <div class="project-identity__text"><h2>${esc(p.name)}</h2><p>${esc(meta)}</p></div>
        <span class="project-status project-status--${STATUS_CLASS[p.status] || 'progress'}">${esc(L(D.PROJECT_STATUSES[p.status]?.label || [p.status, p.status]))}</span></div>
      <div class="project-progress"><div class="project-progress__label"><span>${esc(T('نسبة الإنجاز', 'Completion'))}</span><strong>${pct}%</strong></div>
        <div aria-label="${esc(T('نسبة إنجاز المشروع', 'Project completion'))}" aria-valuemax="100" aria-valuemin="0" aria-valuenow="${pct}" class="project-progress__track" role="progressbar"><span${pct >= 100 ? ' class="is-completed"' : ''} style="width:${pct}%"></span></div></div>
      <div class="project-card-foot"><span class="project-updated">${esc(T('آخر تحديث', 'Last updated'))} ${esc(UI.fmtDate(p.updatedAt))} ${setup}</span>
        <a class="project-card-action" href="project-overview.html?project=${encodeURIComponent(p.id)}">${esc(T('فتح المشروع', 'Open project'))}</a></div></article>`;
  }

  // Loading: one centred state in the list area (never a half-drawn card); then the cards,
  // the empty state, or an error with a retry. A reload after an action keeps the old cards
  // until the new ones are ready (no flash, no layout jump).
  let loadSeq = 0;
  async function loadProjects() {
    const seq = ++loadSeq;
    const first = !list.querySelector('.projects-list-card');
    let holder = list.querySelector('.projects-list-state');
    if (first) {
      $('projectsEmptyState').hidden = true;
      if (!holder) { holder = document.createElement('div'); holder.className = 'projects-list-state'; list.append(holder); }
      UI.state(holder, 'loading', { title: T('جارٍ تحميل المشاريع…', 'Loading projects…') });
    }
    try {
      const items = await S.projects(true);
      if (seq !== loadSeq) return;
      list.querySelectorAll('.projects-list-card, .projects-list-state').forEach((n) => n.remove());
      list.insertAdjacentHTML('beforeend', items.map(card).join(''));
      window.applyProjectFilter?.(document.querySelector('.project-filter.is-active')?.dataset.filter || 'all');
    } catch (e) {
      if (seq !== loadSeq) return;
      list.querySelectorAll('.projects-list-card').forEach((n) => n.remove());
      $('projectsEmptyState').hidden = true;
      if (!holder) { holder = document.createElement('div'); holder.className = 'projects-list-state'; list.append(holder); }
      UI.state(holder, 'error', { error: e, retry: loadProjects });
    }
  }

  // ----- incoming team invitations -----
  const inv = $('invitations');
  async function loadInvitations() {
    try {
      const items = await Api.get('/team-invitations/incoming');
      const pending = (items || []).filter((i) => i.status === 'PENDING');
      inv.hidden = pending.length === 0;
      inv.querySelector('ul').innerHTML = pending.map((i) => `<li><div><strong>${esc(i.team.projectName || i.team.name)}</strong>
        <div class="app-muted">${esc(T(`دعوة من ${i.invitedBy?.displayName || ''} للانضمام إلى ${i.team.name}`, `${i.invitedBy?.displayName || ''} invited you to join ${i.team.name}`))}</div></div>
        <div class="app-inline-form"><button class="app-btn app-btn--primary" type="button" data-accept="${esc(i.id)}">${esc(T('قبول', 'Accept'))}</button><button class="app-btn" type="button" data-decline="${esc(i.id)}">${esc(T('اعتذار', 'Decline'))}</button></div></li>`).join('');
    } catch (e) { inv.hidden = true; }
  }
  inv.addEventListener('click', (e) => {
    const a = e.target.closest('[data-accept]'); const d = e.target.closest('[data-decline]');
    if (!a && !d) return;
    UI.busy(a || d, async () => {
      await Api.post(`/team-invitations/${encodeURIComponent((a || d).dataset.accept || (a || d).dataset.decline)}/${a ? 'accept' : 'decline'}`, {});
      UI.toast(a ? T('انضممت إلى الفريق.', 'You joined the team.') : T('تم الاعتذار عن الدعوة.', 'The invitation was declined.'), 'success');
      await Promise.all([loadInvitations(), loadProjects()]);
    });
  });

  // ----- wizard -----
  // Layout: header (title + steps) / scrolling body / footer that always shows the actions.
  // Errors are listed in ONE dismissible alert at the top of the body (plus the field marks).
  const modal = $('projectWizard'); const LAST_STEP = 4; let step = 1; let createdProjectId = null;
  const panels = [...document.querySelectorAll('[data-wizard-panel]')]; const tabs = [...document.querySelectorAll('.wizard-tab')];
  $('wizardCategory').insertAdjacentHTML('beforeend', Object.entries(D.PROJECT_CATEGORIES).map(([k, l]) => `<option value="${k}">${esc(L(l))}</option>`).join(''));
  $('wizardOrigin').insertAdjacentHTML('beforeend', Object.entries(D.PROJECT_ORIGINS).map(([k, l]) => `<option value="${k}">${esc(L(l))}</option>`).join(''));
  const srcOf = () => document.querySelector('input[name="wizardHandbookSource"]:checked').value;
  const uni = (key) => universities.find((u) => u.key === key) || null;
  const uName = (u) => (UI.isEn() ? u.name.en : u.name.ar);

  // ---- the alert (top of the body) ----
  const alertBox = $('wizardAlert');
  function showAlert(kind, title, items) {
    alertBox.className = `wz-alert wz-alert--${kind}`;
    $('wizardAlertTitle').textContent = title;
    $('wizardAlertList').innerHTML = (items || []).map((t) => `<li>${esc(t)}</li>`).join('');
    alertBox.hidden = false;
    $('wizardBody').scrollTop = 0;
  }
  const hideAlert = () => { alertBox.hidden = true; };
  $('wizardAlertClose').addEventListener('click', hideAlert);

  function updateNote() {
    const n = $('wizardHandbookNote'); const u = srcOf() === 'UNIVERSITY' ? uni($('wizardHandbookUniversity').value) : null;
    n.textContent = !u ? '' : !u.handbook ? T(`لم يُضف الدليل الرسمي لـ${uName(u)} إلى المنصة بعد؛ يمكن رفع الدليل يدويًا.`, `The official handbook of ${uName(u)} has not been added to the platform yet; you can upload it manually.`)
      : !u.isMyUniversity ? T(`استخدام دليل ${uName(u)} لا يغيّر الجامعة المسجلة في حسابك.`, `Using the handbook of ${uName(u)} does not change the university registered in your account.`) : '';
    n.hidden = !n.textContent;
  }
  const syncSource = () => { document.querySelectorAll('[data-handbook-source]').forEach((el) => { el.hidden = el.dataset.handbookSource !== srcOf(); }); updateNote(); };
  document.querySelectorAll('input[name="wizardHandbookSource"]').forEach((r) => r.addEventListener('change', () => { syncSource(); setErr('wizardHandbook', ''); }));
  $('wizardHandbookUniversity').addEventListener('change', () => { updateNote(); setErr('wizardHandbook', ''); });
  $('wizardHandbookFile').addEventListener('change', () => setErr('wizardHandbook', ''));
  function setErr(id, msg) { const el = document.querySelector(`[data-error-for="${id}"]`); const input = $(id); if (el) { el.textContent = msg || ''; el.hidden = !msg; } if (input) { input.classList.toggle('is-invalid', !!msg); input.setAttribute('aria-invalid', String(!!msg)); } return !msg; }
  const iso = (id) => $(id).dataset.iso || $(id).value;
  const blank = (id) => !(($(id).type === 'date' || $(id).classList.contains('date-field__input')) ? iso(id) : $(id).value.trim());

  // ---- stages (step 4): ordered, renamable, removable ----
  const DEFAULT_STAGES = [['التحليل والبحث', 'Analysis and research'], ['التصميم', 'Design'], ['التطوير', 'Development'], ['الاختبار', 'Testing'], ['التسليم النهائي', 'Final delivery']];
  let stages = [];
  const resetStages = () => { stages = DEFAULT_STAGES.map((n) => ({ name: L(n), on: true })); drawStages(); };
  function drawStages() {
    const on = stages.filter((x) => x.on).length;
    $('wizardStages').innerHTML = stages.map((x, i) => `<li class="wz-stage${x.on ? '' : ' is-off'}" data-i="${i}">
      <label class="wz-stage__check"><input type="checkbox" data-stage-on ${x.on ? 'checked' : ''} aria-label="${esc(T(`تضمين المرحلة ${x.name}`, `Include the stage ${x.name}`))}"/></label>
      <span class="wz-stage__num" aria-hidden="true">${x.on ? stages.slice(0, i + 1).filter((y) => y.on).length : '–'}</span>
      <input class="wz-stage__name" data-stage-name maxlength="200" value="${esc(x.name)}" aria-label="${esc(T('اسم المرحلة', 'Stage name'))}"/>
      ${x.on && stages.findIndex((y) => y.on) === i ? `<span class="wz-stage__tag">${esc(T('المرحلة الحالية', 'Current stage'))}</span>` : ''}
      <span class="wz-stage__tools">
        <button type="button" class="wz-icon" data-stage-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="${esc(T('نقل للأعلى', 'Move up'))}">↑</button>
        <button type="button" class="wz-icon" data-stage-move="1" ${i === stages.length - 1 ? 'disabled' : ''} aria-label="${esc(T('نقل للأسفل', 'Move down'))}">↓</button>
        <button type="button" class="wz-icon wz-icon--danger" data-stage-remove aria-label="${esc(T('حذف المرحلة', 'Remove stage'))}">×</button>
      </span></li>`).join('') || `<li class="wz-stages__empty">${esc(T('لا توجد مراحل. أضف مرحلة واحدة على الأقل.', 'No stages. Add at least one stage.'))}</li>`;
    $('wizardStages').dataset.count = on;
  }
  $('wizardStages').addEventListener('change', (e) => {
    const li = e.target.closest('[data-i]'); if (!li) return; const x = stages[+li.dataset.i];
    if (e.target.matches('[data-stage-on]')) { x.on = e.target.checked; drawStages(); }
  });
  $('wizardStages').addEventListener('input', (e) => {
    const li = e.target.closest('[data-i]'); if (li && e.target.matches('[data-stage-name]')) stages[+li.dataset.i].name = e.target.value;
  });
  $('wizardStages').addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]'); if (!li) return; const i = +li.dataset.i;
    const mv = e.target.closest('[data-stage-move]');
    if (mv) { const j = i + +mv.dataset.stageMove; if (j < 0 || j >= stages.length) return; [stages[i], stages[j]] = [stages[j], stages[i]]; drawStages(); const btn = $('wizardStages').querySelector(`[data-i="${j}"] [data-stage-move="${mv.dataset.stageMove}"]`) || $('wizardStages').querySelector(`[data-i="${j}"] .wz-stage__name`); if (btn) btn.focus(); return; }
    if (e.target.closest('[data-stage-remove]')) { stages.splice(i, 1); drawStages(); }
  });
  const addStage = () => {
    const name = $('customStageName').value.trim();
    if (name.length < 2) { setErr('customStageName', T('اكتب اسم المرحلة (حرفان على الأقل)', 'Write the stage name (at least 2 characters)')); $('customStageName').focus(); return; }
    if (stages.some((x) => x.name.trim() === name)) { setErr('customStageName', T('هذه المرحلة موجودة في القائمة', 'This stage is already in the list')); return; }
    stages.push({ name, on: true }); $('customStageName').value = ''; setErr('customStageName', ''); drawStages();
  };
  $('saveCustomStage').addEventListener('click', addStage);
  $('customStageName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addStage(); } });
  const chosenStages = () => stages.filter((x) => x.on).map((x) => x.name.trim());

  // ---- validation: field marks + the alert lists every problem of the step ----
  function validate(n) {
    const bad = []; const msgs = [];
    const mark = (id, msg) => { if (!setErr(id, msg)) { bad.push(id); msgs.push(msg); } };
    const need = (id, msg) => mark(id, blank(id) ? msg : '');
    if (n === 1) {
      need('wizardProjectName', T('اسم المشروع مطلوب', 'Project name is required'));
      if (!blank('wizardProjectName') && $('wizardProjectName').value.trim().length < 3) mark('wizardProjectName', T('اسم المشروع 3 أحرف على الأقل', 'The project name needs at least 3 characters'));
      need('wizardProjectDescription', T('الوصف المختصر مطلوب', 'Short description is required'));
      need('wizardCategory', T('اختر تصنيف المشروع', 'Select the project category'));
      need('wizardOrigin', T('اختر نوع المشروع', 'Select the project type'));
      need('wizardStartDate', T('تاريخ البدء مطلوب', 'Start date is required'));
      if (!blank('wizardStartDate') && !blank('wizardEndDate') && iso('wizardEndDate') <= iso('wizardStartDate')) mark('wizardEndDate', T('تاريخ الإنجاز يجب أن يكون بعد تاريخ البدء', 'The completion date must be after the start date'));
      need('wizardProjectGoal', T('هدف المشروع مطلوب', 'Project objective is required'));
      need('wizardProjectAbout', T('نبذة المشروع مطلوبة', 'Project overview is required'));
    }
    if (n === 2) {
      need('wizardTeamName', T('اسم الفريق مطلوب', 'Team name is required'));
      if (!blank('wizardTeamName') && $('wizardTeamName').value.trim().length < 2) mark('wizardTeamName', T('اسم الفريق حرفان على الأقل', 'The team name needs at least 2 characters'));
      // the academic supervisor is optional: an e-mail typed but not added is only checked for its form
      const typed = $('supervisorInviteInput').value.trim();
      if (typed && !/^\S+@\S+\.\S+$/.test(typed)) mark('supervisorInviteInput', T('بريد المشرف غير صحيح، أو اترك الحقل فارغًا', "The supervisor's e-mail is not valid, or leave the field empty"));
    }
    if (n === 3) {
      let msg = '';
      if (srcOf() === 'UNIVERSITY') { const u = uni($('wizardHandbookUniversity').value); msg = !u ? T('اختر جامعة الدليل', "Select the handbook's university") : !u.handbook ? T('دليل هذه الجامعة غير متاح حاليًا؛ ارفع دليلًا خاصًا', "This university's handbook is not available yet; upload a handbook instead") : ''; }
      if (srcOf() === 'UPLOAD') { const f = $('wizardHandbookFile').files[0]; msg = !f ? T('اختر ملف الدليل', 'Select the handbook file') : !(f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) ? T('ملف الدليل يجب أن يكون بصيغة PDF', 'The handbook must be a PDF file') : f.size === 0 ? T('ملف الدليل فارغ', 'The handbook file is empty') : f.size > 20 * 1024 * 1024 ? T('حجم ملف الدليل يتجاوز 20MB', 'The handbook file is larger than 20 MB') : ''; }
      if (msg) { setErr('wizardHandbook', msg); bad.push(srcOf() === 'UNIVERSITY' ? 'wizardHandbookUniversity' : 'wizardHandbookFile'); msgs.push(msg); } else setErr('wizardHandbook', '');
    }
    if (n === 4) {
      const names = chosenStages();
      if (!names.length) msgs.push(T('اختر مرحلة واحدة على الأقل أو أضف مرحلة', 'Select at least one stage or add one'));
      if (names.some((x) => x.length < 2)) msgs.push(T('اسم كل مرحلة حرفان على الأقل', 'Each stage name needs at least 2 characters'));
      if (new Set(names).size !== names.length) msgs.push(T('يوجد اسم مرحلة مكرر', 'A stage name is repeated'));
      if (msgs.length) bad.push('wizardStages');
    }
    if (bad.length) {
      // a short list stays readable; many empty fields are summarised (each field shows its own message)
      if (msgs.length > 3) showAlert('error', T(`أكمل الحقول المطلوبة المعلّمة باللون الأحمر (${msgs.length}).`, `Complete the required fields marked in red (${msgs.length}).`), []);
      else showAlert('error', T('راجع ما يلي قبل المتابعة:', 'Please review the following before continuing:'), msgs);
      const first = $(bad[0]); if (first && first.focus) first.focus({ preventScroll: true });
    } else hideAlert();
    return bad.length === 0;
  }
  const render = () => {
    panels.forEach((p) => { const on = +p.dataset.wizardPanel === step; p.hidden = !on; p.classList.toggle('is-active', on); });
    tabs.forEach((t) => { const n = +t.dataset.step; t.classList.toggle('is-active', n === step); t.classList.toggle('is-done', n < step); t.setAttribute('aria-current', n === step ? 'step' : 'false'); });
    const done = !!createdProjectId;
    $('wizardPrev').hidden = step === 1 || done; $('wizardNext').hidden = step === LAST_STEP || done; $('wizardCreate').hidden = step !== LAST_STEP || done;
    $('wizardOpenProject').hidden = !done; $('wizardCancel').textContent = done ? T('إغلاق', 'Close') : T('إلغاء', 'Cancel');
    $('wizardBody').scrollTop = 0;
  };
  function resetWizard() {
    createdProjectId = null; step = 1; hideAlert();
    $('projectWizardForm').reset();
    ['wizardStartDate', 'wizardEndDate'].forEach((id) => { delete $(id).dataset.iso; });
    ['teamInviteChips', 'supervisorInviteChips'].forEach((id) => { $(id).innerHTML = ''; });
    document.querySelectorAll('#projectWizardForm .field-error').forEach((el) => { el.hidden = true; el.textContent = ''; });
    document.querySelectorAll('#projectWizardForm .is-invalid').forEach((el) => el.classList.remove('is-invalid'));
    panels.forEach((p) => p.querySelectorAll('input,select,textarea,button').forEach((el) => { el.disabled = false; }));
    resetStages(); syncSource(); setWizardImage(null);
  }
  // ----- project image (optional): shown on the project cards -----
  function setWizardImage(data) {
    wizardImage = data;
    const box = $('wizardImagePreview'); if (!box) return;
    box.style.backgroundImage = data ? `url('${data}')` : '';
    box.classList.toggle('has-image', !!data);
    $('wizardImageRemove').hidden = !data;
    $('wizardImagePickLabel').textContent = data ? T('تغيير الصورة', 'Change image') : T('اختيار صورة', 'Choose image');
  }
  $('wizardImageFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    const err = $('wizardImageError'); err.hidden = true; err.textContent = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { err.textContent = T('الصورة أكبر من 5MB.', 'The image is larger than 5 MB.'); err.hidden = false; return; }
    try { setWizardImage(await UI.imageDataUrl(file)); }
    catch (x) { err.textContent = T('اختر صورة PNG أو JPG أو WebP.', 'Choose a PNG, JPG or WebP image.'); err.hidden = false; }
  });
  $('wizardImageRemove').addEventListener('click', () => setWizardImage(null));
  async function open() {
    if (modal.hidden && !createdProjectId) resetWizard();
    modal.hidden = false; document.body.classList.add('has-wizard'); render(); syncSource();
    $('wizardProjectName').focus({ preventScroll: true });
    if (!universities.length) {
      const [unis, sups] = await Promise.allSettled([Api.get('/handbooks/universities'), Api.get('/supervision-requests/supervisors')]);
      if (unis.status === 'fulfilled') {
        universities = unis.value || [];
        $('wizardHandbookUniversity').insertAdjacentHTML('beforeend', universities.map((u) => `<option value="${esc(u.key)}">${esc(uName(u))}${u.handbook ? '' : esc(T(' — غير متاح', ' — not available'))}</option>`).join(''));
      } else setErr('wizardHandbook', Api.message(unis.reason));
    }
  }
  const close = () => {
    modal.hidden = true; document.body.classList.remove('has-wizard');
    if (createdProjectId) { createdProjectId = null; resetWizard(); }
  };
  $('openProjectWizard').addEventListener('click', open); $('closeProjectWizard').addEventListener('click', close); $('wizardCancel').addEventListener('click', close);
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('wizardNext').addEventListener('click', () => { if (!validate(step)) return; step = Math.min(LAST_STEP, step + 1); render(); });
  $('wizardPrev').addEventListener('click', () => { hideAlert(); step = Math.max(1, step - 1); render(); });
  tabs.forEach((t) => t.addEventListener('click', () => {
    if (createdProjectId) return;
    const target = +t.dataset.step;
    if (target < step) { hideAlert(); step = target; render(); return; }
    for (let n = step; n < target; n += 1) { if (!validate(n)) { step = n; render(); return; } }
    step = target; render();
  }));
  document.querySelectorAll('[data-wizard-panel] input,[data-wizard-panel] select,[data-wizard-panel] textarea').forEach((el) => el.addEventListener('input', () => { if (el.classList.contains('is-invalid')) setErr(el.id, ''); }));
  document.querySelectorAll('[data-add-invite]').forEach((btn) => btn.addEventListener('click', () => addInvite(btn.dataset.addInvite)));
  ['teamInviteInput', 'supervisorInviteInput'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addInvite(id === 'teamInviteInput' ? 'team' : 'supervisor'); } }));
  function addInvite(type) {
    const input = $(type === 'team' ? 'teamInviteInput' : 'supervisorInviteInput'); const chips = $(type === 'team' ? 'teamInviteChips' : 'supervisorInviteChips');
    const val = input.value.trim(); if (!val) { input.focus(); return; }
    if (type === 'supervisor') { if (!/^\S+@\S+\.\S+$/.test(val)) { setErr('supervisorInviteInput', T('أدخل البريد الجامعي للمشرف', "Enter the supervisor's university email")); return; } chips.innerHTML = ''; }
    if ([...chips.children].some((c) => c.dataset.value.toLowerCase() === val.toLowerCase())) { setErr(input.id, T('أُضيف من قبل', 'Already added')); return; }
    setErr(input.id, '');
    const chip = document.createElement('span'); chip.className = 'invite-chip'; chip.dataset.value = val; chip.textContent = val;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', T(`إزالة ${val}`, `Remove ${val}`)); x.onclick = () => chip.remove(); chip.append(x); chips.append(chip); input.value = '';
  }

  // ---- create: project first, then everything that depends on it ----
  $('projectWizardForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (createdProjectId) return;
    for (const n of [1, 2, 3, 4]) { if (!validate(n)) { step = n; render(); validate(n); return; } }
    // a supervisor e-mail typed but not added with the button still counts
    if ($('supervisorInviteInput').value.trim()) addInvite('supervisor');
    if ($('teamInviteInput').value.trim()) addInvite('team');
    const createBtn = $('wizardCreate'); createBtn.disabled = true; hideAlert();
    const problems = [];
    const start = iso('wizardStartDate'); const end = iso('wizardEndDate');
    let w = null;
    const loader = window.TammhaLoader.show({ label: T('جارٍ إنشاء المشروع…', 'Creating the project…') });
    try {
      try {
        w = await Api.post('/projects', { name: $('wizardProjectName').value.trim(), description: $('wizardProjectDescription').value.trim(), teamName: $('wizardTeamName').value.trim(), startDate: start, endDate: end || undefined });
      } catch (err) {
        showAlert('error', T('تعذّر إنشاء المشروع', 'The project could not be created'), [Api.message(err)]);
        createBtn.disabled = false; return;
      }
      const pid = w.project.id; const teamId = w.team.id;
      const run = async (label, fn) => { try { await fn(); return true; } catch (err) { problems.push(`${label}: ${Api.message(err)}`); return false; } };
      const details = { overview: $('wizardProjectAbout').value.trim(), objectives: [$('wizardProjectGoal').value.trim()], category: $('wizardCategory').value, origin: $('wizardOrigin').value, expectedCompletionDate: end || undefined };
      if (wizardImage) details.thumbnail = wizardImage;
      await run(T('تفاصيل المشروع', 'Project details'), () => Api.patch(`/projects/${pid}`, details));
      // stages, in the chosen order (the backend makes the first one the current stage)
      const names = chosenStages();
      const t0 = new Date(`${start}T00:00:00`).getTime(); const t1 = new Date(`${end}T00:00:00`).getTime();
      for (const [i, title] of names.entries()) {
        const due = UI.isoDay(new Date(t0 + ((t1 - t0) * (i + 1)) / names.length));
        await run(T(`المرحلة "${title}"`, `Stage "${title}"`), () => Api.post('/milestones', { projectId: pid, title, dueDate: due, order: i + 1 }));
      }
      if (srcOf() === 'UNIVERSITY') {
        await run(T('دليل الجامعة', 'University handbook'), () => Api.put(`/projects/${pid}/handbook/university-selection`, { universityKey: $('wizardHandbookUniversity').value }));
      } else {
        const fd = new FormData(); fd.append('file', $('wizardHandbookFile').files[0]);
        await run(T('رفع الدليل', 'Handbook upload'), () => Api.upload('PUT', `/projects/${pid}/handbook`, fd));
      }
      for (const chip of $('teamInviteChips').children) {
        const v = chip.dataset.value; const body = /@/.test(v) ? { universityEmail: v } : { studentNumber: v };
        await run(T(`دعوة ${v}`, `Invitation to ${v}`), () => Api.post(`/teams/${teamId}/student-invitations`, body));
      }
      const supEmail = $('supervisorInviteChips').firstElementChild?.dataset.value;
      if (supEmail) await run(T('طلب الإشراف', 'Supervision request'), () => Api.post(`/projects/${pid}/supervision-requests`, { supervisorEmail: supEmail }));
      let setupDone = false;
      try { await Api.post(`/projects/${pid}/setup/complete`, {}); setupDone = true; } catch (err) {
        const missing = (err.details?.missingRequirements || err.details?.missing || []);
        if (missing.includes('HANDBOOK_PROCESSING')) problems.push(T('الدليل المرفوع قيد المعالجة؛ أكمل الإعداد من صفحة المشروع بعد انتهائها.', 'The uploaded handbook is still being processed; finish the setup on the project page once it is ready.'));
        else problems.push(`${T('إكمال الإعداد', 'Setup completion')}: ${missing.length ? missing.map(UI.setupRequirement).join(T('، ', ', ')) : Api.message(err)}`);
      }
      createdProjectId = pid;
      $('wizardOpenProject').href = `project-overview.html?project=${encodeURIComponent(pid)}`;
      panels.forEach((p) => p.querySelectorAll('input,select,textarea,button').forEach((el) => { el.disabled = true; }));
      if (problems.length) showAlert('warning', setupDone ? T('أُنشئ المشروع مع ملاحظات:', 'The project was created, with notes:') : T('أُنشئ المشروع، وبقيت خطوات تُكمل من صفحة المشروع:', 'The project was created; some steps remain on the project page:'), problems);
      else { S.invalidateProjects(); S.setCurrentProject(pid); location.assign('projects.html'); return; }
      S.invalidateProjects(); S.setCurrentProject(pid);
      render(); $('wizardOpenProject').focus();
      loadProjects();
    } finally { loader.done(); createBtn.disabled = false; }
  });

  S.ready.then(() => {
    loadProjects(); loadInvitations();
    if (new URLSearchParams(location.search).get('new') === '1') open();
  });
})();
