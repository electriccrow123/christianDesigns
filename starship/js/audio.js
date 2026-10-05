// Synthesized sound effects, engine hum, generative music and the ship computer voice.
// No audio files: everything is made with WebAudio oscillators and noise.
import { on, clamp } from './core.js';
import { S } from './state.js';

let ctx = null, master = null, sfxBus = null, musicBus = null, noiseBuf = null;
let engine = null;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
  sfxBus = ctx.createGain(); sfxBus.connect(master);
  musicBus = ctx.createGain(); musicBus.gain.value = 0.0; musicBus.connect(master);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  startEngine();
}

function env(g, t, a, peak, dcy) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dcy);
}
function osc(type, f0, f1, dur, vol = 0.2, delay = 0) {
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  env(g, t, 0.005, vol, dur);
  o.connect(g); g.connect(sfxBus); o.start(t); o.stop(t + dur + 0.05);
}
function noise(dur, vol, freq = 1000, type = 'lowpass', delay = 0, q = 1) {
  const t = ctx.currentTime + delay;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); env(g, t, 0.005, vol, dur);
  s.connect(f); f.connect(g); g.connect(sfxBus); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  return f;
}

const SFX = {
  click: () => osc('square', 1800, 1200, 0.04, 0.08),
  hover: () => osc('sine', 2400, 2400, 0.02, 0.02),
  switch: () => { noise(0.05, 0.25, 3000, 'bandpass'); osc('square', 300, 200, 0.05, 0.08); },
  key: () => osc('square', 2600, 2000, 0.025, 0.05),
  deny: () => { osc('square', 220, 200, 0.12, 0.12); osc('square', 180, 160, 0.15, 0.12, 0.12); },
  buy: () => { [880, 1175, 1568].forEach((f, i) => osc('triangle', f, f, 0.15, 0.15, i * 0.07)); },
  blaster: () => { osc('sawtooth', 1400, 180, 0.18, 0.18); noise(0.06, 0.1, 4000, 'highpass'); },
  rifle: () => { osc('square', 900, 200, 0.08, 0.12); },
  shotgun: () => { noise(0.25, 0.4, 1500); osc('sawtooth', 600, 80, 0.2, 0.18); },
  phaser: () => { osc('sawtooth', 600, 520, 0.5, 0.12); osc('sine', 1200, 1100, 0.5, 0.08); },
  torpedo: () => { osc('sine', 200, 900, 0.6, 0.2); noise(0.5, 0.1, 800, 'bandpass'); },
  enemyFire: () => osc('sawtooth', 500, 120, 0.25, 0.06),
  explosion: () => { noise(1.2, 0.6, 600); osc('sine', 90, 30, 1.0, 0.4); },
  smallExplosion: () => { noise(0.5, 0.35, 900); osc('sine', 140, 50, 0.4, 0.2); },
  shieldHit: () => { noise(0.4, 0.3, 2200, 'bandpass', 0, 4); osc('sine', 300, 600, 0.3, 0.12); },
  hullHit: () => { noise(0.6, 0.6, 400); osc('square', 70, 40, 0.5, 0.25); },
  hurt: () => { osc('sawtooth', 200, 90, 0.25, 0.2); },
  saber: () => { osc('sawtooth', 140, 90, 0.25, 0.12); noise(0.2, 0.12, 1800, 'bandpass', 0, 3); },
  saberHit: () => { noise(0.2, 0.4, 3000, 'bandpass', 0, 2); osc('square', 300, 100, 0.2, 0.15); },
  hammer: () => { noise(0.4, 0.6, 500); osc('sawtooth', 2000, 100, 0.4, 0.15); },
  grab: () => osc('sine', 500, 900, 0.08, 0.1),
  drop: () => osc('sine', 700, 300, 0.1, 0.08),
  weld: () => noise(0.12, 0.15, 5000, 'highpass'),
  scan: () => osc('sine', 1000 + Math.random() * 800, 1000 + Math.random() * 800, 0.08, 0.05),
  scanDone: () => { [660, 990, 1320].forEach((f, i) => osc('sine', f, f, 0.2, 0.12, i * 0.09)); },
  teleport: () => { osc('sine', 200, 2000, 0.9, 0.15); noise(0.9, 0.12, 3000, 'bandpass', 0, 2); },
  alarm: () => { osc('square', 660, 660, 0.35, 0.1); osc('square', 440, 440, 0.35, 0.1, 0.4); },
  warp: () => { osc('sawtooth', 60, 1200, 3.0, 0.2); noise(3.5, 0.25, 600, 'lowpass'); },
  warpExit: () => { noise(1.5, 0.5, 1200); osc('sine', 1600, 80, 1.5, 0.25); },
  coin: () => { osc('triangle', 1318, 1318, 0.08, 0.1); osc('triangle', 1975, 1975, 0.25, 0.1, 0.07); },
  eat: () => { noise(0.08, 0.2, 1500, 'bandpass'); noise(0.08, 0.2, 1200, 'bandpass', 0.15); },
  boop: () => osc('sine', 800, 1200, 0.1, 0.08),
  bark: () => { osc('square', 500, 300, 0.08, 0.08); osc('square', 520, 320, 0.08, 0.08, 0.15); },
  scrap: () => { noise(0.15, 0.25, 2500, 'bandpass', 0, 3); },
};

