// Turn an albedo tile into a tangent-space normal map.
//
//   node tools/normalFromAlbedo.mjs --keys wall_crypt              one tile
//   node tools/normalFromAlbedo.mjs --all-tiles --size 512         the whole set
//   node tools/normalFromAlbedo.mjs --keys wall_crypt --strength 2.4 --blur 3
//
// Why offline rather than a model: a normal map is geometry, not imagery. Deriving it from
// the tile's own shading means the relief agrees with the albedo, it is reproducible from the
// source, and it carries no third-party licence question at all â€” the only generated thing in
// the chain is the albedo. It also costs milliseconds instead of GPU minutes.
//
// Method: luminance -> box blur (a raw albedo is too high-frequency: per-grain noise turns
// into sparkle under a moving light) -> Sobel gradients -> normal = normalize(-dx, -dy, 1).
// The result is written as an RGB PNG in the OpenGL convention (green up); --invertY flips it,
// because which convention agrees with the artwork's own shading is something to check against
// a render, not to assert from a spec.
import fs from 'fs';
import os from 'node:os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './pngio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const SIZE = Number(arg('size', 512));
const STRENGTH = Number(arg('strength', 1.8));
const BLUR = Number(arg('blur', 2));
const INVERT_Y = process.argv.includes('--invertY');
const OUT = arg('out', 'assets/images/normals');
const FORMAT = arg('format', 'webp');
const WEBP_Q = Number(arg('webp-quality', 92));
const keys = process.argv.includes('--all-tiles')
  ? fs.readdirSync(path.join(ROOT, 'assets/images/textures')).filter(f => f.endsWith('.png')).map(f => f.replace(/\.png$/, ''))
  : (arg('keys') || '').split(',').map(s => s.trim()).filter(Boolean);
// Where the albedo lives. A candidate restyle is measured in experiments/ before anything in
// assets/ is touched, so the tool has to be able to read a tile from somewhere else â€” and
// resolve() rather than join(), because a caller may pass an absolute temp directory.
const SRC_DIR = path.resolve(ROOT, arg('src-dir', 'assets/images/textures'));
const OUT_DIR = path.resolve(ROOT, OUT);

if (!keys.length) {
  console.error('usage: node tools/normalFromAlbedo.mjs --keys wall_crypt[,floor_crypt] | --all-tiles [--size 512] [--strength 1.8] [--blur 2] [--invertY]');
  process.exit(2);
}

// Nearest-free box downscale without alpha: normals and albedo both want an averaged pixel.
function downscaleRGB(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 3);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx), y0 = Math.floor(y * fy);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx)), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) for (let xx = x0; xx < x1 && xx < sw; xx++) {
        const o = (yy * sw + xx) * 3;
        r += src[o]; g += src[o + 1]; b += src[o + 2]; n++;
      }
      const d = (y * dw + x) * 3;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n;
    }
  }
  return out;
}

function luminance(rgb, w, h) {
  const L = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 3;
    L[i] = 0.2126 * rgb[o] + 0.7152 * rgb[o + 1] + 0.0722 * rgb[o + 2];
  }
  return L;
}

// Separable box blur, wrapping at the edges: the tile repeats in the shader, so a non-wrapping
// blur would invent a seam that the mirrored composite then doubles.
function boxBlur(L, w, h, radius) {
  if (radius < 1) return L;
  const tmp = new Float64Array(w * h);
  const span = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += L[y * w + ((x % w) + w) % w];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / span;
      acc -= L[y * w + ((x - radius) % w + w) % w];
      acc += L[y * w + ((x + radius + 1) % w + w) % w];
    }
  }
  const out = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[((y % h) + h) % h * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / span;
      acc -= tmp[((y - radius) % h + h) % h * w + x];
      acc += tmp[((y + radius + 1) % h + h) % h * w + x];
    }
  }
  return out;
}

function sobelNormals(H, w, h, strength, invertY) {
  const out = Buffer.alloc(w * h * 3);
  let devSum = 0, busy = 0;
  const at = (x, y) => H[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      let gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      if (invertY) gy = -gy;
      const nx = -gx / 255 * strength, ny = -gy / 255 * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const o = (y * w + x) * 3;
      out[o] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      const dev = Math.hypot(out[o] - 128, out[o + 1] - 128);
      devSum += dev;
      if (dev > 12) busy++;
    }
  }
  return { rgb: out, meanDev: devSum / (w * h), busyPct: 100 * busy / (w * h) };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
console.log(`normal maps: ${keys.length} tile(s) at ${SIZE} px, strength ${STRENGTH}, blur ${BLUR}, green ${INVERT_Y ? 'down' : 'up'}`);
for (const key of keys) {
  const src = path.join(SRC_DIR, `${key}.png`);
  if (!fs.existsSync(src)) { console.log(`  skip ${key}: no such texture`); continue; }
  const dec = decodePng(fs.readFileSync(src));
  const rgb = dec.channels === 3 ? dec.px : (() => {
    const o = Buffer.alloc(dec.w * dec.h * 3);
    for (let i = 0; i < dec.w * dec.h; i++) {
      o[i * 3] = dec.px[i * 4]; o[i * 3 + 1] = dec.px[i * 4 + 1]; o[i * 3 + 2] = dec.px[i * 4 + 2];
    }
    return o;
  })();
  const small = downscaleRGB(rgb, dec.w, dec.h, SIZE, SIZE);
  const H = boxBlur(luminance(small, SIZE, SIZE), SIZE, SIZE, BLUR);
  const n = sobelNormals(H, SIZE, SIZE, STRENGTH, INVERT_Y);
  const buf = encodePng(SIZE, SIZE, 3, n.rgb);
  // Shipping format: a normal map is a smooth directional field, and lossy WebP at q92
  // stores it for 79 KB where the PNG needs 608 KB. The deviation statistics are measured
  // from the same pixels either way, and the render check is what decides whether the loss
  // is visible â€” so the format is a flag, not a guess.
  let final = buf, finalName = `${key}.png`;
  if (FORMAT === 'webp') {
    const tmpPng = path.join(os.tmpdir(), `strata-normal-${key}.png`);
    fs.writeFileSync(tmpPng, buf);
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', tmpPng,
      '-c:v', 'libwebp', '-pix_fmt', 'yuva444p', '-lossless', '0',
      '-quality', String(WEBP_Q), '-compression_level', '6',
      path.join(OUT_DIR, `${key}.webp`)], { stdio: ['ignore', 'pipe', 'pipe'] });
    fs.unlinkSync(tmpPng);
    final = fs.readFileSync(path.join(OUT_DIR, `${key}.webp`));
    finalName = `${key}.webp`;
    // Keep a PNG copy out of the shipped folder so the registry cannot see both.
    const stale = path.join(OUT_DIR, `${key}.png`);
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  } else {
    const stale = path.join(OUT_DIR, `${key}.webp`);
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }
  const to = path.join(OUT_DIR, finalName);
  fs.writeFileSync(to, final);
  total += final.length;
  console.log(`  ${key.padEnd(18)} ${SIZE}x${SIZE}  ${(final.length / 1024).toFixed(0)} KB  ` +
    `mean normal deviation ${n.meanDev.toFixed(1)}/128, ${n.busyPct.toFixed(1)}% of texels carrying relief`);
}
console.log(`\ntotal ${(total / 1024 / 1024).toFixed(2)} MB written under ${OUT}`);
console.log('relief is asserted by the deviation numbers; whether the bumps read as in or out is checked against a render');
