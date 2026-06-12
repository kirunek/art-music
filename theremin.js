(function(){
  "use strict";

  // Update this after Railway deploy — use wss:// for production
  const WS_URL = 'wss://music-art-production.up.railway.app';

  const canvas = document.getElementById('theremin-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const FREQ_MIN = 130.81; // C3
  const FREQ_MAX = 1046.5; // C6
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  let W = 0, H = 0, dpr = 1;

  function resize(){
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function xToGain(x){ return Math.max(0, Math.min(1, x / W)); }
  function yToFreq(y){ return FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, 1 - y / H); }
  function freqToNoteName(freq){
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  // ----- audio (raw Web Audio API — lazy init from first user gesture) -----
  let audioCtx = null;
  const voices = new Map(); // pointerId -> { osc, vol }

  function getAudioCtx(){
    if (!audioCtx){
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function unlockAudio(){
    const ac = getAudioCtx();
    // Play a silent buffer — iOS Safari requires actual audio playback during
    // the gesture to fully unlock the context, resume() alone is not enough
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
    osc.type = 'triangle';
    osc.frequency.value = freq;
    vol.gain.value = gain * 0.7;
    osc.connect(vol);
    vol.connect(ac.destination);
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

  // ----- room / WebSocket -----
  const MY_HUE = 200;
  const ownTouches = new Map(); // pointerId -> { x, y }
  const remotePlayers = new Map(); // playerId -> { touches, hue }
  const REMOTE_HUES = [18, 150, 280, 55, 320];
  let nextHue = 0;
  let ws = null, wsRoom = null;

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
          if (!remotePlayers.has(id)){
            remotePlayers.set(id, { touches: [], hue: REMOTE_HUES[nextHue++ % REMOTE_HUES.length] });
          }
        });
        setRoomState('joined', { room: msg.room, count: msg.playerCount });
      }
      if (msg.type === 'player_joined'){
        if (!remotePlayers.has(msg.playerId)){
          remotePlayers.set(msg.playerId, { touches: [], hue: REMOTE_HUES[nextHue++ % REMOTE_HUES.length] });
        }
        updatePlayersDisplay();
      }
      if (msg.type === 'move'){
        const p = remotePlayers.get(msg.playerId);
        if (p) p.touches = (msg.touches || []).map(t => ({ x: t.x * W, y: t.y * H }));
      }
      if (msg.type === 'player_left'){
        remotePlayers.delete(msg.playerId);
        updatePlayersDisplay();
      }
      if (msg.type === 'error'){
        setRoomState('error', msg.msg === 'room_full' ? strings.roomFull : strings.connFailed);
      }
    };

    ws.onclose = () => {
      wsRoom = null; remotePlayers.clear();
      setRoomState('idle');
      updatePlayersDisplay();
    };

    ws.onerror = () => setRoomState('error', strings.connFailed);
  }

  function leaveRoom(){
    wsRoom = null; remotePlayers.clear();
    if (ws){ ws.onclose = null; ws.close(); ws = null; }
    updatePlayersDisplay();
    setRoomState('idle');
  }

  function sendMove(){
    if (!ws || ws.readyState !== WebSocket.OPEN || !wsRoom || !W) return;
    ws.send(JSON.stringify({
      type: 'move',
      touches: [...ownTouches.values()].map(t => ({ x: t.x / W, y: t.y / H }))
    }));
  }

  // ----- room UI -----
  let strings = {
    join: 'Join', leave: 'Leave',
    roomPlaceholder: 'room code',
    roomFull: 'Room is full', connFailed: 'Connection failed',
    players: n => n === 1 ? '1 player' : `${n} players`,
    loud: 'loud', silent: 'silent', high: 'high', low: 'low',
  };

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
      if (codeInfo) codeInfo.textContent = data.room;
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
    const infoEl = document.getElementById('theremin-players');
    if (infoEl) infoEl.textContent = strings.players(1 + remotePlayers.size);
  }

  function handleJoin(){
    unlockAudio(); // create + resume AudioContext from this user gesture
    const inp = document.getElementById('room-input');
    if (!inp) return;
    const code = inp.value.trim().toUpperCase();
    if (code) connectAndJoin(code);
  }

  function bindRoomUI(){
    document.getElementById('room-join-btn')?.addEventListener('click', handleJoin);
    const inp = document.getElementById('room-input');
    if (inp){
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') handleJoin(); });
      inp.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
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
    stopVoice(e.pointerId);
    ownTouches.delete(e.pointerId);
    updateNoteDisplay();
    sendMove();
  }
  canvas.addEventListener('pointerup', releasePointer);
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
    // Y axis: high/low at top/bottom, horizontally centered
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';    ctx.fillText(strings.high,   W / 2, 10);
    ctx.textBaseline = 'bottom'; ctx.fillText(strings.low,    W / 2, H - 10);
    // X axis: silent/loud at left/right, vertically centered
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';  ctx.fillText(strings.silent, 10,      H / 2);
    ctx.textAlign = 'right'; ctx.fillText(strings.loud,   W - 10,  H / 2);

    for (const [, p] of remotePlayers){
      for (const t of p.touches) drawRemotePoint(t.x, t.y, p.hue);
    }
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
    bindRoomUI();
    draw();
  }

  document.addEventListener('theremin:show', init, { once: true });

  document.addEventListener('theremin:lang', e => {
    const T = e.detail;
    strings = {
      join: T.join, leave: T.leave,
      roomPlaceholder: T.roomPlaceholder,
      roomFull: T.roomFull, connFailed: T.connFailed,
      players: T.thereminPlayers,
      loud: T.loud, silent: T.silent, high: T.high, low: T.low,
    };
    const joinLabel = document.getElementById('room-join-label');
    const inp       = document.getElementById('room-input');
    if (joinLabel) joinLabel.textContent = strings.join;
    if (inp) inp.placeholder = strings.roomPlaceholder;
    updatePlayersDisplay();
  });

  if (document.getElementById('tab-theremin').classList.contains('active')) init();
})();
