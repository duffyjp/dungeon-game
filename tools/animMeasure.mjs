// Re-measure clips that already exist. No generation, no GPU.
//
//   node tools/animMeasure.mjs                      every clip under experiments/anim
//   node tools/animMeasure.mjs slime__walk          just one
//   node tools/animMeasure.mjs --motion 1.5 --iou 0.5      what the phase looks like under
//                                                          stricter gates
//   node tools/animMeasure.mjs --write              refresh results.json and list.json
//
// This exists because a gate that cannot be re-run is a guess. When a threshold turns out
// to be too loose — the motion floor was, see README — the honest thing is to re-judge
// every clip already rendered and say which ones no longer pass, rather than keep the
// ACCEPTED stamps that were awarded under the old, weaker rule.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './pngio.mjs';
import { pickBackdrop, composeStartFrame, keyFrame, alignFrames, scoreClip } from './videoKit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANIM = path.join(ROOT, 'experiments', 'anim');

function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const motionFloor = Number(arg('motion', 0.6));
const iouFloor = Number(arg('iou', 0.30));
const write = process.argv.includes('--write');
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));

function findSprite(base) {
  for (const tier of ['t1', 't2', 't3', 't4']) {
    const p = path.join(ROOT, 'assets', 'images', 'enemies', tier, `${base}.png`);
    if (fs.existsSync(p)) return { key: `enemies/${tier}/${base}`, p };
  }
  return null;
}

const dirs = fs.existsSync(ANIM)
  ? fs.readdirSync(ANIM).filter(d => fs.statSync(path.join(ANIM, d)).isDirectory() &&
    (!only.length || only.some(o => d === o || d.startsWith(o))))
  : [];
if (!dirs.length) { console.log('no clips under experiments/anim'); process.exit(0); }

console.log(`re-measuring ${dirs.length} clip(s) with motion floor ${motionFloor}% and consecutive-IoU floor ${iouFloor}`);
console.log('');
console.log('clip                        frames  clear  worstCov  IoU(prev)  IoU(src)  move%   minBox  verdict');

const rows = [];
for (const d of dirs) {
  const dir = path.join(ANIM, d);
  const meta = fs.existsSync(path.join(dir, 'results.json'))
    ? JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')) : {};
  const files = fs.readdirSync(path.join(dir, 'frames')).filter(f => /^f\d+\.png$/.test(f)).sort();
  if (files.length < 2) { console.log(`${d.padEnd(26)}  (only ${files.length} frame(s) on disk)`); continue; }

  const frames = files.map(f => {
    const dec = decodePng(fs.readFileSync(path.join(dir, 'frames', f)));
    if (dec.channels === 4) return { W: dec.w, H: dec.h, rgba: dec.px };
    const W = dec.w, H = dec.h, rgba = Buffer.alloc(W * H * 4);
    for (let i = 0, p = 0; i < W * H; i++, p += dec.channels) {
      rgba[i * 4] = dec.px[p]; rgba[i * 4 + 1] = dec.px[p + 1]; rgba[i * 4 + 2] = dec.px[p + 2]; rgba[i * 4 + 3] = 255;
    }
    return { W, H, rgba };
  });
  const W = frames[0].W, H = frames[0].H;
  const keyed = frames.map(f => keyFrame(f.rgba, f.W, f.H).rgba);
  const { aligned } = alignFrames(keyed, W, H);

  // Score against the still the clip was built from. The backdrop it was flattened onto is
  // recorded in results.json; without it, re-pick it the same way the runner would have.
  const found = findSprite(d.split('__')[0]);
  let srcKeyed = null;
  if (found) {
    const src = decodePng(fs.readFileSync(found.p));
    const bg = meta.backdropRgb || pickBackdrop(src.px, src.w, src.h, src.channels).choice.rgb;
    const canvas = composeStartFrame(src.px, src.w, src.h, src.channels, { w: W, h: H }, bg, meta.scale ?? 1.0);
    srcKeyed = keyFrame(canvas, W, H, { backdrop: { r: bg[0], g: bg[1], b: bg[2] } }).rgba;
  }

  const act = meta.action || d.split('__')[1];
  const scored = scoreClip({
    frames: aligned, W, H,
    requested: Number(meta.frames || files.length),
    srcKeyed, motionFloor, iouFloor, allowShrink: act === 'flee'
  });
  const failed = scored.gates.filter(g => !g[1]).map(g => g[0]);
  rows.push({
    id: d, meta, frames: aligned, scored, failed,
    verdict: failed.length ? 'REJECTED' : 'ACCEPTED'
  });
  const s = scored.summary;
  console.log(
    `${d.padEnd(26)} ${String(aligned.length).padStart(5)}  ${String(s.minClear).padStart(5)}  ` +
    `${String(s.minCov).padStart(7)}  ${s.minIoU.toFixed(3).padStart(8)}  ${s.minSrc.toFixed(3).padStart(8)}  ` +
    `${String(s.meanMove).padStart(5)}  ${String(s.minBox).padStart(5)}  ` +
    `${failed.length ? 'REJECTED: ' + failed.join(', ') : 'accepted'}`
  );

  if (write) {
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({
      ...meta, framesOnDisk: aligned.length, motionFloor, iouFloor,
      rows: scored.rows, summary: scored.summary,
      gates: Object.fromEntries(scored.gates.map(([n, h, det]) => [n, { pass: h, detail: det }])),
      verdict: rows.at(-1).verdict, remeasuredAt: new Date().toISOString()
    }, null, 2));
    for (let i = 0; i < aligned.length; i++) {
      fs.writeFileSync(path.join(dir, `keyed_${String(i + 1).padStart(3, '0')}.png`), encodePng(W, H, 4, aligned[i]));
    }
  }
}

// Refresh the index the review page reads, so the verdicts shown on screen are the current
// rules rather than the rules in force when each clip happened to be rendered.
if (write && rows.length) {
  const list = rows.map(r => ({
    id: r.id,
    sprite: r.meta.sprite || `enemies/?/${r.id.split('__')[0]}`,
    action: r.meta.action || r.id.split('__')[1],
    verdict: r.verdict,
    sheet: `experiments/anim/${r.id}/sheet.png`,
    start: `experiments/anim/${r.id}/start.png`,
    clip: `experiments/anim/${r.id}/${r.meta.clip || ''}`,
    backdrop: r.meta.backdrop, seed: r.meta.seed, fast: r.meta.fast,
    frames: r.frames.length,
    failedGates: r.failed,
    minIoU: +r.scored.summary.minIoU.toFixed(3),
    startIoU: +r.scored.rows[0].iouSource.toFixed(3),
    meanMove: r.scored.summary.meanMove,
    loopMove: r.scored.rows.at(-1).loopMoved,
    worstCoverage: +r.scored.summary.minCov.toFixed(1),
    seconds: r.meta.generatedIn
  }));
  list.sort((p, q) => p.id.localeCompare(q.id));
  fs.writeFileSync(path.join(ANIM, 'list.json'), JSON.stringify(list, null, 2));
  console.log('\nrewrote experiments/anim/list.json');
}

const accepted = rows.filter(r => !r.failed.length).length;
console.log(`\nunder these gates: ${accepted}/${rows.length} accepted`);
process.exit(accepted === rows.length ? 0 : 1);
