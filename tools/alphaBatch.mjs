// Batch: turn the 2D sprite set into properly alpha-channelled art with Qwen-Image-2.1,
// and prove each result before it is allowed near the asset tree.
//
//   node tools/alphaBatch.mjs --groups enemies,items,vfx
//   node tools/alphaBatch.mjs --keys vfx/ghost_trail,enemies/t1/goblin_archer
//
// Why a batch runner instead of a loop in the shell: every asset needs three checks that a
// human will not eyeball 49 times.
//   1. transparency  — clear and opaque share, because "colour type 6" can be fully opaque
//   2. identity      — overlap between the new alpha mask and the mask of the art we already
//                     approved; this model repaints, and IoU is how we see how far it drifted
//   3. edge colour   — the semi-transparent band, which the model renders violet
// Anything that fails is kept in experiments/alpha/raw and reported; nothing here writes to
// assets/images/. That is a separate, deliberate step (tools/promoteAlpha.mjs).
//
// One generation in flight at a time, and resumable: an existing passing output is skipped,
// so an interrupted run can be restarted without re-burning seeds.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { analyzePng } from './pngAlpha.mjs';
import { decodePng } from './pngio.mjs';
import { despill } from './alphaDespill.mjs';

const OUT = 'experiments/alpha';
const RAW = path.join(OUT, 'raw');
fs.mkdirSync(RAW, { recursive: true });
const LOG = path.join(OUT, 'results.json');

const FRAMING = 'the image contains an alpha channel.';
const TAIL = 'transparent background';
const KEEP = 'Remove the background so the subject floats on nothing. Keep the subject itself exactly as drawn: same pose, same silhouette, same proportions, same colours, same materials, same painted stylization, same soft feathered edges.';

