// Turn an isolated decal on a flat backdrop into a shipped RGBA tile.
//
//   node tools/decalAlpha.mjs --src experiments/decalalpha/strata-decalalpha-blood_splatter_00001.png --key blood_splatter
//
// Why these went through transparency after all: the blood and scorch decals are floor
// planes, and their tiles were opaque squares of stone. Hiding the square edge was done with
// a radial alpha mask, which produced exactly what it says on the screenshot — a pool of
// light with a dark shape in it. The fix is the one used for the enemy sprites: ask the
// model for the subject on a flat chroma backdrop, key it here, and let the art carry its
// own silhouette. The engine drops the mask on its own when a decal has real alpha.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './pngio.mjs';
import { keyFrame, borderBackdrop } from './videoKit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const src = arg('src'), key = arg('key');
const OUT = arg('out', 'assets/images/textures');
const Q = Number(arg('quality', 86));
if (!src || !key) {
  console.error('usage: node tools/decalAlpha.mjs --src <image> --key blood_splatter [--out assets/images/textures] [--quality 86]');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-decal-'));
const png = path.join(tmp, `${key}.png`);
try { execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.resolve(ROOT, src), '-pix_fmt', 'rgba', png], { stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { console.error(`decode failed: ${(e.stderr || '').toString().split('\n').filter(Boolean).slice(-2).join(' ')}`); process.exit(1); }

const dec = decodePng(fs.readFileSync(png));
const rgba = dec.channels === 4 ? dec.px : (() => {
  const o = Buffer.alloc(dec.w * dec.h * 4);
  for (let i = 0; i < dec.w * dec.h; i++) {
    o[i * 4] = dec.px[i * 3]; o[i * 4 + 1] = dec.px[i * 3 + 1]; o[i * 4 + 2] = dec.px[i * 3 + 2]; o[i * 4 + 3] = 255;
  }
  return o;
})();

const bg = borderBackdrop(rgba, dec.w, dec.h);
const result = keyFrame(rgba, dec.w, dec.h, { backdrop: bg });
const keyed = result.rgba;
let clear = 0, soft = 0, solid = 0;
for (let i = 0; i < dec.w * dec.h; i++) {
  const a = keyed[i * 4 + 3];
  if (a < 12) clear++; else if (a > 244) solid++; else soft++;
}
const n = dec.w * dec.h;
console.log(`${arg('key')}: backdrop rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}) gate ${Number(result.gate).toFixed(2)} — clear ${(100 * clear / n).toFixed(1)}%, soft ${(100 * soft / n).toFixed(1)}%, solid ${(100 * solid / n).toFixed(1)}%`);
if (clear / n < 0.25) {
  console.error('REFUSED: less than a quarter of the frame keyed out. The subject probably fills the tile, or the backdrop was not the colour the instruction asked for.');
  process.exit(1);
}
if (solid / n < 0.04) {
  console.error('REFUSED: less than 4% of the frame is opaque subject — the keyer has eaten the decal.');
  process.exit(1);
}

// RGBA PNG is the auditable intermediate; the shipped file is WebP, which the registry has
// accepted since the environment pass and which the browser decodes with alpha intact.
const pngOut = path.join(ROOT, OUT, `${key}.png`);
fs.writeFileSync(pngOut, encodePng(dec.w, dec.h, 4, keyed));
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', pngOut, '-c:v', 'libwebp', '-pix_fmt', 'yuva444p',
  '-lossless', '0', '-quality', String(Q), '-compression_level', '6', path.join(ROOT, OUT, `${key}.webp`)], { stdio: ['ignore', 'pipe', 'pipe'] });
fs.unlinkSync(pngOut);
const webp = fs.statSync(path.join(ROOT, OUT, `${key}.webp`));
const old = path.join(ROOT, 'assets/images/_textures_v1', `${key}.png`);
const cur = path.join(ROOT, OUT, `${key}.png`);
if (fs.existsSync(cur)) fs.renameSync(cur, old);
console.log(`shipped ${OUT}/${key}.webp at ${dec.w}x${dec.h}, ${(webp.size / 1024).toFixed(0)} KB (any superseded PNG archived under assets/images/_textures_v1)`);
fs.rmSync(tmp, { recursive: true, force: true });
