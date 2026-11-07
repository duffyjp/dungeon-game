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

// How big a clip's frame is on the billboard, in the billboard's own units.
//
// This is the fix for monsters changing size when they start or stop animating. The billboard
// is one fixed quad sized for the *still* sprite, which is a padded square: the creature
// occupies roughly 80% of it. A clip cell is the opposite - a tight crop around the moving
// silhouette. Stretching that crop across the whole quad therefore drew the animated creature
// about 25% larger than the same monster standing still, and the pop happened on every
// idle-to-walk or walk-to-attack switch.
//
// The manifest now records the framing the bake knew and the manifest used to drop: the canvas
// the sprite was composed onto, the scale it was composed at, the pixel size of the still, and
// the still's own silhouette box. That is enough to draw a clip so the creature is exactly as
// tall as it is standing still, on the same floor line, with the clip's own aspect preserved.
//
// Locking to the still's silhouette is deliberate. Measuring the shipped clips, the animated
// box ranges from 56% to 106% of the still's height - the video model zooms and drifts a little
// - so a purely geometric mapping would still let a monster shrink when it starts walking. The
// size a player judges is the size of the creature, so the height comes from the still.
//
// Returns { w, h, dx, dy }: the quad to use and how far to shift it inside the billboard's own
// plane (dx in the sprite's local x, which rotates with the billboarding, dy in world y).
export function bodyRectFor(entry, baseW, baseH) {
  const f = entry && entry.frame;
  if (!f || !Array.isArray(f.sprite) || !f.sprite[0] || !f.sprite[1] || !Array.isArray(f.subject)) return null;
  if (!entry.cellW || !entry.cellH) return null;
  const [SW, SH] = f.sprite;
  const [, subjY, , subjH] = f.subject;
  let h = baseH * (subjH / SH);
  // The crop box is the union of every pose in the clip, so it is a little taller than the
  // standing pose the still shows. medianSubject is the clip's usual silhouette height, and
  // dividing by it is what removes the last 5-10% of shrink.
  if (f.medianSubject && entry.crop && entry.crop[3]) {
    const k = entry.crop[3] / f.medianSubject;
    if (k > 0.5 && k < 2) h *= k;
  }
  const w = h * (entry.cellW / entry.cellH);
  if (!(h > 0.05 * baseH && h < 1.8 * baseH) || !(w > 0.05 * baseW && w < 2.2 * baseW)) return null;
  // The silhouette's feet line, and its horizontal centre, in the standing sprite's placement.
  const feetY = baseH * (1 - (subjY + subjH) / SH);
  const centreX = baseW * ((f.subject[0] + f.subject[2] / 2) / SW - 0.5);
  return { w, h, dx: centreX, dy: (feetY + h / 2) - baseH / 2 };
}

export function animationEntries() {
  return manifest.entries || [];
}
