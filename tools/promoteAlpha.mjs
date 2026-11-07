// Promote validated alpha conversions into the asset tree, with provenance.
//
//   node tools/promoteAlpha.mjs --dry                       # show what would change
//   node tools/promoteAlpha.mjs --yes                       # all passing assets
//   node tools/promoteAlpha.mjs --yes --keys vfx/ghost_trail
//
// Promotion is a separate command from the batch on purpose. The batch may produce 40 good
// files; a human still decides which ones match the art direction, and this step is the only
// place anything is allowed to overwrite a shipped image. The file being replaced is copied
// into assets/images/_chroma_v1/ first, and the manifest record keeps the original model and
// seed while adding the conversion — model, licence, seed and the measurements that justified
// it — so "where did this pixel come from" stays a lookup.
import fs from 'fs';
import path from 'path';
import { decodePng, encodePng } from './pngio.mjs';

const RESULTS = 'experiments/alpha/results.json';
const BACKUP = 'assets/images/_chroma_v1';
const MODEL = 'Qwen/Qwen-Image-2.1 (qwen_image_2.1_int8_convrot.safetensors)';
const LICENCE = 'Qwen Research License (owner reviewed 2026-11-06 and accepts shipping its outputs)';

// Box-downscale an RGBA buffer to at most maxPx on a side, keeping the alpha channel.
// The conversions arrive at 1024², where the shipped sprites are 512² and the engine
// downscales to 512 at load anyway — promoting full size would roughly double the
// download for the hosted build and buy nothing on screen.
function downscale(buf, maxPx) {
  const { w, h, channels, px } = decodePng(buf);
  if (channels !== 4 || (w <= maxPx && h <= maxPx)) return { buf, w, h };
  const nw = Math.max(1, Math.round(w * (maxPx / Math.max(w, h))));
  const nh = Math.max(1, Math.round(h * (maxPx / Math.max(w, h))));
  const out = Buffer.alloc(nw * nh * 4);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const x0 = Math.floor(x * sx), y0 = Math.floor(y * sy);
    const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = y0; yy < y1 && yy < h; yy++) for (let xx = x0; xx < x1 && xx < w; xx++) {
      const o = (yy * w + xx) * 4, al = px[o + 3];
      // weight colour by alpha so a soft edge does not bleed its colour into the average
      r += px[o] * al; g += px[o + 1] * al; b += px[o + 2] * al; a += al; n++;
    }
    const d = (y * nw + x) * 4;
    if (!a) { out[d + 3] = 0; continue; }
    out[d] = Math.round(r / a); out[d + 1] = Math.round(g / a); out[d + 2] = Math.round(b / a);
    out[d + 3] = Math.round(a / n);
  }
  return { buf: encodePng(nw, nh, 4, out), w: nw, h: nh };
}

const has = f => fs.existsSync(f);
const dry = !process.argv.includes('--yes');
function arg(name) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : null; }
const only = arg('keys') ? new Set(arg('keys').split(',')) : null;
// --min-iou holds back anything whose silhouette moved noticeably; --max-px keeps the
// hosted build from inflating (default 512, which is what the engine draws a billboard at).
const minIou = Number(arg('min-iou') ?? '0.9');
const maxPx = Number(arg('max-px') ?? '512');
let held = 0;

if (!has(RESULTS)) { console.error(`${RESULTS} not found — run tools/alphaBatch.mjs first`); process.exit(2); }
const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
const manifestPath = 'assets/images/manifest.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let promoted = 0, skipped = 0;
for (const [key, r] of Object.entries(results)) {
  if (!r.ok || !r.final) { console.log(`skip ${key}: ${r.why || `failed validation (clear ${r.clear}, opaque ${r.opaque}, IoU ${r.iou})`}`); skipped++; continue; }
  if (only && !only.has(key)) continue;
  if (minIou > 0 && r.iou < minIou) { console.log(`hold ${key}: silhouette overlap ${r.iou} is under the ${minIou} gate — look at it before it ships`); held++; continue; }

  const dest = `assets/images/${key}.png`;
  if (!has(dest)) { console.log(`skip ${key}: no shipped file at ${dest}`); skipped++; continue; }
  if (!has(r.final)) { console.log(`skip ${key}: converted file missing (${r.final})`); skipped++; continue; }

  const backup = path.join(BACKUP, `${key}.png`);
  console.log(`${dry ? 'would ' : ''}promote ${key}  clear ${r.clear}%  opaque ${r.opaque}%  edge ${r.edge}  IoU ${r.iou}`);
  if (dry) { promoted++; continue; }

  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (!has(backup)) fs.copyFileSync(dest, backup);
  const scaled = downscale(fs.readFileSync(r.final), maxPx);
  fs.writeFileSync(dest, scaled.buf);

  const rec = manifest.find(m => m.path === dest);
  if (rec) {
    rec.alphaConverted = {
      model: MODEL, licence: LICENCE, seed: r.seed, at: new Date().toISOString().slice(0, 10),
      from: { model: 'z_image_turbo', seed: rec.seed },
      measurements: { clear: r.clear, soft: r.soft, opaque: r.opaque, edge: r.edge, silhouetteIoU: r.iou },
      backup: backup.replace(/\\/g, '/')
    };
  }
  promoted++;
}

if (!dry) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\n${dry ? 'DRY RUN —' : 'promoted'} ${promoted} asset(s), ${held} held for review (overlap < ${minIou}), ${skipped} skipped.`);
if (!dry) console.log(`assets written at max ${maxPx} px on a side; originals are in ${BACKUP}/`);
if (dry) console.log('re-run with --yes to write. Backups go to assets/images/_chroma_v1/.');
