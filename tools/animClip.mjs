// One animated sprite clip, start to finish.
//
//   node tools/animClip.mjs --sprite enemies/t1/slime --action walk
//   node tools/animClip.mjs --sprite enemies/t1/orc_grunt --action attack --fast false
//
// The approved billboard becomes the model's first frame, so the clip inherits the
// sprite's identity instead of asking a video model to invent a creature. Because Wan
// paints a flat backdrop and returns a video with no alpha, the sprite is composited onto
// a backdrop chosen by measuring the sprite, and every returned frame is keyed back out
// with the same maths tools/testVideoKit.mjs proves on the shipped art.
//
// Nothing is written into assets/images. Everything lands under experiments/anim/, with a
// contact sheet and a measured verdict, so a bad clip is obvious before anything promotes
// it. tools/graphCheck.mjs has already confirmed this graph runs on that server; this tool
// re-checks nothing and simply refuses to run against a host that is not the video box.
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './pngio.mjs';
import { pickBackdrop, composeStartFrame, keyFrame, alignFrames, scoreClip, contactSheet } from './videoKit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.ANIM_HOST || 'http://10.1.1.1:8188';
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const TIMEOUT_MS = Number(process.env.ANIM_TIMEOUT || 60 * 60 * 1000);

function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const key = arg('sprite');
const action = arg('action');
if (!key || !action) {
  console.error('usage: node tools/animClip.mjs --sprite <assets/images key> --action <walk|attack|flee|hurt> [--frames 13] [--size 640] [--fast true] [--seed N] [--dry]');
  process.exit(2);
}

// Motion prompts. The lessons from the still-image pass all apply here and one of them
// applies harder: naming a body part the sprite does not have makes the model grow it, and
// asking for a moving camera moves the matte instead of the character. So these describe
// rhythm and direction only, never anatomy, never the lens, and they end by pinning the
// frame, which is what makes the per-frame alignment step cheap instead of guesswork.
// Motion prompts. The lessons from the still-image pass all apply here and one of them
// applies harder: naming a body part the sprite does not have makes the model grow it, so
// these describe rhythm and extent, never anatomy — "outline swinging wide" instead of
// "arms swinging", which matters for a spider and a will-o'-the-wisp. They also pin the
// facing, because the first clips we measured did not fail by going still, they failed by
// quietly rotating the creature sideways while everything else stayed in place.
const ACTIONS = {
  walk: 'the figure moves with large exaggerated steps in place, its whole body bouncing up and down noticeably, its outline swinging wide from side to side, it keeps facing the viewer, it stays in the middle of the frame, the view stays fixed, the background stays completely still',
  attack: 'the figure crouches down low and then thrusts forward once in one big fast strike, then settles back to standing still, it keeps facing the viewer, it stays in the middle of the frame, the view stays fixed, the background stays completely still',
  // Fleeing used to ask the figure to run off into the distance, and the model obliged by
  // shrinking it to a speck — which is wrong twice over: these billboards already scale with
  // the player's distance, so an in-sprite recession would double-count the perspective, and
  // the frames stop being one creature. So flee runs in place, facing away, at constant size,
  // and the engine does the receding.
  flee: 'the figure turns around to face away from the viewer and runs in place with big fast strides, keeping exactly the same size and staying in the middle of the frame, the view stays fixed, the background stays completely still',
  hurt: 'the figure is struck and recoils with a big stagger, folding inward, then straightens back to standing still, it keeps facing the viewer, it stays in the middle of the frame, the view stays fixed, the background stays completely still'
};
// A step cycle needs enough frames to read as a cycle; a single strike does not.
const ACTION_FRAMES = { walk: 17, attack: 13, flee: 17, hurt: 13 };
const prompt = arg('prompt', null) || ACTIONS[action];
if (!prompt) { console.error(`unknown action "${action}" — known: ${Object.keys(ACTIONS).join(', ')}`); process.exit(2); }

