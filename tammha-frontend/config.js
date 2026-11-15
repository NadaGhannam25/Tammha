// ===== Tammha frontend configuration =====
// The only place that says where the backend API is. No secrets belong here: this file is
// public, like every other frontend file. Keys for Gemini, Supabase, SMTP and LiveKit stay
// on the server (Render environment variables).
//
// apiBaseUrl
//   - local development: http://localhost:3000/api/v1 (npm run start:dev) or
//     http://localhost:3100/api/v1 (npm run dev:integration, the local integration server);
//     choose with ?api=<url> once (remembered in this browser) or keep the default below;
//   - production: set PRODUCTION_API_BASE_URL to the Render URL of the API, e.g.
//     https://tammha-api.onrender.com/api/v1 or https://api.tammha.site/api/v1.
(function () {
  'use strict';
  const PRODUCTION_API_BASE_URL = 'https://tammha-api.onrender.com/api/v1';

  const LOCAL_DEFAULT = 'http://localhost:3000/api/v1';
  const KEY = 'tammha-api-base-url';
  const isLocal = ['localhost', '127.0.0.1', ''].includes(location.hostname) || location.protocol === 'file:';
  let base = isLocal ? LOCAL_DEFAULT : PRODUCTION_API_BASE_URL;
  try {
    const fromQuery = new URLSearchParams(location.search).get('api');
    if (isLocal && fromQuery && /^https?:\/\/[^\s]+$/.test(fromQuery)) localStorage.setItem(KEY, fromQuery.replace(/\/+$/, ''));
    const saved = isLocal ? localStorage.getItem(KEY) : null;
    if (saved) base = saved;
  } catch (e) { /* storage unavailable */ }
  window.TAMMHA_CONFIG = Object.freeze({
    apiBaseUrl: base,
    requestTimeoutMs: 30000,
    // AI calls send a whole handbook to the model: the server allows up to ~95 s.
    aiTimeoutMs: 100000,
    uploadTimeoutMs: 180000
  });
})();
