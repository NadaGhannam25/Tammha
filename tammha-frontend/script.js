const searchInput = document.getElementById('globalSearch');
const calendarTitle = document.getElementById('calendarTitle');
const calendarDays = document.getElementById('calendarDays');
const prevMonthButton = document.getElementById('prevMonth');
const nextMonthButton = document.getElementById('nextMonth');

// Sidebar navigation uses plain <a href> links (see the sidebar markup in each page),
// so no JavaScript is needed for page-to-page navigation.

searchInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && searchInput.value.trim()) searchInput.blur();
});

const projectFilters = document.querySelectorAll('.project-filter');
// The project list comes from the API: pages/projects.js applies the filter once the data has
// arrived (running it on page load showed the empty state while the projects were still loading).
const projectListCards = document.querySelectorAll('.projects-list-card');
const projectsEmptyState = document.getElementById('projectsEmptyState');
const projectsEmptyTitle = document.getElementById('projectsEmptyTitle');
const projectsEmptyText = document.getElementById('projectsEmptyText');
const projectsEmptyIcon = document.getElementById('projectsEmptyIcon');

const emptyStateIcons = {
  completed: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 4h8v3a4 4 0 0 1-8 0V4Z" />
      <path d="M6 5H4v1a4 4 0 0 0 4 4" />
      <path d="M18 5h2v1a4 4 0 0 1-4 4" />
      <path d="M12 11v5" />
      <path d="M9 20h6" />
      <path d="M10 16h4v4h-4z" />
    </svg>`,
  archived: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 6h16v4H4z" />
      <path d="M5 10h14v9H5z" />
      <path d="M9 14h6" />
      <path d="M7 4h10" />
    </svg>`,
  progress: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 3h10" />
      <path d="M7 21h10" />
      <path d="M8 3c0 4 1.5 6 4 8-2.5 2-4 4-4 10" />
      <path d="M16 3c0 4-1.5 6-4 8 2.5 2 4 4 4 10" />
    </svg>`,
  default: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 7h6l2 2h10v10H3z" />
      <path d="M3 7V5h6l2 2" />
    </svg>`
};

const emptyMessages = {
  COMPLETED: {
    title: 'لا توجد مشاريع مكتملة حتى الآن',
    text: 'تُعرض المشاريع المكتملة في هذا القسم تلقائيًا.',
    icon: 'completed'
  },
  ARCHIVED: {
    title: 'لا توجد مشاريع مؤرشفة حتى الآن',
    text: 'تُعرض المشاريع المؤرشفة في هذا القسم.',
    icon: 'archived'
  },
  IN_PROGRESS: {
    title: 'لا توجد مشاريع قيد التنفيذ حاليًا',
    text: 'تُعرض المشاريع الجارية في هذا القسم.',
    icon: 'progress'
  }
};

// Project status codes (backend ProjectStatus). The "قيد التنفيذ" tab groups the active ones.
const PROJECT_FILTER_GROUPS = { IN_PROGRESS: ['PLANNING', 'IN_PROGRESS', 'REVIEW'] };
const inProjectFilter = (status, target) => target === 'all' || (PROJECT_FILTER_GROUPS[target] || [target]).includes(status);
function applyProjectFilter(target) {
  let visibleCount = 0;
  document.querySelectorAll('.projects-list-card').forEach((card) => {
    const isVisible = inProjectFilter(card.dataset.status, target);
    card.hidden = !isVisible;
    if (isVisible) visibleCount += 1;
  });

  document.querySelectorAll('[data-project-count]').forEach((el) => {
    const key = el.dataset.projectCount;
    el.textContent = [...document.querySelectorAll('.projects-list-card')].filter((c) => inProjectFilter(c.dataset.status, key)).length;
  });

  if (projectsEmptyState) {
    const showEmpty = visibleCount === 0;
    projectsEmptyState.hidden = !showEmpty;
    if (showEmpty) {
      const message = emptyMessages[target] || {
        title: 'لا توجد مشاريع هنا حتى الآن',
        text: 'تُعرض المشاريع في هذا القسم عند توفرها.',
        icon: 'default'
      };
      if (projectsEmptyTitle) projectsEmptyTitle.textContent = message.title;
      if (projectsEmptyText) projectsEmptyText.textContent = message.text;
      if (projectsEmptyIcon) projectsEmptyIcon.innerHTML = emptyStateIcons[message.icon] || emptyStateIcons.default;
    }
  }
}

