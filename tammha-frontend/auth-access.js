// Login / register: account type (student or academic supervisor) and validation.
// Same rules as the backend: everyone signs in with the university e-mail. Students register with
// their university e-mail + student ID; academic supervisors register with a university e-mail of
// the chosen university (no student ID). Both verify the e-mail before full access; supervisor
// accounts created by the university administration still use the activation e-mail.
// A red border and a short message appear only for real errors.
(function () {
  const form = document.querySelector('[data-auth-form]');
  if (!form) return;
  const card = form.closest('.auth-access-card');
  const radios = [...form.querySelectorAll('input[name="accountType"]')];
  const fields = () => [...form.querySelectorAll('input:not([type="radio"])')].filter((input) => !input.disabled);
  const ROLES = ['student', 'supervisor'];
  // Personal mailboxes are refused (backend: PERSONAL_EMAIL_DOMAINS).
  const PERSONAL_DOMAINS = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com'];
  const verifyNotice = document.querySelector('[data-verify-notice]');
  if (verifyNotice && new URLSearchParams(location.search).get('verify') === '1') verifyNotice.hidden = false;

  // ----- Account type -----
  function setRole(role) {
    if (!ROLES.includes(role)) role = 'student';
    const i = ROLES.indexOf(role);
    radios.forEach((radio) => { radio.checked = radio.value === role; });
    card.classList.toggle('is-supervisor', role === 'supervisor');
    form.querySelectorAll('[data-role-field]').forEach((label) => {
      const on = label.dataset.roleField === role;
      label.hidden = !on;
      (label.matches('input, button') ? [label] : [...label.querySelectorAll('input, button')]).forEach((input) => {
        input.disabled = !on;
        if (!on && input.matches('input') && input.closest('label')) setError(input, '');
      });
    });
    form.querySelectorAll('[data-role-text]').forEach((el) => { el.textContent = el.dataset.roleText.split('|')[i]; });
    form.querySelectorAll('[data-role-placeholder]').forEach((el) => { el.placeholder = el.dataset.rolePlaceholder.split('|')[i]; });
    document.querySelectorAll('[data-role-link]').forEach((a) => { a.href = a.getAttribute('href').split('?')[0] + (role === 'supervisor' ? '?role=supervisor' : ''); });
    const url = new URL(location.href);
    if (role === 'supervisor') url.searchParams.set('role', 'supervisor'); else url.searchParams.delete('role');
    history.replaceState(null, '', url);
  }
  const role = () => (radios.find((radio) => radio.checked) || {}).value || 'student';

  // ----- Validation -----
  function setError(input, message) {
    const label = input.closest('label');
    if (!label) return;
    let note = label.querySelector('.field-error');
    if (!note) {
      if (!message) return;
      note = document.createElement('small');
      note.className = 'field-error';
      label.appendChild(note);
    }
    note.textContent = message || '';
    note.hidden = !message;
    input.classList.toggle('is-invalid', !!message);
    input.setAttribute('aria-invalid', String(!!message));
  }

  function check(input) {
    const value = input.value.trim();
    if (!value) return 'هذا الحقل مطلوب';
    if (input.type === 'email' && !/^\S+@\S+\.\S+$/.test(value)) return 'أدخل بريدًا جامعيًا صحيحًا';
    if (input.type === 'email' && PERSONAL_DOMAINS.includes(value.split('@').pop().toLowerCase())) return 'استخدم بريدك الجامعي وليس بريدًا شخصيًا';
    if (input.hasAttribute('data-university-email') && uniSelect && uniSelect.value) {
      const u = universities.find((x) => x.id === uniSelect.value); const domains = (u && u.emailDomains) || [];
      const d = value.split('@').pop().toLowerCase();
      if (domains.length && !domains.some((x) => d === x || d.endsWith(`.${x}`))) return isEnglish() ? `Use a university e-mail of the selected university (${domains.join(', ')})` : `استخدم البريد الجامعي التابع للجامعة المختارة (${domains.join('، ')})`;
    }
    if (input.hasAttribute('data-student-number') && !/^[A-Za-z0-9-]{4,30}$/.test(value)) return 'أدخل الرقم الجامعي كما في بطاقتك الجامعية';
    if (form.dataset.authForm === 'register' && input.type === 'password') {
      const [password, confirmation] = form.querySelectorAll('input[type="password"]');
      if (input === password && (value.length < 8 || !/[A-Za-z\u0600-\u06FF]/.test(value) || !/\d/.test(value))) return 'كلمة المرور 8 أحرف على الأقل، وتحتوي على حرف ورقم';
      if (input === confirmation && value !== password.value.trim()) return 'كلمتا المرور غير متطابقتين';
    }
    return '';
  }

  form.addEventListener('input', (event) => {
    const input = event.target;
    if (input.classList && input.classList.contains('is-invalid')) setError(input, check(input));
  });
  radios.forEach((radio) => radio.addEventListener('change', () => setRole(radio.value)));
  setRole(new URLSearchParams(location.search).get('role'));

  // ----- University list (register) -----
  const uniSelect = form.querySelector('[data-university]');
  let universities = [];
  const OTHER = '__other__';
  let otherLabel = null;
  let otherInput = null;
  const clean = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, '');
  const uniLabel = (u) => (isEnglish() ? (u.nameEn || u.name) : (u.nameAr || u.name));
  function syncOther() {
    if (!otherLabel) return;
    const on = uniSelect.value === OTHER;
    otherLabel.hidden = !on;
    otherInput.disabled = !on;
    if (!on) setError(otherInput, '');
  }
  // Listed universities in the interface language (alphabetical), then "Other",
  // which opens a field for the name of a university that is not listed.
  function renderUniversities() {
    if (!uniSelect) return;
    const en = isEnglish();
    const keep = uniSelect.value;
    const collator = new Intl.Collator(en ? 'en' : 'ar');
    const listed = universities.filter((u) => !u.isCustom).sort((a, b) => collator.compare(uniLabel(a), uniLabel(b)));
    let html = `<option value="">${en ? 'Select the university' : 'اختر الجامعة'}</option>`;
    html += listed.map((u) => `<option value="${clean(u.id)}">${clean(uniLabel(u))}</option>`).join('');
    html += `<option value="${OTHER}">${en ? 'Other' : 'أخرى'}</option>`;
    uniSelect.innerHTML = html;
    if (keep && [...uniSelect.options].some((o) => o.value === keep)) uniSelect.value = keep;
    otherLabel.querySelector('span').textContent = en ? 'University name' : 'اسم الجامعة';
    otherInput.placeholder = en ? 'Type the full name of your university' : 'اكتب الاسم الكامل لجامعتك';
    syncOther();
  }
  if (uniSelect) {
    otherLabel = document.createElement('label');
    otherLabel.hidden = true;
    otherLabel.setAttribute('data-university-other', '');
    otherLabel.innerHTML = '<span></span><input type="text" maxlength="150" autocomplete="organization" data-university-name disabled>';
    (uniSelect.closest('label') || uniSelect).after(otherLabel);
    otherInput = otherLabel.querySelector('input');
    uniSelect.addEventListener('change', syncOther);
    renderUniversities();
    new MutationObserver(renderUniversities).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }
  if (uniSelect && window.TammhaApi) {
    window.TammhaApi.get('/universities', { auth: false }).then((list) => {
      universities = Array.isArray(list) ? list : [];
      renderUniversities();
    }).catch((e) => showFormError(window.TammhaApi.message(e)));
  }

  // ----- Server errors -----
  let formError = form.querySelector('.auth-access-error');
  function showFormError(text) {
    if (!formError) { formError = document.createElement('p'); formError.className = 'auth-access-error'; formError.setAttribute('role', 'alert'); form.querySelector('.auth-access-primary').before(formError); }
    formError.textContent = text || ''; formError.hidden = !text;
  }
  const params = new URLSearchParams(location.search);
  if (params.get('expired') === '1') showFormError(isEnglish() ? 'The session has ended. Please sign in again.' : 'انتهت الجلسة. سجّل الدخول مجددًا.');
  function isEnglish() { return document.documentElement.lang === 'en'; }
  // a relative page of this site only (never another origin)
  function nextPage(fallback) {
    const n = params.get('next') || '';
    return /^[a-z0-9-]+\.html([?#].*)?$/i.test(n) && !/^(login|register)\.html/i.test(n) ? n : fallback;
  }
  const homeOf = (user) => (user.role === 'SUPERVISOR' ? 'supervisor.html' : 'dashboard.html');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    let firstInvalid = null;
    fields().forEach((input) => {
      const message = check(input);
      setError(input, message);
      if (message && !firstInvalid) firstInvalid = input;
    });
    if (uniSelect && !uniSelect.disabled && !uniSelect.value) {
      setError(uniSelect, isEnglish() ? 'Select the university' : 'اختر الجامعة');
      firstInvalid = firstInvalid || uniSelect;
    }
    if (firstInvalid) { firstInvalid.focus(); return; }
    const Api = window.TammhaApi;
    const submit = form.querySelector('.auth-access-primary');
    showFormError('');
    submit.disabled = true;
    try {
      if (form.dataset.authForm === 'login') {
        const [email, password] = [form.querySelector('input[type="email"]').value.trim(), form.querySelector('input[type="password"]').value];
        // from the click until the next page opens: only the Tammha logo and «جارٍ تسجيل الدخول»
        // on a plain screen (no waiting messages); on an error the form comes back with the message
        window.addEventListener('pageshow', (ev) => { if (ev.persisted) { document.querySelectorAll('.tm-loader--solid').forEach((n) => n.remove()); document.body.classList.remove('tm-loading'); } }, { once: true });
        const signing = window.TammhaLoader ? window.TammhaLoader.show({ solid: true, showSlow: false, label: isEnglish() ? 'Signing in…' : 'جارٍ تسجيل الدخول…' }) : null;
        let res;
        try {
          res = await Api.post('/auth/login', { email, password }, { auth: false });
        } catch (err) {
          if (signing) signing.fail();
          throw err;
        }
        Api.saveTokens(res.tokens, res.user);
        if (res.user.emailVerified === false) { location.href = 'verify-email.html?pending=1'; return; }
        // the account decides the pages, whatever account type was ticked
        location.href = res.user.role === 'SUPERVISOR' ? (/^supervisor/.test(nextPage('')) ? nextPage('') : 'supervisor.html') : nextPage(homeOf(res.user));
        return;
      }
      // students and academic supervisors register themselves with their university e-mail;
      // a supervisor has no student number. The e-mail is verified before full access.
      const isSupervisor = role() === 'supervisor';
      const inputs = form.querySelectorAll('input:not([type="radio"])');
      const fullName = form.querySelector('input[autocomplete="name"]').value.trim().split(/\s+/);
      const email = form.querySelector('[data-university-email]').value.trim();
      const body = {
        firstName: fullName[0],
        lastName: fullName.slice(1).join(' ') || undefined,
        email,
        password: form.querySelectorAll('input[type="password"]')[0].value,
        ...(uniSelect.value === OTHER ? { universityName: otherInput.value.trim() } : { universityId: uniSelect.value }),
        role: isSupervisor ? 'SUPERVISOR' : 'STUDENT',
        ...(isSupervisor ? {} : { studentNumber: form.querySelector('[data-student-number]').value.trim(), accountEmailIsUniversityEmail: true })
      };
      const res = await Api.post('/auth/register', body, { auth: false, loader: { label: isEnglish() ? 'Creating the account…' : 'جارٍ إنشاء الحساب…' } });
      Api.saveTokens(res.tokens, res.user);
      location.href = `verify-email.html?pending=1&email=${encodeURIComponent(email)}`;
    } catch (e) {
      const Api2 = window.TammhaApi;
      if (form.dataset.authForm === 'login' && e.status === 401) showFormError(isEnglish() ? 'The email or password is incorrect.' : 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
      else if (e.status === 400 && /password/i.test(e.message || '')) showFormError(isEnglish() ? 'The password needs 8–128 characters with at least one letter and one digit.' : 'كلمة المرور من 8 إلى 128 حرفًا، وتحتوي على حرف ورقم على الأقل.');
      else showFormError(Api2.message(e));
    } finally {
      submit.disabled = false;
    }
  });
})();