const manifest = JSON.parse(fs.readFileSync('assets/images/manifest.json', 'utf8'));
const allKeys = manifest.map(r => String(r.path || '')
  .replace(/^assets\/images\//, '').replace(/\.png$/i, ''));

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const keys = (arg('keys') ? arg('keys').split(',') : [])
  .concat(...(arg('groups') ? arg('groups').split(',').map(g => allKeys.filter(k => k.startsWith(g + '/'))) : []));
if (!keys.length && !process.argv.includes('--rescore')) {
  console.error('nothing to do: pass --groups enemies,items,vfx or --keys a,b'); process.exit(2);
}

const results = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : {};

// The mask of art we already approved: everything that is not the chroma field. The field
// colour is sampled from the border, the same way the runtime keyer decides.
function approvedMask(file) {
  const { w, h, channels, px } = decodePng(fs.readFileSync(file));
  if (channels === 4) {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = px[i * 4 + 3] > 16 ? 1 : 0;
    return { w, h, m };
  }
  let br = 0, bg = 0, bb = 0, n = 0;
  const edge = [...Array(16).keys()].map(i => i).flatMap(i => [i, w - 1 - i]);
  for (const x of edge) for (const y of [0, Math.floor(h / 2), h - 1]) {
    const o = (y * w + x) * channels; br += px[o]; bg += px[o + 1]; bb += px[o + 2]; n++;
  }
  br /= n; bg /= n; bb /= n;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * channels;
    const d = Math.hypot(px[o] - br, px[o + 1] - bg, px[o + 2] - bb);
    m[i] = d > 70 ? 1 : 0;
  }
  return { w, h, m };
}

// Different outputs can be different sizes, so compare on a shared grid by sampling.
function overlap(a, b) {
  let inter = 0, union = 0;
  const stepX = Math.max(1, Math.floor(a.w / 256)), stepY = Math.max(1, Math.floor(a.h / 256));
  for (let y = 0; y < a.h; y += stepY) for (let x = 0; x < a.w; x += stepX) {
    const ax = a.m[y * a.w + x];
    const bx = b.m[Math.floor(y * b.h / a.h) * b.w + Math.floor(x * b.w / a.w)];
    if (ax && bx) inter++;
    if (ax || bx) union++;
  }
  return union ? +(inter / union).toFixed(3) : 0;
}

// Acceptance, after seeing 33 real results:
//   clear >= 12%              the background is genuinely absent (a painted-white field is 0%)
//   opaque + soft >= 6%       the subject is actually there (an erased cutout is 0%)
//   silhouette IoU >= 0.35    it is still the creature/item we approved
// Note what is deliberately NOT a gate: the fully-opaque share alone. A sword blade, a bow
// limb and a wraith are mostly soft-edged pixels in a square frame, and all of them scored
// 0.96+ silhouette overlap while tripping an "opaque >= 10%" rule. Translucency is a property
// of the subject, not a defect, so solidity is recorded and reported but not required.
function accepted(a, iou) {
  return a.clear >= 12 && (a.opaque + a.soft) >= 6 && iou >= 0.35;
}

function scoreRaw(key, file) {
  const a = analyzePng(fs.readFileSync(file));
  const iou = overlap(approvedMask(`assets/images/${key}.png`), approvedMask(file));
  const tint = (() => {
    const m = /\((\d+), (\d+), (\d+)\)/.exec(a.softMean || '');
    return m ? Math.min(+m[1], +m[3]) - +m[2] : 0;
  })();
  return { a, iou, tint, ok: accepted(a, iou) };
}

// Re-score existing raw outputs against a changed rule: no re-generation, no re-burned seeds.
if (process.argv.includes('--rescore')) {
  let flipped = 0, still = 0;
  for (const [key, r] of Object.entries(results)) {
    const file = r.raw && hasRaw(r.raw) ? r.raw : findRaw(key);
    if (!file) continue;
    const s = scoreRaw(key, file);
    const finalFile = path.join(OUT, `${key.replace(/[\\/]/g, '_')}.png`);
    if (s.ok) {
      fs.writeFileSync(finalFile, despill(fs.readFileSync(file)).buf);
      results[key] = { ...r, ok: true, clear: s.a.clear, soft: s.a.soft, opaque: s.a.opaque, edge: s.a.softMean, edgeTint: s.tint, iou: s.iou, final: finalFile };
      flipped++;
    } else {
      results[key] = { ...r, ok: false, clear: s.a.clear, soft: s.a.soft, opaque: s.a.opaque, edge: s.a.softMean, edgeTint: s.tint, iou: s.iou, final: null };
      still++;
    }
    console.log(`${s.ok ? 'ACCEPT' : 'reject'} ${key}: clear ${s.a.clear}% opaque ${s.a.opaque}% soft ${s.a.soft}% IoU ${s.iou}`);
  }
  fs.writeFileSync(LOG, JSON.stringify(results, null, 2));
  console.log(`\nrescored: ${flipped} accepted, ${still} rejected. Nothing written to assets/images/.`);
  process.exit(0);
}

function hasRaw(f) { return fs.existsSync(f); }
function findRaw(key) {
  const slug = key.replace(/[\\/]/g, '_');
  const hit = fs.readdirSync(RAW).find(f => f.startsWith(`strata-alphabatch-${slug}`) && f.endsWith('.png'));
  return hit ? path.join(RAW, hit) : null;
}

let done = 0, okCount = 0;
for (const key of keys) {
  const slug = key.replace(/[\\/]/g, '_');
  const finalFile = path.join(OUT, `${slug}.png`);
  if (results[key] && results[key].ok) { done++; okCount++; console.log(`skip ${key} (already passed, IoU ${results[key].iou})`); continue; }

  const src = `assets/images/${key}.png`;
  if (!fs.existsSync(src)) { console.log(`missing source for ${key}, skipping`); continue; }

  const prompt = `${FRAMING} ${KEEP} ${TAIL}`;
  const seed = 44300 + done;
  const r = spawnSync(process.execPath, ['tools/comfyRun.mjs',
    '--graph', 'workflows/qwen_image_edit.json',
    '--upload', src, '--image-node', '470',
    '--set', '459:484.switch=false',
    '--set', `459:484.on_false=${prompt}`,
    '--set', `459:458.seed=${seed}`,
    '--set', '459:458.steps=20',
    '--set', `461.filename_prefix=strata-alphabatch-${slug}`,
    '--out', RAW
  ], { encoding: 'utf8', timeout: 25 * 60 * 1000 });

  const out = (r.stdout || '') + (r.stderr || '');
  const file = (out.match(/experiments[\\/][^\s]+\.png/) || [])[0];
  if (!file) {
    results[key] = { ok: false, why: 'no output', log: out.slice(-400) };
    console.log(`FAIL ${key}: no output`);
    fs.writeFileSync(LOG, JSON.stringify(results, null, 2));
    done++;
    continue;
  }

  const a = analyzePng(fs.readFileSync(file));
  const approved = approvedMask(src);
  const made = approvedMask(file);
  const iou = overlap(approved, made);
  const tint = (() => {
    const m = /\((\d+), (\d+), (\d+)\)/.exec(a.softMean || '');
    return m ? Math.min(+m[1], +m[3]) - +m[2] : 0;
  })();

  const ok = accepted(a, iou);
  if (ok) {
    const fixed = despill(fs.readFileSync(file));
    fs.writeFileSync(finalFile, fixed.buf);
    okCount++;
  }
  results[key] = {
    ok, seed, clear: a.clear, soft: a.soft, opaque: a.opaque,
    edge: a.softMean, edgeTint: tint, iou,
    raw: file, final: ok ? finalFile : null
  };
  fs.writeFileSync(LOG, JSON.stringify(results, null, 2));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${key}: clear ${a.clear}% opaque ${a.opaque}% edge ${a.softMean} tint ${tint} IoU ${iou}${ok ? ' -> ' + finalFile : ''}`);
  done++;
}

console.log(`\nbatch: ${done} attempted, ${okCount} passed. Log: ${LOG}`);
console.log('Nothing was written to assets/images/. Review, then promote deliberately.');