export function sfx(name) {
  if (!ctx || !SFX[name]) return;
  try { SFX[name](); } catch (e) { /* ignore */ }
}

// ---------- engine hum ----------
function startEngine() {
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
  o1.type = 'sawtooth'; o2.type = 'sine';
  o1.frequency.value = 42; o2.frequency.value = 63;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 180;
  const g = ctx.createGain(); g.gain.value = 0.03;
  o1.connect(f); o2.connect(f); f.connect(g); g.connect(master);
  o1.start(); o2.start();
  engine = { o1, o2, f, g };
}
export function setEngine(throttle, boost) {
  if (!engine) return;
  const t = ctx.currentTime;
  engine.o1.frequency.setTargetAtTime(42 + throttle * 30 + (boost ? 40 : 0), t, 0.3);
  engine.f.frequency.setTargetAtTime(160 + throttle * 400 + (boost ? 600 : 0), t, 0.3);
  engine.g.gain.setTargetAtTime(0.03 + throttle * 0.05 + (boost ? 0.05 : 0), t, 0.3);
}

// ---------- generative music (Lounge Bot) ----------
let musicTimer = null, musicStep = 0;
const SCALE = [0, 3, 5, 7, 10, 12, 15, 17];
export function setMusic(onOff) {
  if (!ctx) return;
  musicBus.gain.setTargetAtTime(onOff ? 0.35 : 0, ctx.currentTime, 0.8);
  if (onOff && !musicTimer) musicTimer = setInterval(musicTick, 250);
  if (!onOff && musicTimer) { setTimeout(() => { if (!S.settings.music) { clearInterval(musicTimer); musicTimer = null; } }, 2000); }
}
function note(freq, dur, type, vol, when = 0) {
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
  o.type = type; o.frequency.value = freq;
  f.type = 'lowpass'; f.frequency.value = 1400;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.3, dur * 0.3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f); f.connect(g); g.connect(musicBus); o.start(t); o.stop(t + dur + 0.1);
}
function musicTick() {
  const root = 110;
  const bar = Math.floor(musicStep / 16) % 4;
  const chordRoots = [0, 8, 3, 10];
  const r = root * Math.pow(2, chordRoots[bar] / 12);
  if (musicStep % 16 === 0) {
    note(r / 2, 4, 'sawtooth', 0.06);
    note(r * Math.pow(2, 7 / 12), 4, 'triangle', 0.05);
    note(r * Math.pow(2, 3 / 12) * 2, 4, 'sine', 0.04);
  }
  if (musicStep % 2 === 0 && Math.random() < 0.55) {
    const n = SCALE[Math.floor(Math.random() * SCALE.length)];
    note(r * 2 * Math.pow(2, n / 12), 0.6, 'triangle', 0.05);
  }
  if (musicStep % 4 === 0) note(55, 0.25, 'sine', 0.12);
  musicStep++;
}

// ---------- ship computer voice ----------
let lastSay = 0;
export function say(text, force = false) {
  if (!S.settings.voice || !('speechSynthesis' in window)) return;
  const now = performance.now();
  if (!force && now - lastSay < 2500) return; // don't spam
  lastSay = now;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 1.15; u.volume = 0.9;
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => /female|samantha|zira|aria|jenny|google uk english female/i.test(x.name)) || voices.find((x) => x.lang?.startsWith('en'));
    if (v) u.voice = v;
    if (speechSynthesis.speaking && !force) return;
    speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}

on('sfx', sfx);
on('say', (t) => say(t));
export function audioVolume(v) { if (master) master.gain.value = clamp(v, 0, 1); }
