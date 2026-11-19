// ===== Meetings page (meetings.html) — connected to the API =====
//   GET  /meetings?includeCancelled=true      meetings of every project of the user
//   POST /meetings                            schedule (project, title, goals, date + time, duration, participants)
//   POST /meetings/:id/cancel                 organiser or the project's supervisor
//   GET/PUT /meetings/:id/notes               my own notes (private to me) + the supervisor's notes (read-only, `shared`); the follow-up points are kept
//                                             after a marker line inside the same text
// "انضمام" opens meeting-prejoin.html?id=… when the join window is open (the server decides).
// meetings.html?ended=<id> (after leaving the room) opens the short notes dialog.
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession;
  const { T, esc } = UI;
  const $ = (id) => document.getElementById(id);
  const list = $('meetingsList');
  const header = list.querySelector('.meeting-table-header');
  const MARK = '— نقاط التحسين والمتابعة —';
  let meetings = []; let projects = []; let filter = 'all';

  const isPast = (m) => m.status === 'COMPLETED' || m.status === 'CANCELLED' || new Date(m.endsAt) < new Date();
  const statusOf = (m) => (isPast(m) ? 'previous' : m.createdBy?.id !== S.user.id && m.isParticipant ? 'invitation' : 'upcoming');
  const projectName = (id) => (projects.find((p) => p.id === id) || {}).name || '';
  const split = (content) => { const i = (content || '').indexOf(MARK); return i < 0 ? { notes: (content || '').trim(), improvements: '' } : { notes: content.slice(0, i).trim(), improvements: content.slice(i + MARK.length).trim() }; };
  const join = (notes, improvements) => (improvements ? `${notes}\n\n${MARK}\n${improvements}` : notes);

  function action(m) {
    if (m.status === 'CANCELLED') return `<span class="app-chip app-chip--muted">${esc(T('ملغى', 'Cancelled'))}</span>`;
    if (isPast(m)) return `<button class="meeting-action-button meeting-action-button--notes" data-notes="${esc(m.id)}" type="button">${esc(T('التفاصيل', 'Details'))}</button>`;
    const cancel = m.canManage ? `<button class="meeting-cancel-btn" data-cancel="${esc(m.id)}" type="button" title="${esc(T('إلغاء الاجتماع', 'Cancel meeting'))}" aria-label="${esc(T('إلغاء الاجتماع', 'Cancel meeting'))}"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="m9 9 6 6m0-6-6 6"></path></svg></button>` : '';
    if (m.join?.isOpen && m.isParticipant) return `<a class="meeting-action-button meeting-action-button--join" href="meeting-prejoin.html?id=${encodeURIComponent(m.id)}">${esc(T('انضمام', 'Join'))}</a>${cancel}`;
    return `<span class="app-chip app-chip--muted" title="${esc(T('يُفتح الدخول قبل الموعد بقليل', 'Opens shortly before the start'))}">${esc(T(`يُفتح ${UI.fmtTime(m.join?.opensAt)}`, `Opens ${UI.fmtTime(m.join?.opensAt)}`))}</span>${cancel}`;
  }
  function render() {
    list.querySelectorAll('.meeting-list-card, .app-state').forEach((n) => n.remove());
    const visible = meetings.filter((m) => filter === 'all' || (filter === 'invitations' ? statusOf(m) === 'invitation' : filter === 'upcoming' ? !isPast(m) : isPast(m)));
    header.insertAdjacentHTML('afterend', visible.map((m) => `<article class="meeting-list-card meeting-list-card--table" data-meeting-status="${statusOf(m)}">
      <div class="meeting-list-card__kind"><span class="meeting-kind-line"></span><span class="meeting-kind-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="3"></rect><path d="m16 10 5-3v10l-5-3"></path></svg></span></div>
      <div class="meeting-list-card__name">${esc(m.title)}${m.description ? `<small class="app-muted"> · ${esc(m.description)}</small>` : ''}</div>
      <div class="meeting-list-card__supervisor">${esc(projectName(m.projectId))}</div>
      <div class="meeting-list-card__date">${esc(UI.fmtDate(m.scheduledAt))}</div>
      <div class="meeting-list-card__time">${esc(UI.fmtTime(m.scheduledAt))} - ${esc(UI.fmtTime(m.endsAt))}</div>
      <div class="meeting-list-card__action">${action(m)}</div></article>`).join(''));
    // the table (with its column titles) only when there is something to list
    list.hidden = visible.length === 0;
    $('meetingsEmptyState').hidden = visible.length !== 0;
  }
  async function load() {
    const first = !meetings.length;
    let holder = document.querySelector('.meetings-state');
    if (first) {
      list.hidden = true; $('meetingsEmptyState').hidden = true;
      if (!holder) { holder = document.createElement('div'); holder.className = 'meetings-state'; list.before(holder); }
      UI.state(holder, 'loading', { title: T('جارٍ تحميل الاجتماعات…', 'Loading meetings…') });
    }
    try {
      const r = await Api.get('/meetings', { query: { includeCancelled: true, limit: 100 } });
      meetings = (r.items || r || []).sort((a, b) => { const pa = isPast(a); const pb = isPast(b); return pa !== pb ? (pa ? 1 : -1) : pa ? String(b.scheduledAt).localeCompare(a.scheduledAt) : String(a.scheduledAt).localeCompare(b.scheduledAt); });
      if (holder) holder.remove(); render();
    } catch (e) {
      list.hidden = true; $('meetingsEmptyState').hidden = true;
      if (!holder) { holder = document.createElement('div'); holder.className = 'meetings-state'; list.before(holder); }
      UI.state(holder, 'error', { error: e, retry: load });
    }
  }
  document.querySelectorAll('[data-meeting-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.meetingFilter || 'all';
    document.querySelectorAll('[data-meeting-filter]').forEach((x) => x.classList.toggle('is-active', x === b));
    render();
  }));
  list.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cancel]');
    if (c && window.confirm(T('إلغاء هذا الاجتماع؟ يُبلَّغ المدعوون بالإلغاء.', 'Cancel this meeting? The participants are notified.'))) UI.busy(c, async () => { await Api.post(`/meetings/${c.dataset.cancel}/cancel`, {}); await load(); });
    const n = e.target.closest('[data-notes]'); if (n) openNotes(meetings.find((m) => m.id === n.dataset.notes));
  });

  // ----- schedule -----
  // each project's people are fetched once, in the background as soon as the page opens,
  // so the invitees show at once when the form is opened
  const peopleCache = new Map();
  const projectPeople = (pid) => {
    if (!peopleCache.has(pid)) peopleCache.set(pid, Api.get(`/projects/${pid}`, { loader: false }).catch((e) => { peopleCache.delete(pid); throw e; }));
    return peopleCache.get(pid);
  };
  const modal = $('meetingModal'); const form = $('meetingForm');
  async function fillParticipants() {
    const box = $('meetingCreateParticipants'); box.innerHTML = '';
    const pid = $('meetingCreateProject').value; if (!pid) return;
    try {
      const w = await projectPeople(pid);
      if ($('meetingCreateProject').value !== pid) return;
      const people = [S.user, ...(w.team?.members || []).map((m) => m.user || m), ...(w.supervisors || []).map((x) => x.user || x)];
      const unique = [...new Map(people.filter((u) => u && (u.id || u.userId)).map((u) => [u.id || u.userId, u])).values()];
      box.innerHTML = unique.map((u) => `<label class="meeting-participants__item"><input type="checkbox" value="${esc(u.id)}" checked ${u.id === S.user.id ? 'disabled' : ''}/><span>${esc(UI.personName(u))}${u.role === 'SUPERVISOR' ? ` (${esc(T('المشرف', 'Supervisor'))})` : ''}</span></label>`).join('');
    } catch (err) { box.textContent = Api.message(err); }
  }
  const showModal = () => { modal.hidden = false; $('meetingCreateError').textContent = ''; fillParticipants(); };
  const hideModal = () => { modal.hidden = true; form.reset(); };
  $('openMeetingModal').addEventListener('click', showModal);
  $('closeMeetingModal').addEventListener('click', hideModal); $('cancelMeetingModal').addEventListener('click', hideModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });
  $('meetingCreateProject').addEventListener('change', fillParticipants);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('meetingCreateTitle').value.trim();
    const date = $('meetingCreateDate').dataset.iso || $('meetingCreateDate').value;
    // the time picker keeps the 24-hour value in data-time (the visible text is "02:30 م")
    const time = $('meetingCreateTime').dataset.time || $('meetingCreateTime').value;
    const err = $('meetingCreateError');
    if (title.length < 3) { err.textContent = T('اكتب عنوان الاجتماع (3 أحرف على الأقل).', 'Enter the meeting title (at least 3 characters).'); return; }
    if (!date || !time) { err.textContent = T('حدّد التاريخ والوقت.', 'Choose the date and time.'); return; }
    let when = new Date(`${date}T${time.slice(0, 5)}:00`);
    // the current minute counts as "now" (the meeting can be joined at once)
    if (isNaN(when) || when.getTime() < Date.now() - 60_000) { err.textContent = T('اختر موعدًا لاحقًا.', 'Choose a time in the future.'); return; }
    if (when.getTime() < Date.now() + 5000) when = new Date(Date.now() + 5000);
    const ids = [...$('meetingCreateParticipants').querySelectorAll('input:checked:not(:disabled)')].map((i) => i.value);
    UI.busy(form.querySelector('[type="submit"]'), async () => {
      try {
        const payload = { projectId: $('meetingCreateProject').value, title, description: $('meetingCreateGoals').value.trim() || undefined, scheduledAt: when.toISOString(), durationMinutes: Number($('meetingCreateDuration').value) };
        if (ids.length) payload.participantIds = ids;
        await Api.post('/meetings', payload);
        hideModal(); UI.toast(T('جُدول الاجتماع وأُبلغ المدعوون.', 'The meeting is scheduled and the participants were notified.'), 'success'); load();
      } catch (er) { err.textContent = Api.message(er); }
    });
  });

  // ----- notes (view / edit) -----
  const notesModal = $('meetingNotesModal');
  let notesMeeting = null; let notesData = null;
  async function openNotes(m) {
    if (!m) return;
    notesMeeting = m; notesModal.hidden = false;
    $('meetingNotesTitle').textContent = m.title;
    $('meetingNotesSubtitle').textContent = projectName(m.projectId);
    const sections = notesModal.querySelector('.meeting-notes-sections');
    UI.state(sections, 'loading');
    try { notesData = await Api.get(`/meetings/${m.id}/notes`); renderNotes(false); } catch (e) { UI.state(sections, 'error', { error: e }); }
  }
  function renderNotes(editing) {
    const sections = notesModal.querySelector('.meeting-notes-sections'); const parts = split(notesData?.content);
    const meta = $('meetingNotesMeta');
    meta.textContent = notesData?.exists ? T(`آخر تحديث لملاحظاتك: ${UI.fmtDateTime(notesData.updatedAt)}`, `Your notes were last updated: ${UI.fmtDateTime(notesData.updatedAt)}`) : '';
    meta.hidden = !meta.textContent;
    const cancelled = notesMeeting.status === 'CANCELLED';
    // meeting details: length and who attended
    const m = notesMeeting; const mins = Number(m.durationMinutes) || 0;
    const hrs = Math.floor(mins / 60); const rest = mins % 60;
    const hoursAr = hrs === 1 ? 'ساعة' : hrs === 2 ? 'ساعتان' : `${hrs} ساعات`;
    const length = hrs ? T(`${hoursAr}${rest ? ` و${rest} دقيقة` : ''}`, `${hrs} h${rest ? ` ${rest} min` : ''}`) : T(`${mins} دقيقة`, `${mins} min`);
    const people = (m.participants || []).map((p) => { const came = p.attendance === 'ATTENDED' || !!p.joinedAt; return `<li><span>${esc(UI.personName(p.user))}</span><small class="${came ? 'is-came' : ''}">${esc(came ? T('حضر', 'Attended') : T('لم يحضر', 'Did not attend'))}</small></li>`; }).join('');
    const details = `<section class="meeting-details"><dl><div><dt>${esc(T('التاريخ', 'Date'))}</dt><dd>${esc(UI.fmtDate(m.scheduledAt))}</dd></div><div><dt>${esc(T('الوقت', 'Time'))}</dt><dd>${esc(UI.fmtTime(m.scheduledAt))} - ${esc(UI.fmtTime(m.endsAt))}</dd></div><div><dt>${esc(T('المدة', 'Length'))}</dt><dd>${esc(length)}</dd></div></dl>
      <h3>${esc(T('الحاضرون', 'Attendees'))}</h3>${people ? `<ul class="meeting-details__people">${people}</ul>` : `<p class="meeting-details__empty">${esc(T('لا يوجد مدعوون.', 'No one was invited.'))}</p>`}</section>`;
    // the supervisor's notes: shared with the team, read-only for students
    const shared = (notesData?.shared || []).map((n) => `<section class="meeting-notes-field meeting-notes-field--shared"><h3>${esc(T('ملاحظات المشرف', 'Supervisor notes'))}<small>${esc(UI.personName(n.author))} · ${esc(UI.fmtDateTime(n.updatedAt))}</small></h3><div class="meeting-notes-box"><p>${esc(n.content)}</p></div></section>`).join('');
    const privacy = `<p class="meeting-notes-privacy">${esc(T('ملاحظاتك خاصة بك، لا يراها أعضاء الفريق ولا المشرف.', 'Your notes are private: neither the team nor the supervisor can see them.'))}</p>`;
    if (!editing) {
      sections.innerHTML = `${details}${shared}<section class="meeting-notes-field"><h3>${esc(T('ملاحظاتي', 'My notes'))}</h3><div class="meeting-notes-box"><p></p></div></section><section class="meeting-notes-field meeting-notes-field--improvements"><h3>${esc(T('نقاط التحسين والمتابعة', 'Improvement and follow-up points'))}</h3><div class="meeting-notes-box"><p></p></div></section>`;
      const own = sections.querySelectorAll('.meeting-notes-field:not(.meeting-notes-field--shared) p');
      own[0].textContent = parts.notes || T('لم تكتب ملاحظات بعد.', 'You have not written notes yet.'); own[1].textContent = parts.improvements || T('لا توجد نقاط تحسين إضافية.', 'No additional improvement points.');
      $('meetingNotesEdit').hidden = cancelled; $('meetingNotesSave').hidden = true; return;
    }
    sections.innerHTML = `${shared}<section class="meeting-notes-field"><label for="meetingNotesInput"><h3>${esc(T('ملاحظاتي', 'My notes'))}</h3></label><textarea class="meeting-notes-input" id="meetingNotesInput" maxlength="20000" rows="5"></textarea><small class="field-error" hidden id="meetingNotesError">${esc(T('اكتب ملاحظات الاجتماع أولًا', 'Write the meeting notes first'))}</small></section><section class="meeting-notes-field meeting-notes-field--improvements"><label for="meetingImprovementsInput"><h3>${esc(T('نقاط التحسين والمتابعة', 'Improvement and follow-up points'))}</h3></label><textarea class="meeting-notes-input" id="meetingImprovementsInput" maxlength="10000" rows="3"></textarea></section>${privacy}`;
    $('meetingNotesInput').value = parts.notes; $('meetingImprovementsInput').value = parts.improvements;
    $('meetingNotesEdit').hidden = true; $('meetingNotesSave').hidden = false; $('meetingNotesInput').focus();
  }
  const hideNotes = () => { notesModal.hidden = true; notesMeeting = null; };
  $('meetingNotesEdit').addEventListener('click', () => renderNotes(true));
  $('meetingNotesSave').addEventListener('click', () => {
    const notes = $('meetingNotesInput').value.trim(); const improvements = $('meetingImprovementsInput').value.trim();
    if (!notes) { $('meetingNotesInput').classList.add('is-invalid'); $('meetingNotesError').hidden = false; return; }
    UI.busy($('meetingNotesSave'), async () => {
      notesData = await Api.put(`/meetings/${notesMeeting.id}/notes`, { content: join(notes, improvements) });
      notesMeeting.hasNotes = true; renderNotes(false); render(); UI.toast(T('حُفظت الملاحظات.', 'Notes saved.'), 'success');
    });
  });
  $('closeMeetingNotesModal').addEventListener('click', hideNotes); $('meetingNotesCloseButton').addEventListener('click', hideNotes);
  notesModal.addEventListener('click', (e) => { if (e.target === notesModal) hideNotes(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!notesModal.hidden) hideNotes(); if (!modal.hidden) hideModal(); } });

  // ----- after leaving a meeting: short notes dialog -----
  function endedDialog(id) {
    const m = meetings.find((x) => x.id === id); const dialog = $('meetingEndedPanel'); if (!m || !dialog) return;
    window.history.replaceState(null, '', window.location.pathname);
    $('meetingEndedName').textContent = m.title; dialog.hidden = false;
    Api.get(`/meetings/${m.id}/notes`).then((n) => { $('meetingEndedNotes').value = split(n.content).notes; }).catch(() => {});
    const close = () => { dialog.hidden = true; };
    $('meetingEndedClose').onclick = close; $('meetingEndedLater').onclick = close;
    $('meetingEndedForm').onsubmit = (e) => {
      e.preventDefault();
      const notes = $('meetingEndedNotes').value.trim(); if (!notes) { close(); return; }
      UI.busy(e.target.querySelector('[type="submit"]'), async () => {
        const prev = await Api.get(`/meetings/${m.id}/notes`).catch(() => null);
        await Api.put(`/meetings/${m.id}/notes`, { content: join(notes, split(prev?.content).improvements) });
        $('meetingEndedStatus').textContent = T('حُفظت الملاحظات.', 'Notes saved.'); m.hasNotes = true; render(); setTimeout(close, 700);
      });
    };
  }

  S.ready.then(async () => {
    try {
      projects = await S.projects();
      $('meetingCreateProject').innerHTML = projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      projects.forEach((p) => projectPeople(p.id).catch(() => {}));
      $('openMeetingModal').hidden = !projects.length;
      await load();
      const ended = new URLSearchParams(location.search).get('ended'); if (ended) endedDialog(ended);
    } catch (e) { UI.state(list, 'error', { error: e }); }
  });
})();
