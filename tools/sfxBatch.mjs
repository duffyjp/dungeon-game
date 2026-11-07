// Generate and gate the sound-effect bank with Stable Audio 3 on the 5070 Ti box.
//
//   node tools/sfxBatch.mjs --only swing_whoosh,hit_flesh     a few names
//   node tools/sfxBatch.mjs --all                             the whole bank, serially
//   node tools/sfxBatch.mjs --all --dry                       measure without shipping
//
// One generation in flight at a time, as everywhere else in this project.
//
// Why gates at all, when the owner is the one who listens: a sound effect can be silently
// wrong in ways a listening pass catches late — a clipped peak that distorts at volume, a
// clip whose actual length disagrees with the requested one so it truncates mid-decay, a
// "whoosh" that is mostly silence, a drum loop where an impact was asked for. All of those
// are measurable without ears, so they are measured here, and what is left for the owner to
// judge is taste rather than defects. The measurements come from decoded PCM samples, not
// from a filter: this ffmpeg build has no working stats filters, verified earlier.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const HOST = process.env.COMFY_HOST || 'http://10.1.1.1:8188';
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/sfx_prompts.json'), 'utf8'));
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/stable_audio_sfx.json'), 'utf8'));
const OUT_DIR = 'assets/audio/sfx';
const WORK = 'experiments/sfx';
fs.mkdirSync(path.join(ROOT, WORK), { recursive: true });
fs.mkdirSync(path.join(ROOT, OUT_DIR), { recursive: true });

const names = has('all') ? Object.keys(spec.sounds)
  : (arg('only') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!names.length) {
  console.error('usage: node tools/sfxBatch.mjs --all | --only swing_whoosh,hit_flesh [--dry] [--force] [--seeds-from 46001]');
  process.exit(2);
}
const SEED_BASE = Number(arg('seeds-from', 46001));
const DRY = has('dry');

async function json(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// --- measurement from decoded PCM --------------------------------------------------------
function pcm(file) {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '22050', '-'],
    { maxBuffer: 64 * 1024 * 1024 });
  const n = raw.length >> 1;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = raw.readInt16LE(i * 2) / 32768;
  return { s, rate: 22050 };
}

function measure(file) {
  const { s, rate } = pcm(file);
  const win = Math.floor(rate * 0.02);                       // 20 ms frames
  const frames = [];
  let peak = 0, zeroCross = 0, energy = 0;
  for (let i = 0; i < s.length; i++) {
    const a = Math.abs(s[i]);
    if (a > peak) peak = a;
    energy += s[i] * s[i];
    if (i > 0 && (s[i] > 0) !== (s[i - 1] > 0)) zeroCross++;
  }
  for (let f = 0; f + win <= s.length; f += win) {
    let acc = 0;
    for (let i = f; i < f + win; i++) acc += s[i] * s[i];
    frames.push(Math.sqrt(acc / win));
  }
  const db = (v) => 20 * Math.log10(Math.max(v, 1e-7));
  const maxFrame = Math.max(...frames, 1e-7);
  const tail = frames.slice(Math.floor(frames.length * 0.9));
  const onsetIdx = frames.findIndex(v => v > 0.3 * maxFrame);
  // The active span matters more than the silence ratio. A one-second impact is *supposed*
  // to be mostly decay: the first version of this gate rejected every honest sound because
  // it counted a fading tail as silence. What is actually wrong is a clip with no audible
  // body, a long dead lead-in, or a hard cut at the end.
  const first = frames.findIndex(v => v > 0.1 * maxFrame);
  let last = frames.length - 1;
  while (last > 0 && frames[last] <= 0.1 * maxFrame) last--;
  return {
    duration: s.length / rate,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(energy / s.length)),
    silenceRatio: frames.filter(v => v < 0.012).length / frames.length,
    activeSec: first < 0 ? 0 : (last - first + 1) * 0.02,
    leadSec: first < 0 ? 99 : first * 0.02,
    onsetSec: onsetIdx < 0 ? 99 : onsetIdx * 0.02,
    endDb: db(frames[frames.length - 1] / maxFrame),
    tailRatio: (tail.reduce((a, b) => a + b, 0) / Math.max(tail.length, 1)) / maxFrame,
    zcr: zeroCross / (s.length / rate)
  };
}

function gates(m, want, cat) {
  const fail = [];
  if (m.duration < want - 0.35 || m.duration > want + 0.8) fail.push(`length ${m.duration.toFixed(2)}s for a ${want}s request`);
  if (m.peakDb > -0.6) fail.push(`peak ${m.peakDb.toFixed(1)} dBFS clips at volume`);
  if (m.peakDb < -26) fail.push(`peak ${m.peakDb.toFixed(1)} dBFS is inaudibly quiet`);
  // A sword whoosh is 0.15 s of sound and the rest of the file is room tail — that is correct,
  // not thin. The floor for a one-shot is therefore short; what still catches a bad generation
  // is a sustained bed that goes quiet, which is where the fraction of the requested length
  // does the work.
  const floorSec = cat === 'sustained' ? 0.38 * want : 0.12;
  if (m.activeSec < floorSec) fail.push(`only ${m.activeSec.toFixed(2)}s of audible body`);
  if (m.leadSec > 0.25) fail.push(`${m.leadSec.toFixed(2)}s of dead air before the sound starts`);
  if (m.endDb > -16) fail.push(`still at ${m.endDb.toFixed(1)} dB below peak when the file ends — hard cut`);
  return fail;
}

