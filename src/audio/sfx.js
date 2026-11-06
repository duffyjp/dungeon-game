// Sound effects, synthesised at runtime with WebAudio (spec §12.2).
// The ComfyUI server only produces images, so SFX have no generated files; this
// bank is procedural. If the user later drops assets/audio/sfx/<name>.<ext>,
// that file wins and the synthesised recipe is skipped.

import { CFG } from '../config.js';

const files = import.meta.glob('../../assets/audio/sfx/*.{mp3,ogg,wav,m4a}', {
  eager: true, query: '?url', import: 'default'
});

const FILE_URLS = {};
for (const [p, url] of Object.entries(files)) {
  const name = p.split('/').pop().replace(/\.[^.]+$/, '');
  FILE_URLS[name] = url;
}

let ctx = null;
let master = null;
let sfxBus = null;
let musicBus = null;
let noiseBuf = null;
const buffers = new Map();
let activeVoices = 0;
let volume = 0.7;

export function initAudio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  musicBus.connect(master);

  const len = Math.floor(ctx.sampleRate * 2);
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

export function resumeAudio() { if (ctx && ctx.state === 'suspended') ctx.resume(); }
export function getSfxBus() { initAudio(); return sfxBus; }
export function getMusicBus() { initAudio(); return musicBus; }
export function setMasterVolume(v) { volume = v; if (master) master.gain.value = v; }

function jitter() { return 1 + (Math.random() * 0.16 - 0.08); }    // ±8 % per spec

function noise(dur, { gain = 0.3, type = 'lowpass', freq = 1200, q = 1, attack = 0.005, curve = 'exp' } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = jitter();
  const filt = ctx.createBiquadFilter();
  filt.type = type; filt.frequency.value = freq; filt.Q.value = q;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  else g.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(filt).connect(g);
  src.start(t);
  src.stop(t + dur + 0.02);
  return { g, stop: () => src.stop() };
}

function tone(freq, dur, { type = 'sine', gain = 0.25, slideTo = null, attack = 0.005, delay = 0 } = {}) {
  const osc = ctx.createOscillator();
  osc.type = type;
  const t = ctx.currentTime + delay;
  osc.frequency.setValueAtTime(freq * jitter(), t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo * jitter()), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  return g;
}

