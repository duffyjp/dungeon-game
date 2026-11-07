// Prove the animation keyer on real sprites before spending GPU minutes on it.
//
//   node tools/testVideoKit.mjs
//
// The chain being tested is: pick a backdrop for a sprite, paint the sprite onto it, key
// that painting back out, and compare the matte to the matte we started with. If the
// round-trip is faithful on the actual shipped art, the same maths applied to a video
// model's frames is measuring motion rather than fighting its own keyer. All of this runs
// on files already in the repo, so a regression here fails in seconds, not after a
// twenty-minute clip.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './pngio.mjs';
import { pickBackdrop, composeStartFrame, keyFrame, frameStats, silhouetteIoU, shift, spillAxis, contactSheet, motionBetween, scoreClip, alignFrames } from './videoKit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMG = path.join(ROOT, 'assets', 'images');

// ffmpeg is a local art-pipeline dependency, not something a CI runner or a fresh clone has.
// Find it where it actually is - FFMPEG env, PATH, then the Windows install location - and if it
// is not there, sprites that only exist as WebP are skipped rather than crashing the suite. This
// script gates the animation bake, not the deploy; a missing optional tool must not take the
// site down.
function findFfmpeg() {
  // FFMPEG=off is how the skip path is tested on a machine that does have ffmpeg installed.
  if (process.env.FFMPEG === 'off') return null;
  for (const c of [process.env.FFMPEG, 'ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe']) {
    if (!c) continue;
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c; } catch (e) { /* try the next candidate */ }
  }
  return null;
}
const FFMPEG = findFfmpeg();
let skipped = 0;
const SKIP = { reason: FFMPEG ? 'no file' : 'ffmpeg not installed (WebP sprites cannot be decoded)' };

function load(key) {
  // Sprites move between containers - the enemy stills became WebP fallbacks and their PNG
  // masters were archived out of the site - so resolve png, then the archived master, then
  // WebP decoded through ffmpeg. Hard-coding .png here meant this suite died on a rename.
  const png = path.join(IMG, `${key}.png`);
  if (fs.existsSync(png)) return decodePng(fs.readFileSync(png));
  const master = path.join(ROOT, 'sprite_sources', `${path.basename(path.dirname(key))}_${path.basename(key)}.png`);
  if (fs.existsSync(master)) return decodePng(fs.readFileSync(master));
  const web = path.join(IMG, `${key}.webp`);
  if (!fs.existsSync(web)) return null;
  if (!FFMPEG) return null;
  const tmp = path.join(os.tmpdir(), `strata-videokit-${path.basename(key)}.png`);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', web, '-pix_fmt', 'rgba', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
  const d = decodePng(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  return d;
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

// (the sprite loader lives above, next to the ffmpeg probe)

// The source sprite's silhouette, laid out exactly the way composeStartFrame lays it out,
// so the keyed result can be compared against it pixel for pixel.
function silhouettedSource(d, W, H, scale) {
  const ref = Buffer.alloc(W * H * 4);
  const dw = Math.round(d.w * scale), dh = Math.round(d.h * scale);
  const ox = Math.round((W - dw) / 2), oy = Math.round((H - dh) / 2);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(d.w - 1, Math.floor((x / dw) * d.w)), sy = Math.min(d.h - 1, Math.floor((y / dh) * d.h));
      const src = (sy * d.w + sx) * d.channels;
      const a = d.channels === 4 ? d.px[src + 3] : 255;
      if (a >= 128) { const t = ((oy + y) * W + (ox + x)) * 4; ref[t + 3] = 255; }
    }
  }
  return ref;
}

// ---------------------------------------------------------------- sprites
const sprites = ['enemies/t1/slime', 'enemies/t1/orc_grunt', 'enemies/t1/cellar_spider',
  'items/sword_long', 'items/bow_long', 'vfx/slash_arc', 'enemies/t2/wraith'];

// A sprite we cannot read is a skip, never a failure: this suite gates the animation bake, and
// a fresh clone or a CI runner without ffmpeg has no way to decode WebP art.
function need(key) {
  const d = load(key);
  if (!d) { skipped++; console.log(`  skip  ${key} — ${SKIP.reason}`); }
  return d;
}

