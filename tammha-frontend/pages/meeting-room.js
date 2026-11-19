// ===== Meeting room (meeting-room.html?id=…) — LiveKit through the backend =====
//   GET  /meetings/:id           title, project, participants (only members of the meeting's project)
//   POST /meetings/:id/token     short-lived LiveKit token + server URL (only participants, only while
//                                the join window is open: MEETING_NOT_OPEN_YET otherwise)
// The LiveKit browser SDK (vendor/livekit-client, Apache-2.0) connects with that token; no LiveKit key
// is ever in the frontend. Chat uses LiveKit data messages (topic "chat"; not stored).
// Microphone / camera choices come from the pre-join page (sessionStorage "tammha-prejoin").
// Leaving disconnects and opens the meetings page with the notes dialog (?ended=<id>).
// The organiser (or the project supervisor) can also end the meeting for everyone:
//   POST /meetings/:id/end closes the room; a "control" data message tells everyone to leave.
// A shared screen gets its own large tile (fitted, never cropped) with a full-screen button.
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
  function conn(text, state) { const c = $('roomConn'); c.textContent = text; c.dataset.state = state === true ? 'ok' : state || 'pending'; }
  function fail(text) { $('roomError').hidden = false; $('roomErrorText').textContent = text; conn(T('غير متصل', 'Not connected'), 'off'); }
  function roleOf(p) {
    try { const md = JSON.parse(p.metadata || '{}'); return md.role === 'SUPERVISOR' ? T('المشرف الأكاديمي', 'Academic supervisor') : T('عضو الفريق', 'Team member'); } catch (e) { return ''; }
  }
  const userOf = (p) => ((meeting && meeting.participants) || []).map((x) => x.user).find((u) => u && u.id === p.identity) || { firstName: p.name || p.identity };

  // ----- icons (microphone state / speaking) -----
  const ICON = {
    mic: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"></path></svg>',
    micOff: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"></path><path d="M4 4l16 16"></path></svg>',
    speaking: '<svg aria-hidden="true" class="room-wave" viewBox="0 0 24 24"><path d="M5 10v4"></path><path d="M9 7v10"></path><path d="M13 4v16"></path><path d="M17 8v8"></path><path d="M21 11v2"></path></svg>',
    expand: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path></svg>',
    screen: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>',
  };
  function micState(p) { return p.isSpeaking && p.isMicrophoneEnabled ? 'speaking' : p.isMicrophoneEnabled ? 'on' : 'muted'; }
  function micBadge(p) {
    const st = micState(p);
    const label = { speaking: T('يتحدث', 'Speaking'), on: T('الميكروفون يعمل', 'Microphone on'), muted: T('الميكروفون مغلق', 'Microphone off') }[st];
    return `<span class="room-mic" data-state="${st}" title="${esc(label)}" role="img" aria-label="${esc(label)}">${st === 'speaking' ? ICON.speaking : st === 'on' ? ICON.mic : ICON.micOff}</span>`;
  }

  // ----- render participants -----
  const Src = (LK && LK.Track && LK.Track.Source) || { Camera: 'camera', ScreenShare: 'screen_share' };
  const pubOf = (p, source) => [...p.videoTrackPublications.values()].find((pub) => pub.source === source && pub.track && !pub.isMuted);
  // one <video> per track, reused between renders (no flicker, no leaked elements)
  const videos = new Map();
  function videoFor(pub) {
    let v = videos.get(pub.trackSid);
    if (!v) { v = pub.track.attach(); v.muted = true; v.playsInline = true; videos.set(pub.trackSid, v); }
    return v;
  }
  function dropUnusedVideos(live) {
    videos.forEach((v, sid) => { if (!live.has(sid)) { try { v.srcObject = null; } catch (e) { /* ignore */ } v.remove(); videos.delete(sid); } });
  }
  function allParticipants() { return room ? [room.localParticipant, ...room.remoteParticipants.values()] : []; }

  stage.innerHTML = '<div class="room-main" id="roomMain"></div><div class="room-strip" id="roomStrip"></div>';
  const mainEl = $('roomMain'); const stripEl = $('roomStrip');
  // the shared-screen tile stays the same element while the screen is shared (full screen keeps working)
  const screenBox = document.createElement('section');
  screenBox.className = 'meeting-screen';
  screenBox.setAttribute('aria-label', T('الشاشة المعروضة', 'Shared screen'));

  function tileFor(p, small) {
    const el = document.createElement('article');
    el.className = `meeting-tile ${small ? 'meeting-tile--small' : 'meeting-tile--main'}${micState(p) === 'speaking' ? ' is-speaking' : ''}`;
    const cam = pubOf(p, Src.Camera);
    if (cam) { const v = videoFor(cam); v.className = 'meeting-tile-video'; el.append(v); }
    else el.insertAdjacentHTML('beforeend', `<div class="meeting-tile-avatar${p === room.localParticipant ? '' : ' meeting-tile-avatar--soft'}">${UI.avatarHtml(userOf(p), 'meeting-tile-avatar__img')}</div>`);
    const name = p.name || p.identity;
    el.insertAdjacentHTML('beforeend', `<div class="meeting-tile__label">${micBadge(p)}<b>${esc(name)}</b><small>${esc(p === room.localParticipant ? T('أنت', 'You') : roleOf(p))}</small></div>`);
    return el;
  }
  function paintScreen(presenter, pub) {
    if (screenBox.dataset.sid === pub.trackSid) return;
    screenBox.dataset.sid = pub.trackSid;
    const name = presenter.name || presenter.identity;
    const local = presenter === room.localParticipant;
    screenBox.innerHTML = '';
    if (local) {
      // your own shared screen is shown live (as the others see it), with a stop button
      const v = videoFor(pub); v.className = 'meeting-screen__video meeting-screen__video--self'; screenBox.append(v);
      screenBox.insertAdjacentHTML('beforeend', `<div class="meeting-screen__presenting"><b>${esc(T('أنت تعرض شاشتك الآن', 'You are presenting your screen'))}</b><button type="button" data-stop-share>${esc(T('إيقاف المشاركة', 'Stop sharing'))}</button></div>`);
    } else {
      const v = videoFor(pub); v.className = 'meeting-screen__video'; screenBox.append(v);
      screenBox.insertAdjacentHTML('beforeend', `<button class="meeting-screen__expand" type="button" data-expand>${ICON.expand}<span>${esc(T('ملء الشاشة', 'Full screen'))}</span></button>`);
    }
    screenBox.insertAdjacentHTML('beforeend', `<span class="meeting-screen__label">${ICON.screen}${esc(local ? T('شاشتك', 'Your screen') : T(`شاشة ${name}`, `${name}'s screen`))}</span>`);
  }
  screenBox.addEventListener('click', (e) => {
    if (e.target.closest('[data-stop-share]')) { toggle('share'); return; }
    if (e.target.closest('[data-expand]') || e.target.closest('video')) toggleFullscreen();
  });
  screenBox.addEventListener('dblclick', toggleFullscreen);
  function toggleFullscreen() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const req = screenBox.requestFullscreen || screenBox.webkitRequestFullscreen;
    if (req) req.call(screenBox); else screenBox.classList.toggle('is-expanded');
  }

  function render() {
    if (!room) return;
    const list = allParticipants();
    $('roomPeopleCount').textContent = String(list.length);
    const presenter = list.find((p) => pubOf(p, Src.ScreenShare));
    const live = new Set();
    list.forEach((p) => p.videoTrackPublications.forEach((pub) => { if (pub.track && !pub.isMuted) live.add(pub.trackSid); }));
    stage.classList.toggle('has-screen', !!presenter);
    if (presenter) {
      paintScreen(presenter, pubOf(presenter, Src.ScreenShare));
      if (mainEl.firstChild !== screenBox) mainEl.replaceChildren(screenBox);
      stripEl.replaceChildren(...list.map((p) => tileFor(p, true)));
    } else {
      if (document.fullscreenElement === screenBox) document.exitFullscreen().catch(() => {});
      screenBox.dataset.sid = '';
      mainEl.replaceChildren(tileFor(list[0], false));
      stripEl.replaceChildren(...list.slice(1).map((p) => tileFor(p, true)));
    }
    stage.classList.toggle('is-alone', !presenter && list.length < 2);
    dropUnusedVideos(live);

    people.innerHTML = list.map((p) => {
      const name = p.name || p.identity;
      return `<li>${UI.avatarHtml(userOf(p), 'room-people__avatar')}<div><b>${esc(name)}</b><small>${esc(p === room.localParticipant ? T('أنت', 'You') : roleOf(p))}</small></div>${pubOf(p, Src.ScreenShare) ? `<span class="room-mic" title="${esc(T('يعرض شاشته', 'Presenting'))}">${ICON.screen}</span>` : ''}${micBadge(p)}</li>`;
    }).join('');
    // remote audio
    list.forEach((p) => { if (p === room.localParticipant) return; p.audioTrackPublications.forEach((pub) => { if (pub.track && !pub.track.attachedElements.length) document.body.append(Object.assign(pub.track.attach(), { hidden: true })); }); });
    syncButtons();
  }
  function syncButtons() {
    if (!room) return;
    const lp = room.localParticipant;
    const labels = {
      roomMic: [T('إيقاف الميكروفون', 'Turn microphone off'), T('تشغيل الميكروفون', 'Turn microphone on')],
      roomCamera: [T('إيقاف الكاميرا', 'Turn camera off'), T('تشغيل الكاميرا', 'Turn camera on')],
      roomShare: [T('إيقاف مشاركة الشاشة', 'Stop sharing'), T('مشاركة الشاشة', 'Share screen')],
    };
    [['roomMic', lp.isMicrophoneEnabled], ['roomCamera', lp.isCameraEnabled], ['roomShare', lp.isScreenShareEnabled]].forEach(([bid, on]) => {
      const b = $(bid); b.classList.toggle('is-on', !!on); b.setAttribute('aria-pressed', String(!!on));
      b.setAttribute('aria-label', labels[bid][on ? 0 : 1]); b.title = labels[bid][on ? 0 : 1];
    });
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
    // the browser's own "Stop sharing" bar ends the screen share too
    room.on(E.LocalTrackUnpublished, () => setTimeout(render, 0));
    room.on(E.Reconnecting, () => conn(T('جارٍ إعادة الاتصال…', 'Reconnecting…'), false));
    room.on(E.Reconnected, () => conn(T('متصل', 'Connected'), true));
    room.on(E.Disconnected, (reason) => {
      if (leaving) return;
      const R = LK.DisconnectReason || {};
      if (reason !== undefined && reason === R.ROOM_DELETED) { endedByHost(); return; }
      fail(T('انقطع الاتصال بالاجتماع.', 'The connection to the meeting was lost.'));
    });
    room.on(E.DataReceived, (payload, participant, kind, topic) => {
      if (topic === 'control') {
        try { if (JSON.parse(decoder.decode(payload)).type === 'end') endedByHost(); } catch (e) { /* ignore */ }
        return;
      }
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
  async function leave() {
    leaving = true;
    try { if (room) await room.disconnect(); } catch (e) { /* ignore */ }
    location.href = `${backPage()}?ended=${encodeURIComponent(id || '')}`;
  }
  // someone else ended the meeting for everyone
  function endedByHost() {
    if (leaving) return;
    UI.toast(T('أنهى المنظِّم الاجتماع.', 'The organiser ended the meeting.'));
    setTimeout(leave, 900);
    leaving = true;
  }
  $('exitMeeting').onclick = () => leave();
  // "Leave" with an arrow beside it (like Teams): the arrow opens "End meeting" under it (managers only)
  const leaveMenu = $('leaveMenu');
  const setLeaveMenu = (open) => { leaveMenu.hidden = !open; $('leaveMore').setAttribute('aria-expanded', String(open)); };
  $('leaveMore').onclick = (e) => { e.stopPropagation(); setLeaveMenu(leaveMenu.hidden); };
  document.addEventListener('click', (e) => { if (!e.target.closest('#leaveSplit')) setLeaveMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setLeaveMenu(false); closeEndDialog(); } });
  const endDialog = $('endDialog');
  function closeEndDialog() { endDialog.hidden = true; }
  $('endMeeting').onclick = () => { setLeaveMenu(false); endDialog.hidden = false; $('endConfirm').focus(); };
  $('endCancel').onclick = closeEndDialog;
  endDialog.addEventListener('click', (e) => { if (e.target === endDialog) closeEndDialog(); });
  $('endConfirm').onclick = () => {
    UI.busy($('endConfirm'), async () => {
      // tell everyone first (works even if closing the room on the server is slow)
      try { if (room) await room.localParticipant.publishData(encoder.encode(JSON.stringify({ type: 'end' })), { reliable: true, topic: 'control' }); } catch (e) { /* ignore */ }
      await Api.post(`/meetings/${encodeURIComponent(id)}/end`, {});
      closeEndDialog();
      await leave();
    });
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
      $('roomTitle').textContent = meeting.title; document.title = meeting.title;
      $('endMeeting').hidden = !meeting.canManage; $('leaveMore').hidden = !meeting.canManage; $('leaveSplit').classList.toggle('has-menu', !!meeting.canManage);
    } catch (e) { fail(Api.message(e)); $('roomRetry').hidden = true; return; }
    connect();
  });
})();
