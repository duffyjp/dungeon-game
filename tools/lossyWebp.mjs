// Lossy WebP for the art that has no transparency to protect.
//
//   node tools/lossyWebp.mjs                 report what would change, with measured fidelity
//   node tools/lossyWebp.mjs --write         convert, verify, move masters, update the manifest
//
// Opaque surfaces - walls, floors, ceilings, item and UI art that carries no alpha - do not need
// a lossless container, and the difference is not subtle: the same gritty 512 px wall tile costs
// 583 KB as PNG and 82 KB as WebP. But these are the images a player looks at continuously, so
// unlike the enemy fallback stills they get a quality floor: every conversion is decoded back and
// compared to the master, and anything under --min-psnr (default 30 dB) is left alone and
// reported instead of shipped.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePng } from './pngio.mjs';
import { readWebp } from './webpParse.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const WRITE = process.argv.includes('--write');
const MIN_PSNR = Number(process.env.MIN_PSNR || (process.argv.find((a, i) => process.argv[i - 1] === '--min-psnr') || 30));
const Q = Number(process.env.WEBP_Q || 90);
const MASTER_DIR = 'asset_sources';
const SKIP_FOLDERS = new Set(['enemies']);      // already handled: those sprites have alpha

const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/images/manifest.json'), 'utf8'));
const targets = man.filter(e => e.path.endsWith('.png') && !e.path.split('/').some(p => p.startsWith('_')) && !SKIP_FOLDERS.has(e.path.split('/')[2]));

fs.mkdirSync(path.join(ROOT, MASTER_DIR), { recursive: true });
const tmp = path.join(ROOT, 'experiments', 'lossycheck.png');
let converted = 0, skipped = [], before = 0, after = 0;

for (const e of targets) {
  const from = path.join(ROOT, e.path);
  if (!fs.existsSync(from)) { skipped.push(`${e.slug}: master missing`); continue; }
  const png = decodePng(fs.readFileSync(from));
  let opaque = true;
  if (png.channels === 4) for (let i = 3; i < png.px.length; i += 4) { if (png.px[i] !== 255) { opaque = false; break; } }
  if (!opaque) { skipped.push(`${e.slug}: has transparency, left alone`); continue; }
  const pngBytes = fs.statSync(from).size;
  before += pngBytes;

  const to = e.path.replace(/\.png$/, '.webp');
  const toAbs = path.join(ROOT, to);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', from,
    '-c:v', 'libwebp', '-quality', String(Q), '-compression_level', '6',
    '-pix_fmt', 'yuv420p', '-lossless', '0', toAbs], { stdio: ['ignore', 'pipe', 'pipe'] });

  const web = readWebp(fs.readFileSync(toAbs));
  if (web.canvas && (web.canvas[0] !== png.w || web.canvas[1] !== png.h)) {
    fs.rmSync(toAbs, { force: true }); skipped.push(`${e.slug}: size changed ${web.canvas.join('x')}`); continue;
  }

  // Decode the result back and compare, because "the encoder ran" is not evidence about pixels.
  // ffmpeg returns RGB for an opaque WebP and RGBA for the master, so both sides are widened to
  // RGBA before indexing - comparing a 3-channel buffer with a 4-channel stride produced NaN.
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', toAbs, '-pix_fmt', 'rgba', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
  const back = decodePng(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  const at = (img, i, c) => img.px[i * img.channels + c];
  let se = 0, n = 0;
  if (back.w !== png.w || back.h !== png.h) {
    fs.rmSync(toAbs, { force: true });
    skipped.push(`${e.slug}: re-decode came back ${back.w}x${back.h}`);
    console.log(`${e.slug.padEnd(22)} ${(pngBytes / 1024).toFixed(0).padStart(5)} KB png -> rejected (re-decode size mismatch)`);
    continue;
  }
  for (let i = 0; i < png.w * png.h; i++) {
    for (let c = 0; c < 3; c++) { const d = at(png, i, c) - at(back, i, c); se += d * d; n++; }
  }
  const psnr = 20 * Math.log10(255 / Math.sqrt(se / n));
  const webBytes = fs.statSync(toAbs).size;
  const line = `${e.slug.padEnd(22)} ${(pngBytes / 1024).toFixed(0).padStart(5)} KB png -> ${(webBytes / 1024).toFixed(0).padStart(5)} KB webp   PSNR ${psnr.toFixed(1)} dB`;

  if (psnr < MIN_PSNR) {
    fs.rmSync(toAbs, { force: true });
    skipped.push(`${e.slug}: PSNR ${psnr.toFixed(1)} dB under ${MIN_PSNR} — kept PNG`);
    console.log(`${line}   REJECTED`);
    continue;
  }
  console.log(line);
  after += webBytes;
  converted++;
  if (WRITE) {
    fs.renameSync(from, path.join(ROOT, MASTER_DIR, e.path.replace(/^assets\/images\//, '').replace(/\//g, '_')));
    e.path = to;
    e.convertedAt = new Date().toISOString().slice(0, 10);
    e.masterPreservedIn = MASTER_DIR;
    e.fidelity = { psnr: Number(psnr.toFixed(1)), quality: Q };
  }
}

console.log(`\n${targets.length} opaque PNGs considered, ${converted} pass at q${Q} and PSNR >= ${MIN_PSNR} dB`);
console.log(` ${(before / 1048576).toFixed(2)} MB -> ${(after / 1048576).toFixed(2)} MB`);
for (const s of skipped) console.log(`  skip: ${s}`);
if (WRITE && converted) {
  fs.writeFileSync(path.join(ROOT, 'assets/images/manifest.json'), JSON.stringify(man, null, 2) + '\n');
  console.log(`manifest updated; PNG masters moved to ${MASTER_DIR}/ (git-ignored)`);
} else {
  console.log('dry run: pass --write to convert');
}
