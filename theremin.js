(function(){
  "use strict";

  const WS_URL = 'wss://music-art-production.up.railway.app';

  const canvas = document.getElementById('theremin-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const FREQ_MIN = 130.81;
  const FREQ_MAX = 1046.5;
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  let W = 0, H = 0, dpr = 1;

  function resize(){
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    W = r.width; H = r.height;
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function xToGain(x){ return Math.max(0, Math.min(1, x / W)); }
  function yToFreq(y){ return FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, 1 - y / H); }
  function freqToNoteName(freq){
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  // ----- sound presets -----
  const SOUND_PRESETS = [
    { id: 'sine',     type: 'sine',     en: 'Flute',   ua: 'Флейта' },
    { id: 'triangle', type: 'triangle', en: 'Crystal', ua: 'Кришталь' },
    { id: 'sawtooth', type: 'sawtooth', en: 'Strings', ua: 'Струни' },
    { id: 'square',   type: 'square',   en: 'Organ',   ua: 'Орган' },
  ];
  let currentSound = 'triangle';
  let userName = localStorage.getItem('pond_name') || '';

  // ----- audio -----
  let audioCtx = null;
  let masterGain = null;
  const voices = new Map(); // pointerId -> { osc, vol }

  function getAudioCtx(){
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // All audio routes through masterGain so MediaRecorder can capture everything
  function getMaster(){
    if (!masterGain){
      const ac = getAudioCtx();
      masterGain = ac.createGain();
      masterGain.connect(ac.destination);
    }
    return masterGain;
  }

  function unlockAudio(){
    const ac = getAudioCtx();
    try {
      const buf = ac.createBuffer(1, 1, ac.sampleRate);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      src.start(0);
    } catch(e) {}
    if (ac.state === 'suspended') ac.resume();
  }

  function startVoice(id, freq, gain){
    if (voices.has(id)) return;
    const ac = getAudioCtx();
    const osc = ac.createOscillator();
    const vol = ac.createGain();
    osc.type = SOUND_PRESETS.find(p => p.id === currentSound)?.type ?? 'triangle';
    osc.frequency.value = freq;
    vol.gain.value = gain * 0.7;
    osc.connect(vol);
    vol.connect(getMaster());
    osc.start();
    voices.set(id, { osc, vol });
  }

  function updateVoice(id, freq, gain){
    if (!voices.has(id)) return;
    const { osc, vol } = voices.get(id);
    const now = getAudioCtx().currentTime;
    osc.frequency.setTargetAtTime(freq, now, 0.03);
    vol.gain.setTargetAtTime(gain * 0.7, now, 0.03);
  }

  function stopVoice(id){
    if (!voices.has(id)) return;
    const { osc, vol } = voices.get(id);
    const now = getAudioCtx().currentTime;
    vol.gain.setTargetAtTime(0.0001, now, 0.1);
    setTimeout(() => { try { osc.stop(); osc.disconnect(); vol.disconnect(); } catch(e){} }, 400);
    voices.delete(id);
  }

  // ----- pinned notes -----
  const pinnedNotes = []; // { id, x, y, osc, vol }
  let nextPinId = 0;
  let pinMode = false;

  function placePin(x, y){
    const ac = getAudioCtx();
    const type = SOUND_PRESETS.find(p => p.id === currentSound)?.type ?? 'triangle';
    const osc = ac.createOscillator();
    const vol = ac.createGain();
    osc.type = type;
    osc.frequency.value = yToFreq(y);
    vol.gain.setValueAtTime(0, ac.currentTime);
    vol.gain.linearRampToValueAtTime(xToGain(x) * 0.65, ac.currentTime + 0.02);
    osc.connect(vol);
    vol.connect(getMaster());
    osc.start();
    pinnedNotes.push({ id: nextPinId++, x, y, osc, vol });
  }

  function removePinNear(x, y){
    const idx = pinnedNotes.findIndex(p => Math.hypot(p.x - x, p.y - y) < 24);
    if (idx === -1) return false;
    const pin = pinnedNotes.splice(idx, 1)[0];
    const now = getAudioCtx().currentTime;
    pin.vol.gain.setTargetAtTime(0.0001, now, 0.08);
    setTimeout(() => { try { pin.osc.stop(); pin.osc.disconnect(); pin.vol.disconnect(); } catch(e){} }, 300);
    return true;
  }

  function clearPins(){
    if (!pinnedNotes.length) return;
    const now = getAudioCtx().currentTime;
    pinnedNotes.forEach(pin => {
      pin.vol.gain.setTargetAtTime(0.0001, now, 0.08);
      setTimeout(() => { try { pin.osc.stop(); pin.osc.disconnect(); pin.vol.disconnect(); } catch(e){} }, 300);
    });
    pinnedNotes.length = 0;
  }

  function togglePinMode(){
    pinMode = !pinMode;
    if (!pinMode) clearPins();
    const btn = document.getElementById('pin-btn');
    if (btn) btn.classList.toggle('active', pinMode);
  }

  // ----- recording (MP3 via lamejs) -----
  let recProcessor = null;
  let recSilent = null;
  let mp3Encoder = null;
  let mp3Chunks = [];
  let isRecording = false;

  function startRecording(){
    if (isRecording || !window.lamejs) return;
    const ac = getAudioCtx();
    mp3Encoder = new lamejs.Mp3Encoder(1, ac.sampleRate, 128);
    mp3Chunks = [];
    recProcessor = ac.createScriptProcessor(4096, 1, 1);
    recSilent = ac.createGain();
    recSilent.gain.value = 0;
    getMaster().connect(recProcessor);
    recProcessor.connect(recSilent);
    recSilent.connect(ac.destination);
    recProcessor.onaudioprocess = e => {
      const samples = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++){
        const s = Math.max(-1, Math.min(1, samples[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      const buf = mp3Encoder.encodeBuffer(int16);
      if (buf.length > 0) mp3Chunks.push(new Uint8Array(buf));
    };
    isRecording = true;
    updateRecBtn();
  }

  function stopRecording(){
    if (!isRecording) return;
    recProcessor.disconnect(); recProcessor.onaudioprocess = null; recProcessor = null;
    recSilent.disconnect(); recSilent = null;
    const tail = mp3Encoder.flush();
    if (tail.length > 0) mp3Chunks.push(new Uint8Array(tail));
    mp3Encoder = null;
    isRecording = false;
    updateRecBtn();
    const blob = new Blob(mp3Chunks, { type: 'audio/mp3' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'theremin-' + Date.now() + '.mp3';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    mp3Chunks = [];
  }

  function toggleRecording(){
    if (isRecording) stopRecording(); else startRecording();
  }

  function updateRecBtn(){
    const btn = document.getElementById('rec-btn');
    if (!btn) return;
    btn.classList.toggle('recording', isRecording);
    const icon = isRecording
      ? `<svg viewBox="0 0 24 24" width="12" height="12"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`
      : `<svg viewBox="0 0 24 24" width="12" height="12"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>`;
    btn.innerHTML = icon + `<span>${isRecording ? strings.recStop : strings.recStart}</span>`;
  }

  // ----- room / WebSocket -----
  const MY_HUE = 200;
  const ownTouches  = new Map(); // pointerId -> { x, y }
  const remotePlayers = new Map(); // playerId -> { touches, hue, voices[] }
  const REMOTE_HUES = [18, 150, 280, 55, 320];
  let nextHue = 0;
  let ws = null, wsRoom = null;

  // ----- remote audio -----
  function stopAllRemoteVoices(player){
    player.voices.forEach(v => {
      if (!v) return;
      const now = getAudioCtx().currentTime;
      v.vol.gain.setTargetAtTime(0.0001, now, 0.1);
      setTimeout(() => { try { v.osc.stop(); v.osc.disconnect(); v.vol.disconnect(); } catch(e){} }, 400);
    });
    player.voices = [];
  }

  function reconcileRemoteVoices(player, rawTouches, soundType){
    const ac = audioCtx;
    if (!ac || ac.state !== 'running'){
      player.touches = rawTouches.map(t => ({ x: t.x * W, y: t.y * H }));
      return;
    }
    const now     = ac.currentTime;
    const oscType = SOUND_PRESETS.find(p => p.id === soundType)?.type ?? 'triangle';

    rawTouches.forEach((t, i) => {
      const freq = yToFreq(t.y * H);
      const gain = xToGain(t.x * W) * 0.55;
      if (player.voices[i]){
        player.voices[i].osc.frequency.setTargetAtTime(freq, now, 0.03);
        player.voices[i].vol.gain.setTargetAtTime(gain, now, 0.03);
        player.voices[i].osc.type = oscType;
      } else {
        const osc = ac.createOscillator();
        const vol = ac.createGain();
        osc.type = oscType;
        osc.frequency.value = freq;
        vol.gain.setValueAtTime(0, now);
        vol.gain.linearRampToValueAtTime(gain, now + 0.02);
        osc.connect(vol);
        vol.connect(getMaster());
        osc.start();
        player.voices[i] = { osc, vol };
      }
    });

    for (let i = rawTouches.length; i < player.voices.length; i++){
      const v = player.voices[i];
      if (!v) continue;
      v.vol.gain.setTargetAtTime(0.0001, now, 0.1);
      setTimeout(() => { try { v.osc.stop(); v.osc.disconnect(); v.vol.disconnect(); } catch(e){} }, 400);
    }
    player.voices.length = rawTouches.length;
    player.touches = rawTouches.map(t => ({ x: t.x * W, y: t.y * H }));
  }

  function connectAndJoin(roomCode){
    setRoomState('joining');
    if (ws){ ws.onclose = null; ws.close(); }
    ws = new WebSocket(WS_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: roomCode }));
    ws.onmessage = ({ data }) => {
      let msg; try { msg = JSON.parse(data); } catch(e){ return; }
      if (msg.type === 'joined'){
        wsRoom = msg.room;
        (msg.existingPlayers || []).forEach(id => {
          if (!remotePlayers.has(id))
            remotePlayers.set(id, { touches: [], hue: REMOTE_HUES[nextHue++ % REMOTE_HUES.length], voices: [] });
        });
        setRoomState('joined', { room: msg.room, count: msg.playerCount });
      }
      if (msg.type === 'player_joined'){
        if (!remotePlayers.has(msg.playerId))
          remotePlayers.set(msg.playerId, { touches: [], hue: REMOTE_HUES[nextHue++ % REMOTE_HUES.length], voices: [] });
        updatePlayersDisplay();
        showToast(strings.playerJoined);
        playCrystal();
      }
      if (msg.type === 'move'){
        const p = remotePlayers.get(msg.playerId);
        if (p) reconcileRemoteVoices(p, msg.touches || [], msg.sound);
      }
      if (msg.type === 'player_left'){
        const p = remotePlayers.get(msg.playerId);
        if (p) stopAllRemoteVoices(p);
        remotePlayers.delete(msg.playerId);
        updatePlayersDisplay();
      }
      if (msg.type === 'error'){
        setRoomState('error', msg.msg === 'room_full' ? strings.roomFull : strings.connFailed);
      }
    };
    ws.onclose = () => {
      wsRoom = null;
      for (const p of remotePlayers.values()) stopAllRemoteVoices(p);
      remotePlayers.clear();
      setRoomState('idle');
      updatePlayersDisplay();
    };
    ws.onerror = () => setRoomState('error', strings.connFailed);
  }

  function leaveRoom(){
    wsRoom = null;
    for (const p of remotePlayers.values()) stopAllRemoteVoices(p);
    remotePlayers.clear();
    if (ws){ ws.onclose = null; ws.close(); ws = null; }
    updatePlayersDisplay();
    setRoomState('idle');
  }

  function sendMove(){
    if (!ws || ws.readyState !== WebSocket.OPEN || !wsRoom || !W) return;
    ws.send(JSON.stringify({
      type: 'move',
      sound: currentSound,
      touches: [...ownTouches.values()].map(t => ({ x: t.x / W, y: t.y / H }))
    }));
  }

  // ----- i18n -----
  const LANGS = {
    en: {
      join: 'Join',
      roomPlaceholder: 'room code',
      roomFull: 'Room is full', connFailed: 'Connection failed',
      players: n => `In the room: ${n}`,
      roomPrefix: 'Room #',
      modalTitle: 'Enter a room code',
      playerJoined: 'A new player joined',
      playAlone: 'or play alone',
      pinMode: 'Notes', recStart: 'Record', recStop: 'Stop',
      loud: 'loud', silent: 'silent', high: 'high', low: 'low',
      langSwitch: 'UA',
      nameTitle: 'What is your name?',
      namePlaceholder: 'your name',
      nameConfirm: 'Continue',
    },
    ua: {
      join: 'Увійти',
      roomPlaceholder: 'код кімнати',
      roomFull: 'Кімната заповнена', connFailed: 'Помилка з\'єднання',
      players: n => `У кімнаті: ${n}`,
      roomPrefix: 'Кімната #',
      modalTitle: 'Введіть код кімнати',
      playerJoined: 'Новий гравець приєднався',
      playAlone: 'або грати самому',
      pinMode: 'Ноти', recStart: 'Запис', recStop: 'Зупинити',
      loud: 'гучно', silent: 'тихо', high: 'високо', low: 'низько',
      langSwitch: 'EN',
      nameTitle: 'Як вас звати?',
      namePlaceholder: 'ваше ім\'я',
      nameConfirm: 'Продовжити',
    },
  };

  let currentLang = 'ua';
  let strings = LANGS.ua;

  function applyStrings(){
    const langBtn         = document.getElementById('langbtn');
    const joinLabel       = document.getElementById('room-join-label');
    const inp             = document.getElementById('room-input');
    const modalTitle      = document.getElementById('room-modal-title');
    const soloBtn         = document.getElementById('solo-btn');
    const pinSpan         = document.querySelector('#pin-btn span');
    const nameTitleEl     = document.getElementById('name-modal-title');
    const nameInput       = document.getElementById('name-input');
    const nameConfirmLabel = document.getElementById('name-confirm-label');
    if (langBtn)          langBtn.textContent          = strings.langSwitch;
    if (joinLabel)        joinLabel.textContent        = strings.join;
    if (inp)              inp.placeholder              = strings.roomPlaceholder;
    if (modalTitle)       modalTitle.textContent       = strings.modalTitle;
    if (soloBtn)          soloBtn.textContent          = strings.playAlone;
    if (pinSpan)          pinSpan.textContent          = strings.pinMode;
    if (nameTitleEl)      nameTitleEl.textContent      = strings.nameTitle;
    if (nameInput)        nameInput.placeholder        = strings.namePlaceholder;
    if (nameConfirmLabel) nameConfirmLabel.textContent = strings.nameConfirm;
    updatePlayersDisplay();
    buildSoundSelector();
    updateRecBtn();
  }

  // ----- room UI -----
  function setRoomState(state, data){
    const backdrop = document.getElementById('room-modal-backdrop');
    const errorEl  = document.getElementById('room-error');
    const inp      = document.getElementById('room-input');
    const btn      = document.getElementById('room-join-btn');
    const codeInfo = document.getElementById('room-code-info');
    if (!backdrop) return;
    if (state === 'idle'){
      backdrop.classList.add('visible');
      if (errorEl) errorEl.hidden = true;
      if (inp){ inp.disabled = false; inp.value = ''; inp.focus(); }
      if (btn) btn.disabled = false;
      if (codeInfo) codeInfo.textContent = '';
    }
    if (state === 'joining'){
      if (inp) inp.disabled = true;
      if (btn) btn.disabled = true;
    }
    if (state === 'joined'){
      backdrop.classList.remove('visible');
      if (codeInfo) codeInfo.textContent = strings.roomPrefix + data.room;
      updatePlayersDisplay();
    }
    if (state === 'error'){
      if (errorEl){ errorEl.hidden = false; errorEl.textContent = data; }
      if (inp) inp.disabled = false;
      if (btn) btn.disabled = false;
      setTimeout(() => { if (errorEl) errorEl.hidden = true; }, 3000);
    }
  }

  function updatePlayersDisplay(){
    const infoEl   = document.getElementById('theremin-players');
    const codeInfo = document.getElementById('room-code-info');
    if (infoEl)   infoEl.textContent   = wsRoom ? strings.players(1 + remotePlayers.size) : '';
    if (codeInfo) codeInfo.textContent = wsRoom ? strings.roomPrefix + wsRoom : '';
  }

  function playCrystal(){
    const ac = getAudioCtx();
    if (!ac || ac.state !== 'running') return;
    const now = ac.currentTime;
    [[1046.5, 0.10], [1568.0, 0.055]].forEach(([freq, peak]) => {
      const osc = ac.createOscillator();
      const vol = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      vol.gain.setValueAtTime(0, now);
      vol.gain.linearRampToValueAtTime(peak, now + 0.008);
      vol.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
      osc.connect(vol);
      vol.connect(getMaster());
      osc.start(now); osc.stop(now + 1.2);
    });
  }

  let toastTimer = null;
  function showToast(msg){
    let el = document.getElementById('toast');
    if (!el){
      el = document.createElement('div');
      el.id = 'toast'; el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
  }

  function handleJoin(){
    unlockAudio();
    const inp = document.getElementById('room-input');
    if (!inp) return;
    const code = inp.value.trim().toUpperCase();
    if (code) connectAndJoin(code);
  }

  function buildSoundSelector(){
    const container = document.getElementById('sound-selector');
    if (!container) return;
    container.innerHTML = '';
    SOUND_PRESETS.forEach(preset => {
      const btn = document.createElement('button');
      btn.className = 'sound-btn' + (preset.id === currentSound ? ' active' : '');
      btn.dataset.sound = preset.id;
      btn.textContent = preset[currentLang];
      btn.addEventListener('click', () => {
        currentSound = preset.id;
        container.querySelectorAll('.sound-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const type = preset.type;
        for (const { osc } of voices.values()) osc.type = type;
        for (const pin of pinnedNotes) pin.osc.type = type;
      });
      container.appendChild(btn);
    });
  }

  function bindRoomUI(){
    document.getElementById('room-join-btn')?.addEventListener('click', handleJoin);
    const inp = document.getElementById('room-input');
    if (inp){
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') handleJoin(); });
      inp.addEventListener('input',   e => { e.target.value = e.target.value.toUpperCase(); });
    }
    document.getElementById('langbtn')?.addEventListener('click', () => {
      currentLang = currentLang === 'en' ? 'ua' : 'en';
      strings = LANGS[currentLang];
      applyStrings();
    });
    document.getElementById('solo-btn')?.addEventListener('click', () => {
      unlockAudio();
      document.getElementById('room-modal-backdrop')?.classList.remove('visible');
      updatePlayersDisplay();
    });
    document.getElementById('pin-btn')?.addEventListener('click', togglePinMode);
    document.getElementById('rec-btn')?.addEventListener('click', toggleRecording);
  }

  // ----- name modal -----
  function confirmName(){
    const inp = document.getElementById('name-input');
    const name = inp?.value.trim() || '';
    if (!name) { inp?.focus(); return; }
    userName = name;
    localStorage.setItem('pond_name', name);
    unlockAudio();
    document.getElementById('name-modal-backdrop')?.classList.remove('visible');
  }

  function bindNameModal(){
    document.getElementById('name-confirm-btn')?.addEventListener('click', confirmName);
    const inp = document.getElementById('name-input');
    inp?.addEventListener('keydown', e => { if (e.key === 'Enter') confirmName(); });
    if (!userName){
      document.getElementById('name-modal-backdrop')?.classList.add('visible');
      setTimeout(() => inp?.focus(), 80);
    }
  }

  // ----- pointer handling -----
  function getPos(e){
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(W, e.clientX - r.left)),
      y: Math.max(0, Math.min(H, e.clientY - r.top)),
    };
  }

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    unlockAudio();
    const { x, y } = getPos(e);

    if (pinMode){
      if (!removePinNear(x, y)) placePin(x, y);
      return;
    }

    canvas.setPointerCapture(e.pointerId);
    ownTouches.set(e.pointerId, { x, y });
    updateNoteDisplay();
    sendMove();
    const hintEl = document.getElementById('theremin-hint');
    if (hintEl) hintEl.style.opacity = '0';
    const ac = getAudioCtx();
    const doStart = () => startVoice(e.pointerId, yToFreq(y), xToGain(x));
    if (ac.state === 'running') { doStart(); } else { ac.resume().then(doStart); }
  }, { passive: false });

  canvas.addEventListener('pointermove', e => {
    if (!ownTouches.has(e.pointerId)) return;
    const { x, y } = getPos(e);
    ownTouches.set(e.pointerId, { x, y });
    updateVoice(e.pointerId, yToFreq(y), xToGain(x));
    updateNoteDisplay();
    sendMove();
  });

  function releasePointer(e){
    if (pinMode) return;
    stopVoice(e.pointerId);
    ownTouches.delete(e.pointerId);
    updateNoteDisplay();
    sendMove();
  }
  canvas.addEventListener('pointerup',     releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);

  function updateNoteDisplay(){
    const noteEl = document.getElementById('theremin-note');
    const freqEl = document.getElementById('theremin-freq');
    if (!noteEl || !freqEl) return;
    if (ownTouches.size > 0 && W > 0){
      const freq = yToFreq(ownTouches.values().next().value.y);
      noteEl.textContent = freqToNoteName(freq);
      freqEl.textContent = Math.round(freq) + ' Hz';
    } else {
      noteEl.textContent = '—';
      freqEl.textContent = '— Hz';
    }
  }

  // ----- drawing -----
  function drawPin(x, y, pulse){
    [[22 + 4 * pulse, 0.05 + 0.03 * pulse], [12, 0.14], [5, 0.85]].forEach(([r, a]) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(45,90%,70%,${a})`;
      ctx.fill();
    });
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = 'hsla(45,90%,90%,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawTouchPoint(x, y, hue){
    ctx.save();
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = `hsla(${hue},70%,65%,0.18)`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.strokeStyle = `hsla(${hue},70%,65%,0.10)`;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.restore();
    [[44, 0.06], [24, 0.13], [11, 0.22]].forEach(([r, a]) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue},80%,65%,${a})`; ctx.fill();
    });
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue},80%,72%,0.95)`; ctx.fill();
    ctx.strokeStyle = `hsla(${hue},80%,90%,0.7)`;
    ctx.lineWidth = 1.5; ctx.stroke();
  }

  function drawRemotePoint(x, y, hue){
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue},70%,65%,0.75)`; ctx.fill();
    ctx.strokeStyle = `hsla(${hue},70%,88%,0.6)`;
    ctx.lineWidth = 1.2; ctx.stroke();
  }

  function draw(){
    if (!W){ requestAnimationFrame(draw); return; }
    ctx.fillStyle = '#101a2e';
    ctx.fillRect(0, 0, W, H);
    for (let i = 1; i < 8; i++){
      ctx.fillStyle = i % 4 === 0 ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.022)';
      ctx.fillRect(Math.round((i / 8) * W), 0, 1, H);
      ctx.fillRect(0, Math.round((i / 8) * H), W, 1);
    }
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillStyle = 'rgba(232,238,247,0.2)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';    ctx.fillText(strings.high,   W / 2, 10);
    ctx.textBaseline = 'bottom'; ctx.fillText(strings.low,    W / 2, H - 10);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';  ctx.fillText(strings.silent, 10,     H / 2);
    ctx.textAlign = 'right'; ctx.fillText(strings.loud,   W - 10, H / 2);

    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 500);
    for (const pin of pinnedNotes) drawPin(pin.x, pin.y, pulse);
    for (const [, p] of remotePlayers) for (const t of p.touches) drawRemotePoint(t.x, t.y, p.hue);
    for (const [, t] of ownTouches) drawTouchPoint(t.x, t.y, MY_HUE);

    requestAnimationFrame(draw);
  }

  // ----- init -----
  let initialized = false;
  function init(){
    if (initialized) return;
    initialized = true;
    resize();
    window.addEventListener('resize', resize);
    bindNameModal();
    bindRoomUI();
    applyStrings();
    draw();
  }

  document.addEventListener('theremin:show', init, { once: true });
  if (document.getElementById('tab-theremin').classList.contains('active')) init();
})();
