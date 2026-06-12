/*
  Pond — a calm spatial sound space.

  Concept: a single surface. Tap empty water to open a ring of sound FAMILIES;
  pick one, it expands into that family's voices; pick a voice and an orb is
  placed where you first tapped. A playhead sweeps left to right on a loop and
  sounds each orb as it passes. Vertical position = pitch (locked to a 16-note
  pentatonic scale). Horizontal position = WHEN in the loop the orb sounds.

  Two safety nets make it "impossible to sound bad":
    1. Pitch is locked to the pentatonic scale (every row is an in-scale note).
    2. Timing snaps to a 32-step grid, so nothing lands off the pulse.

  GRID:  16 pitch rows x 16 visible beat columns.
  SNAP:  32 horizontal snap positions (finer than the 16 visible columns).
*/
(function(){
  "use strict";

  const canvas = document.getElementById('pond');
  const ctx = canvas.getContext('2d');
  const hint = document.getElementById('hint');
  const playbtn = document.getElementById('playbtn');
  const playicon = document.getElementById('playicon');
  const tempoEl = document.getElementById('tempo');
  const tempoSlow = document.getElementById('tempo-slow');
  const tempoLively = document.getElementById('tempo-lively');
  const legend = document.getElementById('legend');
  const clearbtn = document.getElementById('clearbtn');
  const clearlabel = document.getElementById('clearlabel');
  const langbtn = document.getElementById('langbtn');
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalMsg = document.getElementById('modal-msg');
  const modalCancel = document.getElementById('modal-cancel');
  const modalConfirm = document.getElementById('modal-confirm');
  const pickerOverlay = document.getElementById('picker-overlay');

  // ----- i18n -----
  const TRANSLATIONS = {
    en: {
      hint: 'touch anywhere — pick a family, then a sound',
      slow: 'slow', lively: 'lively',
      clear: 'clear',
      modalMsg: 'Clear all orbs?', modalCancel: 'Cancel', modalConfirm: 'Clear',
      families: ['rhythm', 'ambient', 'accent', 'bass'],
      langSwitch: 'UA',
      ariaPlay: 'Play', ariaStop: 'Stop', ariaClear: 'Clear all',
      tabPond: 'pond', tabTheremin: 'theremin',
      thereminHint: 'hold anywhere · left–right: pitch · up–down: volume',
      thereminPlayers: n => n === 1 ? '1 player' : `${n} players`,
      join: 'Join', leave: 'Leave',
      roomPlaceholder: 'room code',
      roomFull: 'Room is full', connFailed: 'Connection failed',
      loud: 'loud', silent: 'silent', high: 'high', low: 'low',
    },
    ua: {
      hint: 'торкніться будь-де — оберіть категорію, а потім звук',
      slow: 'повільно', lively: 'жваво',
      clear: 'очистити',
      modalMsg: 'Очистити всі кулі?', modalCancel: 'Скасувати', modalConfirm: 'Очистити',
      families: ['ритм', 'ембієнт', 'акцент', 'бас'],
      langSwitch: 'EN',
      ariaPlay: 'Грати', ariaStop: 'Зупинити', ariaClear: 'Очистити все',
      tabPond: 'ставок', tabTheremin: 'терємін',
      thereminHint: 'утримуйте · ліво-право: висота · вгору-вниз: гучність',
      thereminPlayers: n => n === 1 ? '1 гравець' : `${n} гравці`,
      join: 'Приєднатись', leave: 'Вийти',
      roomPlaceholder: 'код кімнати',
      roomFull: 'Кімната заповнена', connFailed: 'Помилка підключення',
      loud: 'гучно', silent: 'тихо', high: 'високо', low: 'низько',
    }
  };
  let lang = 'en';
  function tr(){ return TRANSLATIONS[lang]; }

  function applyTranslations(){
    const T = tr();
    hint.textContent = T.hint;
    tempoSlow.textContent = T.slow;
    tempoLively.textContent = T.lively;
    clearlabel.textContent = T.clear;
    clearbtn.setAttribute('aria-label', T.ariaClear);
    modalMsg.textContent = T.modalMsg;
    modalCancel.querySelector('span').textContent = T.modalCancel;
    modalConfirm.querySelector('span').textContent = T.modalConfirm;
    langbtn.textContent = T.langSwitch;
    playbtn.setAttribute('aria-label', playing ? T.ariaStop : T.ariaPlay);
    document.getElementById('tab-btn-pond').textContent = T.tabPond;
    document.getElementById('tab-btn-theremin').textContent = T.tabTheremin;
    const thereminHintEl = document.getElementById('theremin-hint');
    if (thereminHintEl) thereminHintEl.textContent = T.thereminHint;
    document.dispatchEvent(new CustomEvent('theremin:lang', { detail: T }));
    renderLegend();
  }

  langbtn.addEventListener('click', () => {
    lang = lang === 'en' ? 'ua' : 'en';
    applyTranslations();
  });

  // ----- tab switching -----
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'theremin'){
        document.dispatchEvent(new CustomEvent('theremin:show'));
      }
    });
  });

  // ----- grid + scale config -----
  const SCALE = ['D2','F2','A2','C3','D3','F3','A3','C4','D4','F4','A4','C5','D5','F5','A5','C6']; // D minor pentatonic, low -> high
  const ROWS = 16;   // pitch rows
  const COLS = 16;   // visible beat columns
  const SNAP = 32;   // horizontal snap positions (quantization >= 32)
  const ORB_R = 11;  // uniform orb radius

  // ----- sound families (4 categories x 4 voices) -----
  const CATEGORIES = [
    { key:'rhythm', label:'rhythm', hue:18, voices:[
      { label:'woodblock', vol:-12, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'triangle'},envelope:{attack:0.001,decay:0.22,sustain:0,release:0.25}}) },
      { label:'mallet',    vol:-10, mono:true, make:()=>new Tone.MembraneSynth({pitchDecay:0.02,octaves:2,envelope:{attack:0.004,decay:0.6,sustain:0,release:0.6}}) },
      { label:'pluck',     vol:-16, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'sawtooth'},envelope:{attack:0.005,decay:0.4,sustain:0,release:0.8}}) },
      { label:'tick',      vol:-18, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'square'},envelope:{attack:0.001,decay:0.15,sustain:0,release:0.2}}) }
    ]},
    { key:'ambient', label:'ambient', hue:150, voices:[
      { label:'breath',  vol:-13, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'sine'},envelope:{attack:0.25,decay:1.8,sustain:0.2,release:3.5}}) },
      { label:'pad',     vol:-15, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'sine4'},envelope:{attack:0.6,decay:1,sustain:0.6,release:4}}) },
      { label:'shimmer', vol:-15, make:()=>new Tone.PolySynth(Tone.AMSynth,{harmonicity:2.5,envelope:{attack:0.4,decay:1.5,sustain:0.3,release:3}}) },
      { label:'air',     vol:-16, make:()=>new Tone.PolySynth(Tone.AMSynth,{harmonicity:1.5,envelope:{attack:0.8,decay:1,sustain:0.4,release:4}}) }
    ]},
    { key:'accent', label:'accent', hue:200, voices:[
      { label:'bell',    vol:-13, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'triangle'},envelope:{attack:0.05,decay:2.0,sustain:0.08,release:3.2}}) },
      { label:'glass',   vol:-14, make:()=>new Tone.PolySynth(Tone.FMSynth,{harmonicity:3.01,modulationIndex:8,envelope:{attack:0.01,decay:1.6,sustain:0,release:2.4},modulationEnvelope:{attack:0.01,decay:0.4,sustain:0,release:0.4}}) },
      { label:'crystal', vol:-15, make:()=>new Tone.PolySynth(Tone.FMSynth,{harmonicity:5,modulationIndex:12,envelope:{attack:0.01,decay:2.2,sustain:0,release:3}}) },
      { label:'marimba', vol:-12, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'sine'},envelope:{attack:0.002,decay:0.9,sustain:0,release:0.9}}) }
    ]},
    { key:'bass', label:'bass', hue:280, voices:[
      { label:'warm',  vol:-11, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'sine'},envelope:{attack:0.02,decay:1.4,sustain:0.05,release:2.6}}) },
      { label:'round', vol:-11, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'triangle'},envelope:{attack:0.03,decay:1.2,sustain:0.1,release:2.2}}) },
      { label:'sub',   vol:-9,  mono:true, make:()=>new Tone.MembraneSynth({pitchDecay:0.05,octaves:1.5,envelope:{attack:0.01,decay:1.4,sustain:0,release:1.4}}) },
      { label:'reed',  vol:-16, make:()=>new Tone.PolySynth(Tone.Synth,{oscillator:{type:'square'},envelope:{attack:0.08,decay:0.6,sustain:0.4,release:1.5}}) }
    ]}
  ];

  // ----- canvas sizing -----
  let W, H, dpr;
  function resize(){
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ----- grid <-> pixel helpers -----
  function snapToX(s){ return ((s + 0.5) / SNAP) * W; }
  function xToSnap(x){ return Math.max(0, Math.min(SNAP - 1, Math.round((x / W) * SNAP - 0.5))); }
  function rowToY(r){ return ((r + 0.5) / ROWS) * H; }
  function yToRow(y){ return Math.max(0, Math.min(ROWS - 1, Math.round((y / H) * ROWS - 0.5))); }
  function rowToNote(r){ return SCALE[(ROWS - 1) - r]; } // row 0 = top = highest pitch

  // ----- tempo -----
  let bpm = 64;
  function loopDur(){ return 240 / bpm; } // seconds per full sweep (4 beats per loop feel)
  tempoEl.addEventListener('input', e => { bpm = parseInt(e.target.value, 10); });

  // ----- audio -----
  let reverb, audioReady = false, playing = false, phase = 0, lastNow = 0;
  const synthCache = {};

  async function ensureAudio(){
    if (audioReady) return;
    try {
      await Tone.start();
      reverb = new Tone.Reverb({ decay: 7, wet: 0.5 }).toDestination();
      audioReady = true;
    } catch (e) { /* audio will retry on next gesture */ }
  }
  function getSynth(ci, vi){
    const k = ci + '-' + vi;
    if (!synthCache[k]){
      const v = CATEGORIES[ci].voices[vi];
      const s = v.make();
      s.volume.value = v.vol;
      s.connect(reverb);
      s._mono = !!v.mono;
      synthCache[k] = s;
    }
    return synthCache[k];
  }
  function trigger(ci, vi, note, vel){
    const s = getSynth(ci, vi);
    if (s._mono) s.triggerAttackRelease(note, '8n', undefined, vel);
    else s.triggerAttackRelease([note], '4n', undefined, vel);
  }
  function preview(ci, vi, row){ if (audioReady) trigger(ci, vi, rowToNote(row), 0.45); }

  function setPlaying(p){
    playing = p;
    if (!p){
      phase = 0;
      orbs.forEach(o => o.fired = false);
    }
    playicon.innerHTML = p
      ? '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"></rect>'
      : '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor"></polygon>';
    playbtn.setAttribute('aria-label', p ? tr().ariaStop : tr().ariaPlay);
    lastNow = performance.now();
  }
  playbtn.addEventListener('click', async () => { await ensureAudio(); setPlaying(!playing); });

  // ----- clear modal -----
  function openClearModal(){ modalBackdrop.classList.add('visible'); }
  function closeClearModal(){ modalBackdrop.classList.remove('visible'); }

  clearbtn.addEventListener('click', () => { if (orbs.length > 0) openClearModal(); });
  modalCancel.addEventListener('click', closeClearModal);
  modalConfirm.addEventListener('click', () => { orbs.length = 0; picker = null; closeClearModal(); });
  modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeClearModal(); });

  // ----- orbs -----
  const orbs = [];
  let picker = null; // { x, y, stage:'cat'|'voice', ci, t }

  function radius(){ return ORB_R; }
  function crossPos(o){ const r = radius(); return { cx: o.x + r * 0.9, cy: o.y - r * 0.9 }; }

  function placeOrb(ci, vi, x, y){
    const snap = xToSnap(x), row = yToRow(y);
    orbs.push({ ci, vi, hue: CATEGORIES[ci].hue, snap, row, x: snapToX(snap), y: rowToY(row), pulse: 1, appear: 0, fired: false });
    preview(ci, vi, row);
  }

  // ----- radial picker geometry -----
  const PR = 72;
  const SLOT = 21;
  function ringSlots(p, items){
    const n = items.length;
    return items.map((it, i) => {
      const ang = -Math.PI / 2 + i * (Math.PI * 2 / n);
      let sx = p.x + Math.cos(ang) * PR;
      let sy = p.y + Math.sin(ang) * PR;
      sx = Math.max(SLOT, Math.min(W - SLOT, sx));
      sy = Math.max(SLOT, Math.min(H - SLOT, sy));
      return { i, x: sx, y: sy, it };
    });
  }

  // ----- picker DOM overlay -----
  function renderPickerDOM(p){
    pickerOverlay.innerHTML = '';
    if (!p) return;

    const dot = document.createElement('div');
    dot.className = 'picker-dot';
    dot.style.cssText = `left:${p.x}px;top:${p.y}px`;
    pickerOverlay.appendChild(dot);

    const items = p.stage === 'cat' ? CATEGORIES : CATEGORIES[p.ci].voices;
    ringSlots(p, items).forEach(s => {
      const hue = p.stage === 'cat' ? s.it.hue : CATEGORIES[p.ci].hue;
      const label = p.stage === 'cat' ? tr().families[s.i] : s.it.label;
      const btn = document.createElement('button');
      btn.className = 'picker-slot';
      btn.style.cssText = `left:${s.x}px;top:${s.y}px;background:hsla(${hue},62%,60%,0.94);border-color:hsla(${hue},70%,84%,1)`;
      btn.textContent = label;
      btn.dataset.index = s.i;
      pickerOverlay.appendChild(btn);
    });
    requestAnimationFrame(() => {
      pickerOverlay.querySelectorAll('.picker-slot').forEach(el => el.classList.add('visible'));
    });
  }

  pickerOverlay.addEventListener('pointerdown', async e => {
    e.stopPropagation();
    await ensureAudio();
    const btn = e.target.closest('.picker-slot');
    if (!btn || !picker){ picker = null; renderPickerDOM(null); return; }

    const idx = parseInt(btn.dataset.index);
    if (picker.stage === 'cat'){
      picker.stage = 'voice';
      picker.ci = idx;
      renderPickerDOM(picker);
    } else {
      placeOrb(picker.ci, idx, picker.x, picker.y);
      hint.style.opacity = '0';
      picker = null;
      renderPickerDOM(null);
    }
  });

  // ----- pointer handling -----
  let drag = null, hovered = null;
  function pos(e){ const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function orbAt(x, y){
    let best = null, bd = Infinity;
    orbs.forEach(o => { const d = (o.x - x) ** 2 + (o.y - y) ** 2; if (d < bd){ bd = d; best = o; } });
    return (best && bd < (radius() + 12) ** 2) ? best : null;
  }
  function crossAt(x, y){
    for (const o of orbs){
      if (o !== hovered && o !== drag) continue;
      const { cx, cy } = crossPos(o);
      if ((cx - x) ** 2 + (cy - y) ** 2 < 15 * 15) return o;
    }
    return null;
  }
  function removeOrb(o){
    const i = orbs.indexOf(o);
    if (i >= 0) orbs.splice(i, 1);
    if (hovered === o) hovered = null;
    if (drag === o) drag = null;
  }

  canvas.addEventListener('pointerdown', async e => {
    e.preventDefault();
    await ensureAudio();
    const { x, y } = pos(e);

    if (picker){ picker = null; renderPickerDOM(null); return; }

    const xc = crossAt(x, y);
    if (xc){ removeOrb(xc); return; }

    const o = orbAt(x, y);
    if (o){ drag = o; hovered = o; return; }

    picker = { x, y, stage: 'cat' };
    renderPickerDOM(picker);
  });

  canvas.addEventListener('pointermove', e => {
    const { x, y } = pos(e);
    if (drag){
      drag.x = Math.max(ORB_R + 2, Math.min(W - ORB_R - 2, x));
      drag.y = Math.max(ORB_R + 2, Math.min(H - ORB_R - 2, y));
      drag.snap = xToSnap(drag.x);
      drag.row = yToRow(drag.y);
      return;
    }
    hovered = orbAt(x, y);
    canvas.style.cursor = (hovered || crossAt(x, y)) ? 'pointer' : (picker ? 'pointer' : 'crosshair');
  });

  window.addEventListener('pointerup', () => {
    if (drag){
      drag.x = snapToX(drag.snap);
      drag.y = rowToY(drag.row);
      drag = null;
    }
  });
  canvas.addEventListener('pointerleave', () => { if (!drag) hovered = null; });

  // ----- drawing -----
  function drawCross(o){
    const { cx, cy } = crossPos(o);
    ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,30,48,0.92)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    const s = 3.5;
    ctx.beginPath();
    ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
    ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
    ctx.stroke();
  }

  function draw(){
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;

    ctx.fillStyle = '#101a2e';
    ctx.fillRect(0, 0, W, H);

    // pitch row guides
    for (let r = 0; r < ROWS; r++){
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.fillRect(0, (r / ROWS) * H, W, 1);
    }
    // fine snap ticks (32)
    for (let s = 0; s < SNAP; s++){
      ctx.fillStyle = 'rgba(255,255,255,0.018)';
      ctx.fillRect((s / SNAP) * W, 0, 1, H);
    }
    // visible beat columns (16; every 4th brightest)
    for (let b = 0; b < COLS; b++){
      ctx.fillStyle = (b % 4 === 0) ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect((b / COLS) * W, 0, 1, H);
    }

    // drag guide: highlight target column + row
    if (drag){
      ctx.fillStyle = 'rgba(190,220,255,0.08)';
      ctx.fillRect((drag.snap / SNAP) * W, 0, W / SNAP, H);
      ctx.fillRect(0, (drag.row / ROWS) * H, W, H / ROWS);
    }

    // advance sweep + trigger orbs
    if (playing && audioReady){
      const prev = phase;
      phase = (phase + dt / loopDur()) % 1;
      if (phase < prev) orbs.forEach(o => o.fired = false);
      orbs.forEach(o => {
        const op = o.x / W;
        if (!o.fired && phase >= op){
          o.fired = true;
          trigger(o.ci, o.vi, rowToNote(o.row), 0.5);
          o.pulse = 1;
        }
      });
    }

    // sweep line + played region
    const headX = phase * W;
    ctx.fillStyle = playing ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, headX, H);
    ctx.fillStyle = playing ? 'rgba(190,220,255,0.85)' : 'rgba(160,180,210,0.4)';
    ctx.fillRect(headX - 1, 0, 2, H);

    // orbs
    orbs.forEach(o => {
      o.pulse *= 0.93;
      o.appear = Math.min(1, o.appear + 0.12);
      const r = radius() * (0.4 + 0.6 * o.appear);
      if (o.pulse > 0.02){
        ctx.beginPath(); ctx.arc(o.x, o.y, r + o.pulse * 28, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${o.hue},70%,72%,${o.pulse * 0.55})`;
        ctx.lineWidth = 2 * o.pulse; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${o.hue},65%,${52 + o.pulse * 18}%,${0.6 + o.pulse * 0.35})`;
      ctx.fill();
      ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${o.hue},70%,82%,0.9)`; ctx.lineWidth = 1.4; ctx.stroke();
    });

    if (hovered && orbs.includes(hovered)) drawCross(hovered);
    if (drag && drag !== hovered && orbs.includes(drag)) drawCross(drag);

    requestAnimationFrame(draw);
  }

  // ----- legend -----
  function renderLegend(){
    legend.innerHTML = '';
    CATEGORIES.forEach((c, i) => {
      const s = document.createElement('span');
      s.innerHTML = `<i style="background:hsl(${c.hue},62%,60%)"></i>${tr().families[i]}`;
      legend.appendChild(s);
    });
  }

  // ----- boot -----
  window.addEventListener('resize', () => {
    resize();
    orbs.forEach(o => { o.x = snapToX(o.snap); o.y = rowToY(o.row); });
  });
  resize();
  lastNow = performance.now();
  applyTranslations();
  draw();
})();