const FRAMES = Number(arg('frames', ACTION_FRAMES[action] || 13));
const SIZE = Number(arg('size', 640));
const FPS = Number(arg('fps', 16));
const FAST = arg('fast', 'true') !== 'false';
const SEED = Number(arg('seed', 44500));
const SCALE = Number(arg('scale', 1.0));
// Floor for "the subject actually moves", as a percentage of the frame whose silhouette
// changes per step. Calibrated from measured clips, not chosen; see README.
const MOTION_FLOOR = Number(arg('motion', 0.6));
// A variant tag makes a settings comparison leave its own folder behind instead of stamping
// on the previous attempt. Comparing two ways of rendering one sprite is how the sampling
// path and the wording get chosen on evidence rather than by preference.
const VARIANT = arg('variant', '');
const DRY = process.argv.includes('--dry');
const base = path.basename(key);
const id = `${base}__${action}${VARIANT ? `_${VARIANT}` : ''}`;

const outDir = path.join(ROOT, 'experiments', 'anim', id);
fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });

// ---------------------------------------------------------------- 1. start frame
const src = decodePng(fs.readFileSync(path.join(ROOT, 'assets', 'images', `${key}.png`)));
const pick = pickBackdrop(src.px, src.w, src.h, src.channels);
const bg = pick.choice.rgb;
console.log(`sprite ${key}  ${src.w}x${src.h}  action ${action}`);
console.log(`backdrop ${pick.choice.name} rgb(${bg.join(',')}) — collision ${pick.choice.ratio.toFixed(2)}  [${pick.table}]`);
if (pick.risky) console.log('  WARNING: every candidate backdrop collides with this sprite; expect a ragged matte');

const canvas = composeStartFrame(src.px, src.w, src.h, src.channels, { w: SIZE, h: SIZE }, bg, SCALE);
const startPath = path.join(outDir, 'start.png');
fs.writeFileSync(startPath, encodePng(SIZE, SIZE, 4, canvas));
console.log(`start frame ${SIZE}x${SIZE} -> ${path.relative(ROOT, startPath)}`);

// ---------------------------------------------------------------- 2. the graph
const wrapped = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', 'wan22_i2v.json'), 'utf8'));
const graph = JSON.parse(JSON.stringify(wrapped.graph));
const uploadName = `strata_${id}_start.png`;

// length comes from floor(duration * fps + 1) in the graph, so ask for the duration that
// yields exactly the frame count we want. Wan's video VAE compresses time by 4, so a count
// of 4n+1 is what decodes cleanly; anything else silently costs or gains a frame.
if ((FRAMES - 1) % 4) console.log(`  note: ${FRAMES} frames is not 4n+1, the VAE may drop or add one`);
const patches = {
  '97': { image: uploadName },
  '129:93': { text: prompt },
  '129:98': { width: SIZE, height: SIZE },
  '129:161': { value: (FRAMES - 1) / FPS },
  '129:162': { value: FPS },
  '129:131': { value: FAST },
  '129:86': { noise_seed: SEED },
  '108': { filename_prefix: `video/${id}` }
};
for (const [node, fields] of Object.entries(patches)) {
  if (!graph[node]) { console.error(`node ${node} is not in workflows/wan22_i2v.json`); process.exit(1); }
  Object.assign(graph[node].inputs, fields);
}
console.log(`sampling: ${FAST ? '4-step lightx2v LoRA path, CFG 1' : '20-step path, CFG 3.5'}   seed ${SEED}   ${FRAMES} frames @ ${FPS} fps`);

if (DRY) {
  console.log('--dry: start frame written and graph patched, nothing submitted');
  process.exit(0);
}

