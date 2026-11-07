// Turn a rendered clip into an animated WebP with the boomerang baked in.
//
//   node tools/animWebp.mjs --only cellar_spider__walk
//   node tools/animWebp.mjs --cell 160 --quality 75 --yes
//
// Boomerang means the file plays forward then backward — 1..N..2 — so the cycle never jumps
// when it loops, which is what a model-generated clip needs: Wan returns a motion that starts
// at the still and drifts, it does not hand back a seamlessly looping cycle. The reverse pass
// reuses frames already in the file rather than re-rendering anything, so it costs container
// overhead, not pixels.
//
// Two things this refuses to take on trust:
//   * the frames it encodes are the keyed, re-anchored ones (keyed_*.png), never the raw
//     clip frames, which still carry the painted backdrop — an earlier version of this tool
//     encoded the raw frames and produced a sprite with a coloured rectangle behind it;
//   * the output is checked by parsing the WebP container itself (tools/webpParse.mjs),
//     because ffmpeg on this machine cannot re-read the animated WebP it writes, and
//     webpmux/cwebp are not installed. A container that does not declare an animation, a
//     loop-forever count, per-frame alpha and the frame count we asked for is rejected here.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unionBox } from './videoKit.mjs';
import { keyedAligned, readMeta } from './clipIo.mjs';
import { readWebp } from './webpParse.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';

function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const CELL = Number(arg('cell', 192));
const QUALITY = Number(arg('quality', 80));
const FPS = Number(arg('fps', 16));
const BOOM = arg('boomerang', 'true') !== 'false';
const YES = process.argv.includes('--yes');
const ONLY = arg('only') ? new Set(arg('only').split(',').map(s => s.trim())) : null;
// Warn, do not silently shrink: the right cell size is a decision made by looking at the
// sprite in the game, not by a byte count.
const BUDGET_KB = Number(arg('budget-kb', 400));

const OUT = YES ? path.join(ROOT, 'assets', 'anim') : path.join(ROOT, 'experiments', 'anim', 'webp');

const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'experiments', 'anim', 'list.json'), 'utf8'))
  .filter(e => e.verdict === 'ACCEPTED' && !e.id.split('__')[1].includes('_'))
  .filter(e => !ONLY || ONLY.has(e.id));

if (!list.length) { console.error('no accepted clips matched' + (ONLY ? ` --only ${[...ONLY].join(',')}` : '')); process.exit(1); }

console.log(`${list.length} clip(s) -> ${path.relative(ROOT, OUT)}`);
console.log(`cell ${CELL} px, quality ${QUALITY}, ${FPS} fps, boomerang ${BOOM ? 'baked in' : 'off (engine plays it)'}, alpha required`);
console.log('');

fs.mkdirSync(OUT, { recursive: true });

function run(cmd, args, what) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const lines = ((e.stderr || '') + '').split(/\r?\n/).filter(Boolean);
    throw new Error(`${what} failed: ${lines.slice(-4).join(' | ') || e.message}`);
  }
}

const entries = [];
let total = 0, held = 0;

