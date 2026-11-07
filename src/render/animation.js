// Frame-animated billboards from animated WebP (spec 13.8).
//
// One file per (sprite, action), boomeranged — forward then reverse — so the cycle has no
// seam when it loops. The file *containing* the animation is not what plays it: measured in
// the browser, an <img> of an animated WebP hands the canvas one frozen frame forever, and
// this game needs to name a frame, because two spiders never stand at the same moment of
// their walk, the player can pause, and a monster that is idle should show its still sprite.
// So the frames come out through WebCodecs' ImageDecoder, which is built for exactly that.
//
// If ImageDecoder is unavailable the whole feature switches off and every billboard keeps
// the static sprite it has today. Animation is a garnish; it must never be a dependency.
// The clip roster is a JSON manifest rather than a build-time glob. A glob is expanded when
// the module is transformed, so a clip added after the dev server started is invisible to it
// — that is exactly the failure that made only the spider animate while 48 finished clips sat
// on disk. dist/anim/ is copied verbatim by a Vite plugin (see vite.config.js), the same way
// the music manifest is, and the manifest timestamp busts the cache when the roster changes.
import * as THREE from 'three';
import manifest from '../../assets/anim/manifest.json';

function clipUrl(file) {
  if (import.meta.env.DEV) return `assets/anim/${file}`;
  const base = (import.meta.env.BASE_URL || './').replace(/\/?$/, '/');
  const v = manifest.generatedAt ? `?v=${encodeURIComponent(manifest.generatedAt)}` : '';
  return `${base}anim/${file}${v}`;
}

const byKey = new Map();
for (const e of manifest.entries || []) byKey.set(`${e.sprite}|${e.action}`, e);

export function animationSupported() {
  return typeof ImageDecoder !== 'undefined';
}

export function animationFor(spriteKey, action) {
  return byKey.get(`${spriteKey}|${action}`) || null;
}

// file -> Promise<Texture[]> ; decoded once per clip, shared by every monster of that kind
const cache = new Map();

// Why an animation is not playing. Returning null silently is how a feature ends up "on" in
// the manifest and off on screen with nobody able to say which step failed, so the last
// attempt records its reason and the self-test prints it.
let lastDiag = 'not attempted';
export function animationDiagnostic() { return lastDiag; }

function frameToTexture(bitmap) {
  const w = bitmap.displayWidth, h = bitmap.displayHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.userData = { w, h };
  return tex;
}

export function loadFrames(entry) {
  if (cache.has(entry.file)) return cache.get(entry.file);
  const work = (async () => {
    if (!animationSupported()) { lastDiag = 'no ImageDecoder in this browser'; return null; }
    const url = clipUrl(entry.file);
    const res = await fetch(url);
    if (!res.ok) { lastDiag = `fetch ${url} -> HTTP ${res.status}`; return null; }
    const buf = await res.arrayBuffer();
    // ImageDecoder wants an ArrayBuffer. A Blob throws a type error that reads like the API
    // is missing, which is how this nearly got written off as unsupported.
    const dec = new ImageDecoder({ data: buf, type: 'image/webp' });
    await dec.tracks.ready;
    // Track metadata is not dependable here: this build hands back a null selectedTrack
    // while decoding frames perfectly well. So the frame count is a hint when present, and
    // the decode loop itself, which reports when it has produced the last frame, is the
    // authority.
    const track = dec.selectedTrack || (dec.tracks && dec.tracks.list && dec.tracks.list[0]) || null;
    const declared = track && track.frameCount ? track.frameCount : entry.frames;
    const out = [];
    let guard = 0;
    while (guard++ < declared + 4) {
      try {
        // decode() must be called in frame order; it is a streaming decoder, not random access
        const r = await dec.decode({ frameIndex: out.length });
        out.push(frameToTexture(r.image));
        r.image.close();
      } catch (e) {
        // The decoder refuses the frame past the last one. Note that `complete` is not a
        // usable stop signal here: this build reports true on frame 0 of a 32-frame file.
        lastDiag = `stopped after ${out.length} frames: ${e && e.message}`;
        break;
      }
    }
    // No destroy() in this build; the object is garbage-collected once the loop is done.
    if (typeof dec.destroy === 'function') dec.destroy();
    if (!out.length) { lastDiag = `track=${track ? 'present' : 'null'} but no frames decoded`; return null; }
    lastDiag = `decoded ${out.length} frames of ${entry.file} (container declared ${declared})`;
    return out;
  })().catch((e) => { lastDiag = `decode threw: ${e && e.message}`; return null; });
  cache.set(entry.file, work);
  return work;
}

// Which frame to show. The clip is boomeranged inside the file, so the frame index simply
// wraps — no direction bookkeeping at runtime, and every monster can carry its own offset
// so a room full of the same creature does not march in step.
export function frameIndex(entry, clockSeconds, offset = 0) {
  if (!entry || !entry.frames) return 0;
  const fps = entry.fps || 16;
  return Math.floor(((clockSeconds + offset) * fps)) % entry.frames;
}

export function animationEntries() {
  return manifest.entries || [];
}
