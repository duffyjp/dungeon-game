// Turn accepted clips into sprite atlases the game can actually draw.
//
//   node tools/animAtlas.mjs                      measure the cost, write to experiments/
//   node tools/animAtlas.mjs --frames 10 --cell 192
//   node tools/animAtlas.mjs --yes                write into assets/anim/ for real
//
// Two things make this a separate step rather than a copy. First, size: 18 clips of 17
// frames at 640 px is not a download anyone should ship, so frames are sub-sampled, cropped
// to the union of their own motion, and scaled to the cell the engine will draw them at.
// Second, registration: the frames of a clip share one crop window, so the figure does not
// jump between cells — the crop comes from the whole clip, never from a single frame.
//
// Nothing here re-judges a clip. Only entries the index says are ACCEPTED are considered, so
// an atlas cannot be built out of art the gates rejected.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './pngio.mjs';
import { keyFrame, alignFrames, composeStartFrame, pickBackdrop } from './videoKit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const CELL = Number(arg('cell', 192));
const WANT = Number(arg('frames', 12));
const YES = process.argv.includes('--yes');
const OUT = YES ? path.join(ROOT, 'assets', 'anim') : path.join(ROOT, 'experiments', 'anim', 'atlas');

// The atlas lives outside assets/images on purpose: that folder is imported eagerly by the
// dev server's texture glob, and an atlas must be loaded by name and animated by UV offset,
// not registered as one more static billboard.
const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'experiments', 'anim', 'list.json'), 'utf8'))
  .filter(e => e.verdict === 'ACCEPTED' && !e.id.split('__')[1].includes('_'));

console.log(`${list.length} accepted clip(s); cell ${CELL} px, up to ${WANT} frames each -> ${path.relative(ROOT, OUT)}`);

function clipFrames(dir, meta) {
  const files = fs.readdirSync(path.join(dir, 'frames')).filter(f => /^f\d+\.png$/.test(f)).sort();
  const raw = files.map(f => {
    const dec = decodePng(fs.readFileSync(path.join(dir, 'frames', f)));
    const W = dec.w, H = dec.h;
    if (dec.channels === 4) return { W, H, rgba: dec.px };
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0, p = 0; i < W * H; i++, p += dec.channels) {
      rgba[i * 4] = dec.px[p]; rgba[i * 4 + 1] = dec.px[p + 1]; rgba[i * 4 + 2] = dec.px[p + 2]; rgba[i * 4 + 3] = 255;
    }
    return { W, H, rgba };
  });
  const W = raw[0].W, H = raw[0].H;
  const keyed = raw.map(r => keyFrame(r.rgba, r.W, r.H).rgba);
  return { frames: alignFrames(keyed, W, H).aligned, W, H };
}

// Even sub-sample that always keeps the first and last frame, so the cycle still closes on
// itself however few frames are kept.
function pickEvery(frames, n) {
  if (frames.length <= n) return frames.map((_, i) => i);
  const out = [];
  for (let k = 0; k < n; k++) out.push(Math.round(k * (frames.length - 1) / (n - 1)));
  return [...new Set(out)];
}

// Box filter with alpha-weighted colour, so a soft edge does not bleed its hue into the
// average of a transparent neighbourhood.
function scaleRGBA(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx), y0 = Math.floor(y * fy);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx)), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) for (let xx = x0; xx < x1 && xx < sw; xx++) {
        const o = (yy * sw + xx) * 4, al = src[o + 3];
        r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al; n++;
      }
      const d = (y * dw + x) * 4;
      if (!a) { out[d + 3] = 0; continue; }
      out[d] = Math.round(r / a); out[d + 1] = Math.round(g / a); out[d + 2] = Math.round(b / a);
      out[d + 3] = Math.round(a / n);
    }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = [];
let totalBytes = 0, skipped = 0;

for (const e of list) {
  const dir = path.join(ROOT, 'experiments', 'anim', e.id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
  const { frames, W, H } = clipFrames(dir, meta);
  if (!frames.length) { skipped++; continue; }

  // One crop window for the whole clip: the union of every frame's box, padded. Cropping per
  // frame would re-centre each cell and the animation would shiver as it played.
  let [cx0, cy0, cx1, cy1] = [W, H, 0, 0];
  for (const f of frames) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (f[(y * W + x) * 4 + 3] < 8) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) continue;
    cx0 = Math.min(cx0, x0); cy0 = Math.min(cy0, y0);
    cx1 = Math.max(cx1, x1); cy1 = Math.max(cy1, y1);
  }
  const pad = 3;
  cx0 = Math.max(0, cx0 - pad); cy0 = Math.max(0, cy0 - pad);
  cx1 = Math.min(W - 1, cx1 + pad); cy1 = Math.min(H - 1, cy1 + pad);
  const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;

  const keep = pickEvery(frames, WANT);
  const cells = keep.map(i => {
    const f = frames[i];
    const crop = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      const s = ((cy0 + y) * W + cx0) * 4, t = y * cw * 4;
      crop.set(f.subarray(s, s + cw * 4), t);
    }
    // Uniform scale for every frame of the clip, so the figure stays the same size in the
    // atlas as it is in the clip.
    const s = Math.min(CELL / cw, CELL / ch);
    return scaleRGBA(crop, cw, ch, Math.max(1, Math.round(cw * s)), Math.max(1, Math.round(ch * s)));
  });
  const fw = Math.round(cw * Math.min(CELL / cw, CELL / ch));
  const fh = Math.round(ch * Math.min(CELL / cw, CELL / ch));

  const cols = Math.min(keep.length, 6);
  const rows = Math.ceil(keep.length / cols);
  const atlas = Buffer.alloc(cols * fw * rows * fh * 4);
  cells.forEach((c, k) => {
    const ox = (k % cols) * fw, oy = Math.floor(k / cols) * fh;
    for (let y = 0; y < fh; y++) {
      const s = y * fw * 4, t = ((oy + y) * cols * fw + ox) * 4;
      atlas.set(c.subarray(s, s + fw * 4), t);
    }
  });

  const file = `${e.sprite.replace(/[\\/]/g, '_')}__${e.action}.png`;
  const buf = encodePng(cols * fw, rows * fh, 4, atlas);
  fs.writeFileSync(path.join(OUT, file), buf);
  totalBytes += buf.length;
  manifest.push({
    sprite: e.sprite, action: e.action, file,
    frames: keep.length, cols, rows, cellW: fw, cellH: fh,
    atlasW: cols * fw, atlasH: rows * fh,
    fps: meta.fps || 16, keptFrom: keep, crop: [cx0, cy0, cw, ch],
    clip: e.id, seed: meta.seed, model: 'wan2.2_i2v',
    licence: 'Wan 2.2 Apache 2.0'
  });
  console.log(`  ${e.id.padEnd(26)} ${keep.length} frames  ${cols}x${rows} cells of ${fw}x${fh}  ${(buf.length / 1024).toFixed(0)} KB`);
}

manifest.sort((p, q) => `${p.sprite}`.localeCompare(`${q.sprite}`) || p.action.localeCompare(q.action));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), cell: CELL, entries: manifest
}, null, 2));

console.log(`\n${manifest.length} atlas(es), ${(totalBytes / 1024 / 1024).toFixed(2)} MB total, manifest ${manifest.length} entries`);
console.log(`wrote to ${path.relative(ROOT, OUT)}${YES ? '' : '  (dry run: assets/anim untouched — add --yes to publish)'}`);
if (skipped) console.log(`skipped ${skipped}`);
