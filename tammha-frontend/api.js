// ===== Tammha API client (vanilla JS) =====
// One place for every request to the backend:
//   - base URL from config.js (TAMMHA_CONFIG.apiBaseUrl);
//   - JWT access token on every authorised request; on 401 the refresh token is used once
//     (single request even when several calls fail together; the backend rotates refresh
//     tokens), then the original request is retried; if that fails the session ends and the
//     user is sent to the sign-in page;
//   - one error type (TammhaApi.ApiError: status, code, message, details, kind) for HTTP
//     errors, network failures and timeouts; TammhaApi.message(error) gives the text to show
//     in the current language (backend error codes are translated here);
//   - optional loading state: { loader: { label, target } } wraps the call in TammhaLoader.
// Tokens are kept in localStorage ('tammha-auth'); no other secret is ever stored here.
(function () {
  'use strict';
  const CFG = window.TAMMHA_CONFIG || { apiBaseUrl: '', requestTimeoutMs: 30000 };
  const AUTH_KEY = 'tammha-auth';
  const isEn = () => document.documentElement.lang === 'en';
  const T = (ar, en) => (isEn() ? en : ar);

  class ApiError extends Error {
    constructor({ status = 0, code = '', message = '', details = null, kind = 'http' }) {
      super(message || code || 'API error');
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
      this.kind = kind; // 'http' | 'network' | 'timeout' | 'aborted'
    }
  }

  // ---------- tokens ----------
  const store = {
    read() { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { return null; } },
    write(v) { try { if (v) localStorage.setItem(AUTH_KEY, JSON.stringify(v)); else localStorage.removeItem(AUTH_KEY); } catch (e) { /* storage unavailable */ } }
  };
  function saveTokens(tokens, user) {
    const prev = store.read() || {};
    store.write({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + (Number(tokens.expiresIn) || 900) * 1000,
      user: user || prev.user || null
    });
  }
  function saveUser(user) { const s = store.read(); if (s) { s.user = user; store.write(s); } }
  const session = () => store.read();
  function clearSession() { store.write(null); }

  // ---------- request ----------
  let refreshing = null;
  async function refresh() {
    const s = store.read();
    if (!s || !s.refreshToken) throw new ApiError({ status: 401, code: 'SESSION_EXPIRED' });
    if (!refreshing) {
      refreshing = raw('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken }, auth: false })
        .then((t) => { saveTokens(t); return t; })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  function buildUrl(path, query) {
    const url = new URL(CFG.apiBaseUrl.replace(/\/+$/, '') + path);
    if (query) Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, String(v));
    });
    return url.toString();
  }

  async function raw(method, path, opts = {}) {
    const { body, query, form, auth = true, timeout = CFG.requestTimeoutMs, signal } = opts;
    const headers = { Accept: 'application/json' };
    if (auth) {
      const s = store.read();
      if (s && s.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;
    }
    let payload;
    if (form) payload = form; // FormData: the browser sets the multipart boundary
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeout);
    if (signal) { if (signal.aborted) ctrl.abort(signal.reason); else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true }); }
    let res;
    try {
      res = await fetch(buildUrl(path, query), { method, headers, body: payload, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (signal && signal.aborted) throw new ApiError({ kind: 'aborted', code: 'ABORTED' });
      if (ctrl.signal.aborted) throw new ApiError({ kind: 'timeout', code: 'REQUEST_TIMEOUT' });
      throw new ApiError({ kind: 'network', code: 'NETWORK_ERROR' });
    }
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
    if (!res.ok) {
      const d = data && typeof data === 'object' ? data : {};
      throw new ApiError({
        status: res.status,
        code: d.code || (res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' : res.status === 404 ? 'NOT_FOUND' : res.status === 400 ? 'VALIDATION_ERROR' : res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'SERVER_ERROR' : ''),
        message: Array.isArray(d.message) ? d.message.join('; ') : d.message || '',
        details: d.details || (Array.isArray(d.message) ? d.message : null)
      });
    }
    return data;
  }

  function goToLogin() {
    const here = location.pathname.split('/').pop() + location.search;
    clearSession();
    location.href = `login.html?next=${encodeURIComponent(here)}&expired=1`;
  }

  // A GET that fails because the server is waking up or briefly unreachable (no connection,
  // 502/503/504, a timeout) is tried again a few times before the page shows an error, so a
  // first visit after a quiet period does not end on "could not load the data".
  const RETRY_DELAYS = [1500, 3000, 6000];
  const retryable = (e) => e instanceof ApiError && (e.kind === 'network' || e.kind === 'timeout' || [502, 503, 504].includes(e.status));
  async function rawWithRetry(method, path, opts) {
    for (let i = 0; ; i++) {
      try { return await raw(method, path, opts); } catch (e) {
        if (method !== 'GET' || i >= RETRY_DELAYS.length || !retryable(e) || (opts.signal && opts.signal.aborted)) throw e;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[i]));
      }
    }
  }

  async function request(method, path, opts = {}) {
    const run = async () => {
      try {
        return await rawWithRetry(method, path, opts);
      } catch (e) {
        const auth = opts.auth !== false;
        if (auth && e instanceof ApiError && e.status === 401 && store.read()?.refreshToken && !opts._retried) {
          try { await refresh(); } catch (r) { if (opts.redirectOn401 !== false) goToLogin(); throw e; }
          return raw(method, path, { ...opts, _retried: true });
        }
        if (auth && e instanceof ApiError && e.status === 401 && opts.redirectOn401 !== false) goToLogin();
        throw e;
      }
    };
    // requests made in the background (loader: false) are not counted as page loading
    const counted = opts.loader !== false;
    const tracked = () => {
      if (!counted) return run();
      inflight += 1; lastActivity = Date.now();
      return run().finally(() => { inflight -= 1; lastActivity = Date.now(); });
    };
    if (opts.loader && window.TammhaLoader) {
      return window.TammhaLoader.track(tracked, { timeout: (opts.timeout || CFG.requestTimeoutMs) + 2000, signal: opts.signal, ...opts.loader });
    }
    return tracked();
  }

  // ---------- page loading: resolves once no request has been running for `quietMs` ----------
  let inflight = 0; let lastActivity = 0;
  function idle(quietMs = 250, maxMs = 12000) {
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        const now = Date.now();
        if ((inflight === 0 && now - lastActivity >= quietMs) || now - started >= maxMs) resolve();
        else setTimeout(check, 60);
      };
      setTimeout(check, 60);
    });
  }

  // ---------- messages ----------
  const MESSAGES = {
    NETWORK_ERROR: ['تعذّر الاتصال بالخادم. تحقق من الاتصال بالإنترنت ثم أعد المحاولة.', 'Could not reach the server. Check the internet connection and try again.'],
    REQUEST_TIMEOUT: ['استغرق الطلب وقتًا أطول من المسموح. أعد المحاولة.', 'The request took too long. Please try again.'],
    TimeoutError: ['استغرقت العملية وقتًا أطول من المسموح. أعد المحاولة.', 'The operation took too long. Please try again.'],
    SESSION_EXPIRED: ['انتهت الجلسة. سجّل الدخول مجددًا.', 'The session has ended. Please sign in again.'],
    UNAUTHORIZED: ['انتهت الجلسة أو بيانات الدخول غير صحيحة.', 'The session has ended or the sign-in details are incorrect.'],
    INVALID_CREDENTIALS: ['البريد الإلكتروني أو كلمة المرور غير صحيحة.', 'The email or password is incorrect.'],
    FORBIDDEN: ['لا تملك صلاحية تنفيذ هذا الإجراء.', 'You do not have permission to do this.'],
    NOT_FOUND: ['العنصر المطلوب غير موجود.', 'The requested item was not found.'],
    VALIDATION_ERROR: ['بعض البيانات غير صحيحة. راجع الحقول ثم أعد المحاولة.', 'Some data is not valid. Check the fields and try again.'],
    SERVER_ERROR: ['حدث خطأ في الخادم. أعد المحاولة لاحقًا.', 'A server error occurred. Please try again later.'],
    RATE_LIMITED: ['عدد الطلبات كبير. انتظر قليلًا ثم أعد المحاولة.', 'Too many requests. Wait a moment and try again.'],
    PAYLOAD_TOO_LARGE: ['حجم الملف أكبر من المسموح.', 'The file is larger than allowed.'],
    EMAIL_NOT_VERIFIED: ['يجب تأكيد البريد الإلكتروني أولًا.', 'Please verify your email address first.'],
    UNIVERSITY_EMAIL_NOT_VERIFIED: ['يجب تأكيد البريد الجامعي أولًا.', 'Please verify your university email first.'],
    LOGIN_ROLE_MISMATCH: ['نوع الدخول غير صحيح. يرجى إعادة المحاولة.', 'Incorrect account type. Please try again.'],
    EMAIL_ALREADY_REGISTERED: ['هذا البريد مسجّل مسبقًا.', 'This email is already registered.'],
    EMAIL_ALREADY_VERIFIED: ['البريد مؤكَّد مسبقًا.', 'This email is already verified.'],
    VERIFICATION_TOKEN_INVALID: ['رابط التأكيد غير صالح أو منتهي الصلاحية.', 'The verification link is invalid or has expired.'],
    VERIFICATION_RECENTLY_SENT: ['أُرسل رابط قبل قليل. انتظر دقيقة ثم أعد المحاولة.', 'A link was sent a moment ago. Wait a minute and try again.'],
    RESET_TOKEN_INVALID: ['رابط إعادة التعيين غير صالح أو منتهي الصلاحية.', 'The reset link is invalid or has expired.'],
    ACTIVATION_TOKEN_INVALID: ['رابط التفعيل غير صالح أو منتهي الصلاحية.', 'The activation link is invalid or has expired.'],
    ACCOUNT_ALREADY_ACTIVE: ['الحساب مفعّل مسبقًا. سجّل الدخول.', 'The account is already active. Please sign in.'],
    USER_INACTIVE: ['الحساب غير نشط. تواصل مع الدعم الفني.', 'The account is inactive. Contact support.'],
    STUDENT_NUMBER_REQUIRED: ['الرقم الجامعي مطلوب.', 'The student number is required.'],
    STUDENT_NUMBER_TAKEN: ['الرقم الجامعي مستخدم في حساب آخر.', 'This student number is used by another account.'],
    UNIVERSITY_EMAIL_REQUIRED: ['استخدم البريد الجامعي للجامعة المختارة.', 'Use a university email of the selected university.'],
    UNIVERSITY_EMAIL_DOMAIN_MISMATCH: ['البريد لا يتبع نطاق الجامعة المختارة.', 'The email does not belong to the selected university.'],
    UNIVERSITY_EMAIL_TAKEN: ['البريد الجامعي مستخدم في حساب آخر.', 'This university email is used by another account.'],
    UNIVERSITY_NOT_FOUND: ['الجامعة غير موجودة.', 'The university was not found.'],
    SUPERVISOR_SELF_REGISTRATION_NOT_ALLOWED: ['تُنشئ إدارة الجامعة حسابات المشرفين.', 'Supervisor accounts are created by the university.'],
    PROJECT_NOT_FOUND: ['المشروع غير موجود.', 'The project was not found.'],
    PROJECT_ACCESS_DENIED: ['لا تملك صلاحية الوصول إلى هذا المشروع.', 'You do not have access to this project.'],
    NOT_TEAM_LEADER: ['هذا الإجراء لقائد الفريق فقط.', 'Only the Team Leader can do this.'],
    NOT_IN_TEAM: ['لست عضوًا في فريق هذا المشروع.', 'You are not a member of this project team.'],
    TEAM_FULL: ['الفريق مكتمل العدد.', 'The team is full.'],
    ALREADY_IN_THIS_TEAM: ['أنت عضو في هذا الفريق بالفعل.', 'You are already in this team.'],
    INVITATION_INVALID: ['رمز الدعوة غير صالح.', 'The invitation code is not valid.'],
    INVITATION_MALFORMED: ['رمز الدعوة غير صحيح الصيغة.', 'The invitation code is malformed.'],
    INVITATION_NOT_FOUND: ['الدعوة غير موجودة.', 'The invitation was not found.'],
    INVITATION_NOT_PENDING: ['لم تعد الدعوة متاحة.', 'The invitation is no longer pending.'],
    INVITATION_ALREADY_PENDING: ['أُرسلت دعوة لهذا الطالب من قبل.', 'An invitation to this student is already pending.'],
    CANNOT_INVITE_YOURSELF: ['لا يمكن دعوة نفسك.', 'You cannot invite yourself.'],
    STUDENT_NOT_FOUND: ['لم يُعثر على طالب بهذه البيانات في جامعتك.', 'No student of your university matches these details.'],
    STUDENT_IDENTIFIER_REQUIRED: ['أدخل الرقم الجامعي أو البريد الجامعي.', 'Enter a student number or university email.'],
    SUPERVISOR_NOT_FOUND: ['لم يُعثر على مشرف بهذا البريد.', 'No supervisor has this email.'],
    SUPERVISOR_ALREADY_ASSIGNED: ['للمشروع مشرف بالفعل.', 'The project already has a supervisor.'],
    REQUEST_ALREADY_PENDING: ['يوجد طلب إشراف قيد الانتظار.', 'A supervision request is already pending.'],
    REQUEST_NOT_PENDING: ['لم يعد الطلب قيد الانتظار.', 'The request is no longer pending.'],
    USER_NOT_SUPERVISOR: ['هذا الحساب ليس حساب مشرف.', 'This account is not a supervisor account.'],
    UNIVERSITY_MISMATCH: ['المشرف من جامعة أخرى.', 'The supervisor belongs to another university.'],
    PROJECT_SETUP_INCOMPLETE: ['إعداد المشروع غير مكتمل بعد.', 'The project setup is not complete yet.'],
    SETUP_ALREADY_COMPLETED: ['اكتمل إعداد المشروع مسبقًا.', 'The project setup is already complete.'],
    TASK_NOT_FOUND: ['المهمة غير موجودة.', 'The task was not found.'],
    TASK_NOT_ASSIGNED_TO_YOU: ['يغيّر حالة المهمة المسؤول عنها أو قائد الفريق.', 'Only the task owner or the Team Leader can change this task.'],
    TASK_STATUS_ONLY: ['يمكنك تغيير حالة المهمة فقط.', 'You can only change the task status.'],
    ASSIGNEE_NOT_IN_TEAM: ['المسؤول المختار ليس عضوًا في الفريق.', 'The selected owner is not a team member.'],
    INVALID_STATUS_TRANSITION: ['لا يمكن الانتقال إلى هذه الحالة من الحالة الحالية.', 'This status change is not allowed from the current status.'],
    INVALID_DATE_RANGE: ['نطاق التواريخ غير صحيح.', 'The date range is not valid.'],
    MILESTONE_NOT_FOUND: ['المرحلة غير موجودة.', 'The stage was not found.'],
    COMMENT_EMPTY: ['اكتب نص التعليق.', 'Write the comment text.'],
    DOCUMENT_NOT_FOUND: ['الملف غير موجود.', 'The file was not found.'],
    DOCUMENT_NOT_OWNER: ['يعدّل الملف رافعه أو قائد الفريق.', 'Only the uploader or the Team Leader can change this file.'],
    FILE_REQUIRED: ['اختر ملفًا.', 'Choose a file.'],
    FILE_EMPTY: ['الملف فارغ.', 'The file is empty.'],
    FILE_TOO_LARGE: ['حجم الملف أكبر من المسموح.', 'The file is larger than allowed.'],
    FILE_TYPE_NOT_ALLOWED: ['نوع الملف غير مدعوم.', 'This file type is not supported.'],
    STORAGE_ERROR: ['خدمة تخزين الملفات غير متاحة حاليًا. أعد المحاولة لاحقًا.', 'File storage is unavailable right now. Please try again later.'],
    STORAGE_QUOTA_EXCEEDED: ['تجاوزت المساحة المتاحة لحسابك.', 'Your storage quota is exceeded.'],
    STATUS_REQUIRES_DOCUMENT: ['هذه الحالة تتطلب ملفًا.', 'This status requires a document.'],
    SUBMISSION_STATUS_UNCHANGED: ['الحالة لم تتغير.', 'The status did not change.'],
    FEEDBACK_EMPTY: ['اكتب نص الملاحظة.', 'Write the feedback text.'],
    FEEDBACK_TARGET_REQUIRED: ['حدّد المشروع أو الملف أو المهمة.', 'Choose the project, file or task.'],
    MEETING_NOT_OPEN_YET: ['لم يحن موعد الدخول إلى الاجتماع بعد.', 'The meeting is not open yet.'],
    MEETING_CANCELLED: ['الاجتماع ملغى.', 'The meeting is cancelled.'],
    MEETING_NOTES_EMPTY: ['اكتب الملاحظات أولًا.', 'Write the notes first.'],
    MEETING_TOKEN_UNAVAILABLE: ['تعذّر إنشاء رمز الدخول إلى الاجتماع.', 'Could not create the meeting access token.'],
    INTEGRATION_DISABLED: ['هذه الخدمة غير مفعّلة على الخادم حاليًا.', 'This service is not enabled on the server.'],
    AI_PROVIDER_UNAVAILABLE: ['خدمة الذكاء الاصطناعي غير متاحة حاليًا. أعد المحاولة لاحقًا.', 'The AI service is unavailable right now. Please try again later.'],
    AI_PROVIDER_TIMEOUT: ['استغرقت خدمة الذكاء الاصطناعي وقتًا أطول من المسموح. أعد المحاولة.', 'The AI service took too long. Please try again.'],
    AI_INVALID_RESPONSE: ['أعادت خدمة الذكاء الاصطناعي إجابة غير صالحة، ولم يُعرض أي محتوى.', 'The AI service returned an invalid answer; nothing was shown.'],
    AI_RESPONSE_BLOCKED: ['رُفضت الإجابة من خدمة الذكاء الاصطناعي.', 'The AI answer was blocked.'],
    AI_RATE_LIMITED: ['بلغت الحد المسموح من طلبات الذكاء الاصطناعي. أعد المحاولة لاحقًا.', 'You reached the AI request limit. Please try later.'],
    AI_FEATURE_NOT_FOR_SUPERVISOR: ['هذه الميزة غير متاحة للمشرف.', 'This feature is not available to supervisors.'],
    HANDBOOK_NOT_FOUND: ['لا يوجد دليل جاهز لهذا المشروع.', 'This project has no ready handbook.'],
    HANDBOOK_NOT_READABLE: ['تعذّرت قراءة نص الدليل. ارفع ملف PDF يحتوي على نص.', 'The handbook text could not be read. Upload a PDF with selectable text.'],
    UNIVERSITY_HANDBOOK_NOT_AVAILABLE: ['الدليل غير متاح حاليًا', 'Handbook not available'],
    UNIVERSITY_NOT_IN_HANDBOOK_LIST: ['هذه الجامعة ليست ضمن قائمة الأدلة.', 'This university is not in the handbook list.'],
    DUPLICATE_VALUE: ['القيمة مستخدمة مسبقًا.', 'This value already exists.']
  };
  function message(err) {
    if (!err) return '';
    const code = err.code || err.name;
    if (MESSAGES[code]) return T(...MESSAGES[code]);
    if (err.status === 401) return T(...MESSAGES.UNAUTHORIZED);
    if (err.status === 403) return T(...MESSAGES.FORBIDDEN);
    if (err.status === 404) return T(...MESSAGES.NOT_FOUND);
    if (err.status === 400 || err.status === 422) return T(MESSAGES.VALIDATION_ERROR[0], err.message || MESSAGES.VALIDATION_ERROR[1]);
    if (err.status === 429) return T(...MESSAGES.RATE_LIMITED);
    // an account that already exists (older servers answered without a code)
    if (err.status === 409 && /already registered/i.test(err.message || '')) return T(...MESSAGES.EMAIL_ALREADY_REGISTERED);
    if (err.status >= 500) return T(...MESSAGES.SERVER_ERROR);
    return T('حدث خطأ غير متوقع. أعد المحاولة.', err.message || 'An unexpected error occurred. Please try again.');
  }

  const get = (p, o) => request('GET', p, o);
  const post = (p, body, o = {}) => request('POST', p, { ...o, body });
  const patch = (p, body, o = {}) => request('PATCH', p, { ...o, body });
  const put = (p, body, o = {}) => request('PUT', p, { ...o, body });
  const del = (p, o) => request('DELETE', p, o);
  const upload = (method, p, form, o = {}) => request(method, p, { timeout: CFG.uploadTimeoutMs || 180000, ...o, form });

  window.TammhaApi = Object.freeze({
    idle,
    ApiError, request, get, post, patch, put, del, upload, message,
    saveTokens, saveUser, session, clearSession, refresh,
    baseUrl: CFG.apiBaseUrl,
    aiTimeout: CFG.aiTimeoutMs || 100000
  });
})();