projectFilters.forEach((filter) => {
  filter.addEventListener('click', () => {
    projectFilters.forEach((item) => {
      item.classList.toggle('is-active', item === filter);
      item.setAttribute('aria-selected', String(item === filter));
    });
    applyProjectFilter(filter.dataset.filter);
  });
});

const arabicMonths = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
];
const englishMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const calendarEn = () => document.documentElement.lang === 'en';
const monthName = (i) => (calendarEn() ? englishMonths[i] : arabicMonths[i]);
// The calendar opens on today; its items come from the API (pages/dashboard.js → TammhaCalendar.setItems).
const calendarToday = new Date();
let visibleDate = new Date(calendarToday.getFullYear(), calendarToday.getMonth(), 1);
let selectedDateKey = `${calendarToday.getFullYear()}-${calendarToday.getMonth() + 1}-${calendarToday.getDate()}`;
const eventDates = new Set();

function createDayCell(day, muted = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `calendar-day${muted ? ' is-muted' : ''}`;
  button.textContent = day;
  button.setAttribute('aria-label', calendarEn() ? `Day ${day}` : `اليوم ${day}`);
  return button;
}

function renderCalendar() {
  if (!calendarTitle || !calendarDays) return;
  const year = visibleDate.getFullYear();
  const month = visibleDate.getMonth();
  calendarTitle.textContent = `${monthName(month)} ${year}`;
  calendarDays.innerHTML = '';
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPreviousMonth = new Date(year, month, 0).getDate();
  const startOffset = (firstDay + 1) % 7;
  for (let index = startOffset; index > 0; index -= 1) {
    calendarDays.appendChild(createDayCell(daysInPreviousMonth - index + 1, true));
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${month + 1}-${day}`;
    const cell = createDayCell(day, false);
    if (key === selectedDateKey) cell.classList.add('is-selected');
    if (eventDates.has(key)) cell.classList.add('has-event');
    calendarDays.appendChild(cell);
  }
  const remaining = (7 - (calendarDays.children.length % 7)) % 7;
  for (let day = 1; day <= remaining; day += 1) calendarDays.appendChild(createDayCell(day, true));
}

function changeMonth(step) {
  visibleDate = new Date(visibleDate.getFullYear(), visibleDate.getMonth() + step, 1);
  const y = visibleDate.getFullYear(), m = visibleDate.getMonth() + 1;
  // today when it is in the shown month, otherwise the first day
  selectedDateKey = calendarToday.getFullYear() === y && calendarToday.getMonth() + 1 === m ? `${y}-${m}-${calendarToday.getDate()}` : `${y}-${m}-1`;
  renderCalendar();
  renderCalendarAgenda(selectedDateKey);
  if (window.TammhaCalendar && window.TammhaCalendar.onMonthChange) window.TammhaCalendar.onMonthChange(new Date(visibleDate));
}
prevMonthButton?.addEventListener('click', () => changeMonth(-1));
nextMonthButton?.addEventListener('click', () => changeMonth(1));
const calendarAgendaDate = document.getElementById('calendarAgendaDate');
const calendarAgendaContent = document.getElementById('calendarAgendaContent');
// day key "yyyy-m-d" → [{ type: 'task' | 'meeting', title, status, statusCls, meta, href }] (filled from the API)
const calendarAgendaItems = {};
let calendarLoaded = false;
let calendarError = '';
const escapeCalendar = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.TammhaCalendar = {
  setItems(map) {
    calendarLoaded = true; calendarError = '';
    Object.keys(calendarAgendaItems).forEach((k) => delete calendarAgendaItems[k]);
    eventDates.clear();
    Object.entries(map).forEach(([k, v]) => { calendarAgendaItems[k] = v; if (v.length) eventDates.add(k); });
    renderCalendar();
    renderCalendarAgenda(selectedDateKey);
  },
  setError(text) { calendarError = text || ''; renderCalendarAgenda(selectedDateKey); },
  visibleMonth() { return new Date(visibleDate); },
  onMonthChange: null
};

function renderCalendarAgenda(key) {
  if (!calendarAgendaContent || !calendarAgendaDate) return;
  const [year, month, day] = key.split('-').map(Number);
  calendarAgendaDate.textContent = calendarEn() ? `${englishMonths[month - 1]} ${day}, ${year}` : `${day} ${arabicMonths[month - 1]} ${year}`;
  const items = calendarAgendaItems[key] || [];
  if (calendarError) {
    calendarAgendaContent.innerHTML = `<div class="calendar-agenda__empty" role="alert">${escapeCalendar(calendarError)}</div>`;
    return;
  }
  if (!items.length) {
    calendarAgendaContent.innerHTML = `<div class="calendar-agenda__empty">${calendarLoaded || !document.getElementById('dashProjects') ? (calendarEn() ? 'No tasks or meetings on this day.' : 'لا توجد مهام أو اجتماعات في هذا اليوم.') : ''}</div>`;
    return;
  }
  // each item: name, status and the basic details; it opens the task (or the meetings page)
  calendarAgendaContent.innerHTML = items.map((item) => `
    <a class="calendar-agenda__item calendar-agenda__item--${escapeCalendar(item.type)}" href="${escapeCalendar(item.href || '#')}">
      <span class="calendar-agenda__dot"></span>
      <div><span class="calendar-agenda__line"><strong>${escapeCalendar(item.title)}</strong>${item.status ? `<em class="calendar-agenda__status calendar-agenda__status--${escapeCalendar(item.statusCls || 'idle')}">${escapeCalendar(item.status)}</em>` : ''}</span><small>${escapeCalendar(item.meta)}</small></div>
    </a>`).join('');
}

calendarDays?.addEventListener('click', (event) => {
  const dayCell = event.target.closest('.calendar-day:not(.is-muted)');
  if (!dayCell) return;
  calendarDays.querySelectorAll('.calendar-day').forEach((cell) => cell.classList.remove('is-selected'));
  dayCell.classList.add('is-selected');
  const year = visibleDate.getFullYear();
  const month = visibleDate.getMonth() + 1;
  selectedDateKey = `${year}-${month}-${Number(dayCell.textContent)}`;
  renderCalendarAgenda(selectedDateKey);
});
renderCalendar();
renderCalendarAgenda(selectedDateKey);

// Settings page tabs — only the center content changes.
const settingsTabButtons = document.querySelectorAll('[data-settings-tab]');
const settingsTabPanels = document.querySelectorAll('[data-settings-panel]');

const settingsTabInk = document.querySelector('.settings-v43-tabs__ink');

// Slide the underline under the active tab.
function moveSettingsInk() {
  const active = document.querySelector('[data-settings-tab].is-active');
  if (!settingsTabInk || !active) return;
  const bar = settingsTabInk.parentElement;
  const x = active.getBoundingClientRect().left - bar.getBoundingClientRect().left + bar.scrollLeft;
  settingsTabInk.style.setProperty('--ink-x', `${x}px`);
  settingsTabInk.style.setProperty('--ink-width', `${active.offsetWidth}px`);
}

settingsTabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const target = button.dataset.settingsTab;
    settingsTabButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    settingsTabPanels.forEach((panel) => {
      const active = panel.dataset.settingsPanel === target;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    moveSettingsInk();
  });
});
if (settingsTabInk) {
  moveSettingsInk();
  requestAnimationFrame(() => settingsTabInk.parentElement.classList.add('is-ready'));
  document.fonts?.ready.then(moveSettingsInk);
  window.addEventListener('resize', moveSettingsInk);
}

const languageOptions = document.querySelectorAll('.language-option');

// ===== V27: persistent language selection inside settings =====
const languagePreferenceKey = 'tammha-settings-language';

function renderLanguageSelection(language) {
  languageOptions.forEach((option) => {
    const selected = option.dataset.language === language;
    option.classList.toggle('is-selected', selected);

    let check = option.querySelector('.language-check');
    if (selected && !check) {
      check = document.createElement('span');
      check.className = 'language-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      option.appendChild(check);
    }
    if (!selected && check) check.remove();

    const subtitle = option.querySelector('small');
    if (subtitle) subtitle.remove(); // only the language name is shown
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(selected));
  });
}

const savedLanguage = localStorage.getItem(languagePreferenceKey) || 'ar';
renderLanguageSelection(savedLanguage);

languageOptions.forEach((option) => {
  option.addEventListener('click', () => {
    const language = option.dataset.language || 'ar';
    renderLanguageSelection(language);
    // applies at once (i18n.js reloads the page in the new direction)
    if (window.TammhaI18n) window.TammhaI18n.setLanguage(language);
    else localStorage.setItem(languagePreferenceKey, language);
  });
});

// ===== V27: local profile photo picker =====
const profilePhotoModal = document.getElementById('profileUploadModal');
const profilePhotoInput = document.getElementById('profilePhotoInput');
const profilePhotoChangeButton = document.getElementById('changeProfilePhoto');
const profilePhotoAddButton = document.getElementById('profilePhotoAdd');
const profilePhotoCloseButton = document.getElementById('profileUploadClose');
const profilePhotoCancelButton = document.getElementById('profileUploadCancel');
const profilePhotoApplyButton = document.getElementById('profileUploadApply');
const profilePhotoPreview = document.getElementById('profileUploadPreview');
const profilePhotoPreviewImage = document.getElementById('profileUploadPreviewImage');
const profilePhotoImage = document.getElementById('profilePhotoImage');
const profilePhotoContainer = document.getElementById('profilePhotoPreview');
const profilePhotoFileName = document.getElementById('profileUploadFileName');
const settingsTopAvatar = document.querySelector('.settings-profile .profile__avatar');
let pendingProfilePhoto = '';

function openProfilePhotoModal() {
  if (!profilePhotoModal) return;
  profilePhotoModal.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeProfilePhotoModal() {
  if (!profilePhotoModal) return;
  profilePhotoModal.hidden = true;
  document.body.style.overflow = '';
}

profilePhotoChangeButton?.addEventListener('click', openProfilePhotoModal);
profilePhotoAddButton?.addEventListener('click', openProfilePhotoModal);
profilePhotoCloseButton?.addEventListener('click', closeProfilePhotoModal);
profilePhotoCancelButton?.addEventListener('click', closeProfilePhotoModal);
profilePhotoModal?.addEventListener('click', (event) => {
  if (event.target === profilePhotoModal) closeProfilePhotoModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && profilePhotoModal && !profilePhotoModal.hidden) closeProfilePhotoModal();
});

profilePhotoInput?.addEventListener('change', () => {
  const file = profilePhotoInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) return;
  if (file.size > 5 * 1024 * 1024) {
    alert(document.documentElement.lang === 'en' ? 'The image is larger than 5 MB. Choose a smaller image.' : 'حجم الصورة يتجاوز 5MB. يُرجى اختيار صورة أصغر.');
    profilePhotoInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingProfilePhoto = String(reader.result || '');
    if (profilePhotoPreviewImage) profilePhotoPreviewImage.src = pendingProfilePhoto;
    if (profilePhotoFileName) profilePhotoFileName.textContent = file.name;
    if (profilePhotoPreview) profilePhotoPreview.hidden = false;
    if (profilePhotoApplyButton) profilePhotoApplyButton.disabled = false;
  };
  reader.readAsDataURL(file);
});

profilePhotoApplyButton?.addEventListener('click', () => {
  if (!pendingProfilePhoto) return;
  if (profilePhotoImage) {
    profilePhotoImage.src = pendingProfilePhoto;
    profilePhotoImage.hidden = false;
  }
  profilePhotoContainer?.classList.add('has-image');
  if (settingsTopAvatar) {
    settingsTopAvatar.classList.add('has-image');
    settingsTopAvatar.style.backgroundImage = `url("${pendingProfilePhoto}")`;
  }
  closeProfilePhotoModal();
});

// Meetings page (list, scheduling, notes, the notes dialog after leaving a meeting): pages/meetings.js (API).

// ===== Three-dot file menus (table rows on Project Files and Global Files) =====
function closeFileMenus(keep) {
  document.querySelectorAll('.file-action-menu').forEach((menu) => {
    if (menu === keep) return;
    menu.hidden = true;
    document.querySelector(`[data-file-menu="${menu.dataset.fileMenuPanel}"]`)?.setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-file-menu]');
  if (!toggle) { closeFileMenus(null); return; }
  const menu = document.querySelector(`[data-file-menu-panel="${toggle.dataset.fileMenu}"]`);
  if (!menu) return;
  const open = menu.hidden;
  closeFileMenus(menu);
  menu.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeFileMenus(null); });


// ===== Link dialog (Project Files + Global Files): shows the URL instead of downloading =====
function openLinkDialog(name, url, meta) {
  const dialog = document.getElementById('linkDialog');
  if (!dialog) return;
  document.getElementById('linkDialogTitle').textContent = name;
  document.getElementById('linkDialogMeta').textContent = meta || '';
  document.getElementById('linkDialogUrl').value = url;
  document.getElementById('linkDialogOpen').href = url;
  document.getElementById('linkDialogStatus').textContent = '';
  dialog.hidden = false;
  document.getElementById('linkDialogUrl').select();
}
(function () {
  const dialog = document.getElementById('linkDialog');
  if (!dialog) return;
  const close = () => { dialog.hidden = true; };
  dialog.querySelector('[data-link-close]').addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !dialog.hidden) close(); });
  document.getElementById('linkDialogCopy').addEventListener('click', async () => {
    const field = document.getElementById('linkDialogUrl');
    const status = document.getElementById('linkDialogStatus');
    try { await navigator.clipboard.writeText(field.value); status.textContent = 'تم النسخ'; }
    catch (error) { field.select(); status.textContent = 'اضغط Ctrl+C للنسخ'; }
  });
})();

// ===== Tammha date picker: compact calendar popup for every date field =====
// Native <input type="date"> fields become read-only text fields that open this popup.
// The visible value is the Arabic date; the ISO date (YYYY-MM-DD) is kept in input.dataset.iso.
(function () {
  const fields = document.querySelectorAll('input[type="date"]');
  if (!fields.length) return;
  // Pages that switch to English (the supervisor pages) set <html lang="en"> before this script runs.
  const EN = document.documentElement.lang === 'en';
  const MONTHS = EN ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] : ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const DAYS = EN ? ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] : ['سبت', 'أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة'];
  const DAY_SHORT = EN ? ['Sa', 'Su', 'Mo', 'Tu', 'We', 'Th', 'Fr'] : ['س', 'ح', 'ن', 'ث', 'ر', 'خ', 'ج'];
  const pad = (n) => String(n).padStart(2, '0');
  const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromIso = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const label = (d) => EN ? `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"></path></svg>';

  const popup = document.createElement('div');
  popup.className = 'datepicker';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', EN ? 'Choose a date' : 'اختيار التاريخ');
  document.body.appendChild(popup);

  let active = null;
  let view = new Date();

  function render() {
    const selected = active?.dataset.iso || '';
    const todayIso = toIso(new Date());
    const year = view.getFullYear(), month = view.getMonth();
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - ((first.getDay() + 1) % 7)); // weeks start on Saturday
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = toIso(d);
      const cls = ['datepicker__day'];
      if (d.getMonth() !== month) cls.push('is-outside');
      if (iso === todayIso) cls.push('is-today');
      if (iso === selected) cls.push('is-selected');
      cells += `<button class="${cls.join(' ')}" data-date="${iso}" type="button" aria-label="${label(d)}"${iso === selected ? ' aria-pressed="true"' : ''}>${d.getDate()}</button>`;
    }
    const monthOptions = MONTHS.map((m, i) => `<option value="${i}"${i === month ? ' selected' : ''}>${m}</option>`).join('');
    const thisYear = new Date().getFullYear();
    let yearOptions = '';
    for (let y = Math.min(thisYear - 5, year); y <= Math.max(thisYear + 5, year); y++) yearOptions += `<option value="${y}"${y === year ? ' selected' : ''}>${y}</option>`;
    popup.innerHTML = `
      <div class="datepicker__top">
        <div class="datepicker__head">
          <button class="datepicker__nav" data-step="-1" type="button" aria-label="${EN ? 'Previous month' : 'الشهر السابق'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EN ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'}"></path></svg></button>
          <div class="datepicker__selects">
            <select class="datepicker__select" data-pick="month" aria-label="${EN ? 'Month' : 'الشهر'}">${monthOptions}</select>
            <select class="datepicker__select" data-pick="year" aria-label="${EN ? 'Year' : 'السنة'}">${yearOptions}</select>
          </div>
          <button class="datepicker__nav" data-step="1" type="button" aria-label="${EN ? 'Next month' : 'الشهر التالي'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EN ? 'm9 5 7 7-7 7' : 'm15 5-7 7 7 7'}"></path></svg></button>
        </div>
        <div class="datepicker__weekdays">${DAYS.map((d, i) => `<span title="${d}">${DAY_SHORT[i]}</span>`).join('')}</div>
      </div>
      <div class="datepicker__grid">${cells}</div>`;
  }

  function place() {
    const r = active.getBoundingClientRect();
    const w = popup.offsetWidth, h = popup.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    // never cut off: when neither side has room, keep the whole popup inside the window
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    let left = r.right - w; // RTL: align with the field's right edge
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }

  function open(input) {
    active = input;
    view = input.dataset.iso ? fromIso(input.dataset.iso) : new Date();
    view.setDate(1);
    render();
    popup.hidden = false;
    place();
    input.setAttribute('aria-expanded', 'true');
  }
  function close() {
    if (!active) return;
    active.setAttribute('aria-expanded', 'false');
    popup.hidden = true;
    active = null;
  }
  function setValue(input, iso) {
    input.dataset.iso = iso || '';
    input.value = iso ? label(fromIso(iso)) : '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  fields.forEach((input) => {
    input.type = 'text';
    input.readOnly = true;
    input.classList.add('date-field__input');
    input.setAttribute('aria-haspopup', 'dialog');
    input.setAttribute('aria-expanded', 'false');
    if (!input.placeholder) input.placeholder = EN ? 'Pick a date' : 'اختر التاريخ';
    const wrap = document.createElement('span');
    wrap.className = 'date-field';
    input.parentNode.insertBefore(wrap, input);
    wrap.append(input);
    wrap.insertAdjacentHTML('beforeend', ICON);
    input.addEventListener('click', () => (active === input ? close() : open(input)));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') { event.preventDefault(); open(input); }
    });
    input.form?.addEventListener('reset', () => { input.dataset.iso = ''; });
  });

  popup.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-step]');
    if (nav) { view = new Date(view.getFullYear(), view.getMonth() + Number(nav.dataset.step), 1); render(); return; }
    const day = event.target.closest('[data-date]');
    if (day && active) { const input = active; setValue(input, day.dataset.date); close(); input.focus(); return; }
    const action = event.target.closest('[data-action]');
    if (action && active) {
      const input = active;
      setValue(input, action.dataset.action === 'today' ? toIso(new Date()) : '');
      close(); input.focus();
    }
  });
  popup.addEventListener('change', (event) => {
    const pick = event.target.closest('[data-pick]');
    if (!pick) return;
    const month = Number(popup.querySelector('[data-pick="month"]').value);
    const year = Number(popup.querySelector('[data-pick="year"]').value);
    view = new Date(year, month, 1);
    render();
    popup.querySelector(`[data-pick="${pick.dataset.pick}"]`).focus();
  });
  document.addEventListener('mousedown', (event) => {
    if (active && !popup.contains(event.target) && event.target !== active) close();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && active) { const input = active; close(); input.focus(); event.stopPropagation(); } }, true);
  window.addEventListener('resize', () => { if (active) place(); });
  document.addEventListener('scroll', () => { if (active) place(); }, true);
})();

