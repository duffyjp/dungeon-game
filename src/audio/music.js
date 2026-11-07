// Music (spec §12.1). The player supplies the files; the code must be correct
// with an empty folder. A shuffle bag guarantees no repeats until the bag empties.

import { CFG } from '../config.js';
import { getMusicBus, initAudio } from './sfx.js';
import { Rng, ShuffleBag } from '../util/rng.js';

const found = import.meta.glob('../../assets/music/*.{mp3,ogg,wav,m4a}', {
  eager: true, query: '?url', import: 'default'
});

let tracks = Object.entries(found)
  .map(([p, url]) => ({ name: p.split('/').pop().replace(/\.[^.]+$/, ''), url }))
  .sort((a, b) => a.name.localeCompare(b.name));

const bag = new ShuffleBag(new Rng('music'));
let current = null;         // { name, url, el, gain }
let muted = false;

export function trackList() { return tracks.map(t => t.name); }
export function hasMusic() { return tracks.length > 0; }
export function currentTrack() { return current ? current.name : null; }

export function setMusicMuted(m) {
  muted = m;
  if (current) current.el[m ? 'pause' : 'play']();
}
export function setMusicVolume(v) {
  if (current) current.el.volume = muted ? 0 : v;
}

// Optional manifest can pin the order or exclude tracks; the build-time glob wins when it
// is absent, which is the shipping state. Two locations are tried: `music/manifest.json`
// relative to the site root, which is where the build copies it and the only path that
// resolves on static hosting such as GitHub Pages, and the source-tree path, which is what
// the dev server answers.
export async function loadManifest() {
  const tries = [
    new URL((import.meta.env.BASE_URL || './') + 'music/manifest.json', location.href),
    new URL('../../assets/music/manifest.json', import.meta.url)
  ];
  for (const url of tries) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      if (Array.isArray(json.tracks) && json.tracks.length) {
        const byName = new Map(tracks.map(t => [t.name, t]));
        const pinned = json.tracks.map(n => byName.get(n)).filter(Boolean);
        if (pinned.length) tracks = pinned;
      }
      break;
    } catch { /* nowhere to read: glob order is used */ }
  }
  return tracks;
}

export function playNext(reason = 'level', opts = {}) {
  initAudio();
  if (!tracks.length) {
    console.warn('[music] no tracks in assets/music/ — running silent');
    return null;
  }
  // A cue named for a biome belongs to that biome. Matching is by prefix so `caverns` answers
  // to The Caverns with no config file, and anything unmatched falls back to the whole pool —
  // a soundtrack covering four biomes still plays something everywhere. A boss level prefers
  // the combat cue when one exists.
  const matches = (n, key) => {
    const tag = String(n).split(/[_-]/)[0].toLowerCase();
    const k = String(key || '').toLowerCase();
    return tag === k || tag.startsWith(k) || k.startsWith(tag);
  };
  const bossPool = tracks.filter(t => matches(t.name, 'boss'));
  const biomePool = opts.biome ? tracks.filter(t => matches(t.name, opts.biome)) : [];
  const pool = (opts.boss && bossPool.length) ? bossPool : (biomePool.length ? biomePool : tracks);
  const pick = bag.next(pool);
  return play(pick, reason, opts);
}

export function playTrack(name, reason = 'menu') {
  const t = tracks.find(x => x.name === name);
  return t ? play(t, reason) : null;
}

function play(t, reason, opts = {}) {
  const bus = getMusicBus();
  const el = new Audio(t.url);
  // Not a hard loop. The generated cues were measured at start and end levels differing by up
  // to 17 dB, so looping the element restarts the piece with an audible bump. Instead the
  // element ends and the next cue starts through the crossfade that depth changes already use:
  // with one cue per biome that is usually the same piece, but crossfaded rather than clicked.
  el.loop = false;
  el.crossOrigin = 'anonymous';
  const gain = new GainWrapper(el);
  el.volume = muted ? 0 : 1;

  const prev = current;
  const entry = { name: t.name, url: t.url, el, gain, opts, reason };
  current = entry;
  el.play().catch(err => console.warn('[music] blocked by browser gesture policy:', err.message));
  el.addEventListener('ended', () => {
    if (current !== entry) return;   // a manual change superseded this cue
    playNext(`${entry.reason} · continue`, entry.opts);
  });

  if (prev) {
    fadeOut(prev, CFG.musicCrossfade);
  }
  console.info(`[music] ${reason}: ${t.name}`);
  return t.name;
}

// Simple helper: HTMLAudio volume is already a gain, no WebAudio routing needed
// unless we want ducking. Ducking is done by lowering volume directly.
class GainWrapper {
  constructor(el) { this.el = el; }
  set(v) { this.el.volume = Math.max(0, Math.min(1, v)); }
}

function fadeOut(entry, seconds) {
  const start = entry.el.volume;
  const step = 0.05;
  let t = 0;
  const id = setInterval(() => {
    t += step;
    entry.el.volume = Math.max(0, start * (1 - t / seconds));
    if (t >= seconds) {
      clearInterval(id);
      entry.el.pause();
      entry.el.src = '';
    }
  }, step * 1000);
}

export function duck(on) {
  if (!current) return;
  current.gain.set(on ? CFG.musicDuck : 1);
}

export function stopMusic() {
  if (!current) return;
  current.el.pause();
  current.el.src = '';
  current = null;
}
