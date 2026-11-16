// ===== Graduation Project Handbook (guide.html) — connected to the API =====
// One page, one workflow, per project:
//   1. the handbook is chosen in ONE of two ways (Team Leader):
//      A. a university's official PDF — GET /handbooks/universities (exactly four, by key),
//         PUT /projects/:id/handbook/university-selection { universityKey }
//      B. the team's own PDF — PUT /projects/:id/handbook (multipart "file"); the server extracts the
//         text (PROCESSING → READY / FAILED, polled here)
//      The state is GET /projects/:id/handbook. DELETE …/university-selection goes back to the own upload.
//   2. two separate AI actions on the selected handbook (through the backend; Gemini key on the server):
//      "ملخص الدليل" — GET/POST /projects/:id/handbook/summary (seven fixed topics; cached per language)
//      "استخراج المهام" — POST /projects/:id/handbook/task-suggestions, then the Team Leader adds only the
//      ticked ones with POST /projects/:id/ai-task-suggestions/apply (idempotent; duplicates skipped).
// A failure is shown as an error, never as content; a topic the handbook does not cover shows "لا توجد نتائج".
(function () {
  'use strict';
  const page = document.getElementById('hbSelected');
  if (!page) return;
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession;
  const { T, L, esc } = UI;
  const $ = (id) => document.getElementById(id);
  const lang = UI.lang();
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  let projects = []; let projectId = null; let w = null; let state = null; let universities = [];
  let suggestions = null; // { projectId, aiRequestId, list, canApply, applied: Set }
  const isLeader = () => !!w?.viewer?.isLeader;
  const uName = (u) => (u ? (lang === 'en' ? u.name.en : u.name.ar) : '');
  const pageChips = (pages) => (pages || []).map((p) => `<span class="hb-page">${esc(T(`ص ${p}`, `p. ${p}`))}</span>`).join('');
  function toast(text) { UI.toast(text, 'success'); }

  /** the handbook the AI uses now, or null */
  function selected() {
    if (!state) return null;
    if (state.source === 'LIBRARY' && state.libraryVersion) {
      const v = state.libraryVersion;
      return { kind: 'UNIVERSITY', key: v.universityKey, fileName: v.fileName, pageCount: v.pageCount, title: v.title, universityName: v.universityName, ready: true };
    }
    const a = state.active || state.latest;
    if (a) return { kind: 'UPLOAD', fileName: a.fileName || a.title, pageCount: a.pageCount, fileSize: a.fileSize, uploadedBy: a.uploadedBy, status: a.status || state.state, ready: state.state === 'READY', failed: state.state === 'FAILED', error: a.errorCode || a.failureReason };
    return null;
  }

  // ---------- Selected handbook ----------
  function renderSelected() {
    const sel = selected(); const body = $('hbSelectedBody');
    if (!sel) {
      body.innerHTML = `<p class="hb-empty">${esc(T('لم يُعتمد دليل لهذا المشروع بعد. اختر دليل إحدى الجامعات أو ارفع دليلًا خاصًا، علمًا بأن إعداد المشروع لا يكتمل دون دليل معتمد.', 'No handbook has been set for this project yet. Choose a university handbook or upload one; project setup cannot be completed without a handbook.'))}</p>`;
      return;
    }
    const uni = sel.kind === 'UNIVERSITY' ? universities.find((u) => u.key === sel.key) : null;
    const source = sel.kind === 'UNIVERSITY' ? T(`الدليل الرسمي — ${uName(uni) || sel.universityName}`, `Official handbook — ${uName(uni) || sel.universityName}`) : T(`دليل خاص مرفوع بواسطة ${sel.uploadedBy ? UI.personName(sel.uploadedBy) : 'الفريق'} (خارج مكتبة الأدلة الرسمية)`, `Uploaded by ${sel.uploadedBy ? UI.personName(sel.uploadedBy) : 'the team'} (outside the official handbook library)`);
    const statusText = sel.kind === 'UPLOAD' && !sel.ready ? (sel.failed ? T('تعذّرت قراءة نص الدليل. ارفع ملف PDF يحتوي على نص قابل للتحديد.', 'The handbook text could not be read. Upload a PDF with selectable text.') : T('جارٍ استخراج نص الدليل…', 'Extracting the handbook text…')) : '';
    const myUni = universities.find((u) => u.isMyUniversity);
    body.innerHTML = `<div class="hb-file">
      <img alt="" src="assets/file-pdf.png"/>
      <div class="hb-file__text"><strong dir="auto">${esc(sel.fileName)}</strong><small>${esc(source)}${sel.pageCount ? ` · ${esc(sel.pageCount)} ${esc(T('صفحة', 'pages'))}` : ''}${sel.fileSize ? ` · ${esc(UI.fmtSize(sel.fileSize))}` : ''}</small>
      ${statusText ? `<small class="${sel.failed ? 'hb-file__error' : 'hb-file__note'}">${esc(statusText)}</small>` : ''}
      ${uni && !uni.isMyUniversity && myUni ? `<small class="hb-file__note">${esc(T(`جامعتك المسجلة تبقى ${uName(myUni)}.`, `Your registered university remains ${uName(myUni)}.`))}</small>` : ''}</div>
      <button class="hb-link" data-view-selected type="button">${esc(T('عرض الملف', 'View file'))}</button>
      ${isLeader() && sel.kind === 'UNIVERSITY' ? `<button class="hb-link" data-clear type="button">${esc(T('إلغاء الاعتماد', 'Remove'))}</button>` : ''}
    </div>`;
  }
  $('hbSelectedBody').addEventListener('click', async (e) => {
    if (e.target.closest('[data-view-selected]')) {
      const sel = selected();
      try {
        const r = sel.kind === 'UNIVERSITY' ? await Api.get(`/handbooks/universities/${encodeURIComponent(sel.key)}/file`) : await Api.get(`/projects/${projectId}/handbook/file`);
        window.open(r.url || r.signedUrl, '_blank', 'noopener');
      } catch (err) { UI.toast(Api.message(err), 'error'); }
    }
    const clear = e.target.closest('[data-clear]');
    if (clear) UI.busy(clear, async () => { state = await Api.del(`/projects/${projectId}/handbook/university-selection`); afterChange(); toast(T('أُلغي اعتماد دليل الجامعة لهذا المشروع.', 'The university handbook was removed from this project.')); });
  });

  // ---------- Option A: university ----------
  const uniSelect = $('hbUniversity');
  function fillUniversities() {
    uniSelect.innerHTML = `<option value="">${esc(T('اختر الجامعة', 'Select a university'))}</option>` + universities.map((u) => `<option value="${esc(u.key)}">${esc(uName(u))}${u.isMyUniversity ? esc(T(' (جامعتك)', ' (your university)')) : ''}</option>`).join('');
  }
  function renderUniversity() {
    const box = $('hbUniversityFile'); const uni = universities.find((u) => u.key === uniSelect.value);
    if (!uni) { box.innerHTML = ''; return; }
    if (!uni.handbook) {
      box.innerHTML = `<div class="hb-unavailable"><strong>${esc(T('الدليل غير متاح حاليًا', 'Handbook not available'))}</strong><p>${esc(T(`لم يُضف الدليل الرسمي لـ${uName(uni)} إلى المنصة بعد. يمكن رفع الدليل يدويًا من خيار «رفع دليل خاص».`, `The official handbook of ${uName(uni)} has not been added to the platform yet. You can upload it with “Upload a handbook”.`))}</p></div>`;
      return;
    }
    const h = uni.handbook; const sel = selected();
    const inUse = sel && sel.kind === 'UNIVERSITY' && sel.key === uni.key;
    box.innerHTML = `<div class="hb-file hb-file--option"><img alt="" src="assets/file-pdf.png"/>
      <div class="hb-file__text"><strong dir="auto">${esc(h.fileName)}</strong><small>${esc(UI.fmtSize(h.fileSize))}${h.pageCount ? ` · ${esc(h.pageCount)} ${esc(T('صفحة', 'pages'))}` : ''} · ${esc(T('أُضيف في', 'added'))} ${esc(UI.fmtDate(h.uploadedAt))}</small></div></div>
      <div class="hb-actions"><button class="hb-btn hb-btn--ghost" data-view-university type="button">${esc(T('عرض الملف', 'View file'))}</button>
      ${inUse ? '' : `<button class="hb-btn" data-use-university ${isLeader() ? '' : 'disabled'} type="button">${esc(T('اعتماد الدليل للمشروع', 'Use for the project'))}</button>`}</div>
      ${isLeader() ? '' : `<p class="hb-note">${esc(T('يعتمد دليل المشروع قائد الفريق.', 'The Team Leader sets the project handbook.'))}</p>`}`;
  }
  uniSelect.addEventListener('change', renderUniversity);
  $('hbUniversityFile').addEventListener('click', async (e) => {
    const uni = universities.find((u) => u.key === uniSelect.value); if (!uni) return;
    if (e.target.closest('[data-view-university]')) {
      try { const r = await Api.get(`/handbooks/universities/${encodeURIComponent(uni.key)}/file`); window.open(r.url, '_blank', 'noopener'); } catch (err) { UI.toast(Api.message(err), 'error'); }
    }
    const use = e.target.closest('[data-use-university]');
    if (use) UI.busy(use, async () => {
      state = await Api.put(`/projects/${projectId}/handbook/university-selection`, { universityKey: uni.key }, { loader: { label: T('جارٍ اعتماد الدليل…', 'Setting the handbook…') } });
      afterChange(); toast(T(`اعتُمد دليل ${uName(uni)} لمشروع ${w.name}.`, `${uName(uni)}'s handbook is now used for ${w.name}.`));
    });
  });

  // ---------- Option B: own PDF ----------
  const fileInput = $('hbFile'); const drop = $('hbDrop'); const fileError = $('hbFileError');
  const showFileError = (text) => { fileError.textContent = text; fileError.hidden = !text; };
  const readSignature = (file) => new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String.fromCharCode(...new Uint8Array(reader.result))); reader.onerror = () => resolve(''); reader.readAsArrayBuffer(file.slice(0, 5)); });
  async function takeFile(file) {
    showFileError('');
    if (!file) { showFileError(T('اختر ملف الدليل أولًا.', 'Choose the handbook file first.')); return; }
    if (!isLeader()) { showFileError(T('يرفع دليل المشروع قائد الفريق.', 'The Team Leader uploads the project handbook.')); return; }
    if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) { showFileError(T('صيغة الملف غير مدعومة، ويُقبل ملف PDF فقط.', 'Unsupported file type. Only PDF files are accepted.')); return; }
    if (file.size === 0) { showFileError(T('الملف فارغ.', 'The file is empty.')); return; }
    if (file.size > MAX_FILE_BYTES) { showFileError(T('حجم الملف يتجاوز 20MB.', 'The file is larger than 20 MB.')); return; }
    if ((await readSignature(file)) !== '%PDF-') { showFileError(T('تعذّرت قراءة الملف بوصفه PDF. صدّر الدليل مجددًا بصيغة PDF قياسية.', 'The file could not be read as a PDF. Export the handbook again as a standard PDF.')); return; }
    const fd = new FormData(); fd.append('file', file);
    try {
      await Api.upload('PUT', `/projects/${projectId}/handbook`, fd, { loader: { label: T('جارٍ رفع الدليل ومعالجته…', 'Uploading and processing the handbook…') } });
      // a university selection is replaced by the own upload
      try { await Api.del(`/projects/${projectId}/handbook/university-selection`); } catch (e) { /* not selected */ }
      await waitForProcessing();
      const sel = selected();
      if (sel && sel.failed) showFileError(T('تعذّرت قراءة نص الدليل. ارفع ملف PDF يحتوي على نص قابل للتحديد.', 'The handbook text could not be read. Upload a PDF with selectable text.'));
      else toast(T(`رُفع «${file.name}» واعتُمد دليلًا للمشروع.`, `“${file.name}” was uploaded and set as the project handbook.`));
    } catch (error) { showFileError(Api.message(error)); }
    fileInput.value = '';
  }
  async function waitForProcessing() {
    const pid = projectId; // stops when the user switches to another project
    for (let i = 0; i < 30; i++) {
      const next = await Api.get(`/projects/${pid}/handbook`);
      if (pid !== projectId) return;
      state = next;
      if (state.state !== 'PROCESSING') break;
      renderSelected();
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (pid === projectId) afterChange();
  }
  fileInput.addEventListener('change', () => takeFile(fileInput.files[0]));
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', (e) => takeFile(e.dataTransfer.files[0]));

  // ---------- AI actions ----------
  let tab = 'summary';
  document.querySelectorAll('[data-hb-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.hbTab; renderAi(); }));
  function renderAi() {
    const sel = selected();
    $('hbAi').hidden = !(sel && sel.ready);
    if (!sel || !sel.ready) return;
    document.querySelectorAll('[data-hb-tab]').forEach((b) => { const on = b.dataset.hbTab === tab; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on)); });
    $('hbSummaryPanel').hidden = tab !== 'summary'; $('hbTasksPanel').hidden = tab !== 'tasks';
    if (tab === 'summary') loadSummary(); else renderTasks();
  }

  // ----- A. Summary: seven fixed cards -----
  function summaryCards(result) {
    return `<div class="hb-cards">${result.topics.map((t, i) => `
      <article class="hb-card${t.found ? '' : ' is-empty'}" aria-labelledby="hbTopic${i}">
        <h3 id="hbTopic${i}"><span class="hb-card__num">${i + 1}</span>${esc(L([t.title.ar, t.title.en]))}</h3>
        ${t.found ? `${t.summary ? `<p dir="auto">${esc(t.summary)}</p>` : ''}
          ${t.points.length ? `<ul>${t.points.map((pt) => `<li><span dir="auto">${esc(pt.text)}</span>${pt.pages && pt.pages.length ? `<span class="hb-refs">${pageChips(pt.pages)}</span>` : ''}${pt.verified === false ? `<em class="hb-unverified">${esc(T('لم يُعثر على النص في الدليل، يُرجى التحقق منه.', 'Not found in the handbook text; please check it.'))}</em>` : ''}</li>`).join('')}</ul>` : ''}
          ${t.id === 'GRADING' ? `<p class="hb-card__note">${esc(T('للاطلاع فقط؛ لا تحتسب تممها الدرجات ولا تقيّم الطلاب.', 'For reference only; Tammha does not calculate marks or evaluate students.'))}</p>` : ''}`
        : `<p class="hb-card__none">${esc(T('لا توجد نتائج', 'No results found'))}</p>`}
      </article>`).join('')}</div>`;
  }
  function summaryStart(text) { return `<div class="hb-start"><p>${esc(text || T('يستخرج الملخص من الدليل المعتمد المعلومات المتعلقة بسبعة محاور ثابتة، مع الإشارة إلى أرقام الصفحات حيثما أمكن.', 'The summary extracts the information on seven fixed topics from the selected handbook, with page references where available.'))}</p><button class="hb-btn" data-summary type="button">${esc(T('إنشاء الملخص', 'Create summary'))}</button></div>`; }
  function showSummary(result) {
    const meta = result.coverage && result.coverage.truncated ? `<p class="hb-note">${esc(T(`شمل الملخص ${result.coverage.pagesIncluded} من ${result.coverage.pageCount} صفحة لطول الدليل.`, `The summary covered ${result.coverage.pagesIncluded} of ${result.coverage.pageCount} pages because the handbook is long.`))}</p>` : '';
    $('hbSummaryPanel').innerHTML = summaryCards(result) + meta + `<p class="hb-disclaimer">${esc(T('الملخص مساعد ومبني على نص الدليل، ولا يغني عن الرجوع إلى الدليل في الصفحات المذكورة.', 'The summary is based on the handbook text and does not replace reading the cited pages of the handbook.'))}</p>
      <p class="hb-actions"><button class="hb-btn hb-btn--ghost" data-summary="regenerate" type="button">${esc(T('إعادة إنشاء الملخص', 'Create the summary again'))}</button></p>`;
  }
  async function loadSummary() {
    const panel = $('hbSummaryPanel'); UI.state(panel, 'loading');
    try {
      const r = await Api.get(`/projects/${projectId}/handbook/summary`, { query: { language: lang } });
      if (r.status === 'READY' && r.topics && r.topics.length) showSummary(r); else panel.innerHTML = summaryStart();
    } catch (e) { panel.innerHTML = summaryStart(); }
  }
  async function createSummary(regenerate) {
    const panel = $('hbSummaryPanel'); panel.innerHTML = '';
    try {
      const result = await Api.post(`/projects/${projectId}/handbook/summary`, { language: lang, regenerate: !!regenerate }, { timeout: Api.aiTimeout, loader: { target: panel, label: T('جارٍ إعداد ملخص الدليل…', 'Preparing the handbook summary…') } });
      showSummary(result);
    } catch (error) {
      const wait = Number(error?.details?.retryAfterSeconds || 0);
      const extra = wait > 0 ? T(` يمكن إعادة المحاولة بعد ${Math.ceil(wait / 60)} دقيقة تقريبًا.`, ` You can retry in about ${Math.ceil(wait / 60)} minute(s).`) : '';
      panel.innerHTML = `<div class="hb-error" role="alert"><strong>${esc(T('تعذّر إنشاء الملخص', 'The summary could not be created'))}</strong><p>${esc(Api.message(error) + extra)}</p><p>${esc(T('لم يُعرض أي محتوى غير موثّق.', 'No unverified content is shown.'))}</p><button class="hb-btn" data-summary type="button">${esc(T('إعادة المحاولة', 'Try again'))}</button></div>`;
    }
  }
  $('hbSummaryPanel').addEventListener('click', (e) => { const b = e.target.closest('[data-summary]'); if (b) createSummary(b.dataset.summary === 'regenerate'); });

  // ----- B. Extract tasks: review, select, add -----
  let owners_ = []; // the leader and the active members (S.assignees), loaded with the project
  const members = () => owners_;
  function renderTasks(errorText) {
    const panel = $('hbTasksPanel');
    if (errorText) {
      panel.innerHTML = `<div class="hb-error" role="alert"><strong>${esc(T('تعذّر استخراج المهام', 'Tasks could not be extracted'))}</strong><p>${esc(errorText)}</p><p>${esc(T('لم تُضف أي مهام.', 'No task was added.'))}</p><button class="hb-btn" data-extract type="button">${esc(T('إعادة المحاولة', 'Try again'))}</button></div>`;
      return;
    }
    if (!suggestions || suggestions.projectId !== projectId) {
      panel.innerHTML = `<div class="hb-start"><p>${esc(T('تُستخرج من الدليل المعتمد مهام مقترحة، ثم يراجعها الفريق ويحدد ما يُضاف منها إلى مهام المشروع.', 'Suggested tasks are extracted from the selected handbook; the team reviews them and selects which ones to add to the project tasks.'))}</p><button class="hb-btn" data-extract type="button">${esc(T('استخراج المهام', 'Extract tasks'))}</button></div>`;
      return;
    }
    const dropped = suggestions.dropped || {};
    const droppedNote = dropped.unverified || dropped.duplicates ? `<p class="hb-note">${esc(T(`استُبعدت ${dropped.unverified || 0} مقترحات لم يُعثر على نصها في الدليل، و${dropped.duplicates || 0} مكررة مع مهام موجودة.`, `${dropped.unverified || 0} suggestions not found in the handbook text and ${dropped.duplicates || 0} duplicates of existing tasks were left out.`))}</p>` : '';
    if (!suggestions.list.length) { panel.innerHTML = `<div class="hb-start"><p>${esc(T('لم يتضمن الدليل مهامًا جديدة يمكن اقتراحها.', 'The handbook contains no new tasks to suggest.'))}</p>${droppedNote}<button class="hb-btn hb-btn--ghost" data-extract type="button">${esc(T('استخراج المهام مجددًا', 'Extract again'))}</button></div>`; return; }
    const canApply = isLeader() && suggestions.canApply !== false;
    const owners = `<option value="">${esc(T('غير مُسنَدة', 'Unassigned'))}</option>` + members().map((m) => `<option value="${esc(m.userId)}">${esc(m.label)}</option>`).join('');
    panel.innerHTML = `
      <div class="hb-tasks__bar">
        <label class="handbook-check"><input id="hbSelectAll" type="checkbox"/><span>${esc(T('تحديد الكل', 'Select all'))}</span></label>
        <span class="hb-tasks__end"><button class="hb-btn hb-btn--ghost" data-extract type="button">${esc(T('استخراج المهام مجددًا', 'Extract again'))}</button>
        <button class="tasks-add" disabled id="hbAddSelected" type="button">${esc(T('إضافة المحدد إلى المهام', 'Add selected to tasks'))}</button></span>
      </div>
      ${canApply ? '' : `<p class="hb-note">${esc(T('يضيف قائد الفريق المهام المقترحة إلى المشروع.', 'The Team Leader adds suggested tasks to the project.'))}</p>`}
      ${droppedNote}
      <ul class="hb-suggestions">${suggestions.list.map((s) => {
        const done = suggestions.applied.has(s.id);
        return `<li class="handbook-item${done ? ' is-added' : ''}">
          <label class="handbook-check"><input data-sugg="${esc(s.id)}" type="checkbox"${done || !canApply ? ' disabled' : ''}${done ? ' checked' : ''} aria-label="${esc(T('تحديد', 'Select'))}: ${esc(s.title)}"/></label>
          <div class="handbook-item__text"><strong dir="auto">${esc(s.title)}</strong><small dir="auto">${esc(s.description || '')}</small>${s.quote ? `<small class="hb-quote" dir="auto">«${esc(s.quote)}»</small>` : ''}</div>
          <div class="handbook-item__meta">${pageChips(s.pages)}${canApply && !done ? `<select class="hb-owner" data-owner="${esc(s.id)}" aria-label="${esc(T('المسؤول', 'Owner'))}">${owners}</select>` : ''}</div>
          ${done ? `<a class="handbook-item__done" href="tasks.html?project=${encodeURIComponent(projectId)}">${esc(T('مضافة إلى المهام', 'In tasks'))}</a>` : ''}
        </li>`;
      }).join('')}</ul>
      <p aria-live="polite" class="handbook-status" id="hbTaskStatus"></p>`;
    updateSelection();
  }
  function updateSelection() {
    const boxes = [...document.querySelectorAll('#hbTasksPanel input[data-sugg]:not(:disabled)')];
    const checked = boxes.filter((b) => b.checked); const btn = $('hbAddSelected'); const all = $('hbSelectAll');
    if (!btn) return;
    btn.disabled = checked.length === 0 || !isLeader();
    btn.textContent = checked.length ? T(`إضافة المحدد إلى المهام (${checked.length})`, `Add selected to tasks (${checked.length})`) : T('إضافة المحدد إلى المهام', 'Add selected to tasks');
    all.disabled = boxes.length === 0 || !isLeader(); all.checked = boxes.length > 0 && checked.length === boxes.length; all.indeterminate = checked.length > 0 && checked.length < boxes.length;
  }
  async function extractTasks() {
    const panel = $('hbTasksPanel'); panel.innerHTML = '';
    try {
      const r = await Api.post(`/projects/${projectId}/handbook/task-suggestions`, { language: lang }, { timeout: Api.aiTimeout, loader: { target: panel, label: T('جارٍ استخراج المهام من الدليل…', 'Extracting tasks from the handbook…') } });
      suggestions = { projectId, aiRequestId: r.aiRequestId, list: r.suggestions || [], canApply: r.canApply, dropped: r.dropped, applied: new Set() };
      renderTasks();
    } catch (error) {
      const wait = Number(error?.details?.retryAfterSeconds || 0);
      const extra = wait > 0 ? T(` يمكن إعادة المحاولة بعد ${Math.ceil(wait / 60)} دقيقة تقريبًا.`, ` You can retry in about ${Math.ceil(wait / 60)} minute(s).`) : '';
      renderTasks(Api.message(error) + extra);
    }
  }
  async function addSelected(btn) {
    if (!isLeader()) return;
    const ids = [...document.querySelectorAll('#hbTasksPanel input[data-sugg]:checked:not(:disabled)')].map((b) => b.dataset.sugg);
    if (!ids.length) return;
    const items = ids.map((id) => { const o = document.querySelector(`[data-owner="${CSS.escape(id)}"]`); return o && o.value ? { suggestionId: id, assignedStudentId: o.value } : { suggestionId: id }; });
    await UI.busy(btn, async () => {
      const r = await Api.post(`/projects/${projectId}/ai-task-suggestions/apply`, { aiRequestId: suggestions.aiRequestId, items }, { loader: { label: T('جارٍ إضافة المهام…', 'Adding the tasks…') } });
      const created = r.created || [];
      // created now, applied earlier, or skipped because the task already exists: none can be added again
      ids.forEach((id) => suggestions.applied.add(id));
      (r.alreadyApplied || []).forEach((a) => suggestions.applied.add(a.suggestionId));
      renderTasks();
      const count = created.length; const skipped = (r.skipped || []).length;
      $('hbTaskStatus').innerHTML = `${esc(T(count === 1 ? 'أُضيفت مهمة واحدة إلى المهام.' : count === 2 ? 'أُضيفت مهمتان إلى المهام.' : `أُضيفت ${count} مهام إلى المهام.`, count === 1 ? '1 task was added.' : `${count} tasks were added.`))}${skipped ? ` ${esc(T(`تُجوهلت ${skipped} لوجود مهمة بالعنوان نفسه.`, `${skipped} skipped because a task with the same title exists.`))}` : ''} <a href="tasks.html?project=${encodeURIComponent(projectId)}">${esc(T('عرض المهام', 'View tasks'))}</a>`;
    });
  }
  $('hbTasksPanel').addEventListener('click', (e) => {
    if (e.target.closest('[data-extract]')) extractTasks();
    const add = e.target.closest('#hbAddSelected'); if (add) addSelected(add);
  });
  $('hbTasksPanel').addEventListener('change', (e) => {
    if (e.target.id === 'hbSelectAll') document.querySelectorAll('#hbTasksPanel input[data-sugg]:not(:disabled)').forEach((b) => { b.checked = e.target.checked; });
    updateSelection();
  });

  // ---------- project ----------
  function afterChange() { renderSelected(); renderUniversity(); suggestions = suggestions && suggestions.projectId === projectId ? suggestions : null; renderAi(); }
  // The handbook shown always belongs to the project chosen in the selector: answers of a
  // project the user has already left are ignored (fast switching), and the university list
  // shows the new project's own choice (or nothing) instead of the previous project's.
  let loadSeq = 0;
  async function loadProject(id) {
    const seq = ++loadSeq;
    projectId = id; S.setCurrentProject(id); suggestions = null; w = null; state = null; owners_ = [];
    const url = new URL(location.href); url.searchParams.set('project', id); history.replaceState(null, '', url);
    UI.state($('hbSelectedBody'), 'loading'); $('hbAi').hidden = true;
    try {
      const listed = projects.find((p) => p.id === id);
      const [ws, st, owners] = await Promise.all([Api.get(`/projects/${id}`), Api.get(`/projects/${id}/handbook`), S.assignees(listed)]);
      if (seq !== loadSeq) return;
      w = ws; state = st; w.name = w.project.name; owners_ = owners;
      if (state.state === 'PROCESSING') { waitForProcessing(); }
      const sel = selected(); uniSelect.value = sel && sel.kind === 'UNIVERSITY' ? sel.key : '';
      afterChange();
    } catch (e) { if (seq === loadSeq) UI.state($('hbSelectedBody'), 'error', { error: e, retry: () => loadProject(id) }); }
  }
  $('hbProject').addEventListener('change', (e) => loadProject(e.target.value));

  S.ready.then(async () => {
    try {
      [projects, universities] = await Promise.all([S.projects(), Api.get('/handbooks/universities')]);
      fillUniversities();
      if (!projects.length) {
        UI.state($('hbSelectedBody'), 'empty', { title: T('لا توجد مشاريع بعد', 'No projects yet'), text: T('يُعتمد دليل المشروع بعد إنشاء مشروع أو الانضمام إليه.', 'A handbook is set once you create or join a project.'), action: { href: 'projects.html?new=1', label: T('إنشاء مشروع', 'Create a project') } });
        $('hbProject').disabled = true; return;
      }
      $('hbProject').innerHTML = projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      const id = S.currentProjectId(projects); $('hbProject').value = id;
      loadProject(id);
    } catch (e) { UI.state($('hbSelectedBody'), 'error', { error: e, retry: () => location.reload() }); }
  });
})();