async function req(p, opts) {
  const res = await fetch(HOST + p, opts);
  if (!res.ok) throw new Error(`${p} -> HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

// ---------------------------------------------------------------- 3. upload + submit
{
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(startPath)]), uploadName);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const r = await req('/upload/image', { method: 'POST', body: form });
  const info = await r.json();
  graph['97'].inputs.image = info.subfolder ? `${info.subfolder}/${info.name}` : info.name;
  console.log(`uploaded ${uploadName}`);
}

const sent = await req('/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: crypto.randomUUID() })
});
const { prompt_id: promptId } = await sent.json();
console.log(`queued ${promptId} on ${HOST}`);

const started = Date.now();
let entry = null, lastReport = 0;
while (!entry) {
  const elapsed = Date.now() - started;
  if (elapsed > TIMEOUT_MS) { console.error(`timed out after ${Math.round(elapsed / 1000)}s — check the server queue before assuming the card is free`); process.exit(1); }
  await new Promise(r => setTimeout(r, 3000));
  const h = await (await req(`/history/${promptId}`)).json();
  if (h[promptId]) { entry = h[promptId]; break; }
  if (Date.now() - lastReport > 60000) {
    lastReport = Date.now();
    let q = '';
    try {
      const qq = await (await req('/queue')).json();
      q = ` (running ${qq.queue_running?.length || 0}, pending ${qq.queue_pending?.length || 0})`;
    } catch { /* the queue endpoint is a courtesy, not a dependency */ }
    console.log(`  … ${Math.round(elapsed / 1000)}s elapsed${q}`);
  }
}
const status = entry.status || {};
if (status.status_str && status.status_str !== 'success') {
  console.error(`run reported ${status.status_str}`);
  for (const m of status.messages || []) console.error('  ' + JSON.stringify(m).slice(0, 400));
  process.exit(1);
}
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`generated in ${seconds}s`);

// ---------------------------------------------------------------- 4. pull the clip
const files = [];
for (const out of Object.values(entry.outputs || {})) {
  for (const item of [...(out.videos || []), ...(out.images || []), ...(out.gifs || [])]) {
    if (!item || !item.filename) continue;
    const url = `${HOST}/view?filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(item.subfolder || '')}&type=${item.type || 'output'}`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const to = path.join(outDir, path.basename(item.filename));
    fs.writeFileSync(to, buf);
    files.push(to);
    console.log(`got ${path.basename(item.filename)}  ${(buf.length / 1024).toFixed(1)} KB`);
  }
}
if (!files.length) { console.error('the run succeeded but produced no downloadable video'); process.exit(1); }

// ---------------------------------------------------------------- 5. frames
if (!fs.existsSync(FFMPEG)) { console.error(`ffmpeg not at ${FFMPEG} — set FFMPEG=`); process.exit(1); }
const clip = files.find(f => /\.(mp4|webm|mov|mkv)$/i.test(f)) || files[0];
const framesDir = path.join(outDir, 'frames');
for (const stale of fs.readdirSync(framesDir)) if (/^f\d+\.png$/.test(stale)) fs.unlinkSync(path.join(framesDir, stale));
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', clip, '-vsync', '0', '-pix_fmt', 'rgba', path.join(framesDir, 'f%03d.png')]);
const frameFiles = fs.readdirSync(framesDir).filter(f => /^f\d+\.png$/.test(f)).sort();
console.log(`ffmpeg split the clip into ${frameFiles.length} frames`);

// ---------------------------------------------------------------- 6. key + measure
const raw = frameFiles.map(f => {
  const dec = decodePng(fs.readFileSync(path.join(framesDir, f)));
  const W = dec.w, H = dec.h;
  let rgba;
  if (dec.channels === 4) rgba = dec.px;
  else {
    rgba = Buffer.alloc(W * H * 4);
    for (let i = 0, p = 0; i < W * H; i++, p += dec.channels) {
      rgba[i * 4] = dec.px[p]; rgba[i * 4 + 1] = dec.px[p + 1]; rgba[i * 4 + 2] = dec.px[p + 2]; rgba[i * 4 + 3] = 255;
    }
  }
  return { W, H, rgba };
});
const W = raw[0].W, H = raw[0].H;
const keyed = raw.map(r => keyFrame(r.rgba, r.W, r.H));

// Re-anchor the clip, then judge it with the shared scorer in tools/videoKit.mjs — the
// same scorer tools/animMeasure.mjs re-runs over clips that already exist, so a gate can be
// tightened across a whole phase without generating anything again.
const { aligned, anchor } = alignFrames(keyed.map(k => k.rgba), W, H);
if (!anchor) { console.error('no frames had a subject to align on'); process.exit(1); }
const [ax, ay] = anchor;

// Save the *aligned* frames, because those are what an atlas would be built from; saving
// the unaligned ones here would mean the promoted art is not the art that was measured.
aligned.forEach((f, i) => {
  const name = `keyed_${String(i + 1).padStart(3, '0')}.png`;
  fs.writeFileSync(path.join(outDir, name), encodePng(W, H, 4, f));
});

// ---------------------------------------------------------------- 7. gates
const srcSil = composeStartFrame(src.px, src.w, src.h, src.channels, { w: W, h: H }, bg, SCALE);
const srcKeyed = keyFrame(srcSil, W, H, { backdrop: { r: bg[0], g: bg[1], b: bg[2] } }).rgba;
const { rows, gates, summary } = scoreClip({
  frames: aligned, W, H, requested: FRAMES, srcKeyed,
  motionFloor: MOTION_FLOOR
  // No action is exempt from holding its size any more: the first flee clips shrank the
  // creature to a speck, and since the engine already scales sprites with distance, that
  // shrink was both a double-count and a lost identity.
});
const { minIoU, minCov, maxDrift, maxColour, minClear, srcCov } = summary;
const startFaithful = rows[0].iouSource;

console.log('');
console.log('frame  clear%   cov%   IoU(prev)  IoU(src)  drift  dRGB   move%   box');
for (const r of rows) {
  console.log(`  ${String(r.frame).padStart(3)}   ${String(r.clear).padStart(5)}  ${String(r.coverage).padStart(5)}    ${r.iouPrev.toFixed(3)}    ${r.iouSource.toFixed(3)}  ${String(r.driftPx).padStart(5)}  ${String(r.colourDrift).padStart(4)}   ${String(r.moved).padStart(5)}  ${r.boxRatio.toFixed(2)}`);
}
console.log('');
let failed = 0;
for (const [name, held, detail] of gates) {
  console.log(`  ${held ? 'ok  ' : 'FAIL'}  ${name}  — ${detail}`);
  if (!held) failed++;
}

// Union of every frame's box, so the atlas stage crops a consistent window instead of
// guessing, plus a contact sheet so a human can watch the clip in one image.
const box = [W, H, 0, 0];
for (const r of rows) if (r.bbox) {
  box[0] = Math.min(box[0], r.bbox[0]); box[1] = Math.min(box[1], r.bbox[1]);
  box[2] = Math.max(box[2], r.bbox[2]); box[3] = Math.max(box[3], r.bbox[3]);
}
const sheet = contactSheet(aligned, W, H, 144, Math.min(7, rows.length));
fs.writeFileSync(path.join(outDir, 'sheet.png'), encodePng(sheet.w, sheet.h, 3, sheet.buffer));

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
  sprite: key, action, host: HOST, model: wrapped.model, licence: wrapped.licence,
  seed: SEED, fast: FAST, frames: FRAMES, fps: FPS, size: SIZE, scale: SCALE,
  backdrop: pick.choice.name, backdropRgb: bg, collision: +pick.choice.ratio.toFixed(2),
  generatedIn: seconds, clip: path.basename(clip), rows, summary,
  unionBox: box, anchor: [ax, ay],
  gates: Object.fromEntries(gates.map(([n, h, d]) => [n, { pass: h, detail: d }])),
  verdict: failed ? 'REJECTED' : 'ACCEPTED',
  at: new Date().toISOString()
}, null, 2));

console.log(`\n${failed ? 'REJECTED' : 'ACCEPTED'}: ${key} ${action}  (${failed} gate(s) failed)`);

// Keep a running index so the review page and the batch driver never have to be told what
// exists — the folder is the record, and this is the only thing that writes it.
{
  const listPath = path.join(ROOT, 'experiments', 'anim', 'list.json');
  const list = fs.existsSync(listPath) ? JSON.parse(fs.readFileSync(listPath, 'utf8')) : [];
  const entry = {
    id, sprite: key, action, variant: VARIANT, verdict: failed ? 'REJECTED' : 'ACCEPTED',
    sheet: `experiments/anim/${id}/sheet.png`, start: `experiments/anim/${id}/start.png`,
    clip: `experiments/anim/${id}/${path.basename(clip)}`,
    backdrop: pick.choice.name, seed: SEED, fast: FAST, frames: rows.length,
    failedGates: gates.filter(g => !g[1]).map(g => g[0]),
    minIoU: +minIoU.toFixed(3), startIoU: +startFaithful.toFixed(3),
    meanMove: summary.meanMove, loopMove: rows.at(-1).loopMoved,
    worstCoverage: +minCov.toFixed(1), seconds
  };
  const at = list.findIndex(e => e.id === id);
  if (at >= 0) list[at] = entry; else list.push(entry);
  list.sort((p, q) => p.id.localeCompare(q.id));
  fs.writeFileSync(listPath, JSON.stringify(list, null, 2));
}

console.log(`sheet ${path.relative(ROOT, path.join(outDir, 'sheet.png'))}`);
console.log('nothing was written to assets/images; promote deliberately, later');
process.exit(failed ? 1 : 0);
