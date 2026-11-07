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

const RESULTS = 'experiments/alpha/results.json';
const BACKUP = 'assets/images/_chroma_v1';
const MODEL = 'Qwen/Qwen-Image-2.1 (qwen_image_2.1_int8_convrot.safetensors)';
const LICENCE = 'Qwen Research License (owner reviewed 2026-11-06 and accepts shipping its outputs)';

const has = f => fs.existsSync(f);
const dry = !process.argv.includes('--yes');
function arg(name) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : null; }
const only = arg('keys') ? new Set(arg('keys').split(',')) : null;

if (!has(RESULTS)) { console.error(`${RESULTS} not found — run tools/alphaBatch.mjs first`); process.exit(2); }
const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
const manifestPath = 'assets/images/manifest.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let promoted = 0, skipped = 0;
for (const [key, r] of Object.entries(results)) {
  if (!r.ok || !r.final) { console.log(`skip ${key}: ${r.why || `failed validation (clear ${r.clear}, opaque ${r.opaque}, IoU ${r.iou})`}`); skipped++; continue; }
  if (only && !only.has(key)) continue;

  const dest = `assets/images/${key}.png`;
  if (!has(dest)) { console.log(`skip ${key}: no shipped file at ${dest}`); skipped++; continue; }
  if (!has(r.final)) { console.log(`skip ${key}: converted file missing (${r.final})`); skipped++; continue; }

  const backup = path.join(BACKUP, `${key}.png`);
  console.log(`${dry ? 'would ' : ''}promote ${key}  clear ${r.clear}%  opaque ${r.opaque}%  edge ${r.edge}  IoU ${r.iou}`);
  if (dry) { promoted++; continue; }

  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (!has(backup)) fs.copyFileSync(dest, backup);
  fs.copyFileSync(r.final, dest);

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
console.log(`\n${dry ? 'DRY RUN —' : 'promoted'} ${promoted} asset(s), ${skipped} skipped.`);
if (dry) console.log('re-run with --yes to write. Backups go to assets/images/_chroma_v1/.');
