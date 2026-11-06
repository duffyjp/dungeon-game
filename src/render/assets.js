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
const found = import.meta.glob(
  ['../../assets/images/**/*.png', '!../../assets/images/_*/**'],
  { eager: true, query: '?url', import: 'default' }
);

const URLS = {};
for (const [path, url] of Object.entries(found)) {
  const key = path.replace(/^.*assets\/images\//, '').replace(/\.png$/i, '').replace(/\\/g, '/');
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

export async function loadTexture(key, { keyed = isKeyed(key), repeat = null } = {}) {
  const existing = cache.get(key);
  if (existing && !existing.userData.placeholder) return existing;
  if (pending.has(key)) return pending.get(key);

  const p = (async () => {
    let canvas;
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
      if (keyed) chromaKeyCanvas(canvas);
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

export async function preloadAll(keys) {
  const results = await Promise.allSettled(keys.map(k => loadTexture(k)));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? keys[i] : null))
    .filter(Boolean);
  return { loaded: results.length - failed.length, failed };
}