// ===== Tammha time picker: same family as the date picker =====
// Native <input type="time"> fields become read-only text fields with this popup.
// The visible value is e.g. "10:30 ص"; the 24-hour value (HH:MM) is kept in input.dataset.time.
(function () {
  const EN = document.documentElement.lang === 'en';
  const fields = document.querySelectorAll('input[type="time"]');
  if (!fields.length) return;
  const pad = (n) => String(n).padStart(2, '0');
  const ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path></svg>';
  const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const MINUTES = Array.from({ length: 60 }, (_, i) => i); // every minute (a meeting can start in a minute)

  const popup = document.createElement('div');
  popup.className = 'datepicker timepicker';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', EN ? 'Choose a time' : 'اختيار الوقت');
  document.body.appendChild(popup);

  let active = null;
  let state = { h: 10, m: 0, pm: false };

  const label = (s) => `${pad(s.h)}:${pad(s.m)} ${s.pm ? (EN ? 'PM' : 'م') : (EN ? 'AM' : 'ص')}`;
  const to24 = (s) => `${pad((s.h % 12) + (s.pm ? 12 : 0))}:${pad(s.m)}`;
  const from24 = (t) => { const [H, M] = t.split(':').map(Number); return { h: H % 12 || 12, m: M, pm: H >= 12 }; };

  function render() {
    popup.innerHTML = `
      <div class="datepicker__top timepicker__top">
        <strong class="timepicker__value">${pad(state.h)}:${pad(state.m)}</strong>
        <div class="timepicker__period" role="group" aria-label="${EN ? 'Period' : 'الفترة'}">
          <button type="button" data-period="am" aria-pressed="${!state.pm}" class="${state.pm ? '' : 'is-active'}">${EN ? 'AM' : 'ص'}</button>
          <button type="button" data-period="pm" aria-pressed="${state.pm}" class="${state.pm ? 'is-active' : ''}">${EN ? 'PM' : 'م'}</button>
        </div>
      </div>
      <div class="timepicker__cols">
        <div class="timepicker__col"><span>${EN ? 'Hour' : 'الساعة'}</span><div class="timepicker__list" data-list="h">${HOURS.map((h) => `<button type="button" data-h="${h}" class="${h === state.h ? 'is-selected' : ''}" aria-pressed="${h === state.h}">${pad(h)}</button>`).join('')}</div></div>
        <div class="timepicker__col"><span>${EN ? 'Minute' : 'الدقيقة'}</span><div class="timepicker__list" data-list="m">${MINUTES.map((m) => `<button type="button" data-m="${m}" class="${m === state.m ? 'is-selected' : ''}" aria-pressed="${m === state.m}">${pad(m)}</button>`).join('')}</div></div>
      </div>
      <div class="timepicker__foot"><button type="button" data-done>${EN ? 'Done' : 'تم'}</button></div>`;
    popup.querySelectorAll('.timepicker__list .is-selected').forEach((b) => {
      const list = b.parentElement;
      list.scrollTop = b.offsetTop - list.clientHeight / 2 + b.offsetHeight / 2;
    });
  }

  function place() {
    const r = active.getBoundingClientRect();
    const w = popup.offsetWidth, h = popup.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    // never cut off: when neither side has room, keep the whole popup inside the window
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }
  function apply() {
    active.dataset.time = to24(state);
    active.value = label(state);
    active.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function open(input) {
    active = input;
    // empty field: start from the next minute
    const soon = new Date(Date.now() + 60_000);
    state = input.dataset.time ? from24(input.dataset.time) : from24(`${soon.getHours()}:${soon.getMinutes()}`);
    popup.hidden = false;
    render();
    place();
    input.setAttribute('aria-expanded', 'true');
  }
  function close() {
    if (!active) return;
    active.setAttribute('aria-expanded', 'false');
    popup.hidden = true;
    active = null;
  }

  fields.forEach((input) => {
    input.type = 'text';
    input.readOnly = true;
    input.classList.add('date-field__input');
    input.setAttribute('aria-haspopup', 'dialog');
    input.setAttribute('aria-expanded', 'false');
    if (!input.placeholder) input.placeholder = EN ? 'Pick a time' : 'اختر الوقت';
    const wrap = document.createElement('span');
    wrap.className = 'date-field';
    input.parentNode.insertBefore(wrap, input);
    wrap.append(input);
    wrap.insertAdjacentHTML('beforeend', ICON);
    input.addEventListener('click', () => (active === input ? close() : open(input)));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); open(input); } });
    input.form?.addEventListener('reset', () => { input.dataset.time = ''; });
  });

  popup.addEventListener('click', (e) => {
    if (!active) return;
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.h) state.h = Number(t.dataset.h);
    else if (t.dataset.m) state.m = Number(t.dataset.m);
    else if (t.dataset.period) state.pm = t.dataset.period === 'pm';
    else if ('done' in t.dataset) { apply(); const input = active; close(); input.focus(); return; }
    apply();
    const lists = [...popup.querySelectorAll('.timepicker__list')].map((l) => l.scrollTop);
    render();
    popup.querySelectorAll('.timepicker__list').forEach((l, i) => { l.scrollTop = lists[i]; });
  });
  document.addEventListener('mousedown', (e) => { if (active && !popup.contains(e.target) && e.target !== active) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) { const input = active; close(); input.focus(); e.stopPropagation(); } }, true);
  window.addEventListener('resize', () => { if (active) place(); });
  document.addEventListener('scroll', (e) => { if (active && !popup.contains(e.target)) place(); }, true);
})();
