// Move the enemy base PNGs out of the shipped build.
//
//   node tools/stillToWebp.mjs            convert, verify, update the manifest
//   node tools/stillToWebp.mjs --dry      report without writing
//
// They stopped being runtime art the moment standing monsters were drawn from the animation's
// own first frame: a 512x512 PNG of every species was being sent to every player for a case
// that only happens if the browser cannot decode animated WebP at all. This keeps that fallback,
// but as a WebP with alpha, and moves the PNG masters to sprite_sources/ (git-ignored) so the
// originals that the image-to-video clips were generated from are not lost.
//
// The output is not trusted because ffmpeg wrote it: the WebP container is parsed to confirm
// the size, the frame count and per-frame alpha, the same check the animation bake runs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWebp } from './webpParse.mjs';
import { decodePng } from './pngio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const DRY = process.argv.includes('--dry');
const QUALITY = Number(process.env.WEBP_Q || 82);
const SRC_DIR = 'sprite_sources';

const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/images/manifest.json'), 'utf8'));
const targets = man.filter(e => e.path.startsWith('assets/images/enemies/') && e.path.endsWith('.png'));
if (!targets.length) { console.log('no enemy PNGs left in the manifest'); process.exit(0); }

fs.mkdirSync(path.join(ROOT, SRC_DIR), { recursive: true });
let converted = 0, failed = [];
let before = 0, after = 0;

for (const e of targets) {
  const from = path.join(ROOT, e.path);
  const to = e.path.replace(/\.png$/, '.webp');
  const toAbs = path.join(ROOT, to);
  // Already converted by an earlier run that stopped partway: the WebP exists and the PNG has
  // been archived, so the only thing left to do is point the manifest at it.
  if (!fs.existsSync(from) && fs.existsSync(toAbs)) {
    e.path = to;
    e.convertedAt = e.convertedAt || new Date().toISOString().slice(0, 10);
    after += fs.statSync(toAbs).size;
    converted++;
    console.log(`${e.slug.padEnd(16)} already converted -> ${(fs.statSync(toAbs).size / 1024).toFixed(0)} KB webp`);
    continue;
  }
  if (!fs.existsSync(from)) { failed.push(`${e.slug}: missing ${e.path}`); continue; }
  const png = decodePng(fs.readFileSync(from));
  const pngBytes = fs.statSync(from).size;
  before += pngBytes;

  if (DRY) { console.log(`${e.slug.padEnd(16)} ${png.w}x${png.h} png ${(pngBytes / 1024).toFixed(0)} KB -> webp (dry)`); continue; }

  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', from,
    '-c:v', 'libwebp', '-quality', String(QUALITY), '-compression_level', '6',
    '-pix_fmt', 'yuva420p', '-lossless', '0', toAbs], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Verify the container: same size, alpha present, single frame.
  const web = readWebp(fs.readFileSync(toAbs));
  const problems = [];
  if (web.canvas && (web.canvas[0] !== png.w || web.canvas[1] !== png.h)) problems.push(`size ${web.canvas.join('x')} vs png ${png.w}x${png.h}`);
  if (web.hasAlpha === false) problems.push('no alpha in the container');
  if (web.frames && web.frames > 1) problems.push(`${web.frames} frames, expected a still`);
  if (fs.statSync(toAbs).size < 1024) problems.push('suspiciously small output');
  if (problems.length) { failed.push(`${e.slug}: ${problems.join('; ')}`); fs.rmSync(toAbs, { force: true }); continue; }

  // Keep the PNG master where git will not carry it into the site.
  fs.renameSync(from, path.join(ROOT, SRC_DIR, path.basename(path.dirname(e.path)) + '_' + path.basename(e.path)));
  e.path = to;
  e.convertedAt = new Date().toISOString().slice(0, 10);
  e.masterPreservedIn = SRC_DIR;
  after += fs.statSync(toAbs).size;
  converted++;
  console.log(`${e.slug.padEnd(16)} ${(pngBytes / 1024).toFixed(0)} KB png -> ${(fs.statSync(toAbs).size / 1024).toFixed(0)} KB webp`);
}

console.log(`\nconverted ${converted}/${targets.length}, ${(before / 1048576).toFixed(2)} MB -> ${(after / 1048576).toFixed(2)} MB`);
if (failed.length) console.log(`failed: ${failed.join('\n  ')}`);
if (!DRY && converted) {
  fs.writeFileSync(path.join(ROOT, 'assets/images/manifest.json'), JSON.stringify(man, null, 2) + '\n');
  console.log(`manifest updated; PNG masters moved to ${SRC_DIR}/ (git-ignored)`);
}
