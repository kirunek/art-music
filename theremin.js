(function(){
  "use strict";

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

  function xToFreq(x){ return FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, x / W); }
  function yToGain(y){ return Math.max(0, Math.min(1, 1 - y / H)); }
  function freqToNoteName(freq){
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    const oct = Math.floor(midi / 12) - 1;
    return NOTE_NAMES[((midi % 12) + 12) % 12] + oct;
  }

  // ----- audio -----
  let audioReady = false, sharedReverb;
  const voices = new Map(); // pointerId -> { osc, vol }

  async function ensureAudio(){
    if (audioReady) return;
    await Tone.start();
    sharedReverb = new Tone.Reverb({ decay: 2, wet: 0.22 }).toDestination();
    audioReady = true;
  }

  function startVoice(id, freq, gain){
    if (!audioReady || voices.has(id)) return;
    const vol = new Tone.Volume(Tone.gainToDb(Math.max(gain, 0.001))).connect(sharedReverb);
    const osc = new Tone.Oscillator({ type: 'triangle', frequency: freq }).connect(vol);
    osc.start();
    voices.set(id, { osc, vol });
  }

  function updateVoice(id, freq, gain){
    if (!audioReady || !voices.has(id)) return;
    const { osc, vol } = voices.get(id);
    osc.frequency.rampTo(freq, 0.04);
    vol.volume.rampTo(Tone.gainToDb(Math.max(gain, 0.001)), 0.04);
  }

  function stopVoice(id){
    if (!voices.has(id)) return;
    const { osc, vol } = voices.get(id);
    vol.volume.rampTo(-60, 0.15);
    setTimeout(() => { try { osc.stop(); osc.dispose(); vol.dispose(); } catch(e){} }, 300);
    voices.delete(id);
  }

  // ----- players -----
  const MY_ID = Math.random().toString(36).slice(2, 8);
  const MY_HUE = 200;
  const ownTouches = new Map(); // pointerId -> { x, y }
  const remotePlayers = new Map(); // remoteId -> { touches, hue, lastSeen }
  const REMOTE_HUES = [18, 150, 280, 55, 320];
  let nextHue = 0;

  // BroadcastChannel: cross-tab collaboration with no server
  let bc = null;
  try {
    bc = new BroadcastChannel('pond-theremin');
    bc.onmessage = ({ data }) => {
      if (!data || data.source !== 'theremin' || data.id === MY_ID) return;
      if (!remotePlayers.has(data.id)){
        remotePlayers.set(data.id, { hue: REMOTE_HUES[nextHue++ % REMOTE_HUES.length], touches: [] });
      }
      const p = remotePlayers.get(data.id);
      // touches are sent as normalized [0,1] coordinates
      p.touches = (data.touches || []).map(t => ({ x: t.x * W, y: t.y * H }));
      p.lastSeen = Date.now();
      updatePlayersDisplay();
    };
  } catch(e){}

  setInterval(() => {
    const now = Date.now();
    for (const [id, p] of remotePlayers){
      if (now - p.lastSeen > 3000) remotePlayers.delete(id);
    }
    updatePlayersDisplay();
  }, 1000);

  function broadcast(){
    if (!bc || !W) return;
    bc.postMessage({
      source: 'theremin',
      id: MY_ID,
      touches: [...ownTouches.values()].map(t => ({ x: t.x / W, y: t.y / H }))
    });
  }

  let playersStringFn = n => n === 1 ? '1 player' : `${n} players`;

  function updatePlayersDisplay(){
    const el = document.getElementById('theremin-players');
    if (el) el.textContent = playersStringFn(1 + remotePlayers.size);
  }

  function updateNoteDisplay(){
    const noteEl = document.getElementById('theremin-note');
    const freqEl = document.getElementById('theremin-freq');
    if (!noteEl || !freqEl) return;
    if (ownTouches.size > 0 && W > 0){
      const first = ownTouches.values().next().value;
      const freq = xToFreq(first.x);
      noteEl.textContent = freqToNoteName(freq);
      freqEl.textContent = Math.round(freq) + ' Hz';
    } else {
      noteEl.textContent = '—';
      freqEl.textContent = '— Hz';
    }
  }

  // ----- pointer handling -----
  function getPos(e){
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', async e => {
    e.preventDefault();
    await ensureAudio();
    const { x, y } = getPos(e);
    canvas.setPointerCapture(e.pointerId);
    ownTouches.set(e.pointerId, { x, y });
    startVoice(e.pointerId, xToFreq(x), yToGain(y));
    updateNoteDisplay();
    broadcast();
    const hintEl = document.getElementById('theremin-hint');
    if (hintEl) hintEl.style.opacity = '0';
  });

  canvas.addEventListener('pointermove', e => {
    if (!ownTouches.has(e.pointerId)) return;
    const { x, y } = getPos(e);
    ownTouches.set(e.pointerId, { x, y });
    updateVoice(e.pointerId, xToFreq(x), yToGain(y));
    updateNoteDisplay();
    broadcast();
  });

  function releasePointer(e){
    stopVoice(e.pointerId);
    ownTouches.delete(e.pointerId);
    updateNoteDisplay();
    broadcast();
  }
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);

  // ----- drawing -----
  function drawTouchPoint(x, y, hue){
    // guide lines
    ctx.save();
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = `hsla(${hue},70%,65%,0.18)`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.strokeStyle = `hsla(${hue},70%,65%,0.10)`;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.restore();

    // glow rings
    [[44, 0.06], [24, 0.13], [11, 0.22]].forEach(([r, a]) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue},80%,65%,${a})`;
      ctx.fill();
    });

    // dot
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue},80%,72%,0.95)`;
    ctx.fill();
    ctx.strokeStyle = `hsla(${hue},80%,90%,0.7)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawRemotePoint(x, y, hue){
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue},70%,65%,0.75)`;
    ctx.fill();
    ctx.strokeStyle = `hsla(${hue},70%,88%,0.6)`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function draw(){
    if (!W){ requestAnimationFrame(draw); return; }

    ctx.fillStyle = '#101a2e';
    ctx.fillRect(0, 0, W, H);

    // grid
    for (let i = 1; i < 8; i++){
      ctx.fillStyle = i % 4 === 0 ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.022)';
      ctx.fillRect(Math.round((i / 8) * W), 0, 1, H);
      ctx.fillRect(0, Math.round((i / 8) * H), W, 1);
    }

    // axis labels
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillStyle = 'rgba(232,238,247,0.2)';
    ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
    ctx.fillText('C3', 10, H - 8);
    ctx.textAlign = 'right';
    ctx.fillText('C6', W - 10, H - 8);
    ctx.textBaseline = 'top'; ctx.textAlign = 'right';
    ctx.fillText('loud', W - 10, 10);

    // remote players
    for (const [, p] of remotePlayers){
      for (const t of p.touches) drawRemotePoint(t.x, t.y, p.hue);
    }

    // own touches
    for (const [, t] of ownTouches) drawTouchPoint(t.x, t.y, MY_HUE);

    requestAnimationFrame(draw);
  }

  // ----- init (deferred until tab is shown) -----
  let initialized = false;
  function init(){
    if (initialized) return;
    initialized = true;
    resize();
    window.addEventListener('resize', resize);
    draw();
  }

  document.addEventListener('theremin:show', init, { once: true });
  document.addEventListener('theremin:lang', e => {
    playersStringFn = e.detail.thereminPlayers;
    updatePlayersDisplay();
  });

  // init immediately if theremin tab is somehow already active on load
  if (document.getElementById('tab-theremin').classList.contains('active')) init();
})();
