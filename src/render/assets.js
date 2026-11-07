// Asset registry + runtime chroma-key pipeline (spec §11, §13).
//
// Every texture in the game comes from a z_image_turbo generation under
// assets/images/. Assets that have not been generated yet fall back to a
// procedural placeholder, so the game is playable at every milestone (M0-M4)
// and silently upgrades itself as the PNGs land. Nothing here is a stand-in
// that ships: the manifest in assets/images/manifest.json is the source of truth.

import * as THREE from 'three';
import { chromaKeyCanvas } from './chromaKey.js';

// Underscore-prefixed folders are archive, not content. `assets/images/_photoreal_v1/`
// keeps every superseded photographic pass for reference, and globbing them in would ship
// 57 images nobody displays — the built site would be twice the download for a visitor. A
// negated pattern keeps them out of the build entirely, not just out of the registry.
// WebP is accepted alongside PNG. For opaque ground and wall tiles it is not a cosmetic
// choice: the same gritty 512 px surface costs 82 KB as WebP against 583 KB as PNG, and the
// measured alpha behaviour of WebP in this browser was checked before the animated sprites
// shipped on it. Keys drop the extension, so `textures/wall_crypt` resolves to whichever
// container the art happens to be stored in.
const found = import.meta.glob(
  ['../../assets/images/**/*.{png,webp}', '!../../assets/images/_*/**'],
  { eager: true, query: '?url', import: 'default' }
);

const URLS = {};
for (const [path, url] of Object.entries(found)) {
  const key = path.replace(/^.*assets\/images\//, '').replace(/\.(png|webp)$/i, '').replace(/\\/g, '/');
  URLS[key] = url;
}

export function hasAsset(key) { return Boolean(URLS[key]); }
export function assetUrl(key) { return URLS[key] || null; }
export function assetKeys() { return Object.keys(URLS).sort(); }

// Ground contact shadows are drawn, not generated. The generated `vfx/contact_shadow`
// blob keys out with a hard edge, and under a pale creature it photographed as a hole in
// the floor; a radial gradient in code has no edge to key, costs no art slot, and can be
// scaled per creature.
let softShadowTex = null;
export function getSoftShadowTexture() {
  if (softShadowTex) return softShadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 3, 64, 64, 62);
  grd.addColorStop(0, 'rgba(0,0,0,0.85)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.42)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  softShadowTex = new THREE.CanvasTexture(c);
  softShadowTex.colorSpace = THREE.SRGBColorSpace;
  return softShadowTex;
}

const cache = new Map();     // key -> THREE.Texture
const pending = new Map();   // key -> Promise<THREE.Texture>

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load ' + url));
    img.src = url;
  });
}

// ---- placeholder art (development only, never shipped) -----------------------

function placeholderCanvas(key, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const isTile = key.startsWith('textures/');
  const hue = [...key].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  g.fillStyle = `hsl(${hue} 18% 26%)`;
  g.fillRect(0, 0, size, size);
  // blocky noise so surfaces are not flat while untextured
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    g.fillStyle = `hsl(${hue} 20% ${18 + Math.random() * 22}%)`;
    g.fillRect(x, y, 2 + Math.random() * 6, 2 + Math.random() * 6);
  }
  if (!isTile) {
    g.fillStyle = 'rgba(0,0,0,0)';
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 4;
    g.beginPath();
    g.ellipse(size / 2, size * 0.72, size * 0.3, size * 0.26, 0, 0, Math.PI * 2);
    g.stroke();
    g.font = `600 ${Math.round(size * 0.11)}px system-ui`;
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.textAlign = 'center';
    const name = key.split('/').pop().replace(/_/g, ' ');
    g.fillText(name.slice(0, 16), size / 2, size * 0.4);
  } else {
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 3;
    g.strokeRect(4, 4, size - 8, size - 8);
  }
  return c;
}

// ---- public API -------------------------------------------------------------

// Tiles and UI chrome are not chroma-keyed: tiles are scene surfaces, and UI frames
// are generated on a dark background (spec §13.5), so keying them would punch holes
// in the art. Only entities, items, props and VFX sit on a chroma backdrop.
function isKeyed(key) {
  return key.startsWith('enemies/') || key.startsWith('items/') ||
         key.startsWith('props/') || key.startsWith('vfx/');
}

// Generated art is 1024². Keeping every sprite at full resolution costs ~350 MB of
// RGBA in VRAM for a ~40-sprite scene, and a billboard never occupies more than a few
// hundred pixels on screen, so sprite-size keys are downscaled on load.
const MAX_SPRITE_PX = 512;
function spriteSize(key) {
  return isKeyed(key) && !key.startsWith('props/staircase_down') ? MAX_SPRITE_PX : 0;
}