// name -> factory. Names come from data/*.json sfx fields.
const RECIPES = {
  swing_whoosh: () => noise(0.22, { type: 'bandpass', freq: 1900, q: 1.2, gain: 0.28, attack: 0.01 }),
  hit_metal: () => { tone(2400, 0.16, { type: 'square', gain: 0.12, slideTo: 900 }); noise(0.12, { type: 'highpass', freq: 2600, gain: 0.2 }); },
  hit_flesh: () => { noise(0.16, { type: 'lowpass', freq: 900, gain: 0.35 }); tone(120, 0.12, { type: 'sine', gain: 0.2, slideTo: 60 }); },
  hit_slime: () => { noise(0.2, { type: 'bandpass', freq: 520, q: 3, gain: 0.3 }); tone(300, 0.18, { type: 'sine', gain: 0.14, slideTo: 120 }); },
  bow_draw: () => noise(0.25, { type: 'highpass', freq: 3200, gain: 0.12, attack: 0.08, curve: 'lin' }),
  bow_release: () => { tone(180, 0.18, { type: 'triangle', gain: 0.22, slideTo: 90 }); noise(0.1, { type: 'bandpass', freq: 2600, q: 2, gain: 0.2 }); },
  // The sound of drawing a bow that has nothing to shoot: string against an empty hand.
  bow_empty: () => { tone(1500, 0.05, { type: 'square', gain: 0.09, slideTo: 700 }); noise(0.05, { type: 'highpass', freq: 4200, gain: 0.1 }); },
  // Changing which hand holds what: short, cloth-and-leather, deliberately not a threat.
  weapon_swap: () => noise(0.16, { type: 'bandpass', freq: 1200, q: 0.8, gain: 0.16, attack: 0.03, curve: 'lin' }),
  arrow_impact: () => { tone(900, 0.1, { type: 'square', gain: 0.12, slideTo: 300 }); noise(0.08, { type: 'highpass', freq: 3000, gain: 0.16 }); },
  fireball_cast: () => tone(160, 0.9, { type: 'sawtooth', gain: 0.16, slideTo: 620 }),
  fireball_impact: () => { noise(0.5, { type: 'lowpass', freq: 1400, gain: 0.45 }); tone(90, 0.4, { type: 'sine', gain: 0.3, slideTo: 40 }); },
  magic_orb_cast: () => tone(520, 0.7, { type: 'sine', gain: 0.16, slideTo: 1400 }),
  ghost_moan: () => { tone(220, 1.4, { type: 'sine', gain: 0.16, slideTo: 150 }); tone(331, 1.2, { type: 'sine', gain: 0.09, slideTo: 210, delay: 0.1 }); },
  ghost_hit: () => { tone(700, 0.3, { type: 'sine', gain: 0.14, slideTo: 300 }); noise(0.3, { type: 'bandpass', freq: 1200, q: 6, gain: 0.14 }); },
  slime_squelch: () => noise(0.3, { type: 'bandpass', freq: 420, q: 4, gain: 0.3 }),
  orc_grunt: () => tone(150, 0.3, { type: 'sawtooth', gain: 0.2, slideTo: 90 }),
  orc_death: () => { tone(180, 0.6, { type: 'sawtooth', gain: 0.2, slideTo: 60 }); noise(0.4, { type: 'lowpass', freq: 800, gain: 0.2 }); },
  archer_call: () => tone(1100, 0.12, { type: 'square', gain: 0.1, slideTo: 1600 }),
  pickup_gear: () => { tone(660, 0.12, { type: 'triangle', gain: 0.16 }); tone(990, 0.12, { type: 'triangle', gain: 0.12, delay: 0.06 }); },
  equip_upgrade: () => { tone(523, 0.14, { type: 'triangle', gain: 0.18 }); tone(784, 0.14, { type: 'triangle', gain: 0.16, delay: 0.07 }); tone(1046, 0.22, { type: 'triangle', gain: 0.14, delay: 0.14 }); },
  salvage: () => { tone(880, 0.08, { type: 'square', gain: 0.1 }); tone(1170, 0.08, { type: 'square', gain: 0.08, delay: 0.05 }); },
  heal: () => { tone(392, 0.25, { type: 'sine', gain: 0.2 }); tone(587, 0.3, { type: 'sine', gain: 0.16, delay: 0.1 }); },
  extra_life: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.3, { type: 'sine', gain: 0.16, delay: i * 0.09 })); },
  armor_break: () => { noise(0.4, { type: 'highpass', freq: 1800, gain: 0.35 }); tone(220, 0.35, { type: 'square', gain: 0.14, slideTo: 70 }); },
  player_hurt: () => { tone(320, 0.25, { type: 'sawtooth', gain: 0.22, slideTo: 140 }); noise(0.2, { type: 'lowpass', freq: 700, gain: 0.2 }); },
  player_death: () => { [440, 349, 261, 174].forEach((f, i) => tone(f, 0.5, { type: 'sawtooth', gain: 0.2, delay: i * 0.22 })); },
  stairs_start: () => tone(120, 0.8, { type: 'sine', gain: 0.2, slideTo: 200 }),
  stairs_complete: () => { tone(196, 0.5, { type: 'sine', gain: 0.2 }); tone(294, 0.6, { type: 'sine', gain: 0.16, delay: 0.15 }); tone(392, 0.8, { type: 'sine', gain: 0.14, delay: 0.3 }); },
  menu_click: () => tone(1200, 0.05, { type: 'square', gain: 0.1 }),
  menu_back: () => tone(700, 0.06, { type: 'square', gain: 0.09 }),
  level_start: () => { tone(147, 1.2, { type: 'sine', gain: 0.22 }); tone(220, 1.0, { type: 'sine', gain: 0.14, delay: 0.2 }); noise(0.8, { type: 'lowpass', freq: 300, gain: 0.12 }); },
  boss_roar: () => { tone(90, 1.4, { type: 'sawtooth', gain: 0.3, slideTo: 55 }); noise(1.2, { type: 'lowpass', freq: 500, gain: 0.3 }); },
  distant_drip: () => tone(1600, 0.12, { type: 'sine', gain: 0.05, slideTo: 700 }),
  distant_skitter: () => noise(0.35, { type: 'highpass', freq: 4200, gain: 0.05, attack: 0.02 }),
  distant_stone: () => { noise(0.9, { type: 'lowpass', freq: 260, gain: 0.09 }); tone(70, 0.8, { type: 'sine', gain: 0.07 }); }
};

function panner(x, z) {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = 2;
  p.maxDistance = 40;
  p.rolloffFactor = 1.2;
  p.positionX.value = x; p.positionY.value = 0; p.positionZ.value = z;
  p.connect(sfxBus);
  return p;
}

// play(name, {x, z, gain}) -> void. Falls back to a file in assets/audio/sfx/ if present.
export function play(name, opts = {}) {
  if (!ctx) return;
  if (activeVoices >= CFG.sfxVoices) return;

  if (FILE_URLS[name]) {
    if (!buffers.has(name)) {
      buffers.set(name, fetch(FILE_URLS[name]).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)));
    }
    buffers.get(name).then(buf => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = jitter();
      const chain = opts.x !== undefined ? panner(opts.x, opts.z) : sfxBus;
      const g = ctx.createGain();
      g.gain.value = (opts.gain ?? 1);
      src.connect(g).connect(chain);
      src.start();
    }).catch(() => synth(name, opts));
    return;
  }
  synth(name, opts);
}

function synth(name, opts) {
  const recipe = RECIPES[name];
  if (!recipe) return;
  activeVoices++;
  const prevBus = sfxBus;
  if (opts.x !== undefined) sfxBus = panner(opts.x, opts.z);
  try { recipe(); } catch (e) { console.warn('[sfx] failed', name, e.message); }
  sfxBus = prevBus;
  setTimeout(() => { activeVoices--; }, 700);
}

export function hasRecipe(name) { return Boolean(RECIPES[name] || FILE_URLS[name]); }