for (const e of list) {
  try {
    const dir = path.join(ROOT, 'experiments', 'anim', e.id);
    const meta = readMeta(dir);
    const { frames, W, H } = keyedAligned(dir);
    if (frames.length < 2) throw new Error('fewer than two keyed frames on disk');

    const keyed = fs.readdirSync(dir).filter(f => /^keyed_\d+\.png$/.test(f)).sort();
    if (keyed.length !== frames.length) throw new Error(`${keyed.length} keyed files vs ${frames.length} measured frames`);

    // One crop window for the whole clip, from the keyed silhouettes: cropping each frame to
    // its own box would re-centre it every step and the animation would shiver in place.
    const box = unionBox(frames, W, H, 3);
    if (!box) throw new Error('nothing left after keying');
    const [cx, cy, cw, ch] = box;
    const s = Math.min(CELL / cw, CELL / ch);
    const fw = Math.max(2, Math.round(cw * s)), fh = Math.max(2, Math.round(ch * s));

    // Boomerang order: 0..N-1 then N-2..1, so the last played frame is adjacent to the first
    // and the loop has no seam. Endpoints are not duplicated, which would hold each pose for
    // two frames and give the cycle a limp.
    const N = keyed.length;
    const order = BOOM ? [...Array(N).keys(), ...[...Array(N - 2).keys()].map(i => N - 2 - i)] : [...Array(N).keys()];

    const stage = fs.mkdtempSync(path.join(ROOT, 'experiments', 'anim', 'seq-'));
    order.forEach((src, i) =>
      fs.copyFileSync(path.join(dir, keyed[src]), path.join(stage, 'seq_' + String(i + 1).padStart(3, '0') + '.png')));

    const file = `${e.sprite.replace(/[\\/]/g, '_')}__${e.action}.webp`;
    const to = path.join(OUT, file);
    run(FFMPEG, [
      '-y', '-loglevel', 'error',
      '-framerate', String(FPS), '-start_number', '1',
      '-i', path.join(stage, 'seq_%03d.png'),
      '-vf', `crop=${cw}:${ch}:${cx}:${cy},scale=${fw}:${fh}:flags=lanczos`,
      '-c:v', 'libwebp_anim', '-pix_fmt', 'yuva420p',
      '-lossless', '0', '-quality', String(QUALITY), '-compression_level', '6', '-loop', '0',
      to
    ], `encode ${e.id}`);
    for (const f of fs.readdirSync(stage)) fs.unlinkSync(path.join(stage, f));
    fs.rmdirSync(stage);

    // Verify the container we were handed.
    const buf = fs.readFileSync(to);
    const web = readWebp(buf);
    const problems = [];
    if (!web.animated) problems.push('the file does not declare an animation');
    if (!web.alpha) problems.push('no alpha plane in the container');
    if (web.loopCount !== 0) problems.push(`loop count is ${web.loopCount}, expected 0 (forever)`);
    if (web.frames.length !== order.length) problems.push(`${web.frames.length} frames in the container, expected ${order.length}`);
    if (web.canvas && (web.canvas[0] !== fw || web.canvas[1] !== fh)) problems.push(`canvas ${web.canvas.join('x')} but the sprite was scaled to ${fw}x${fh}`);
    if (web.blendAll === false) problems.push('a frame asks to dispose to the background instead of blending');
    if (problems.length) {
      fs.unlinkSync(to);
      held++;
      console.log(`  HELD ${e.id}: ${problems.join('; ')}`);
      continue;
    }

    const kb = buf.length / 1024;
    total += buf.length;
    console.log(`  ok ${e.id.padEnd(24)} ${order.length} frames (${N} unique, boomeranged)  ${fw}x${fh}  ` +
      `${kb.toFixed(0)} KB  loop forever  alpha yes` +
      (kb > BUDGET_KB ? `\n       over the ${BUDGET_KB} KB budget — lower --cell or --quality` : ''));

    entries.push({
      sprite: e.sprite, action: e.action, file,
      frames: order.length, uniqueFrames: N, fps: FPS, durationMs: Math.round(1000 / FPS),
      cellW: fw, cellH: fh, crop: [cx, cy, cw, ch],
      loop: BOOM ? 'boomerang-baked' : 'forward',
      bytes: buf.length, clip: e.id, seed: meta.seed,
      model: 'wan2.2_i2v (Apache 2.0)', licence: 'Wan 2.2 Apache 2.0'
    });
  } catch (err) {
    console.log(`  FAIL ${e.id}: ${err.message}`);
    held++;
  }
}

entries.sort((p, q) => String(p.sprite).localeCompare(String(q.sprite)) || p.action.localeCompare(q.action));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), cell: CELL, quality: QUALITY, fps: FPS,
  loop: BOOM ? 'boomerang-baked' : 'forward',
  note: 'animated WebP, forward then reverse inside the file so the loop has no seam',
  entries
}, null, 2));

console.log(`\n${entries.length} animated WebP(s), ${(total / 1024).toFixed(0)} KB total` + (held ? `, ${held} held back` : ''));
console.log(`wrote ${path.relative(ROOT, OUT)}${YES ? '' : '   (dry run: assets/anim untouched — add --yes to publish)'}`);
if (!entries.length) process.exit(1);