// Does this image carry a real alpha channel? Detect it from the pixels rather than from a
// naming convention: a chroma-keyed file and a genuinely transparent one can then live in
// the same folder and behave correctly without anyone remembering which is which. An RGBA
// generation needs no keying pass at all, which is the whole reason to prefer one for soft
// subjects — no matte, no colour picked up from the key field at the feathered edge.
export function hasRealAlpha(canvas, g) {
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  let sampled = 0, transparent = 0;
  for (let i = 3; i < d.length; i += 4 * 61) { sampled++; if (d[i] < 250) transparent++; }
  return sampled > 0 && transparent / sampled > 0.02;
}

export async function loadTexture(key, { keyed = isKeyed(key), repeat = null } = {}) {
  const existing = cache.get(key);
  if (existing && !existing.userData.placeholder) return existing;
  if (pending.has(key)) return pending.get(key);

  const p = (async () => {
    let canvas;
    let artHasAlpha = false;
    if (URLS[key]) {
      const img = await loadImage(URLS[key]);
      const cap = spriteSize(key);
      const w = cap ? Math.min(img.naturalWidth, cap) : img.naturalWidth;
      const h = cap ? Math.round(img.naturalHeight * (w / img.naturalWidth)) : img.naturalHeight;
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      g.drawImage(img, 0, 0, w, h);
      artHasAlpha = keyed && hasRealAlpha(canvas, g);
      if (keyed && !artHasAlpha) chromaKeyCanvas(canvas);
    } else {
      canvas = placeholderCanvas(key);
      console.info(`[assets] not generated yet: ${key} (placeholder in use)`);
    }
    // If a placeholder is already bound to materials, mutate it in place instead of
    // swapping the texture object, so anything already drawn upgrades without a reload.
    const tex = (existing && existing.userData.placeholder) ? existing : new THREE.CanvasTexture(canvas);
    if (tex !== existing || tex.userData.placeholder) {
      tex.image = canvas;
      tex.userData.placeholder = false;
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    // Recorded for the QA pages: an alpha asset has no keying step to measure, so the
    // chroma report treats it as out of scope rather than as a failure.
    tex.userData.alphaArt = artHasAlpha;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    if (repeat) tex.repeat.set(repeat[0], repeat[1]);
    tex.needsUpdate = true;
    cache.set(key, tex);
    pending.delete(key);
    return tex;
  })();

  pending.set(key, p);
  return p;
}

// Synchronous access used by hot paths after preload; returns the cached texture
// or a synchronously generated placeholder so rendering never breaks.
export function getTexture(key, opts = {}) {
  if (cache.has(key)) return cache.get(key);
  const tex = new THREE.CanvasTexture(placeholderCanvas(key));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.placeholder = true;
  cache.set(key, tex);
  // Kick off the real load too, so a late-arriving asset replaces the placeholder.
  loadTexture(key, opts).catch(() => {});
  return tex;
}

// Mirror-tiling pass.
// Z-Image "seamless tileable" outputs still carry a lighting gradient, which shows
// up as a hard seam at every tile boundary (verified with /seamcheck.html). Building
// a 2x2 mirrored composite makes the edges match by construction: the wrap boundary
// always meets a mirrored copy of the same edge pixels, so no seam can appear.
const mirrorCache = new Map();

export function getMirroredTexture(key) {
  if (mirrorCache.has(key)) return mirrorCache.get(key);
  const src = getTexture(key);
  const build = (img) => {
    // Cap each tile at 512 px: a 1024² source mirrored into a 2048² composite costs
    // 16 MB per material, and a tile only ever covers a 2 m cell, so 512 px/tile is
    // more detail than the player can resolve under torch light.
    const s = Math.min(img.width, 512);
    const c = document.createElement('canvas');
    c.width = c.height = s * 2;
    const g = c.getContext('2d');
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        g.save();
        g.translate(tx * s, ty * s);
        g.scale(tx ? -1 : 1, ty ? -1 : 1);
        g.drawImage(img, tx ? -s : 0, ty ? -s : 0, s, s);
        g.restore();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    mirrorCache.set(key, tex);
    return tex;
  };
  // The placeholder canvas is uniform noise, so mirroring it is harmless.
  return build(src.image);
}

export async function loadMirroredTexture(key) {
  await loadTexture(key);
  return getMirroredTexture(key);
}

// Normal maps get the same mirror composite, with one difference that matters: mirroring a
// normal map is not mirroring a picture. The stored colour *is* a direction — red is slope
// along U, green slope along V — so a horizontally mirrored quadrant must have its red
// channel negated, a vertically mirrored one its green, and the corner both. Skipping that
// leaves the relief pointing the wrong way at every seam, which reads as the wall changing
// shape as you walk past it. Colour space is linear: a normal map is data, not an image.
const normalMirrorCache = new Map();

export function hasNormalFor(key) {
  return hasAsset(`normals/${key.split('/').pop()}`);
}

export function getMirroredNormalTexture(key) {
  const nkey = `normals/${key.split('/').pop()}`;
  if (normalMirrorCache.has(nkey)) return normalMirrorCache.get(nkey);
  const src = getTexture(nkey);
  const img = src.image;
  if (!img || !img.width) return src;
  const s = Math.min(img.width, 512);
  const c = document.createElement('canvas');
  c.width = c.height = s * 2;
  const g = c.getContext('2d', { willReadFrequently: true });
  const one = document.createElement('canvas');
  one.width = one.height = s;
  const oneG = one.getContext('2d', { willReadFrequently: true });
  oneG.drawImage(img, 0, 0, s, s);
  const base = oneG.getImageData(0, 0, s, s);
  const out = g.createImageData(s * 2, s * 2);
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const flipX = tx === 1, flipY = ty === 1;
      for (let y = 0; y < s; y++) {
        const sy = flipY ? s - 1 - y : y;
        for (let x = 0; x < s; x++) {
          const sx = flipX ? s - 1 - x : x;
          const i = (sy * s + sx) * 4, o = ((ty * s + y) * (s * 2) + (tx * s + x)) * 4;
          let r = base.data[i], grn = base.data[i + 1];
          if (flipX) r = 255 - r;
          if (flipY) grn = 255 - grn;
          out.data[o] = r;
          out.data[o + 1] = grn;
          out.data[o + 2] = base.data[i + 2];
          out.data[o + 3] = 255;
        }
      }
    }
  }
  g.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  normalMirrorCache.set(nkey, tex);
  return tex;
}