console.log('backdrop choice + key round-trip on shipped sprites');
for (const key of sprites) {
  const d = need(key);
  if (!d) continue;
  const pick = pickBackdrop(d.px, d.w, d.h, d.channels);
  const bg = pick.choice.rgb;
  const canvas = composeStartFrame(d.px, d.w, d.h, d.channels, { w: 640, h: 640 }, bg, 0.8);

  // The start frame we hand the model must be fully opaque: no alpha reaching Wan.
  const startStats = frameStats(canvas, 640, 640);
  ok(`${key}: start frame is solid`, startStats.clear === 0,
    `clear ${startStats.clear}%  backdrop ${pick.choice.name} (collision ${pick.choice.ratio.toFixed(2)})`);

  const keyed = keyFrame(canvas, 640, 640, { backdrop: { r: bg[0], g: bg[1], b: bg[2] } });
  const s = frameStats(keyed.rgba, 640, 640);

  // Backdrop gone, subject intact: the two things that have to be true of every frame of
  // every clip. Coverage is judged against the sprite's own silhouette rather than a fixed
  // percentage, because how much of the canvas a thin arrow fills is a property of the
  // arrow, not of the keyer.
  ok(`${key}: backdrop keyed away`, s.clear > 50, `clear ${s.clear}%`);

  const ref = silhouettedSource(d, 640, 640, 0.8);
  const refCoverage = frameStats(ref, 640, 640).coverage;
  ok(`${key}: subject survived`, s.coverage >= refCoverage * 0.85,
    `coverage ${s.coverage}% against the source's ${refCoverage}%`);
  const iou = silhouetteIoU(keyed.rgba, ref, 640, 640);
  ok(`${key}: silhouette matches the source`, iou >= 0.75, `IoU ${iou.toFixed(3)}  backdrop ${pick.choice.name}  all: ${pick.table}`);
}

// ---------------------------------------------------------------- a green subject
// Slime art is green, so a green backdrop has to lose to something else. This is the case
// a hand-picked chroma colour would get wrong and measurement gets right.
if (need('enemies/t1/slime')) {
  const d = load('enemies/t1/slime');
  const pick = pickBackdrop(d.px, d.w, d.h, d.channels);
  ok('slime does not get a green backdrop', pick.choice.name !== 'green',
    `chose ${pick.choice.name}, green scored ${(pick.table.match(/green ([\d.]+)/) || [])[1]}`);
}

// ---------------------------------------------------------------- axis maths
{
  const magenta = spillAxis([255, 0, 255]);
  ok('magenta axis points away from green', magenta.axis[1] < -0.5, JSON.stringify(magenta.axis.map(v => +v.toFixed(2))));
  const grey = spillAxis([128, 128, 128]);
  ok('grey backdrop has no hue axis to key on', grey.length === 0, `length ${grey.length}`);
}

// ---------------------------------------------------------------- shifting
{
  const w = 8, h = 8;
  const src = Buffer.alloc(w * h * 4);
  src[(3 * w + 3) * 4 + 3] = 255;
  const moved = shift(src, w, h, 2, -1);
  ok('shift moves the pixel and nothing else',
    moved[((2) * w + 5) * 4 + 3] === 255 && moved[(3 * w + 3) * 4 + 3] === 0);
}

// ---------------------------------------------------------------- a sheet renders
if (need('vfx/hit_spark')) {
  const d = load('vfx/hit_spark');
  const frames = [d.px, d.px];
  const sheet = contactSheet(frames, d.w, d.h, 96, 2);
  const png = encodePng(sheet.w, sheet.h, 3, sheet.buffer);
  ok('a contact sheet renders at the expected size',
    sheet.w === 2 * (96 + 8) + 8 && sheet.h === 1 * (96 + 8) + 8 && png.length > 1000,
    `${sheet.w}x${sheet.h}, ${png.length} bytes`);
}

