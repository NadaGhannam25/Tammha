// ===== Tammha loader (wave-filled logo) =====
// Reusable loading state built from wave-loader.html (kept as the standalone reference page).
// The blue Tammha logo fills with a gentle wave WHILE an operation is running. It follows
// the real operation, not a fixed duration:
//   - shown only if the operation takes longer than `delay` (no flicker on fast actions);
//   - once shown, stays at least `minVisible` ms, then fills to 100% and fades out;
//   - on failure, cancellation (options.signal) or timeout it closes at once and the caller shows
//     the error (the loader never hides errors);
//   - compact: the logo is 72 px wide (64 px inline, 56 px on small screens), see loader.css;
//   - after `timeout` ms the operation is rejected with a TimeoutError, so nobody is left on
//     an endless loading screen;
//   - honours prefers-reduced-motion (no wave, static logo + text).
// Usage:
//   TammhaLoader.track(promise | () => promise, { label, target, delay, minVisible, timeout, signal })
//     target = element for an inline loader inside a panel; omitted = full-page overlay.
//   const h = TammhaLoader.show({ label }); ... h.done();   // manual control
(function () {
  'use strict';

  const LOGO = 'assets/tammha-loader-logo.png';
  const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'ar');
  const T = (ar, en) => (lang() === 'en' ? en : ar);
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  class TimeoutError extends Error {
    constructor() { super('timeout'); this.name = 'TimeoutError'; }
  }

  function build(label, inline) {
    const box = document.createElement('div');
    box.className = `tm-loader${inline ? ' tm-loader--inline' : ''}`;
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.innerHTML = `
      <div class="tm-loader__logo" aria-hidden="true">
        <img class="tm-loader__base" alt="" src="${LOGO}" draggable="false">
        <img class="tm-loader__fill" alt="" src="${LOGO}" draggable="false">
      </div>
      <p class="tm-loader__label"></p>
      <p class="tm-loader__slow" hidden></p>`;
    box.querySelector('.tm-loader__label').textContent = label || T('جارٍ التحميل…', 'Loading…');
    return box;
  }

  // Wave clip path for a fill level (0-100) at time t.
  function wave(level, t, strength) {
    const pts = [];
    const base = 100 - level;
    for (let i = 0; i <= 48; i++) {
      const x = (i / 48) * 100;
      const w1 = Math.sin((i / 48) * Math.PI * 2 * 2.2 + t * 0.004);
      const w2 = Math.sin((i / 48) * Math.PI * 4.3 - t * 0.0026) * 0.3;
      pts.push(`${x.toFixed(2)}% ${(base + (w1 + w2) * 6 * strength).toFixed(2)}%`);
    }
    return `polygon(${pts.join(', ')}, 100% 100%, 0% 100%)`;
  }

  function show(options = {}) {
    const target = options.target || null;
    const box = build(options.label, !!target);
    const fill = box.querySelector('.tm-loader__fill');
    const startedAt = performance.now();
    let level = 0;
    let finishing = false;
    let raf = 0;
    let closed = false;
    const still = reduced();

    if (target) {
      target.setAttribute('aria-busy', 'true');
      target.append(box);
    } else {
      document.body.append(box);
      document.body.classList.add('tm-loading');
    }
    requestAnimationFrame(() => box.classList.add('is-visible'));

    const frame = (now) => {
      if (closed) return;
      // an inline loader whose area was redrawn (data arrived) stops by itself
      if (target && !box.isConnected) { close(); return; }
      const t = now - startedAt;
      // indeterminate progress: rises quickly, then slows down and never reaches 100% alone
      if (!finishing) level = 88 * (1 - Math.exp(-t / 2200));
      fill.style.clipPath = still ? 'inset(0)' : wave(level, now, finishing ? 0.4 : 1);
      if (!still) raf = requestAnimationFrame(frame);
    };
    if (still) { fill.style.clipPath = 'inset(0)'; box.classList.add('is-still'); } else raf = requestAnimationFrame(frame);

    const slowTimer = setTimeout(() => {
      const slow = box.querySelector('.tm-loader__slow');
      slow.textContent = options.slowText || T('تستغرق العملية وقتًا أطول من المعتاد، يُرجى الانتظار.', 'This is taking longer than usual. Please wait.');
      slow.hidden = false;
    }, options.slowAfter || 8000);

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(slowTimer);
      cancelAnimationFrame(raf);
      box.classList.remove('is-visible');
      setTimeout(() => {
        box.remove();
        if (target) target.removeAttribute('aria-busy');
        else if (!document.querySelector('.tm-loader:not(.tm-loader--inline)')) document.body.classList.remove('tm-loading');
      }, still ? 0 : 220);
    };

    return {
      startedAt,
      /** success: fill the logo, then close */
      done() {
        if (closed || finishing) return;
        finishing = true;
        if (still) { close(); return; }
        const from = level; const t0 = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / 260);
          level = from + (100 - from) * k;
          if (k < 1) requestAnimationFrame(step); else setTimeout(close, 120);
        };
        requestAnimationFrame(step);
      },
      /** failure / cancel: close at once (the caller shows the error) */
      fail: close
    };
  }

  /**
   * Shows the loader for a running operation. Resolves / rejects like the operation.
   * Rejects with TammhaLoader.TimeoutError after `timeout` ms.
   */
  function track(operation, options = {}) {
    const delay = options.delay ?? 200;
    const minVisible = options.minVisible ?? 450;
    const timeout = options.timeout ?? 30000;
    const promise = typeof operation === 'function' ? operation() : operation;
    let handle = null;
    const timer = setTimeout(() => { handle = show(options); }, delay);
    let timeoutId = 0;
    const racers = [
      Promise.resolve(promise),
      new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new TimeoutError()), timeout); })
    ];
    // cancellation: options.signal (AbortSignal) closes the loader and rejects with its reason
    const signal = options.signal;
    if (signal) {
      racers.push(new Promise((_, reject) => {
        const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      }));
    }
    const guarded = Promise.race(racers);
    const settle = (ok) => new Promise((resolve) => {
      clearTimeout(timer);
      clearTimeout(timeoutId);
      if (!handle) { resolve(); return; }
      // success keeps the loader up for minVisible (no flash); failure / cancel / timeout close at once
      const wait = ok ? Math.max(0, minVisible - (performance.now() - handle.startedAt)) : 0;
      setTimeout(() => { if (ok) handle.done(); else handle.fail(); setTimeout(resolve, ok && !reduced() ? 380 : 0); }, wait);
    });
    return guarded.then(
      async (value) => { await settle(true); return value; },
      async (error) => { await settle(false); throw error; }
    );
  }

  window.TammhaLoader = Object.freeze({ show, track, TimeoutError });
})();
