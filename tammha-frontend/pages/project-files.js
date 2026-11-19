// ===== Project files (project-files.html) — connected to the API =====
// Summary: GET /projects/:id. Files: GET /documents?projectId=…. Upload: POST /documents/upload.
// Row menu: view / download (signed URLs), versions (+ new version), delete (uploader or Team Leader).
// Files are shown in a table like the global Files page (no storage bar). Review status chips come from the supervisor's decisions.
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession; const Docs = window.TammhaDocs;
  const { T, L, esc } = UI;
  const $ = (id) => document.getElementById(id);
  const body = $('projectFilesBody');
  let w = null; let docs = [];
  const ICON_MORE = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="12" cy="18.5" r="1.6"></circle></svg>';
  const canEdit = (d) => !!w.viewer?.isLeader || d.uploadedBy?.id === S.user.id;

  function summary() {
    const p = w.project; const sup = ((w.supervisors || [])[0] || {}).user || (w.supervisors || [])[0]; /* { userId, user } from the API */
    $('filesProjectName').textContent = p.name;
    document.querySelector('.project-summary').innerHTML = `<div class="summary-item"><span>${esc(T('تاريخ البدء', 'Start date'))}</span><strong>${esc(UI.fmtDate(p.startDate))}</strong></div>
      <div class="summary-item"><span>${esc(T('أعضاء الفريق', 'Team members'))}</span><strong>${esc(String((w.team?.members || []).length))}</strong></div>
      <div class="summary-item"><span>${esc(T('المشرف الأكاديمي', 'Academic supervisor'))}</span><strong>${esc(sup ? UI.personName(sup) : T('لم يُحدد بعد', 'Not assigned yet'))}</strong></div>`;
    // the completion is shown once, in the title bar
    S.projectHeroProgress(w);
  }
  function row(d) {
    const name = d.fileName || d.title;
    return `<div class="project-files-row" data-doc="${esc(d.id)}" data-file-name="${esc(`${d.title} ${name}`.toLowerCase())}" role="row">
      <div class="file-name-cell" role="cell"><img alt="${esc(Docs.type(name))}" src="${Docs.icon(name)}"/><div><button class="pfile-row__open" type="button" data-doc-action="view"><strong title="${esc(name)}">${esc(d.title)}</strong></button><small>${esc(name)} · v${esc(d.currentVersion || 1)} ${Docs.reviewChip(d.reviewStatus)}</small></div></div>
      <span role="cell">${esc(UI.personName(d.uploadedBy))}</span>
      <span class="file-type" role="cell">${esc(Docs.type(name))}</span>
      <span role="cell">${esc(UI.fmtDate(d.createdAt))}</span>
      <span dir="ltr" role="cell">${esc(UI.fmtSize(d.fileSize))}</span>
      <div role="cell"><div class="file-actions"><button aria-expanded="false" aria-haspopup="menu" aria-label="${esc(T('خيارات الملف', 'File options'))}" class="file-more" data-file-menu="d${esc(d.id)}" type="button">${ICON_MORE}</button>
        <div class="file-action-menu" data-file-menu-panel="d${esc(d.id)}" hidden role="menu">
          <button class="file-action-menu__item" data-doc-action="view" role="menuitem" type="button">${esc(T('عرض الملف', 'View file'))}</button>
          <button class="file-action-menu__item" data-doc-action="download" role="menuitem" type="button">${esc(T('تنزيل الملف', 'Download file'))}</button>
          ${canEdit(d) && d.reviewStatus === 'UPLOADED' && (w.supervisors || []).length ? `<button class="file-action-menu__item" data-doc-action="review" role="menuitem" type="button">${esc(T('إرسال للمراجعة', 'Send for review'))}</button>` : ''}
          ${canEdit(d) ? `<button class="file-action-menu__item" data-doc-action="delete" role="menuitem" type="button">${esc(T('حذف الملف', 'Delete file'))}</button>` : ''}
        </div></div></div>
    </div>`;
  }
  async function load() {
    UI.state(body, 'loading'); $('projectFilesEmpty').hidden = true;
    try {
      const list = await Api.get('/documents', { query: { projectId: w.id } });
      docs = Array.isArray(list) ? list : list.items || [];
      body.innerHTML = docs.map(row).join('');
      if (!docs.length) UI.state(body, 'empty', { title: T('لا توجد ملفات بعد', 'No files yet'), text: T('ارفع ملفات المشروع من زر "إضافة ملف".', 'Upload project files with "Add file".') });
      filter();
    } catch (e) { UI.state(body, 'error', { error: e, retry: load }); }
  }
  function filter() {
    const q = ($('projectFilesSearch')?.value || '').trim().toLowerCase(); let v = 0;
    body.querySelectorAll('.project-files-row').forEach((r) => { const ok = !q || r.dataset.fileName.includes(q) || r.textContent.toLowerCase().includes(q); r.hidden = !ok; if (ok) v += 1; });
    $('projectFilesEmpty').hidden = !(docs.length && v === 0);
  }
  $('projectFilesSearch')?.addEventListener('input', filter);

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-doc-action]'); if (!b) return;
    const d = docs.find((x) => x.id === b.closest('[data-doc]').dataset.doc); if (!d) return;
    const a = b.dataset.docAction;
    if (a === 'view' || a === 'download') Docs.openDocument(d.id, a === 'download').catch((err) => UI.toast(Api.message(err), 'error'));
    if (a === 'review') UI.busy(b, async () => { await Api.post(`/documents/${encodeURIComponent(d.id)}/submit-for-review`, {}); UI.toast(T('أُرسل الملف إلى المشرف للمراجعة.', 'The file was sent to the supervisor for review.'), 'success'); load(); });
    if (a === 'delete' && window.confirm(T(`حذف "${d.title}" وجميع إصداراته؟`, `Delete "${d.title}" and all its versions?`))) {
      UI.busy(b, async () => { await Api.del(`/documents/${d.id}`); UI.toast(T('حُذف الملف.', 'File deleted.'), 'success'); load(); });
    }
  });

  // ----- upload -----
  const addModal = $('addFileModal'); const input = $('newFileInput'); const chosen = $('newFileChosen');
  const open = () => { addModal.hidden = false; $('addFileError').textContent = ''; };
  const close = () => { addModal.hidden = true; $('addFileForm').reset(); chosen.textContent = T('PDF أو Office أو TXT أو ملف آخر', 'PDF, Office, TXT or another file'); };
  $('openAddFileModal').addEventListener('click', open);
  $('closeAddFileModal').addEventListener('click', close); $('cancelAddFileModal').addEventListener('click', close);
  addModal.addEventListener('click', (e) => { if (e.target === addModal) close(); });
  input.addEventListener('change', () => { const f = input.files?.[0]; chosen.textContent = f ? `${f.name} · ${UI.fmtSize(f.size)}` : ''; if (f && !$('newFileName').value.trim()) $('newFileName').value = f.name.replace(/\.[^.]+$/, ''); });
  $('newFileCategory').innerHTML = Object.entries(Docs.CATEGORIES).map(([k, l]) => `<option value="${k}">${esc(L(l))}</option>`).join('');
  $('addFileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const file = input.files?.[0]; const title = $('newFileName').value.trim();
    if (!title || title.length < 2) { $('addFileError').textContent = T('اكتب اسم الملف.', 'Enter the file name.'); return; }
    if (!file) { $('addFileError').textContent = T('اختر الملف.', 'Choose the file.'); return; }
    if (file.size === 0) { $('addFileError').textContent = T('الملف فارغ.', 'The file is empty.'); return; }
    if (file.size > 25 * 1024 * 1024) { $('addFileError').textContent = T('حجم الملف يتجاوز 25MB.', 'The file is larger than 25 MB.'); return; }
    const fd = new FormData(); fd.append('file', file); fd.append('projectId', w.id); fd.append('title', title); fd.append('category', $('newFileCategory').value);
    // regular files are available at once; a review is requested only when the box is ticked
    const review = !$('newFileReviewWrap').hidden && $('newFileReview').checked;
    if (review) fd.append('submitForReview', 'true');
    UI.busy(e.target.querySelector('[type="submit"]'), async () => {
      try {
        await Api.upload('POST', '/documents/upload', fd, { loader: { label: T('جارٍ رفع الملف…', 'Uploading the file…') } });
        close(); UI.toast(review ? T('رُفع الملف وأُرسل إلى المشرف للمراجعة.', 'File uploaded and sent to the supervisor for review.') : T('رُفع الملف.', 'File uploaded.'), 'success'); load();
      } catch (err) { $('addFileError').textContent = Api.message(err); }
    });
  });

  S.ready.then(async () => {
    try {
      w = await S.currentWorkspace();
      if (!w) { UI.state(body, 'empty', { title: T('لا توجد مشاريع بعد', 'No projects yet'), action: { href: 'projects.html?new=1', label: T('إنشاء مشروع', 'Create a project') } }); $('openAddFileModal').hidden = true; return; }
      // the review option is offered only when the project has a supervisor
      $('newFileReviewWrap').hidden = !(w.supervisors || []).length;
      summary(); load();
    } catch (e) { UI.state(body, 'error', { error: e, retry: () => location.reload() }); }
  });
})();
