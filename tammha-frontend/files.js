// ===== Global Files page (files.html) — connected to the API =====
// Every document of every project the user belongs to (GET /documents, then the project names
// from GET /projects). Table rows use a three-dot menu (shared code in script.js); cards use two
// direct buttons. View / download open short-lived signed URLs (GET /documents/:id).
// Project Files (project-files.html) shows one project and is where files are uploaded.
(function () {
  'use strict';
  const tableBody = document.getElementById('allFilesTableBody');
  const cardsGrid = document.getElementById('allFilesCards');
  if (!tableBody || !cardsGrid) return;
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession; const Docs = window.TammhaDocs;
  const { T, esc } = UI;
  const ICON_VIEW = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"></path><circle cx="12" cy="12" r="2.8"></circle></svg>';
  const ICON_DOWNLOAD = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 4v11"></path><path d="m7.5 10.5 4.5 4.5 4.5-4.5"></path><path d="M5 19h14"></path></svg>';
  const ICON_MORE = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="12" cy="18.5" r="1.6"></circle></svg>';
  let files = []; let names = {};

  function render() {
    tableBody.innerHTML = files.map((d) => {
      const name = d.fileName || d.title;
      return `<div class="project-files-row" data-doc="${esc(d.id)}" role="row">
        <div class="file-name-cell" role="cell"><img alt="${esc(Docs.type(name))}" src="${Docs.icon(name)}"/><div><strong title="${esc(name)}">${esc(d.title)}</strong><small>${esc(name)} ${Docs.reviewChip(d.reviewStatus)}</small></div></div>
        <span class="file-project" role="cell">${esc(names[d.projectId] || '')}</span>
        <span class="file-type" role="cell">${esc(Docs.type(name))}</span>
        <span role="cell">${esc(UI.fmtDate(d.createdAt))}</span>
        <span dir="ltr" role="cell">${esc(UI.fmtSize(d.fileSize))}</span>
        <div role="cell"><div class="file-actions"><button aria-expanded="false" aria-haspopup="menu" aria-label="${esc(T('خيارات الملف', 'File options'))}" class="file-more" data-file-menu="g${esc(d.id)}" type="button">${ICON_MORE}</button>
          <div class="file-action-menu" data-file-menu-panel="g${esc(d.id)}" hidden role="menu">
            <button class="file-action-menu__item" data-file-action="view" role="menuitem" type="button">${ICON_VIEW}${esc(T('عرض الملف', 'View file'))}</button>
            <button class="file-action-menu__item" data-file-action="download" role="menuitem" type="button">${ICON_DOWNLOAD}${esc(T('تنزيل الملف', 'Download file'))}</button></div></div></div>
      </div>`;
    }).join('');
    cardsGrid.innerHTML = files.map((d) => {
      const name = d.fileName || d.title;
      return `<article class="file-card" data-doc="${esc(d.id)}" role="listitem">
        <div class="file-card__head"><img alt="" class="file-card__icon" src="${Docs.icon(name)}"/><h3 class="file-card__name" title="${esc(name)}">${esc(d.title)}</h3></div>
        <dl class="file-card__meta">
          <div><dt>${esc(T('المشروع', 'Project'))}</dt><dd>${esc(names[d.projectId] || '')}</dd></div>
          <div><dt>${esc(T('نوع الملف', 'File type'))}</dt><dd>${esc(Docs.type(name))}</dd></div>
          <div><dt>${esc(T('تاريخ الرفع', 'Upload date'))}</dt><dd>${esc(UI.fmtDate(d.createdAt))}</dd></div>
          <div><dt>${esc(T('الحجم', 'Size'))}</dt><dd dir="ltr">${esc(UI.fmtSize(d.fileSize))}</dd></div>
          <div class="file-card__meta-wide"><dt>${esc(T('تم الرفع بواسطة', 'Uploaded by'))}</dt><dd>${esc(UI.personName(d.uploadedBy))}</dd></div>
        </dl>
        <div class="file-card__actions"><button class="file-card__button" data-file-action="view" type="button">${ICON_VIEW}${esc(T('عرض', 'View'))}</button><button class="file-card__button" data-file-action="download" type="button">${ICON_DOWNLOAD}${esc(T('تنزيل', 'Download'))}</button></div>
      </article>`;
    }).join('');
    search();
  }

  // ----- Table / card view toggle (no reload) -----
  const viewKey = 'tammha-files-view';
  const filesPanel = document.querySelector('.project-files-panel');
  const toggleButtons = document.querySelectorAll('[data-files-view]');
  const panels = document.querySelectorAll('[data-files-panel]');
  function setView(view) {
    toggleButtons.forEach((button) => { const active = button.dataset.filesView === view; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active)); });
    panels.forEach((panel) => { panel.hidden = panel.dataset.filesPanel !== view; });
    filesPanel?.classList.toggle('is-card-view', view === 'cards');
    try { localStorage.setItem(viewKey, view); } catch (error) { /* storage unavailable */ }
  }
  let initialView = 'table';
  try { if (localStorage.getItem(viewKey) === 'cards') initialView = 'cards'; } catch (error) { /* storage unavailable */ }
  setView(initialView);
  toggleButtons.forEach((button) => button.addEventListener('click', () => setView(button.dataset.filesView)));

  // ----- Search (title, file name, project, type or uploader) -----
  const searchInput = document.getElementById('allFilesSearch');
  const empty = document.getElementById('allFilesEmpty');
  function search() {
    const query = (searchInput?.value || '').trim().toLowerCase(); let visible = 0;
    files.forEach((d) => {
      const hay = `${d.title} ${d.fileName} ${names[d.projectId] || ''} ${Docs.type(d.fileName)} ${UI.personName(d.uploadedBy)}`.toLowerCase();
      const match = !query || hay.includes(query); if (match) visible += 1;
      document.querySelectorAll(`[data-doc="${CSS.escape(d.id)}"]`).forEach((el) => { el.hidden = !match; });
    });
    if (empty) { empty.hidden = !files.length || visible !== 0; }
    // no column titles over an empty result
    document.querySelectorAll('.project-files-table').forEach((t) => t.classList.toggle('is-empty', visible === 0));
  }
  searchInput?.addEventListener('input', search);

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-file-action]'); if (!button) return;
    const host = button.closest('[data-doc]'); if (!host) return;
    Docs.openDocument(host.dataset.doc, button.dataset.fileAction === 'download').catch((e) => UI.toast(Api.message(e), 'error'));
  });

  async function load() {
    UI.state(tableBody, 'loading'); cardsGrid.innerHTML = '';
    try {
      const [projects, list] = await Promise.all([S.projects(true), Api.get('/documents')]);
      names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
      files = (Array.isArray(list) ? list : list.items || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      if (!files.length) {
        const emptyFiles = { image: 'assets/empty-files.webp', title: T('لا توجد ملفات بعد', 'No files yet'), text: T('تظهر هنا ملفات جميع مشاريعك.', 'The files of all your projects appear here.') };
        UI.state(tableBody, 'empty', emptyFiles);
        UI.state(cardsGrid, 'empty', emptyFiles);
        return;
      }
      render();
    } catch (e) { UI.state(tableBody, 'error', { error: e, retry: load }); }
  }
  S.ready.then(load);
})();
