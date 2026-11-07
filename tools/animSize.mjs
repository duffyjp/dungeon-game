// Does the animation itself change the size of a monster? The owner reported slimes and orcs
// popping in and out of scale on the first level, which is either a runtime bug or an artefact
// of the generated clips - and the two have completely different fixes, so measure first.
//
//   node tools/animSize.mjs                 all shipped clips
//   node tools/animSize.mjs slime orc       filter by creature name
//
// What it measures, from the keyed frames the shipped WebP was actually encoded from
// (experiments/anim/<clip>/keyed_*.png, still on disk):
//   * the subject bounding box in every frame, so drift within a clip shows up as a height
//     swing and a foot-line wobble;
//   * the mean subject height per action, because the game swaps clips when a monster starts
//     attacking or retreating, and a clip drawn at a different scale pops on that cut;
//   * the still sprite that the billboard was sized for, as the reference the clips are
//     supposed to agree with.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './pngio.mjs';
import { keyFrame } from './videoKit.mjs';

// decodePng hands back {w,h,channels,px}; the pipeline works in RGBA, so widen when needed -
// same as tools/animMeasure.mjs does, kept here as a helper rather than re-derived per script.
function readRgba(abs) {
  const dec = decodePng(fs.readFileSync(abs));
  const W = dec.w, H = dec.h;
  if (dec.channels === 4) return { W, H, rgba: dec.px };
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0, p = 0; i < W * H; i++, p += dec.channels) {
    rgba[i * 4] = dec.px[p]; rgba[i * 4 + 1] = dec.px[p + 1]; rgba[i * 4 + 2] = dec.px[p + 2]; rgba[i * 4 + 3] = 255;
  }
  return { W, H, rgba };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANIM = path.join(ROOT, 'experiments/anim');
const filter = process.argv.slice(2).filter(a => !a.startsWith('--'));

function bbox(rgba, W, H, minAlpha = 12) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (rgba[(y * W + x) * 4 + 3] < minAlpha) continue;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, feet: y1, cx: (x0 + x1) / 2, area: n };
}

// Subject box of a still sprite: those carry the painted magenta backdrop, so key them the way
// the pipeline does rather than trusting alpha.
function stillBox(slugPath) {
  const abs = path.join(ROOT, slugPath);
  if (!fs.existsSync(abs)) return null;
  const { W, H, rgba } = readRgba(abs);
  const k = keyFrame(rgba, W, H);
  const out = bbox(k.rgba, W, H);
  return out ? { ...out, W, H } : null;
}

const dirs = fs.readdirSync(ANIM, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name !== 'atlas' && e.name.includes('__'))
  .map(e => e.name)
  .filter(n => !filter.length || filter.some(f => n.includes(f)))
  .sort();

const rows = [];
for (const name of dirs) {
  const frames = fs.readdirSync(path.join(ANIM, name)).filter(f => /^keyed_\d+\.png$/.test(f)).sort();
  if (frames.length < 3) continue;
  const boxes = [];
  const dims = { W: 0, H: 0 };
  for (const f of frames) {
    const { W, H, rgba } = readRgba(path.join(ANIM, name, f));
    dims.W = W; dims.H = H;
    boxes.push(bbox(rgba, W, H));
  }
  const good = boxes.filter(Boolean);
  if (good.length < 3) continue;
  const h = good.map(b => b.h), w = good.map(b => b.w), feet = good.map(b => b.feet), cx = good.map(b => b.cx);
  const mean = (a) => a.reduce((t, v) => t + v, 0) / a.length;
  const spread = (a) => (Math.max(...a) - Math.min(...a)) / mean(a);
  const [creature, action] = name.split('__');
  rows.push({
    name, creature, action, frames: good.length,
    hMean: mean(h), hSpread: spread(h), wSpread: spread(w),
    feetSpread: spread(feet), cxSpread: spread(cx),
    firstLast: Math.abs(h[0] - h[h.length - 1]) / mean(h),
    hMin: Math.min(...h), hMax: Math.max(...h), W: dims.W
  });
}

// Per creature, how much do the actions disagree with each other and with the still sprite?
const byCreature = new Map();
for (const r of rows) (byCreature.get(r.creature) || byCreature.set(r.creature, []).get(r.creature)).push(r);

console.log('clip                                frames  height spread  feet wobble  x wobble  first-vs-last');
for (const r of rows.sort((a, b) => b.hSpread - a.hSpread)) {
  console.log(
    `${r.name.padEnd(35)} ${String(r.frames).padStart(5)}   ${(r.hSpread * 100).toFixed(1).padStart(6)} %  ` +
    `${(r.feetSpread * 100).toFixed(1).padStart(9)} %  ${(r.cxSpread * 100).toFixed(1).padStart(8)} %  ${(r.firstLast * 100).toFixed(1).padStart(11)} %`
  );
}

console.log('\nper creature: mean subject height per action, and the still sprite the billboard was sized for');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/images/manifest.json'), 'utf8'));
for (const [creature, rs] of [...byCreature.entries()].sort()) {
  const per = rs.map(r => `${r.action} ${(100 * r.hMean / r.W).toFixed(1)}%`).join('  ');
  const entry = manifest.find(e => e.slug && (e.slug.endsWith('/' + creature) || e.slug === creature));
  const sb = entry ? stillBox(entry.path) : null;
  const still = sb ? `still ${(100 * sb.h / sb.H).toFixed(1)}%` : 'still (not found)';
  const heights = rs.map(r => r.hMean / r.W);
  const disagree = (Math.max(...heights) - Math.min(...heights)) / (Math.min(...heights));
  console.log(`${creature.padEnd(20)} ${per}   ${still}   action disagreement ${(disagree * 100).toFixed(1)} %`);
}
