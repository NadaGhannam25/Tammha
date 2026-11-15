// ===== Meeting room (meeting-room.html?id=…) — LiveKit through the backend =====
//   GET  /meetings/:id           title, project, participants (only members of the meeting's project)
//   POST /meetings/:id/token     short-lived LiveKit token + server URL (only participants, only while
//                                the join window is open: MEETING_NOT_OPEN_YET otherwise)
// The LiveKit browser SDK (vendor/livekit-client, Apache-2.0) connects with that token; no LiveKit key
// is ever in the frontend. Chat uses LiveKit data messages (topic "chat"; not stored).
// Microphone / camera choices come from the pre-join page (sessionStorage "tammha-prejoin").
// Leaving disconnects and opens the meetings page with the notes dialog (?ended=<id>).
(function () {
  'use strict';
  const Api = window.TammhaApi; const UI = window.TammhaUI; const S = window.TammhaSession;
  const { T, esc } = UI;
  const $ = (id) => document.getElementById(id);
  const LK = window.LivekitClient;
  const id = new URLSearchParams(location.search).get('id');
  const stage = $('roomStage'); const people = $('roomPeople'); const chat = $('roomChatMessages');
  let room = null; let leaving = false; let meeting = null; let timer = 0;
  const encoder = new TextEncoder(); const decoder = new TextDecoder();
  let prefs = { mic: true, cam: false };
  try { prefs = Object.assign(prefs, JSON.parse(sessionStorage.getItem('tammha-prejoin') || '{}')); } catch (e) { /* defaults */ }

  const backPage = () => (S.user && S.user.role === 'SUPERVISOR' ? 'supervisor-meetings.html' : 'meetings.html');
  function conn(text, ok) { $('roomConn').textContent = text; $('roomConn').className = `app-chip${ok ? '' : ' app-chip--muted'}`; }
  function fail(text) { $('roomError').hidden = false; $('roomErrorText').textContent = text; conn(T('غير متصل', 'Not connected'), false); }
  function roleOf(p) {
    try { const md = JSON.parse(p.metadata || '{}'); return md.role === 'SUPERVISOR' ? T('المشرف الأكاديمي', 'Academic supervisor') : T('عضو الفريق', 'Team member'); } catch (e) { return ''; }
  }

  // ----- render participants -----
  function allParticipants() { return room ? [room.localParticipant, ...room.remoteParticipants.values()] : []; }
  function render() {
    const list = allParticipants();
    $('roomPeopleCount').textContent = String(list.length);
    stage.innerHTML = '';
    list.forEach((p, i) => {
      const tile = document.createElement('article');
      tile.className = `meeting-tile${i === 0 ? ' meeting-tile--main' : ''}${p.isSpeaking ? ' is-speaking' : ''}`;
      const name = p.name || p.identity;
      const cam = [...p.videoTrackPublications.values()].find((pub) => pub.track && !pub.isMuted);
      if (cam) { const v = cam.track.attach(); v.className = 'meeting-tile-video'; v.muted = p === room.localParticipant; tile.append(v); }
      else tile.insertAdjacentHTML('beforeend', `<div class="meeting-tile-avatar${i ? ' meeting-tile-avatar--soft' : ''}">${esc(UI.initial(name))}</div>`);
      tile.insertAdjacentHTML('beforeend', `<span>${esc(name)}</span><small>${esc(p === room.localParticipant ? T('أنت', 'You') : roleOf(p))}</small>`);
      stage.append(tile);
    });
    people.innerHTML = list.map((p) => {
      const st = p.isSpeaking ? 'speaking' : p.isMicrophoneEnabled ? 'on' : 'muted';
      const label = { speaking: T('يتحدث', 'Speaking'), on: T('الميكروفون مفتوح', 'Microphone on'), muted: T('صامت', 'Muted') }[st];
      const name = p.name || p.identity;
      return `<li><span class="room-people__avatar">${esc(UI.initial(name))}</span><div><b>${esc(name)}</b><small>${esc(p === room.localParticipant ? T('أنت', 'You') : roleOf(p))}</small></div><span class="room-people__state" data-state="${st}"><span>${esc(label)}</span></span></li>`;
    }).join('');
    // remote audio
    list.forEach((p) => { if (p === room.localParticipant) return; p.audioTrackPublications.forEach((pub) => { if (pub.track && !pub.track.attachedElements.length) document.body.append(Object.assign(pub.track.attach(), { hidden: true })); }); });
    syncButtons();
  }
  function syncButtons() {
    if (!room) return;
    const lp = room.localParticipant;
    [['roomMic', lp.isMicrophoneEnabled], ['roomCamera', lp.isCameraEnabled], ['roomShare', lp.isScreenShareEnabled]].forEach(([bid, on]) => { const b = $(bid); b.classList.toggle('is-on', !!on); b.setAttribute('aria-pressed', String(!!on)); });
  }
  function addChat(from, text, mine) {
    const msg = document.createElement('div'); msg.className = `room-chat__message${mine ? ' room-chat__message--mine' : ''}`;
    msg.innerHTML = `<b></b><p></p><small>${esc(UI.fmtTime(new Date()))}</small>`;
    msg.querySelector('b').textContent = mine ? T('أنت', 'You') : from; msg.querySelector('p').textContent = text;
    chat.append(msg); chat.scrollTop = chat.scrollHeight;
  }

  // ----- connect -----
  async function connect() {
    $('roomError').hidden = true; conn(T('جارٍ الاتصال…', 'Connecting…'), false);
    if (!LK) { fail(T('تعذّر تحميل مكتبة الاجتماعات المرئية.', 'The video meeting library could not be loaded.')); return; }
    let token;
    try { token = await Api.post(`/meetings/${encodeURIComponent(id)}/token`, {}, { loader: { label: T('جارٍ تجهيز الاجتماع…', 'Preparing the meeting…') } }); }
    catch (e) { fail(Api.message(e)); return; }
    room = new LK.Room({ adaptiveStream: true, dynacast: true });
    const E = LK.RoomEvent;
    [E.ParticipantConnected, E.ParticipantDisconnected, E.TrackSubscribed, E.TrackUnsubscribed, E.TrackMuted, E.TrackUnmuted, E.LocalTrackPublished, E.LocalTrackUnpublished, E.ActiveSpeakersChanged].forEach((ev) => room.on(ev, render));
    room.on(E.Reconnecting, () => conn(T('جارٍ إعادة الاتصال…', 'Reconnecting…'), false));
    room.on(E.Reconnected, () => conn(T('متصل', 'Connected'), true));
    room.on(E.Disconnected, () => { if (!leaving) fail(T('انقطع الاتصال بالاجتماع.', 'The connection to the meeting was lost.')); });
    room.on(E.DataReceived, (payload, participant, kind, topic) => {
      if (topic !== 'chat') return;
      try { const m = JSON.parse(decoder.decode(payload)); if (m.text) addChat(participant ? participant.name || participant.identity : '', String(m.text).slice(0, 2000), false); } catch (e) { /* ignore */ }
    });
    try {
      await Promise.race([room.connect(token.serverUrl, token.token), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
    } catch (e) {
      try { await room.disconnect(); } catch (x) { /* ignore */ }
      room = null;
      fail(T('تعذّر الاتصال بخادم الاجتماعات. تحقق من الاتصال ثم أعد المحاولة.', 'Could not connect to the meeting server. Check the connection and try again.'));
      return;
    }
    conn(T('متصل', 'Connected'), true);
    render();
    // devices start in the background: a slow or blocked device never holds the room
    const limit = (pr) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))]);
    if (prefs.mic) limit(room.localParticipant.setMicrophoneEnabled(true)).then(render, () => { UI.toast(T('تعذّر تشغيل الميكروفون. جرّب زر الميكروفون مرة أخرى.', 'The microphone could not be turned on. Try the microphone button again.'), 'error'); render(); });
    if (prefs.cam) limit(room.localParticipant.setCameraEnabled(true)).then(render, () => { UI.toast(T('تعذّر تشغيل الكاميرا. جرّب زر الكاميرا مرة أخرى.', 'The camera could not be turned on. Try the camera button again.'), 'error'); render(); });
    const started = Date.now(); clearInterval(timer);
    timer = setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); $('roomTime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 1000);
  }

  // ----- toolbar -----
  async function toggle(kind) {
    if (!room) return;
    const lp = room.localParticipant;
    const limit = (pr) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))]);
    try {
      if (kind === 'mic') await limit(lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled));
      if (kind === 'cam') await limit(lp.setCameraEnabled(!lp.isCameraEnabled));
      if (kind === 'share') await limit(lp.setScreenShareEnabled(!lp.isScreenShareEnabled));
    } catch (e) { UI.toast(T('تعذّر الوصول إلى الجهاز أو الشاشة.', 'The device or screen could not be accessed.'), 'error'); }
    render();
  }
  $('roomMic').onclick = () => toggle('mic'); $('roomCamera').onclick = () => toggle('cam'); $('roomShare').onclick = () => toggle('share');
  $('roomRetry').onclick = () => connect();
  $('exitMeeting').onclick = async () => {
    leaving = true;
    try { if (room) await room.disconnect(); } catch (e) { /* ignore */ }
    location.href = `${backPage()}?ended=${encodeURIComponent(id || '')}`;
  };
  window.addEventListener('beforeunload', () => { leaving = true; try { room && room.disconnect(); } catch (e) { /* ignore */ } });

  // one side panel shared by chat and participants
  const body = $('roomBody'); const side = $('roomSide'); const sideTitle = $('roomSideTitle');
  const panelButtons = document.querySelectorAll('[data-room-panel]'); let openPanel = null;
  function setPanel(name) {
    openPanel = name; side.hidden = !name; body.classList.toggle('has-panel', !!name);
    panelButtons.forEach((b) => { const on = b.dataset.roomPanel === name; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); });
    side.querySelectorAll('[data-room-view]').forEach((v) => { v.hidden = v.dataset.roomView !== name; });
    if (name) sideTitle.textContent = name === 'chat' ? T('المحادثة', 'Chat') : T('المشاركون', 'Participants');
    if (name === 'chat') $('roomChatText').focus();
  }
  panelButtons.forEach((b) => b.addEventListener('click', () => setPanel(openPanel === b.dataset.roomPanel ? null : b.dataset.roomPanel)));
  $('closeRoomSide').addEventListener('click', () => setPanel(null));
  $('roomChatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('roomChatText'); const text = input.value.trim(); if (!text) return;
    if (!room) { UI.toast(T('لا يوجد اتصال بالاجتماع.', 'Not connected to the meeting.'), 'error'); return; }
    try { await room.localParticipant.publishData(encoder.encode(JSON.stringify({ text })), { reliable: true, topic: 'chat' }); addChat('', text, true); input.value = ''; }
    catch (err) { UI.toast(T('تعذّر إرسال الرسالة.', 'The message could not be sent.'), 'error'); }
  });

  // read-only handle for diagnostics in the browser console (connection state, tracks)
  window.TammhaMeetingRoom = Object.freeze({ get room() { return room; } });

  S.ready.then(async () => {
    $('roomBack').href = backPage();
    if (S.user.role === 'SUPERVISOR') document.body.classList.add('sv-meeting');
    if (!id) { fail(T('لم يُحدد الاجتماع. افتحه من صفحة الاجتماعات.', 'No meeting was selected. Open it from the meetings page.')); $('roomRetry').hidden = true; return; }
    try {
      meeting = await Api.get(`/meetings/${encodeURIComponent(id)}`);
      $('roomTitle').textContent = meeting.title; document.title = `${T('تممها', 'Tammha')} | ${meeting.title}`;
    } catch (e) { fail(Api.message(e)); $('roomRetry').hidden = true; return; }
    connect();
  });
})();
