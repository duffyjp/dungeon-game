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

// Optional manifest (assets/music/manifest.json) can pin the order; the glob wins
// when the manifest is absent, which is the shipping state.
export async function loadManifest() {
  try {
    const res = await fetch(new URL('../../assets/music/manifest.json', import.meta.url));
    if (!res.ok) return tracks;
    const json = await res.json();
    if (Array.isArray(json.tracks) && json.tracks.length) {
      const byName = new Map(tracks.map(t => [t.name, t]));
      const pinned = json.tracks.map(n => byName.get(n)).filter(Boolean);
      if (pinned.length) tracks = pinned;
    }
  } catch { /* no manifest: fine, glob order is used */ }
  return tracks;
}

export function playNext(reason = 'level') {
  initAudio();
  if (!tracks.length) {
    console.warn('[music] no tracks in assets/music/ — running silent');
    return null;
  }
  const pick = bag.next(tracks);
  return play(pick, reason);
}

export function playTrack(name, reason = 'menu') {
  const t = tracks.find(x => x.name === name);
  return t ? play(t, reason) : null;
}

function play(t, reason) {
  const bus = getMusicBus();
  const el = new Audio(t.url);
  el.loop = true;
  el.crossOrigin = 'anonymous';
  const gain = new GainWrapper(el);
  el.volume = muted ? 0 : 1;

  const prev = current;
  current = { name: t.name, url: t.url, el, gain };
  el.play().catch(err => console.warn('[music] blocked by browser gesture policy:', err.message));

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