// --- the generation loop, strictly serial -------------------------------------------------
const results = [];
console.log(`sound effects: ${names.length} clip(s) via ${template.model} at ${HOST}`);
console.log('name                  len    peak    rms  active  lead   end   zcr   verdict');
for (let i = 0; i < names.length; i++) {
  const name = names[i];
  const cfgs = spec.sounds[name];
  if (!cfgs) { console.log(`${name.padEnd(20)} SKIP — no description in workflows/sfx_prompts.json`); continue; }
  const shipped = path.join(ROOT, OUT_DIR, `${name}.mp3`);
  if (fs.existsSync(shipped) && !has('force')) {
    console.log(`${name.padEnd(20)} exists — skipping (--force to redo)`);
    continue;
  }
  const graph = JSON.parse(JSON.stringify(template.graph));
  const prompt = `${cfgs.prompt}, ${spec.space}. Length: ${cfgs.s} seconds`;
  graph['52:31'].inputs.value = prompt;
  graph['52:36'].inputs.value = cfgs.s;
  graph['52:3'].inputs.seed = SEED_BASE + i;
  graph['57'].inputs.filename_prefix = `sfx-${name}`;

  const client = `strata-sfx-${Date.now()}`;
  const queued = await json(`${HOST}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: client })
  });
  if (queued.error) { console.log(`${name.padEnd(20)} queue rejected: ${JSON.stringify(queued).slice(0, 300)}`); continue; }
  const id = queued.prompt_id;

  let entry = null;
  for (let t = 0; t < 120 && !entry; t++) {
    await new Promise(r => setTimeout(r, 2000));
    const h = await json(`${HOST}/history/${id}`);
    const done = h[id];
    if (!done) continue;
    // History outputs are keyed by NODE ID, not by output kind: SaveAudioAdvanced lands as
    // outputs["57"].audio. Reading outputs.audio directly is how an earlier version of this
    // tool reported "no audio came back" for runs that had in fact succeeded.
    const outs = done.outputs || {};
    for (const nodeId of Object.keys(outs)) {
      const o = outs[nodeId];
      if (o && Array.isArray(o.audio) && o.audio.length) { entry = o.audio[0]; break; }
    }
    const st = done.status;
    if (!entry && st && (st.status_str === 'error' || st.status_str === 'failed')) {
      console.log(`${name.padEnd(20)} server error: ${JSON.stringify(st).slice(0, 260)}`);
      break;
    }
  }
  if (!entry) { console.log(`${name.padEnd(20)} no audio came back`); continue; }

  const sub = entry.subfolder || '';
  const url = `${HOST}/view?type=output&filename=${encodeURIComponent(entry.filename)}&subfolder=${encodeURIComponent(sub)}`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const tmp = path.join(ROOT, WORK, `${name}.mp3`);
  fs.writeFileSync(tmp, buf);

  const m = measure(tmp);
  const fail = gates(m, cfgs.s, cfgs.cat);
  const kb = buf.length / 1024;
  if (kb > 240) fail.push(`${kb.toFixed(0)} KB exceeds the 240 KB budget for one effect`);
  console.log(
    `${name.padEnd(20)} ${m.duration.toFixed(2)}  ${m.peakDb.toFixed(1).padStart(6)}  ${m.rmsDb.toFixed(1).padStart(6)}  ` +
    `${m.activeSec.toFixed(2).padStart(5)}s  ${m.leadSec.toFixed(2).padStart(4)}  ${m.endDb.toFixed(0).padStart(4)}dB  ` +
    `${m.zcr.toFixed(0).padStart(4)}  ${fail.length ? `REJECTED — ${fail.join('; ')}` : `ok (${kb.toFixed(0)} KB)`}`
  );
  results.push({ name, seed: SEED_BASE + i, seconds: cfgs.s, category: cfgs.cat, prompt, model: template.model, licence: template.licence, measured: m, bytes: buf.length, accepted: fail.length === 0, failedGates: fail });

  if (!DRY && fail.length === 0) fs.copyFileSync(tmp, shipped);
}

fs.writeFileSync(path.join(ROOT, WORK, 'results.json'), JSON.stringify(results, null, 2) + '\n');
const ok = results.filter(r => r.accepted).length;
console.log(`\naccepted ${ok}/${results.length}${DRY ? ' (nothing shipped, --dry)' : ` into ${OUT_DIR}`}`);
console.log('measurements in ' + WORK + '/results.json; whether each one sounds right is for the owner to judge');
