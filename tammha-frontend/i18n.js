// ===== Tammha interface language (Arabic RTL / English LTR) =====
// One setting for the whole site: localStorage 'tammha-settings-language' = 'ar' | 'en'.
// Every page sets <html lang dir> from it in <head> (before the page draws) and loads this file
// in <head> after its stylesheets. This file:
//   - in English, swaps style.css for style-ltr.css (mirrored layout; ltr.css holds small fixes);
//   - adds the language button to the page header ("English" / "العربية"): one click switches
//     the whole interface, the choice is kept, and the page reloads in the new direction;
//   - in English, replaces Arabic interface text:
//       * elements with data-en / data-en-placeholder / data-en-aria-label / data-en-title
//         (pages that translate themselves, e.g. supervisor.js, are left to do it);
//       * any other interface string found in the dictionary (i18n-en.js, window.TAMMHA_EN),
//         also for content that scripts add later (MutationObserver), plus a few patterns
//         (dates, times, counts).
// Text without a dictionary entry (mostly demonstration data such as names, file names and
// sample task titles) stays as written.
(function () {
  'use strict';
  const KEY = 'tammha-settings-language';
  let saved = 'ar';
  try { saved = localStorage.getItem(KEY) === 'en' ? 'en' : 'ar'; } catch (e) { /* storage unavailable */ }
  const root = document.documentElement;
  root.lang = saved;
  root.dir = saved === 'en' ? 'ltr' : 'rtl';
  const isEn = saved === 'en';
  // English uses the mirrored stylesheet (style-ltr.css, generated from style.css). This file is
  // loaded in <head> right after the stylesheet links, so the swap happens before the page draws.
  if (isEn) document.querySelectorAll('link[rel="stylesheet"][href="style.css"]').forEach((l) => { l.href = 'style-ltr.css'; });

  function setLanguage(next) {
    if (next !== 'en' && next !== 'ar') return;
    try { localStorage.setItem(KEY, next); } catch (e) { /* storage unavailable */ }
    if (next !== saved) location.reload();
  }
  const t = (ar, en) => (isEn ? en : ar);

  // ---------- dictionary translation ----------
  const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const M = `(${MONTHS_AR.join('|')})`;
  const mon = (a) => MONTHS_EN[MONTHS_AR.indexOf(a)];
  const ampm = (x) => (x === 'ص' ? 'AM' : 'PM');
  const PATTERNS = [
    [new RegExp(`^(\\d{1,2}) ${M} (\\d{4})$`), (m) => `${mon(m[2])} ${m[1]}, ${m[3]}`],
    [new RegExp(`^(\\d{1,2}) ${M}$`), (m) => `${mon(m[2])} ${m[1]}`],
    [new RegExp(`^${M} (\\d{4})$`), (m) => `${mon(m[1])} ${m[2]}`],
    [new RegExp(`^(\\d{1,2}) – (\\d{1,2}) ${M} (\\d{4})$`), (m) => `${mon(m[3])} ${m[1]} – ${m[2]}, ${m[4]}`],
    [new RegExp(`^(\\d{1,2}) ${M} – (\\d{1,2}) ${M} (\\d{4})$`), (m) => `${mon(m[2])} ${m[1]} – ${mon(m[4])} ${m[3]}, ${m[5]}`],
    [new RegExp(`^آخر تحديث:? (\\d{1,2}) ${M} (\\d{4})$`), (m) => `Last updated ${mon(m[2])} ${m[1]}, ${m[3]}`],
    [new RegExp(`^(\\d{1,2}) ${M} (\\d{4})، (\\d{1,2}:\\d{2}) ([صم])$`), (m) => `${mon(m[2])} ${m[1]}, ${m[3]}, ${m[4]} ${ampm(m[5])}`],
    [/^(\d{1,2}:\d{2}) ([صم]) - (\d{1,2}:\d{2}) ([صم])$/, (m) => `${m[1]} ${ampm(m[2])} – ${m[3]} ${ampm(m[4])}`],
    [/^(\d{1,2}:\d{2}) ([صم])$/, (m) => `${m[1]} ${ampm(m[2])}`],
    [/^الخميس (\d{1,2}:\d{2}) ([صم])$/, (m) => `Thursday ${m[1]} ${ampm(m[2])}`],
    [/^ص (\d+)$/, (m) => `p. ${m[1]}`],
    [/^(\d+) أعضاء$/, (m) => `${m[1]} members`],
    [/^(\d+) اجتماعات$/, (m) => `${m[1]} meetings`],
    [/^(\d+) ملفات$/, (m) => `${m[1]} files`],
    [/^اليوم (\d+)$/, (m) => `Day ${m[1]}`],
    [/^نسبة إنجاز المشروع (\d+) بالمئة$/, (m) => `Project completion ${m[1]} percent`],
    [/^المساحة المستخدمة (\d+) بالمئة$/, (m) => `Storage used ${m[1]} percent`],
    [/^المشرف: (.+) · (\d+) أعضاء$/, (m) => `Supervisor: ${m[1]} · ${m[2]} members`],
    [/^آخر تحديث: (.+?)(?: · (.+))?$/, (m) => `Last updated: ${m[1]}${m[2] ? ` · ${m[2]}` : ''}`],
    [/^مشروع (.+)$/, (m) => `Project ${m[1]}`],
    [/^من مشروع (.+)\. معاينة تجريبية للملف، ستظهر النسخة الفعلية هنا بعد ربط التخزين بالباك إند\.$/, (m) => `From project ${m[1]}. This is a sample preview; the actual file will appear here once storage is connected to the backend.`],
    [/^يغيّر الحالة المسؤول عن المهمة \((.+)\) أو قائد الفريق\.$/, (m) => `The task owner (${m[1]}) or the Team Leader changes the status.`],
    [/^\((\d+)\)$/, (m) => `(${m[1]})`],
    [/^تحديد: (.+)$/, (m) => `Select: ${m[1]}`]
  ];
  const DICT = window.TAMMHA_EN || {};
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const ARABIC = /[؀-ۿ]/;

  function translateString(value) {
    const key = norm(value);
    if (!key || !ARABIC.test(key)) return null;
    if (Object.prototype.hasOwnProperty.call(DICT, key)) return DICT[key];
    for (const [re, fn] of PATTERNS) { const m = key.match(re); if (m) return fn(m); }
    return null;
  }

  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
  function translateNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.parentNode && (SKIP.has(node.parentNode.nodeName) || node.parentNode.closest('[data-i18n-skip],[contenteditable]'))) return;
      const out = translateString(node.nodeValue);
      if (out != null) {
        const lead = node.nodeValue.match(/^\s*/)[0];
        const trail = node.nodeValue.match(/\s*$/)[0];
        // only write real changes: writing the same text would wake the observer again (endless loop)
        if (lead + out + trail !== node.nodeValue) node.nodeValue = lead + out + trail;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || SKIP.has(node.nodeName) || node.closest('[data-i18n-skip]')) return;
    const els = [node, ...node.querySelectorAll('*')];
    for (const el of els) {
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const own = el.getAttribute(`data-en-${a}`);
        const out = own || translateString(el.getAttribute(a));
        if (out != null && out !== el.getAttribute(a)) el.setAttribute(a, out);
      }
      if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) {
        const out = translateString(el.value); if (out) el.value = out;
      }
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(translateNode);
  }

  function translateOwnAttributes() {
    // pages that translate themselves (supervisor.js) handle data-en; here only the rest
    if (document.body.classList.contains('sv-page')) return;
    document.querySelectorAll('[data-en]').forEach((el) => { if (el.tagName !== 'TITLE') el.textContent = el.dataset.en; });
    const title = document.querySelector('title[data-en]');
    if (title) document.title = title.dataset.en;
  }

  // ---------- language button ----------
  function addButton() {
    if (document.querySelector('[data-lang-toggle], #langToggle')) return; // landing has its own
    // the meeting room has no language switch (the language is chosen in Settings)
    if (document.body && document.body.classList.contains('meeting-room-page')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lang-toggle';
    btn.setAttribute('data-lang-toggle', '');
    btn.setAttribute('data-i18n-skip', '');
    btn.setAttribute('lang', isEn ? 'ar' : 'en');
    // every public page (sign-in, sign-up, password pages, join by code...): the short EN / AR
    // mark of the landing page; application pages change the language in Settings
    const short = !document.querySelector('.topbar');
    btn.textContent = short ? (isEn ? 'AR' : 'EN') : (isEn ? 'العربية' : 'English');
    if (short) btn.classList.add('lang-toggle--short');
    btn.setAttribute('aria-label', isEn ? 'التبديل إلى العربية' : 'Switch to English');
    btn.addEventListener('click', () => setLanguage(isEn ? 'ar' : 'en'));
    // Application pages (with the dashboard header) change the language in Settings; the header
    // keeps only the profile and the notifications. Public / sign-in pages keep a small button.
    if (document.querySelector('.topbar')) return;
    btn.classList.add('lang-toggle--floating');
    document.body.append(btn);
  }

  function start() {
    addButton();
    if (!isEn) return;
    translateOwnAttributes();
    const t0 = document.title && translateString(document.title);
    if (t0) document.title = t0;
    translateNode(document.body);
    // content added or changed later by the page scripts
    let queue = new Set();
    let scheduled = false;
    const flush = () => { scheduled = false; const items = [...queue]; queue = new Set(); items.forEach((n) => n.isConnected && translateNode(n)); };
    new MutationObserver((records) => {
      records.forEach((r) => {
        if (r.type === 'characterData') queue.add(r.target);
        else if (r.type === 'attributes') queue.add(r.target);
        else r.addedNodes.forEach((n) => queue.add(n));
      });
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  window.TammhaI18n = Object.freeze({ lang: saved, isEn, t, setLanguage, translate: translateString });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