// ---------------------------------------------------------------- movement is a number
// The gate that matters most is the one that catches a clip which is really a still
// photograph, so the measurement behind it gets tested directly: identical frames must
// score zero, and a subject that has actually moved must score something.
if (need('enemies/t1/orc_grunt')) {
  const d = load('enemies/t1/orc_grunt');
  const still = motionBetween(d.px, d.px, d.w, d.h);
  ok('a frame against itself shows no movement',
    still.coverageDelta === 0 && still.colourDelta === 0, JSON.stringify(still));

  const moved = motionBetween(d.px, shift(d.px, d.w, d.h, 24, 0), d.w, d.h);
  ok('a subject that moved registers as movement', moved.coverageDelta > 1,
    `coverage delta ${moved.coverageDelta}%`);

  const sc = scoreClip({ frames: [d.px, d.px, d.px], W: d.w, H: d.h, requested: 3, srcKeyed: d.px });
  const moveGate = sc.gates.find(g => g[0] === 'the subject actually moves');
  ok('a three-frame still photograph fails the movement gate', moveGate[1] === false,
    `mean move ${sc.summary.meanMove}%`);

  const turned = scoreClip({
    frames: [d.px, shift(d.px, d.w, d.h, 0, 0), shrink(d.px, d.w, d.h)],
    W: d.w, H: d.h, requested: 3, srcKeyed: d.px
  });
  function shrink(src, w, h, f = 0.8) {
    // Really shrink the subject: sample the source at a smaller scale and recentre it, so
    // its bounding box contracts the way a creature turning sideways makes it contract.
    const out = Buffer.alloc(w * h * 4);
    const dw = Math.round(w * f), dh = Math.round(h * f);
    const ox = Math.round((w - dw) / 2), oy = Math.round((h - dh) / 2);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const s = (Math.floor(y * h / dh) * w + Math.floor(x * w / dw)) * 4;
        const t = ((oy + y) * w + (ox + x)) * 4;
        out[t] = src[s]; out[t + 1] = src[s + 1]; out[t + 2] = src[s + 2]; out[t + 3] = src[s + 3];
      }
    }
    return out;
  }
  const faceGate = turned.gates.find(g => g[0] === 'subject kept its facing');
  ok('a subject that shrinks in both axes fails the facing gate', faceGate[1] === false,
    `min box ${turned.summary.minBox}`);
}

// ---------------------------------------------------------------- alignment
if (need('enemies/t1/orc_grunt')) {
  const d = load('enemies/t1/orc_grunt');
  const a = alignFrames([d.px, shift(d.px, d.w, d.h, 17, -9)], d.w, d.h);
  const s = [d.px, shift(d.px, d.w, d.h, 17, -9)].map(f => frameStats(f, d.w, d.h));
  const after = a.aligned.map(f => frameStats(f, d.w, d.h));
  ok('re-anchoring removes the bulk drift between frames',
    Math.hypot(after[0].centroid[0] - after[1].centroid[0], after[0].centroid[1] - after[1].centroid[1]) < 2,
    `before ${Math.hypot(s[0].centroid[0] - s[1].centroid[0], s[0].centroid[1] - s[1].centroid[1]).toFixed(1)}px, after ${Math.hypot(after[0].centroid[0] - after[1].centroid[0], after[0].centroid[1] - after[1].centroid[1]).toFixed(1)}px`);
}

console.log(`\nvideo kit: ${pass} passed / ${fail} failed${skipped ? ` / ${skipped} skipped: ${SKIP.reason}` : ''}`);
if (fail) {
  // Save one round-trip image so a human can look at the matte rather than trust a number.
  const key = 'enemies/t1/orc_grunt';
  const d = load(key);
  if (d) {
    const pick = pickBackdrop(d.px, d.w, d.h, d.channels);
    const canvas = composeStartFrame(d.px, d.w, d.h, d.channels, { w: 640, h: 640 }, pick.choice.rgb, 0.8);
    const keyed = keyFrame(canvas, 640, 640, { backdrop: { r: pick.choice.rgb[0], g: pick.choice.rgb[1], b: pick.choice.rgb[2] } });
    fs.mkdirSync(path.join(ROOT, 'experiments', 'anim'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'experiments', 'anim', 'roundtrip_debug.png'), encodePng(640, 640, 4, keyed.rgba));
    console.log('wrote experiments/anim/roundtrip_debug.png for eyeballing');
  }
}
process.exit(fail ? 1 : 0);
