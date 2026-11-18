// ===== Documents helpers shared by files.html and project-files.html =====
//   GET    /documents?projectId=…      list (no projectId = every project of the user)
//   GET    /documents/:id              details with a short-lived signed URL (view / download)
//   GET    /documents/:id/versions     version history with signed URLs
//   POST   /documents/upload           multipart: file, projectId, title, category, description
//   POST   /documents/:id/versions     multipart: file (uploader or Team Leader)
//   DELETE /documents/:id              uploader or Team Leader (all versions)
//   GET    /users/me/storage           storage used by the student (10 GB quota)
// Files are kept in a PRIVATE bucket: links are signed by the server and expire after about an hour.
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const D = window.TammhaDomain;
  const { T, L, esc } = UI;
  const ext = (name) => (String(name || '').split('.').pop() || '').toLowerCase();
  const ICONS = { pdf: 'file-pdf', xlsx: 'file-excel', xls: 'file-excel', csv: 'file-excel', ppt: 'file-powerpoint', pptx: 'file-powerpoint', one: 'file-onenote' };
  const TYPES = { pdf: 'PDF', xlsx: 'Excel', xls: 'Excel', csv: 'Excel', ppt: 'PowerPoint', pptx: 'PowerPoint', one: 'OneNote', txt: 'TXT', doc: 'Word', docx: 'Word', zip: 'ZIP', png: 'PNG', jpg: 'JPG', jpeg: 'JPG' };
  const icon = (name) => `assets/${ICONS[ext(name)] || 'file-txt'}.png`;
  const type = (name) => TYPES[ext(name)] || (ext(name) ? ext(name).toUpperCase() : T('ملف', 'File'));
  const CATEGORIES = {
    GENERAL: ['عام', 'General'], PROPOSAL: ['مقترح المشروع', 'Proposal'], REPORT: ['تقرير', 'Report'], PRESENTATION: ['عرض تقديمي', 'Presentation'],
    DESIGN: ['تصميم', 'Design'], CODE: ['شيفرة برمجية', 'Code'], DOCUMENTATION: ['توثيق', 'Documentation'], MEETING_NOTES: ['محضر اجتماع', 'Meeting notes'], OTHER: ['أخرى', 'Other']
  };
  // review status as plain text after the file name (no coloured box); a regular file (UPLOADED)
  // has no review status to show. One colour of text per group: waiting, needs work, approved.
  const REVIEW_TONE = { SUBMITTED: 'waiting', UNDER_REVIEW: 'waiting', CHANGES_REQUESTED: 'action', REJECTED: 'action', APPROVED: 'done' };
  const reviewChip = (s) => { if (!s || s === 'UPLOADED') return ''; const r = D.DOCUMENT_STATUSES && D.DOCUMENT_STATUSES[s]; return r ? `<span class="doc-review doc-review--${REVIEW_TONE[s] || 'waiting'}">${esc(L(r.label))}</span>` : ''; };

  async function openDocument(id, download) {
    const d = await Api.get(`/documents/${encodeURIComponent(id)}`, { loader: { label: T('جارٍ تجهيز الملف…', 'Preparing the file…') } });
    const url = download ? d.downloadUrl || d.signedUrl : d.signedUrl;
    if (!url) throw new Api.ApiError({ code: 'STORAGE_ERROR' });
    window.open(url, '_blank', 'noopener');
  }

  function modal(title, inner) {
    const m = document.createElement('div');
    m.className = 'app-modal';
    m.innerHTML = `<div class="app-modal__dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${inner}<div class="app-modal__actions"><button class="app-btn" type="button" data-close>${esc(T('إغلاق', 'Close'))}</button></div></div>`;
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.remove(); });
    document.body.append(m);
    return m;
  }

  /** version history + upload of a new version (canEdit = uploader or Team Leader) */
  async function versions(doc, canEdit, onChange) {
    const m = modal(T(`إصدارات "${doc.title}"`, `Versions of "${doc.title}"`), `<ul class="app-list" data-list><li>${esc(T('جارٍ التحميل…', 'Loading…'))}</li></ul>
      ${canEdit ? `<form class="app-inline-form" data-new-version style="margin-top:12px"><input type="file" required aria-label="${esc(T('ملف الإصدار الجديد', 'New version file'))}"/><button class="app-btn app-btn--primary" type="submit">${esc(T('رفع إصدار جديد', 'Upload a new version'))}</button></form>` : ''}<p class="app-muted" data-msg></p>`);
    const list = m.querySelector('[data-list]');
    async function load() {
      try {
        const items = await Api.get(`/documents/${doc.id}/versions`);
        list.innerHTML = (items || []).map((v) => `<li><span><strong>v${esc(v.version)}</strong> · ${esc(v.fileName)} · ${esc(UI.fmtDateTime(v.createdAt))}${v.uploadedBy ? ` · ${esc(UI.personName(v.uploadedBy))}` : ''}</span><a class="app-btn app-btn--ghost" href="${esc(v.downloadUrl || v.signedUrl)}" target="_blank" rel="noopener">${esc(T('تنزيل', 'Download'))}</a></li>`).join('') || `<li>${esc(T('لا توجد إصدارات.', 'No versions.'))}</li>`;
      } catch (e) { list.innerHTML = `<li>${esc(Api.message(e))}</li>`; }
    }
    load();
    m.querySelector('[data-new-version]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target.querySelector('input').files[0]; if (!f) return;
      const fd = new FormData(); fd.append('file', f);
      UI.busy(e.target.querySelector('button'), async () => {
        await Api.upload('POST', `/documents/${doc.id}/versions`, fd, { loader: { label: T('جارٍ رفع الإصدار…', 'Uploading the version…'), target: m.querySelector('[data-msg]') } });
        e.target.reset(); UI.toast(T('رُفع الإصدار الجديد.', 'New version uploaded.'), 'success'); load(); if (onChange) onChange();
      });
    });
  }

  async function storageBar(host) {
    if (!host) return;
    try {
      const s = await Api.get('/users/me/storage');
      if (!s.quotaApplies) { host.hidden = true; return; }
      const pct = Math.min(100, Math.round(s.percentageUsed ?? (s.usedBytes / s.quotaBytes) * 100));
      host.hidden = false;
      host.innerHTML = `<div class="app-storage"><span>${esc(T('المساحة المستخدمة', 'Storage used'))}: <strong dir="ltr">${esc(UI.fmtSize(s.usedBytes))}</strong> ${esc(T('من', 'of'))} <span dir="ltr">${esc(UI.fmtSize(s.quotaBytes))}</span></span>
        <div class="app-storage__track${s.status === 'CRITICAL' || s.status === 'EXCEEDED' ? ' is-critical' : s.status === 'WARNING' ? ' is-warning' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(T(`المساحة المستخدمة ${pct} بالمئة`, `Storage used ${pct} percent`))}"><span style="width:${Math.max(pct, s.usedBytes ? 1 : 0)}%"></span></div></div>`;
    } catch (e) { host.hidden = true; }
  }

  window.TammhaDocs = Object.freeze({ ext, icon, type, CATEGORIES, reviewChip, openDocument, versions, storageBar, modal });
})();
