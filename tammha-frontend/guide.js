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
//      "إنشاء مهام المشروع" — POST /projects/:id/handbook/task-suggestions, then the Team Leader adds only the
//      ticked ones with POST /projects/:id/ai-task-suggestions/apply (idempotent; duplicates skipped).
// Layout (QA 32): until a handbook is chosen the two options are shown; once chosen, one bar shows the
// file with "View file" and "Change file", and under it two cards (summary / extract tasks). Choosing an
// edition selects it at once. "Change file" shows the two options again (Cancel goes back). Tasks are
// extracted only when the project has stages; each suggested task is added to a chosen stage.
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
  let changing = false; // "Change file" was pressed: the two options are shown again
  let aiOpen = false; // a summary or the extracted tasks are shown in place of the two cards
  let stages_ = []; // the project's stages, in order (tasks are added to one of them)
  // every student of the team selects or uploads the handbook and applies suggested tasks
  const isLeader = () => !!(w?.viewer?.canManage ?? w?.viewer?.isLeader);
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
    if (a) return { kind: 'UPLOAD', fileName: a.fileName || a.title, pageCount: a.pageCount, fileSize: a.fileSize, status: a.status || state.state, ready: state.state === 'READY', failed: state.state === 'FAILED', error: a.errorCode || a.failureReason };
    return null;
  }

  // ---------- Selected handbook ----------
  function renderSelected() {
    const sel = selected(); const body = $('hbSelectedBody');
    if (!sel) {
      // no white notice box at the top: the two options below say what to do
      body.innerHTML = ''; $('hbSelected').classList.add('is-empty');
      return;
    }
    const statusText = sel.kind === 'UPLOAD' && !sel.ready ? (sel.failed ? T('تعذّرت قراءة نص الدليل. ارفع ملف PDF يحتوي على نص قابل للتحديد.', 'The handbook text could not be read. Upload a PDF with selectable text.') : T('جارٍ استخراج نص الدليل…', 'Extracting the handbook text…')) : '';
    // the selected handbook is not shown as a card (QA review 2): the options below show the
    // choice; only a problem with an uploaded handbook is reported here
    body.innerHTML = statusText ? `<p class="${sel.failed ? 'hb-file__error' : 'hb-file__note'}">${esc(statusText)}</p>` : '';
    $('hbSelected').classList.toggle('is-empty', !body.innerHTML);
  }
  async function viewSelected() {
    const sel = selected(); if (!sel) return;
    try {
      const r = sel.kind === 'UNIVERSITY' ? await Api.get(`/handbooks/universities/${encodeURIComponent(sel.key)}/file`) : await Api.get(`/projects/${projectId}/handbook/file`);
      window.open(r.url || r.signedUrl, '_blank', 'noopener');
    } catch (err) { UI.toast(Api.message(err), 'error'); }
  }
  // ---------- the bar with the project's handbook, and which parts of the page are shown ----------
  function barMeta(sel) {
    if (sel.kind === 'UNIVERSITY') {
      const uni = universities.find((u) => u.key === sel.key); const h = uni && uni.handbook;
      return h ? editionName(h) : T('الإصدار الحالي', 'Current edition');
    }
    if (!sel.ready && !sel.failed) return T('جارٍ استخراج نص الدليل…', 'Extracting the handbook text…');
    return T('دليل مرفوع للمشروع', 'Uploaded handbook');
  }
  function shownFileName(sel) {
    if (sel.kind === 'UNIVERSITY') {
      const uni = universities.find((u) => u.key === sel.key);
      if (uni && uni.name && uni.name.en) return `${uni.name.en}.pdf`;
    }
    return sel.fileName || sel.title || '';
  }
  const EYE = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const SWAP = '<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M12 11v6"/><path d="M9.5 13.5 12 11l2.5 2.5"/></svg>';
  function renderView() {
    const sel = selected(); const has = !!(sel && !sel.failed);
    const choosing = !has || changing;
    const bar = $('hbBar'); bar.hidden = !has;
    if (has) {
      bar.innerHTML = `<img alt="" class="hbv-bar__img" src="assets/file-pdf.png"/>
        <div class="hbv-bar__text"><span class="hbv-bar__label">${esc(changing ? T('الدليل الحالي (يُستبدل بعد اختيار دليل جديد)', 'Current handbook (replaced once you choose a new one)') : T('دليل المشروع', 'Project handbook'))}</span>
        <strong><bdi>${esc(shownFileName(sel))}</bdi></strong><small>${esc(barMeta(sel))}</small></div>
        <div class="hbv-bar__actions">${changing ? `<button class="hbv-btn" data-cancel-change type="button">${esc(T('إلغاء', 'Cancel'))}</button>`
          : `<button class="hbv-btn" data-view-selected type="button">${EYE}<span>${esc(T('عرض الملف', 'View file'))}</span></button>${isLeader() ? `<button class="hbv-btn" data-change-file type="button">${SWAP}<span>${esc(T('تغيير الملف', 'Change file'))}</span></button>` : ''}`}</div>`;
    }
    $('hbChooseHead').hidden = !(has && changing);
    document.querySelector('.hb-options').hidden = !choosing;
    $('hbActions').hidden = !(sel && sel.ready && !changing && !aiOpen);
    renderAi();
  }
  $('hbBar').addEventListener('click', (e) => {
    if (e.target.closest('[data-view-selected]')) viewSelected();
    if (e.target.closest('[data-change-file]')) { changing = true; uniSelect.value = ''; renderUniversity(); showChosen(null); showFileError(''); renderView(); }
    if (e.target.closest('[data-cancel-change]')) { changing = false; renderView(); }
  });
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
    uniSelect.innerHTML = `<option value="">${esc(T('اختر الجامعة', 'Select a university'))}</option>` + universities.map((u) => `<option value="${esc(u.key)}">${esc(uName(u))}</option>`).join('');
  }
  // under the university: its available editions ("Edition 2024" = the year the handbook was released)
  const editionField = $('hbEditionField'); const editionSelect = $('hbEdition');
  const editionName = (h) => (h.releaseYear ? T(`إصدار ${h.releaseYear}`, `${h.releaseYear} edition`) : T('الإصدار الحالي', 'Current edition'));
  // both lists are shown from the start as "Select ..."; the edition list opens once a university
  // with a handbook is chosen, and the handbook file appears after an edition is chosen
  function fillEditions(uni) {
    const h = uni && uni.handbook;
    editionField.hidden = false;
    editionSelect.disabled = !h;
    editionSelect.innerHTML = `<option value="">${esc(T('اختر الإصدار', 'Select an edition'))}</option>` + (h ? `<option value="${esc(h.versionId)}">${esc(editionName(h))}</option>` : '');
    const sel = selected();
    if (h && sel && sel.kind === 'UNIVERSITY' && sel.key === uni.key) editionSelect.value = h.versionId;
  }
  // choosing an edition makes it the project's handbook at once (Team Leader)
  async function useEdition() {
    const uni = universities.find((u) => u.key === uniSelect.value);
    if (!uni || !uni.handbook || !editionSelect.value) return;
    const sel = selected();
    if (sel && sel.kind === 'UNIVERSITY' && sel.key === uni.key && !changing) return;
    if (!isLeader()) { UI.toast(T('يعتمد دليل المشروع قائد الفريق.', 'The Team Leader sets the project handbook.'), 'error'); editionSelect.value = ''; return; }
    try {
      state = await Api.put(`/projects/${projectId}/handbook/university-selection`, { universityKey: uni.key }, { loader: { label: T('جارٍ اعتماد الدليل…', 'Setting the handbook…') } });
      changing = false; aiOpen = false; suggestions = null; afterChange();
      toast(T(`اعتُمد دليل ${uName(uni)} لمشروع ${w.name}.`, `${uName(uni)}'s handbook is now used for ${w.name}.`));
    } catch (err) { UI.toast(Api.message(err), 'error'); editionSelect.value = ''; }
  }
  function renderUniversity() {
    const box = $('hbUniversityFile'); const uni = universities.find((u) => u.key === uniSelect.value);
    fillEditions(uni);
    if (uni && !uni.handbook) {
      box.innerHTML = `<div class="hb-unavailable"><strong>${esc(T('الدليل غير متاح حاليًا', 'Handbook not available'))}</strong><p>${esc(T(`لم يُضف الدليل الرسمي لـ${uName(uni)} إلى المنصة بعد. يمكن رفعه من خيار "رفع دليل مخصص (PDF)".`, `The official handbook of ${uName(uni)} has not been added to the platform yet. You can upload it with "Upload a custom handbook (PDF)".`))}</p></div>`;
      return;
    }
    box.innerHTML = '';
  }
  editionSelect.addEventListener('change', useEdition);
  uniSelect.addEventListener('change', renderUniversity);
  // ---------- Option B: own PDF ----------
  const fileInput = $('hbFile'); const drop = $('hbDrop'); const fileError = $('hbFileError');
  const showFileError = (text) => { fileError.textContent = text; fileError.hidden = !text; };
  const readSignature = (file) => new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String.fromCharCode(...new Uint8Array(reader.result))); reader.onerror = () => resolve(''); reader.readAsArrayBuffer(file.slice(0, 5)); });
  // the chosen PDF is named under the drop area, with what happens to it
  const chosen = $('hbChosen');
  function showChosen(file, note) {
    if (!file) { chosen.hidden = true; chosen.textContent = ''; return; }
    chosen.hidden = false;
    chosen.innerHTML = `<img alt="" src="assets/file-pdf.png"/><span><strong dir="auto">${esc(file.name)}</strong><small>${esc(UI.fmtSize(file.size))}${note ? ` · ${esc(note)}` : ''}</small></span>`;
  }
  async function takeFile(file) {
    showFileError('');
    showChosen(file, file ? T('الملف المختار', 'Chosen file') : '');
    if (!file) { showFileError(T('اختر ملف الدليل أولًا.', 'Choose the handbook file first.')); return; }
    if (!isLeader()) { showFileError(T('يرفع دليل المشروع قائد الفريق.', 'The Team Leader uploads the project handbook.')); return; }
    if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) { showFileError(T('صيغة الملف غير مدعومة، ويُقبل ملف PDF فقط.', 'Unsupported file type. Only PDF files are accepted.')); return; }
    if (file.size === 0) { showFileError(T('الملف فارغ.', 'The file is empty.')); return; }
    if (file.size > MAX_FILE_BYTES) { showFileError(T('حجم الملف يتجاوز 20MB.', 'The file is larger than 20 MB.')); return; }
    if ((await readSignature(file)) !== '%PDF-') { showFileError(T('تعذّرت قراءة الملف بوصفه PDF. صدّر الدليل مجددًا بصيغة PDF قياسية.', 'The file could not be read as a PDF. Export the handbook again as a standard PDF.')); return; }
    const fd = new FormData(); fd.append('file', file);
    showChosen(file, T('جارٍ الرفع والمعالجة…', 'Uploading and processing…'));
    try {
      await Api.upload('PUT', `/projects/${projectId}/handbook`, fd, { loader: { label: T('جارٍ رفع الدليل ومعالجته…', 'Uploading and processing the handbook…') } });
      // a university selection is replaced by the own upload
      try { await Api.del(`/projects/${projectId}/handbook/university-selection`); } catch (e) { /* not selected */ }
      changing = false; aiOpen = false; suggestions = null;
      await waitForProcessing();
      const sel = selected();
      if (sel && sel.failed) { showChosen(file, T('تعذّرت قراءة النص', 'Text could not be read')); showFileError(T('تعذّرت قراءة نص الدليل. ارفع ملف PDF يحتوي على نص قابل للتحديد.', 'The handbook text could not be read. Upload a PDF with selectable text.')); }
      else { showChosen(file, T('رُفع واعتُمد دليلًا للمشروع', 'Uploaded and set as the project handbook')); toast(T(`رُفع "${file.name}" واعتُمد دليلًا للمشروع.`, `"${file.name}" was uploaded and set as the project handbook.`)); }
    } catch (error) { showChosen(file, T('لم يُرفع', 'Not uploaded')); showFileError(Api.message(error)); }
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
  // tasks are added to the project's stages: without stages the extraction does not start
  async function hasStages() {
    try {
      const r = await Api.get('/milestones', { query: { projectId, limit: 100 }, loader: false });
      stages_ = (r.items || r || []).slice().sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.dueDate).localeCompare(String(b.dueDate)));
    } catch (e) { /* keep the last list */ }
    if (stages_.length) return true;
    UI.toast(T('أضف مراحل المشروع أولًا، ثم أنشئ المهام.', 'Add the project stages first, then create the tasks.'), 'error');
    return false;
  }
  const currentStage = () => (stages_.find((m) => m.status !== 'COMPLETED' && m.status !== 'CANCELLED') || stages_[0] || {}).id || '';
  async function openAi(which) {
    if (which === 'tasks' && !(await hasStages())) return;
    // the tasks open on their start box (choose the project, then create); the summary is created at once
    tab = which; aiOpen = true; autoCreate = which === 'summary'; renderView();
  }
  $('hbActions').addEventListener('click', (e) => { const b = e.target.closest('[data-open-ai]'); if (b) openAi(b.dataset.openAi); });
  document.querySelectorAll('[data-hb-tab]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.hbTab === tab) return;
    if (b.dataset.hbTab === 'tasks' && !(await hasStages())) return;
    tab = b.dataset.hbTab; renderAi();
  }));
  function renderAi() {
    const sel = selected();
    $('hbAi').hidden = !(sel && sel.ready && aiOpen && !changing);
    if ($('hbAi').hidden) return;
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
          ${t.points.length ? `<ul>${t.points.map((pt) => `<li><span dir="auto">${esc(pt.text)}</span>${pt.pages && pt.pages.length ? `<span class="hb-refs">${pageChips(pt.pages)}</span>` : ''}${pt.verified === false ? `<em class="hb-unverified">${esc(T('صياغة مختصرة، راجع الدليل للتفاصيل.', 'Summarised wording; check the handbook for the details.'))}</em>` : ''}</li>`).join('')}</ul>` : ''}
          ${t.id === 'GRADING' ? `<p class="hb-card__note">${esc(T('للاطلاع فقط؛ لا تحتسب تممها الدرجات ولا تقيّم الطلاب.', 'For reference only; Tammha does not calculate marks or evaluate students.'))}</p>` : ''}`
        : `<p class="hb-card__none">${esc(T('لا يوجد في الدليل نص واضح حول هذا القسم.', 'The handbook has no clear text on this section.'))}</p>`}
      </article>`).join('')}</div>`;
  }
  const panelHead = (title, text, end) => `<div class="hbv-panel-head"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>${end || ''}</div>`;
  const SUMMARY_HEAD = () => panelHead(T('ملخص الدليل', 'Handbook Summary'), T('أهم ما في الدليل في سبعة محاور، مع أرقام الصفحات.', 'The key points of the handbook in seven topics, with page numbers.'));
  const TASKS_HEAD = (end) => panelHead(T('إنشاء مهام المشروع', 'Create project tasks'), T('مهام لكل مرحلة من مراحل مشروعك، من الدليل المعتمد. راجعها قبل إضافتها.', 'Tasks for every stage of your project, from the selected handbook. Review them before adding them.'), end);
  // "Create project tasks": the project is chosen first (nothing chosen = a clear message)
  let taskPick = '';
  const projectPicker = () => `<div class="hb-pick"><label class="visually-hidden" for="hbTaskProject">${esc(T('المشروع', 'Project'))}</label>
      <select class="hb-pick__select" id="hbTaskProject"><option value="">${esc(T('اختر المشروع', 'Choose the project'))}</option>${projects.map((p) => `<option value="${esc(p.id)}"${p.id === taskPick ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <button class="hb-btn" data-extract type="button">${esc(T('إنشاء مهام المشروع', 'Create project tasks'))}</button></div>
      <p class="hb-pick__error" hidden id="hbTaskProjectError">${esc(T('يجب اختيار المشروع لإنشاء مهامه.', 'Choose the project to create its tasks.'))}</p>`;
  function summaryStart(text) { return SUMMARY_HEAD() + `<div class="hb-start"><p>${esc(text || T('يستخرج الملخص من الدليل المعتمد المعلومات المتعلقة بسبعة محاور ثابتة، مع الإشارة إلى أرقام الصفحات حيثما أمكن.', 'The summary extracts the information on seven fixed topics from the selected handbook, with page references where available.'))}</p><button class="hb-btn" data-summary type="button">${esc(T('إنشاء الملخص', 'Create summary'))}</button></div>`; }
  function showSummary(result) {
    const meta = result.coverage && result.coverage.truncated ? `<p class="hb-note">${esc(T(`شمل الملخص ${result.coverage.pagesIncluded} من ${result.coverage.pageCount} صفحة لطول الدليل.`, `The summary covered ${result.coverage.pagesIncluded} of ${result.coverage.pageCount} pages because the handbook is long.`))}</p>` : '';
    $('hbSummaryPanel').innerHTML = SUMMARY_HEAD() + summaryCards(result) + meta + `<p class="hb-disclaimer">${esc(T('الملخص مساعد ومبني على نص الدليل، ولا يغني عن الرجوع إلى الدليل في الصفحات المذكورة.', 'The summary is based on the handbook text and does not replace reading the cited pages of the handbook.'))}</p>
      <p class="hb-actions"><button class="hb-btn" data-summary="regenerate" type="button">${esc(T('إعادة إنشاء الملخص', 'Create the summary again'))}</button></p>`;
  }
  // "Create summary" on the card: the saved summary is shown, or a new one is created
  let autoCreate = false;
  async function loadSummary() {
    const auto = autoCreate; autoCreate = false;
    const panel = $('hbSummaryPanel'); UI.state(panel, 'loading');
    try {
      const r = await Api.get(`/projects/${projectId}/handbook/summary`, { query: { language: lang } });
      if (r.status === 'READY' && r.topics && r.topics.length) { showSummary(r); return; }
    } catch (e) { /* no saved summary */ }
    if (auto) createSummary(false); else panel.innerHTML = summaryStart();
  }
  async function createSummary(regenerate) {
    const panel = $('hbSummaryPanel'); panel.innerHTML = '';
    try {
      const result = await Api.post(`/projects/${projectId}/handbook/summary`, { language: lang, regenerate: !!regenerate }, { timeout: Math.max(Api.aiTimeout, 240000), loader: { target: panel, label: T('جارٍ إعداد ملخص الدليل…', 'Preparing the handbook summary…') } });
      showSummary(result);
    } catch (error) {
      // the summary may have been finished and saved after the connection gave up: show it
      try {
        const saved = await Api.get(`/projects/${projectId}/handbook/summary`, { query: { language: lang } });
        if (saved.status === 'READY' && saved.topics && saved.topics.length) { showSummary(saved); return; }
      } catch (e) { /* show the error below */ }
      panel.innerHTML = SUMMARY_HEAD() + `<div class="hb-error" role="alert"><strong>${esc(T('تعذّر إنشاء الملخص', 'The summary could not be created'))}</strong><p>${esc(Api.message(error))}</p><p>${esc(T('لم يُعرض أي محتوى غير موثّق.', 'No unverified content is shown.'))}</p><button class="hb-btn" data-summary type="button">${esc(T('إعادة المحاولة', 'Try again'))}</button></div>`;
    }
  }
  $('hbSummaryPanel').addEventListener('click', (e) => { const b = e.target.closest('[data-summary]'); if (b) createSummary(b.dataset.summary === 'regenerate'); });

  // ----- B. Extract tasks: review, select, add -----
  let owners_ = []; // the leader and the active members (S.assignees), loaded with the project
  const members = () => owners_;
  function renderTasks(errorText) {
    const panel = $('hbTasksPanel');
    if (errorText) {
      panel.innerHTML = TASKS_HEAD() + `<div class="hb-error" role="alert"><strong>${esc(T('تعذّر إنشاء المهام', 'The tasks could not be created'))}</strong><p>${esc(errorText)}</p><p>${esc(T('لم تُضف أي مهام.', 'No task was added.'))}</p><button class="hb-btn" data-extract type="button">${esc(T('إعادة المحاولة', 'Try again'))}</button></div>`;
      return;
    }
    if (!suggestions || suggestions.projectId !== projectId) {
      panel.innerHTML = TASKS_HEAD() + `<div class="hb-start"><p>${esc(T('اختر المشروع، وتُنشأ مهام مقترحة لكل مرحلة من مراحله من الأولى إلى الأخيرة، ثم يراجعها الفريق ويحدد ما يُضاف منها.', 'Choose the project: suggested tasks are created for each of its stages, from the first to the last, and the team reviews them and selects which ones to add.'))}</p>${projectPicker()}</div>`;
      return;
    }
    const dropped = suggestions.dropped || {};
    const droppedNote = dropped.duplicates ? `<p class="hb-note">${esc(T(`استُبعدت ${dropped.duplicates} مقترحات مكررة مع مهام موجودة.`, `${dropped.duplicates} suggestions that repeat existing tasks were left out.`))}</p>` : '';
    if (!suggestions.list.length) { panel.innerHTML = TASKS_HEAD() + `<div class="hb-start"><p>${esc(T('لم يتضمن الدليل مهامًا جديدة يمكن اقتراحها.', 'The handbook contains no new tasks to suggest.'))}</p>${droppedNote}<button class="hb-btn hb-btn--ghost" data-extract type="button">${esc(T('إنشاء المهام مجددًا', 'Create again'))}</button></div>`; return; }
    const canApply = isLeader() && suggestions.canApply !== false;
    const owners = `<option value="">${esc(T('غير مُسنَدة', 'Unassigned'))}</option>` + members().map((m) => `<option value="${esc(m.userId)}">${esc(m.label)}</option>`).join('');
    panel.innerHTML = TASKS_HEAD() + `
      <div class="hb-tasks__bar">
        <label class="handbook-check"><input id="hbSelectAll" type="checkbox"/><span>${esc(T('تحديد الكل', 'Select all'))}</span></label>
        <span class="hb-tasks__end"><button class="hb-btn hb-btn--ghost" data-extract type="button">${esc(T('إنشاء المهام مجددًا', 'Create again'))}</button>
        <button class="tasks-add" disabled id="hbAddSelected" type="button">${esc(T('إضافة المحدد إلى المهام', 'Add selected to tasks'))}</button></span>
      </div>
      ${canApply ? '' : `<p class="hb-note">${esc(T('يضيف قائد الفريق المهام المقترحة إلى المشروع.', 'The Team Leader adds suggested tasks to the project.'))}</p>`}
      ${droppedNote}
      ${groupByStage(suggestions.list).map((g) => `<section class="hb-stage-group"><h3 class="hb-stage-group__title" dir="auto">${esc(g.title)}</h3><ul class="hb-suggestions">${g.items.map((s) => {
        const done = suggestions.applied.has(s.id);
        return `<li class="handbook-item${done ? ' is-added' : ''}">
          <label class="handbook-check"><input data-sugg="${esc(s.id)}" type="checkbox"${done || !canApply ? ' disabled' : ''}${done ? ' checked' : ''} aria-label="${esc(T('تحديد', 'Select'))}: ${esc(s.title)}"/></label>
          <div class="handbook-item__text"><strong dir="auto">${esc(s.title)}</strong><small dir="auto">${esc(s.description || '')}</small>${s.quote ? `<small class="hb-quote" dir="auto">"${esc(s.quote)}"</small>` : ''}</div>
          <div class="handbook-item__meta">${pageChips(s.pages)}${canApply && !done ? `<select class="hb-owner" data-owner="${esc(s.id)}" aria-label="${esc(T('المسؤول', 'Owner'))}">${owners}</select>` : ''}</div>
        </li>`;
      }).join('')}</ul></section>`).join('')}
      <p aria-live="polite" class="handbook-status" id="hbTaskStatus"></p>`;
    updateSelection();
  }
  // the suggestions under their stage, from the first stage to the last (the server sends them in order)
  function groupByStage(list) {
    const groups = [];
    for (const s of list) {
      const key = s.milestoneId || '';
      let g = groups.find((x) => x.key === key);
      if (!g) { g = { key, title: s.milestoneTitle || (stages_.find((m) => m.id === key) || {}).title || T('مهام عامة', 'General tasks'), items: [] }; groups.push(g); }
      g.items.push(s);
    }
    return groups;
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
      const r = await Api.post(`/projects/${projectId}/handbook/task-suggestions`, { language: lang }, { timeout: Math.max(Api.aiTimeout, 300000), loader: { target: panel, label: T('جارٍ إنشاء مهام المشروع…', 'Creating the project tasks…') } });
      suggestions = { projectId, aiRequestId: r.aiRequestId, list: r.suggestions || [], canApply: r.canApply, dropped: r.dropped, applied: new Set() };
      renderTasks();
    } catch (error) { renderTasks(Api.message(error)); }
  }
  async function addSelected(btn) {
    if (!isLeader()) return;
    const ids = [...document.querySelectorAll('#hbTasksPanel input[data-sugg]:checked:not(:disabled)')].map((b) => b.dataset.sugg);
    if (!ids.length) return;
    // each task goes to the chosen stage and, when chosen, to its owner
    const items = ids.map((id) => {
      const o = document.querySelector(`[data-owner="${CSS.escape(id)}"]`);
      const sg = suggestions.list.find((x) => x.id === id) || {};
      const it = { suggestionId: id };
      if (o && o.value) it.assignedStudentId = o.value;
      // each task goes to its own stage (the current stage when the server gave none)
      const stage = sg.milestoneId && stages_.some((m) => m.id === sg.milestoneId) ? sg.milestoneId : currentStage();
      if (stage) it.milestoneId = stage;
      return it;
    });
    await UI.busy(btn, async () => {
      const r = await Api.post(`/projects/${projectId}/ai-task-suggestions/apply`, { aiRequestId: suggestions.aiRequestId, items }, { loader: { label: T('جارٍ إضافة المهام…', 'Adding the tasks…') } });
      const created = r.created || [];
      // created now, applied earlier, or skipped because the task already exists: none can be added again
      ids.forEach((id) => suggestions.applied.add(id));
      (r.alreadyApplied || []).forEach((a) => suggestions.applied.add(a.suggestionId));
      renderTasks();
      const count = created.length; const skipped = (r.skipped || []).length;
      // a green bar at the bottom for 5 seconds (no link beside each task)
      $('hbTaskStatus').textContent = '';
      if (count) addedBar(T('تمت إضافة المهام بنجاح.', 'The tasks were added successfully.'));
      else if (skipped) addedBar(T('المهام المحددة موجودة في المهام من قبل.', 'The selected tasks are already in the tasks.'));
    });
  }
  $('hbTasksPanel').addEventListener('click', (e) => {
    if (e.target.closest('[data-extract]')) createTasks();
    const add = e.target.closest('#hbAddSelected'); if (add) addSelected(add);
  });
  function addedBar(text) {
    let bar = document.querySelector('.hb-added-bar');
    if (!bar) { bar = document.createElement('div'); bar.className = 'hb-added-bar'; bar.setAttribute('role', 'status'); document.body.appendChild(bar); }
    bar.textContent = text; bar.classList.add('is-on');
    clearTimeout(addedBar.t); addedBar.t = setTimeout(() => bar.classList.remove('is-on'), 5000);
  }
  async function createTasks() {
    const pick = $('hbTaskProject');
    if (pick) {
      taskPick = pick.value;
      if (!taskPick) { pick.classList.add('is-invalid'); $('hbTaskProjectError').hidden = false; pick.focus(); return; }
      if (taskPick !== projectId) { $('hbProject').value = taskPick; await loadProject(taskPick); tab = 'tasks'; aiOpen = true; renderView(); }
    }
    if (await hasStages()) extractTasks();
  }
  $('hbTasksPanel').addEventListener('change', (e) => {
    if (e.target.id === 'hbTaskProject') { taskPick = e.target.value; e.target.classList.remove('is-invalid'); $('hbTaskProjectError').hidden = true; return; }
    if (e.target.id === 'hbSelectAll') document.querySelectorAll('#hbTasksPanel input[data-sugg]:not(:disabled)').forEach((b) => { b.checked = e.target.checked; });
    updateSelection();
  });

  // ---------- project ----------
  function afterChange() { renderSelected(); renderUniversity(); suggestions = suggestions && suggestions.projectId === projectId ? suggestions : null; renderView(); }
  // The handbook shown always belongs to the project chosen in the selector: answers of a
  // project the user has already left are ignored (fast switching), and the university list
  // shows the new project's own choice (or nothing) instead of the previous project's.
  let loadSeq = 0;
  async function loadProject(id) {
    const seq = ++loadSeq;
    projectId = id; S.setCurrentProject(id); suggestions = null; w = null; state = null; owners_ = []; changing = false; aiOpen = false; stages_ = [];
    const url = new URL(location.href); url.searchParams.set('project', id); history.replaceState(null, '', url);
    UI.state($('hbSelectedBody'), 'loading'); $('hbAi').hidden = true; $('hbBar').hidden = true; $('hbActions').hidden = true;
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
      fillUniversities(); fillEditions(null);
      if (!projects.length) {
        // no project yet: nothing to choose a handbook for, so the page says so (no handbook options)
        $('hbSelected').hidden = true; $('hbProject').disabled = true;
        document.querySelector('.hb-options').hidden = true;
        const box = document.createElement('section'); box.className = 'hb-no-project';
        document.querySelector('.projects-hero').after(box);
        UI.state(box, 'empty', { image: 'assets/empty-files.webp', title: T('لا توجد مشاريع حتى الآن', 'No projects yet'),
          text: T('أنشئ مشروعًا أو انضم إلى مشروع، ثم اختر دليله من هنا.', 'Create a project or join one, then choose its handbook here.') });
        return;
      }
      $('hbProject').innerHTML = projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      const id = S.currentProjectId(projects); $('hbProject').value = id;
      loadProject(id);
    } catch (e) { UI.state($('hbSelectedBody'), 'error', { error: e, retry: () => location.reload() }); }
  });
})();
