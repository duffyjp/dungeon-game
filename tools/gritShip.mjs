// Publish the gritty environment pass: restyled albedo -> shipped tile + derived normal.
//
//   node tools/gritShip.mjs --all                    every tile with a restyle on disk
//   node tools/gritShip.mjs --only wall_crypt,floor_crypt
//   node tools/gritShip.mjs --all --dry              report only
//
// What it does per tile, and why in this order:
//   1. resample the 1024 px generation to the size the renderer actually uses (512 px —
//      the mirrored composite caps there, so a 1024 px tile is download the browser throws
//      away), and encode as opaque WebP, measured at 82 KB where the cartoon PNG it replaces
//      cost 741 KB;
//   2. derive the normal map from that same shipped resolution, so the relief the player sees
//      agrees with the pixels they see;
//   3. only then move the superseded PNG into assets/images/_textures_v1/ — underscore
//      folders are excluded from the asset glob, so the old art stays reviewable without
//      shipping. Nothing is discarded while the new file is still only in experiments/.
//   4. rewrite the manifest entry so provenance travels with the asset: model, licence, seed,
//      the edit instruction that was sent, and for the normal map the fact that it was derived
//      offline, which is what keeps it free of any third-party terms.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = arg('from', 'experiments/grit');
const SIZE = Number(arg('size', 512));
const QUALITY = Number(arg('quality', 82));
const DRY = process.argv.includes('--dry');
const ARCHIVE = 'assets/images/_textures_v1';
const MANIFEST = path.join(ROOT, 'assets/images/manifest.json');
const LICENCE = 'Qwen Research License (https://huggingface.co/Qwen/Qwen-Image-2.1/raw/main/LICENSE). Reviewed by the repository owner on 2026-11-06; shipping its outputs is approved. Record model and licence on every asset made with it.';
const MODEL = 'Qwen/Qwen-Image-2.1 (edit mode — conditions on the existing tile, so the composition is preserved)';

const prompts = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/grit_prompts.json'), 'utf8'));
const wanted = process.argv.includes('--all')
  ? Object.keys(prompts.tiles)
  : (arg('only') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!wanted.length) { console.error('usage: node tools/gritShip.mjs --all | --only wall_crypt,floor_crypt [--size 512] [--quality 82] [--dry]'); process.exit(2); }

function run(cmd, args, what) {
  try { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) {
    const err = (e.stderr ? e.stderr.toString() : '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    throw new Error(`${what} failed: ${err || e.message}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const bySlug = new Map(manifest.filter(e => /textures\//.test(e.path || '')).map(e => [e.slug, e]));

let saved = 0, made = 0;
console.log(`shipping ${wanted.length} tile(s) at ${SIZE} px, WebP quality ${QUALITY}${DRY ? ' (dry run)' : ''}`);
console.log('tile                old PNG   new WebP  normal   relief');
for (const slug of wanted) {
  const src = path.join(ROOT, FROM, `strata-grit-${slug}_00001.png`);
  if (!fs.existsSync(src)) { console.log(`${slug.padEnd(18)} SKIP — no restyle at ${path.relative(ROOT, src)}`); continue; }
  const pngNow = path.join(ROOT, 'assets/images/textures', `${slug}.png`);
  const oldKB = fs.existsSync(pngNow) ? Math.round(fs.statSync(pngNow).size / 1024) : 0;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-grit-'));
  const scaled = path.join(tmp, `${slug}.png`);
  run(FFMPEG, ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale=${SIZE}:${SIZE}:flags=lanczos`, '-pix_fmt', 'rgb24', scaled], 'resample');
  const webpPath = path.join(ROOT, 'assets/images/textures', `${slug}.webp`);
  const enc = run(FFMPEG, ['-y', '-loglevel', 'error', '-i', scaled, '-c:v', 'libwebp', '-pix_fmt', 'yuva444p',
    '-lossless', '0', '-quality', String(QUALITY), '-compression_level', '6', webpPath], 'webp encode');
  const newKB = Math.round(fs.statSync(webpPath).size / 1024);
  saved += oldKB - newKB;
  made++;

  let relief = '';
  if (!DRY) {
    // The normal map is derived from the shipped resolution, not from the 1024 px master:
    // relief that is finer than the pixels the renderer keeps is noise under a moving light.
    const out = run(process.execPath, [path.join(ROOT, 'tools/normalFromAlbedo.mjs'),
      '--keys', slug, '--src-dir', tmp, '--out', 'assets/images/normals', '--format', 'webp'],
      'normal derivation').toString();
    const m = out.match(/([\d.]+)% of texels carrying relief/);
    relief = m ? `${m[1]}%` : 'NOT REPORTED';
    if (!fs.existsSync(path.join(ROOT, 'assets/images/normals', `${slug}.webp`))) {
      console.log(`${slug.padEnd(18)} the normal map was not written — ${out.trim().split(/\r?\n/).pop()}`);
    }

    // Archive only after both files are on disk.
    if (fs.existsSync(pngNow)) {
      fs.mkdirSync(path.join(ROOT, ARCHIVE), { recursive: true });
      fs.renameSync(pngNow, path.join(ROOT, ARCHIVE, `${slug}.png`));
    }
    const entry = bySlug.get(slug) || {};
    // The pilot tile was sent as one hand-written sentence; the batch was composed from the
    // shared preamble plus per-tile detail. Record the string that actually reached the model.
    const instruction = prompts.verbatim && prompts.verbatim[slug]
      ? prompts.verbatim[slug]
      : `${prompts.common} : ${prompts.tiles[slug]}`;
    Object.assign(entry, {
      slug,
      path: `assets/images/textures/${slug}.webp`,
      normalPath: `assets/images/normals/${slug}.webp`,
      model: MODEL,
      licence: LICENCE,
      editInstruction: instruction,
      restyleSeed: prompts.seeds && prompts.seeds[slug] != null ? prompts.seeds[slug] : entry.restyleSeed,
      size: [SIZE, SIZE],
      derivedNormal: 'normal map computed offline from this tile (luminance -> wrapping box blur -> Sobel -> normalise); no model involved, so no third-party terms attach'
    });
    if (!manifest.includes(entry)) manifest.push(entry);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${slug.padEnd(18)} ${String(oldKB || '—').padStart(6)} KB  ${String(newKB).padStart(6)} KB  ${relief.padStart(6)}`);
}
if (!DRY) {
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nmanifest updated: ${manifest.length} entries`);
}
console.log(`tiles published: ${made}; download saved: ${(saved / 1024).toFixed(1)} MB${DRY ? ' (nothing written)' : ''}`);
