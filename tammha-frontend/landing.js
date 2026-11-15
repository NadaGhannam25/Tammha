// ===== Tammha landing page (standalone) =====
(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bigScreen = window.matchMedia('(min-width: 1000px) and (min-height: 600px) and (prefers-reduced-motion: no-preference)');
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); // easeInOutQuad
  const progressOf = (el) => { const r = el.getBoundingClientRect(); const run = r.height - window.innerHeight; return run > 0 ? clamp(-r.top / run) : 0; };
  const root = document.documentElement;

  // ----- Language: one button switches the whole page between Arabic and English -----
  const LANG_KEY = 'tammha-settings-language'; // shared with the rest of the site
  const EN = {
    pageTitle: 'Tammha — Graduation Project Management Platform',
    metaDesc: 'Tammha organizes graduation projects for students, their teams and supervisors: stages, tasks, meetings, files and university handbook requirements.',
    skip: 'Skip to content', homeLabel: 'Tammha — Home', brand: 'Tammha', navLabel: 'Page sections', menu: 'Menu',
    navAbout: 'About Tammha', navFeatures: 'Features', navContact: 'Contact us',
    login: 'Log in', register: 'Create account',
    heroBrand: 'Tammha', heroTag: 'Build your idea with awareness, and complete it with impact',
    heroText: 'Tammha organizes the graduation project for you, your team and your supervisor: stages, tasks, meetings, files and university handbook requirements.',
    scroll: 'Scroll down',
    aboutTitle: 'A graduation project<br/>is not one task.',
    aboutNote: 'Requirements, a team, stages, tasks, meetings, files and deadlines.',
    aboutThen: 'Tammha puts your project in one clear place.', boardSection: 'From scattered pieces to one project',
    storyLabel: 'About Tammha', storyTitle: 'A graduation project<br/>is not one task.',
    s1: 'It is university requirements to read closely, responsibilities shared across the team, meetings with the supervisor, files that pile up, deadlines that come closer week after week, and follow-up that does not stop until the final defense.',
    s2: 'Tammha brings all of it into one organized workspace, so every member knows what to do, when, and why.',
    bProject: 'Tammha project', bStage: 'Current stage: Development', boardLabel: 'What a graduation project involves',
    c1k: 'Handbook requirement', c1t: 'Analysis and design report', c1m: 'Page 11',
    c2k: 'Stage', c2t: 'Development', c2m: 'In progress · 60%',
    c3k: 'Task · Team member', c3t: 'Build the files page', c3m: 'Oct 30',
    c4k: 'Meeting', c4t: 'Supervisor check-in', c4m: 'Thursday 10:00 AM',
    c5k: 'File', c5t: 'Project plan.pdf',
    c6k: 'Deadline', c6t: 'Prototype', c6m: 'Nov 19',
    c7k: 'Team', c7t: '<span>N</span><span>R</span><span>L</span><span>N</span>', c7m: '4 members and a supervisor',
    c8k: 'Supervisor note · Dr. Noura', c8t: 'Approve the task screens before the review.', c8m: 'Yesterday',
    offerTitle: 'What Tammha offers',
    o1t: 'Organize the project', o1p: 'The project, its team and its supervisor in one space.',
    o2t: 'Stages and tasks', o2p: 'Clear stages, and every task has an owner and a due date.',
    o3t: 'Meetings and teamwork', o3p: 'Meetings scheduled, held and documented in one place.',
    o4t: 'University handbook', o4p: 'College requirements become tasks.',
    cPageTitle: 'Contact us — Tammha', cMetaDesc: 'Contact the Tammha team for support or general inquiries.',
    cTitle: 'Contact us', cIntro: 'This section lets you contact the Tammha team with questions and feedback about using the platform.', cFormT: 'Send a message',  cHelpT: 'How can we help?',
    cName: 'Full name', cEmail: 'Email', cSubject: 'Subject', cMessage: 'Message', cSend: 'Send message',
    cNameErr: 'Enter your name', cEmailErr: 'Enter a valid email, like name@stu.edu.sa', cSubjectErr: 'Enter a subject', cMessageErr: 'Write your message',
    cSent: 'Your e-mail app has opened with the message addressed to info@tammha.site. If it did not open, write to that address directly.', cOther: 'Other ways to reach us',
    cSupportT: 'Technical support', cSupportP: 'Account, sign-in, files and meetings issues.',
    cInfoT: 'General inquiries', cInfoP: 'Questions about Tammha and working with colleges and supervisors.', cNote: 'We read every message and try to reply within two working days.',
    fTammha: 'Tammha', fHow: 'How it works', fHandbook: 'University handbook',
    fSupport: 'Support', fInfo: 'General inquiries', fForm: 'Contact form',
    fAccount: 'Account',
    fCopy: '© 2026 Tammha. A graduation project, AlMaarefa University.', fTop: 'Back to top ↑'
  };
  const textEls = [...document.querySelectorAll('[data-i18n]')];
  const attrEls = [...document.querySelectorAll('[data-i18n-attr]')];
  const AR = {};
  textEls.forEach((el) => { AR[el.dataset.i18n] = el.innerHTML; });
  attrEls.forEach((el) => el.dataset.i18nAttr.split(';').forEach((pair) => { const [attr, key] = pair.split(':'); AR[key] = el.getAttribute(attr); }));
  const langToggle = document.getElementById('langToggle');

  function setLanguage(lang) {
    const dict = lang === 'en' ? EN : AR;
    root.lang = lang;
    root.dir = lang === 'en' ? 'ltr' : 'rtl';
    textEls.forEach((el) => { const v = dict[el.dataset.i18n]; if (v != null) el.innerHTML = v; });
    attrEls.forEach((el) => el.dataset.i18nAttr.split(';').forEach((pair) => { const [attr, key] = pair.split(':'); if (dict[key] != null) el.setAttribute(attr, dict[key]); }));
    // The button always offers the other language.
    langToggle.textContent = lang === 'en' ? 'AR' : 'EN';
    langToggle.lang = lang === 'en' ? 'ar' : 'en';
    langToggle.setAttribute('aria-label', lang === 'en' ? 'التبديل إلى العربية' : 'Switch to English');
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* storage unavailable */ }
  }
  langToggle.addEventListener('click', () => { setLanguage(root.lang === 'en' ? 'ar' : 'en'); splitStory(); layout(); });

  // ----- Header: transparent over the video, white after it (always white on inner pages); mobile menu -----
  const header = document.getElementById('siteHeader');
  const hero = document.querySelector('.hero'); // landing: transparent header over the video; contact: always solid
  const navToggle = document.getElementById('navToggle');
  navToggle.addEventListener('click', () => {
    const open = navToggle.getAttribute('aria-expanded') !== 'true';
    navToggle.setAttribute('aria-expanded', String(open));
    header.classList.toggle('is-open', open);
  });
  header.addEventListener('click', (e) => {
    if (e.target.closest('.hd__nav a')) { navToggle.setAttribute('aria-expanded', 'false'); header.classList.remove('is-open'); }
  });

  // ----- Hero video: muted, looping background, no controls -----
  // University students working together around laptops (free Pexels clips). The first one that loads is used.
  // To use your own video, save it as assets/landing/hero.mp4 — it is tried first.
  const HERO_SOURCES = [
    'assets/landing/hero.mp4',
    'https://videos.pexels.com/video-files/30614422/13109705_1920_1080_25fps.mp4', // College students collaborative study session
    'https://videos.pexels.com/video-files/8198508/8198508-hd_1920_1080_25fps.mp4',  // College students studying together
    'https://videos.pexels.com/video-files/8639119/8639119-hd_1920_1080_25fps.mp4'   // Students studying together
  ];
  const video = document.getElementById('heroVideo');
  if (video) {
    let at = -1;
    const next = () => {
      at += 1;
      if (at >= HERO_SOURCES.length) return;
      video.src = HERO_SOURCES[at];
      video.load();
      if (!reduceMotion) video.play?.().catch(() => {});
    };
    video.muted = true;
    video.removeAttribute('controls');
    if (reduceMotion) video.removeAttribute('autoplay');
    video.addEventListener('error', next);
    video.addEventListener('loadeddata', () => { hero.dataset.videoSource = HERO_SOURCES[at]; if (reduceMotion) video.pause(); });
    next();
  }



  // ----- About: the story's words fill in as the lines pass through the viewport -----
  const storyLines = document.getElementById('storyLines');
  let storyWords = [];
  function splitStory() {
    if (!storyLines) return;
    storyLines.querySelectorAll('p').forEach((p) => {
      p.innerHTML = p.textContent.trim().split(/\s+/).map((w) => `<span class="w">${w}</span>`).join(' ');
    });
    storyWords = [...storyLines.querySelectorAll('.w')];
    if (reduceMotion) storyWords.forEach((w) => w.classList.add('is-lit'));
  }
  splitStory();

  // ----- "Not one task": scattered cards settle into one project -----
  const about = document.getElementById('organize');
  const board = document.getElementById('board');
  const cards = board ? [...board.querySelectorAll('.pc')] : [];
  const then = about?.querySelector('.about__then');
  let settled = false;
  cards.forEach((c, i) => c.style.setProperty('--i', i));
  function measureCards() {
    if (!board) return;
    const w = board.offsetWidth, h = board.offsetHeight;
    const mirror = root.dir === 'ltr' ? -1 : 1; // keep the same scattered look in English
    cards.forEach((c) => {
      c.style.setProperty('--dx', `${Math.round((mirror * Number(c.dataset.dx) / 100) * w)}px`);
      c.style.setProperty('--dy', `${Math.round((Number(c.dataset.dy) / 100) * h)}px`);
      c.style.setProperty('--r', `${mirror * Number(c.dataset.r)}deg`);
    });
  }
  function setAbout(p) {
    if (!board) return;
    board.style.setProperty('--p', clamp((p - 0.55) / 0.4).toFixed(3));
    then?.style.setProperty('--p', clamp((p - 0.7) / 0.3).toFixed(3));
    cards.forEach((c, i) => c.style.setProperty('--q', ease(clamp((p - i * 0.045) / 0.6)).toFixed(3)));
  }

  const canObserve = !reduceMotion && 'IntersectionObserver' in window;

  // ----- What Tammha offers: the four lines draw in once -----
  const offer = document.getElementById('features');
  if (offer) {
    offer.querySelectorAll('.core').forEach((c, i) => c.style.setProperty('--d', `${i * 0.12}s`));
    if (canObserve) {
      offer.classList.add('is-waiting');
      const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) { offer.classList.remove('is-waiting'); io.disconnect(); } }, { threshold: 0.3 });
      io.observe(offer.querySelector('.offer__list'));
    }
  }

  // ----- Contact form: validated here, then opened in the visitor's e-mail app -----
  const form = document.getElementById('contactForm');
  if (form) {
    const fields = [
      { el: document.getElementById('cName'), ok: (v) => v.length > 1 },
      { el: document.getElementById('cEmail'), ok: (v) => /^\S+@\S+\.\S+$/.test(v) },
      { el: document.getElementById('cSubject'), ok: (v) => v.length > 1 },
      { el: document.getElementById('cMessage'), ok: (v) => v.length > 4 }
    ];
    const sent = document.getElementById('contactSent');
    const check = (f) => {
      const bad = !f.ok(f.el.value.trim());
      f.el.classList.toggle('is-invalid', bad);
      f.el.setAttribute('aria-invalid', String(bad));
      f.el.closest('.field').querySelector('.field__error').hidden = !bad;
      return !bad;
    };
    fields.forEach((f) => f.el.addEventListener('input', () => { if (f.el.classList.contains('is-invalid')) check(f); }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const results = fields.map(check);
      const firstBad = fields[results.indexOf(false)];
      if (firstBad) { sent.hidden = true; firstBad.el.focus(); return; }
      // No contact endpoint exists on the server: the message is handed to the visitor's e-mail app,
      // addressed to the official inquiries mailbox (nothing is stored or sent by the site itself).
      const v = (id) => document.getElementById(id).value.trim();
      const body = `${v('cMessage')}\n\n— ${v('cName')} <${v('cEmail')}>`;
      window.location.href = `mailto:info@tammha.site?subject=${encodeURIComponent(v('cSubject'))}&body=${encodeURIComponent(body)}`;
      sent.hidden = false;
    });
  }

  // ----- One scroll loop -----
  const footerMark = document.querySelector('.ft__mark');
  const navLinks = [...document.querySelectorAll('.hd__nav a[href^="#"]')];
  let ticking = false;
  function tick() {
    ticking = false;
    header.classList.toggle('is-solid', !hero || window.scrollY > hero.offsetHeight - 90);
    if (about?.classList.contains('is-scrub')) setAbout(clamp(progressOf(about) * 1.15));
    if (!reduceMotion && storyWords.length) {
      const r = storyLines.getBoundingClientRect(), vh = window.innerHeight;
      const lit = Math.round(clamp((vh * 0.8 - r.top) / (r.height + vh * 0.25)) * storyWords.length);
      storyWords.forEach((w, i) => w.classList.toggle('is-lit', i < lit));
    }
    if (footerMark && !reduceMotion) {
      const r = footerMark.getBoundingClientRect();
      footerMark.style.setProperty('--fp', clamp((window.innerHeight - r.top) / r.height).toFixed(3));
    }
    let current = null;
    navLinks.forEach((a) => { const s = document.querySelector(a.getAttribute('href')); if (s && s.getBoundingClientRect().top < 140) current = a; });
    navLinks.forEach((a) => a.classList.toggle('is-current', a === current));
  }
  const request = () => { if (!ticking) { ticking = true; requestAnimationFrame(tick); } };

  function layout() {
    if (about) {
      const scrub = bigScreen.matches;
      about.classList.toggle('is-scrub', scrub);
      measureCards();
      if (!scrub) {
        // Smaller screens: the cards settle once when the section comes into view.
        if (!canObserve || settled) setAbout(1);
        else {
          setAbout(0);
          const io = new IntersectionObserver((entries) => {
            if (!entries[0].isIntersecting) return;
            io.disconnect(); settled = true;
            about.classList.add('is-settling');
            requestAnimationFrame(() => setAbout(1));
          }, { threshold: 0.25 });
          io.observe(board);
        }
      }
    }
    request();
  }

  let saved = 'ar';
  try { saved = localStorage.getItem(LANG_KEY) || 'ar'; } catch (e) { /* storage unavailable */ }
  if (saved === 'en') { setLanguage('en'); splitStory(); }
  layout();
  bigScreen.addEventListener?.('change', layout);
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 120); });
  window.addEventListener('scroll', request, { passive: true });
})();
