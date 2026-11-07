// Record, for every animation clip, the framing that connects its crop box to the still sprite
// the billboard was sized for - and then check the arithmetic the game will rely on.
//
//   node tools/animAnchor.mjs
//
// Why this exists: a clip cell is a tight crop of a composed 640-ish canvas, while the still
// sprite is a padded square. The billboard is one fixed quad, so stretching a tight crop into
// the space that was meant for a padded sprite enlarges the creature by roughly the padding -
// which is the slime and orc "size glitch": every idle-to-walk switch resized the monster by
// 25-30%. The fix is exact geometry at runtime, and the geometry needs three numbers that the
// bake knew and the manifest never kept: the canvas size, the scale the sprite was composed at,
// and the pixel size of the still sprite itself.
//
// They are recoverable: each clip directory holds the results.json the runner wrote, with
// `size` and `scale`, and the image manifest has the sprite's file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './pngio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAN = path.join(ROOT, 'assets/anim/manifest.json');
const IMG = path.join(ROOT, 'assets/images/manifest.json');
const ANIM = path.join(ROOT, 'experiments/anim');

const man = JSON.parse(fs.readFileSync(MAN, 'utf8'));
const imgMan = JSON.parse(fs.readFileSync(IMG, 'utf8'));
const spritePath = (slug) => {
  const e = imgMan.find(m => m.slug === slug || (m.path || '').endsWith(`/${slug}.png`) || (m.path || '').endsWith(`/${slug}.webp`));
  return e ? e.path : null;
};
const spriteDims = new Map();
function medianSubjectHeight(dir) {
  if (!fs.existsSync(dir)) return 0;
  const hs = fs.readdirSync(dir).filter(f => /^keyed_\d+\.png$/.test(f)).sort()
    .map(f => {
      const d = decodePng(fs.readFileSync(path.join(dir, f)));
      const b = subjectBoxOf(d);
      return b ? b[3] : 0;
    }).filter(h => h > 0).sort((a, b) => a - b);
  return hs.length ? hs[hs.length >> 1] : 0;
}
function subjectBoxOf(d) {
  let x0 = d.w, y0 = d.h, x1 = -1, y1 = -1;
  for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
    if (d.px[(y * d.w + x) * 4 + 3] < 40) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}
const subjectCache = new Map();
// Alpha bounding box of a still sprite in its own pixels.
function subjectBox(p) {
  if (subjectCache.has(p)) return subjectCache.get(p);
  const d = decodePng(fs.readFileSync(path.join(ROOT, p)));
  let out = null;
  if (d.channels === 4) {
    let x0 = d.w, y0 = d.h, x1 = -1, y1 = -1;
    for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
      if (d.px[(y * d.w + x) * 4 + 3] < 40) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 >= 0) out = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  }
  subjectCache.set(p, out);
  return out;
}
const sizeOf = (p) => {
  if (!spriteDims.has(p)) {
    const d = decodePng(fs.readFileSync(path.join(ROOT, p)));
    spriteDims.set(p, [d.w, d.h]);
  }
  return spriteDims.get(p);
};

let filled = 0, missing = [];
for (const e of man.entries) {
  const creature = (e.sprite || '').split('/').pop();
  const dir = path.join(ANIM, `${creature}__${e.action}`);
  const resPath = path.join(dir, 'results.json');
  const p = spritePath(e.sprite);
  if (!fs.existsSync(resPath) || !p) { missing.push(`${e.sprite} ${e.action}`); continue; }
  const r = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  if (!r.size || !r.scale) { missing.push(`${e.sprite} ${e.action} (results.json lacks size/scale)`); continue; }
  const [sw, sh] = sizeOf(p);
  // The still's own silhouette, in still pixels. This is the size the animation has to match:
  // a monster must not grow or shrink because it started walking.
  const subj = subjectBox(p);
  // And the median silhouette of the animated frames, in canvas pixels: the crop box is the
  // *union* over the clip, so it is a little taller than any one pose. Dividing one by the
  // other is what makes the locked size exact rather than 5-10% shy.
  const med = medianSubjectHeight(dir);
  e.frame = { canvas: [r.size, r.size], compose: r.scale, sprite: [sw, sh], subject: subj || null, medianSubject: med || null };
  filled++;
}

// Arithmetic check: convert each crop into still-sprite pixels and report how much of the
// still's own silhouette the animated crop covers. That is the number the runtime now uses,
// so a clip that covers 100% of the frame while its still covers 60% is a red flag.
console.log('sprite/action            canvas  compose  still     crop in still px   crop/still height');
const ratios = [];
for (const e of man.entries) {
  if (!e.frame) continue;
  const [CW] = e.frame.canvas;
  const [SW] = e.frame.sprite;
  const s = e.frame.compose;
  const off = (CW - SW * s) / 2;
  const [cx, cy, cw, ch] = e.crop;
  const sx = (cx - off) / s, sy = (cy - off) / s, sw2 = cw / s, sh2 = ch / s;
  e.anchor = { x: Number(sx.toFixed(1)), y: Number(sy.toFixed(1)), w: Number(sw2.toFixed(1)), h: Number(sh2.toFixed(1)) };
  const r = sh2 / SW;
  ratios.push({ id: `${creatureOf(e)} ${e.action}`, r });
  console.log(`${(creatureOf(e) + ' ' + e.action).padEnd(24)} ${String(CW).padStart(5)}  ${String(s).padStart(7)}  ${String(SW).padStart(5)}  ` +
    `${`${sx.toFixed(0)},${sy.toFixed(0)} ${sw2.toFixed(0)}x${sh2.toFixed(0)}`.padEnd(18)} ${(100 * r).toFixed(0)} %`);
}
function creatureOf(e) { return (e.sprite || '').split('/').pop(); }

const vals = ratios.map(x => x.r);
console.log(`\n${filled} of ${man.entries.length} entries anchored; crop height spans ${(100 * Math.min(...vals)).toFixed(0)}-${(100 * Math.max(...vals)).toFixed(0)} % of the still sprite`);
console.log('anything far above ~100 % is a clip whose motion grew the silhouette; far below is a clip that shrank it');
if (missing.length) console.log(`missing: ${missing.join(', ')}`);

fs.writeFileSync(MAN, JSON.stringify(man, null, 2) + '\n');
console.log('assets/anim/manifest.json updated with frame + anchor on every entry');