export async function loadMirroredNormalTexture(key) {
  const nkey = `normals/${key.split('/').pop()}`;
  if (!hasAsset(nkey)) return null;
  await loadTexture(nkey, { keyed: false });
  return getMirroredNormalTexture(key);
}

// Roughness companion. A scalar map stores no direction, so the mirror composite is a plain
// geometric flip with no channel negation — the thing that mattered for normals does not
// apply here, and saying so in code is what stops someone "fixing" it later.
const roughMirrorCache = new Map();

export function hasRoughnessFor(key) {
  return hasAsset(`roughness/${key.split('/').pop()}`);
}

export function getMirroredRoughnessTexture(key) {
  const rkey = `roughness/${key.split('/').pop()}`;
  if (roughMirrorCache.has(rkey)) return roughMirrorCache.get(rkey);
  const src = getTexture(rkey);
  const img = src.image;
  if (!img || !img.width) return src;
  const s = Math.min(img.width, 512);
  const c = document.createElement('canvas');
  c.width = c.height = s * 2;
  const g = c.getContext('2d');
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      g.save();
      g.translate(tx * s, ty * s);
      g.scale(tx ? -1 : 1, ty ? -1 : 1);
      g.drawImage(img, tx ? -s : 0, ty ? -s : 0, s, s);
      g.restore();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  roughMirrorCache.set(rkey, tex);
  return tex;
}

export async function loadMirroredRoughnessTexture(key) {
  const rkey = `roughness/${key.split('/').pop()}`;
  if (!hasAsset(rkey)) return null;
  await loadTexture(rkey, { keyed: false });
  return getMirroredRoughnessTexture(key);
}

// Height companion for displacement. Same shape as the roughness composite — a scalar field,
// mirrored geometrically, linear colour space — and consumed by the vertex shader, which is
// why the mesh has to be subdivided: displacement moves vertices, and a wall box with one
// quad per face has four corners to move.
const scalarMirrorCache = new Map();

function mirroredScalar(folder, key) {
  const skey = `${folder}/${key.split('/').pop()}`;
  if (scalarMirrorCache.has(skey)) return scalarMirrorCache.get(skey);
  const src = getTexture(skey);
  const img = src.image;
  if (!img || !img.width) return src;
  const s = Math.min(img.width, 512);
  const c = document.createElement('canvas');
  c.width = c.height = s * 2;
  const g = c.getContext('2d');
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      g.save();
      g.translate(tx * s, ty * s);
      g.scale(tx ? -1 : 1, ty ? -1 : 1);
      g.drawImage(img, tx ? -s : 0, ty ? -s : 0, s, s);
      g.restore();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  scalarMirrorCache.set(skey, tex);
  return tex;
}

export function hasHeightFor(key) {
  return hasAsset(`heights/${key.split('/').pop()}`);
}

export function getMirroredHeightTexture(key) {
  return mirroredScalar('heights', key);
}

export async function loadMirroredHeightTexture(key) {
  const hkey = `heights/${key.split('/').pop()}`;
  if (!hasAsset(hkey)) return null;
  await loadTexture(hkey, { keyed: false });
  return getMirroredHeightTexture(key);
}

export async function preloadAll(keys) {
  const results = await Promise.allSettled(keys.map(k => loadTexture(k)));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? keys[i] : null))
    .filter(Boolean);
  return { loaded: results.length - failed.length, failed };
}
