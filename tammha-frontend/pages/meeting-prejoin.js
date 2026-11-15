// ===== Pre-join (meeting-prejoin.html?id=…) =====
// GET /meetings/:id → title, time and whether the join window is open (the server decides).
// Microphone / camera preview stays on this device; the choice is passed to the room in
// sessionStorage ("tammha-prejoin"). The room asks the server for a LiveKit token.
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession;
  const { T } = UI;
  const $ = (id) => document.getElementById(id);
  const id = new URLSearchParams(location.search).get('id');
  let mic = true; let cam = false; let stream = null;
  const video = $('prejoinVideo'); const avatar = $('prejoinAvatar');
  const save = () => { try { sessionStorage.setItem('tammha-prejoin', JSON.stringify({ mic, cam })); } catch (e) { /* ignore */ } };
  async function ensureStream() { if (stream) return stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); video.srcObject = stream; return stream; } catch (e) { $('prejoinError').textContent = T('لم يُسمح بالوصول إلى الميكروفون أو الكاميرا من المتصفح.', 'The browser did not allow access to the microphone or camera.'); return null; } }
  function renderDevice(btn, on, onText, offText, statusId) { btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', String(on)); $(statusId).textContent = on ? onText : offText; btn.querySelector('small').textContent = on ? T('اضغط للإيقاف', 'Press to turn off') : T('اضغط للتشغيل', 'Press to turn on'); }
  $('toggleMic').onclick = () => { mic = !mic; save(); renderDevice($('toggleMic'), mic, T('الميكروفون يعمل', 'Microphone is on'), T('الميكروفون غير مفعل', 'Microphone is off'), 'micStatus'); ensureStream().then((st) => st && st.getAudioTracks().forEach((t) => { t.enabled = mic; })); };
  $('toggleCamera').onclick = () => { cam = !cam; save(); renderDevice($('toggleCamera'), cam, T('الكاميرا تعمل', 'Camera is on'), T('الكاميرا غير مفعلة', 'Camera is off'), 'cameraStatus'); video.hidden = !cam; avatar.hidden = cam; (cam ? ensureStream() : Promise.resolve(stream)).then((st) => st && st.getVideoTracks().forEach((t) => { t.enabled = cam; })); };
  $('joinMeetingNow').addEventListener('click', () => { save(); if (stream) stream.getTracks().forEach((t) => t.stop()); });
  save();
  S.ready.then(async () => {
    const back = S.user.role === 'SUPERVISOR' ? 'supervisor-meetings.html' : 'meetings.html';
    document.querySelector('.prejoin-v43-back').href = back;
    if (S.user.role === 'SUPERVISOR') document.body.classList.add('sv-meeting');
    avatar.textContent = UI.initial(UI.personName(S.user));
    const join = $('joinMeetingNow');
    if (!id) { $('prejoinError').textContent = T('لم يُحدد الاجتماع.', 'No meeting was selected.'); join.hidden = true; return; }
    try {
      const m = await Api.get(`/meetings/${encodeURIComponent(id)}`);
      $('prejoinMeetingTitle').textContent = m.title;
      $('prejoinWhen').textContent = `${UI.fmtDate(m.scheduledAt)} · ${UI.fmtTime(m.scheduledAt)} - ${UI.fmtTime(m.endsAt)}`;
      join.href = `meeting-room.html?id=${encodeURIComponent(m.id)}`;
      if (m.status === 'CANCELLED') { $('prejoinError').textContent = T('الاجتماع ملغى.', 'The meeting is cancelled.'); join.hidden = true; }
      else if (!m.join?.isOpen) { $('prejoinError').textContent = T(`يُفتح الدخول ${UI.fmtDateTime(m.join?.opensAt)}.`, `Joining opens ${UI.fmtDateTime(m.join?.opensAt)}.`); join.setAttribute('aria-disabled', 'true'); join.classList.add('is-disabled'); join.addEventListener('click', (e) => e.preventDefault()); }
    } catch (e) { $('prejoinError').textContent = Api.message(e); join.hidden = true; }
  });
})();
