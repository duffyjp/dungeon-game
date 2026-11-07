// Generate the soundtrack with MiniMax Music 3, measure it, and ship it into assets/music/.
//
//   node tools/musicBatch.mjs --all                       every cue in workflows/music_briefs.json
//   node tools/musicBatch.mjs --only crypt,boss           a few
//   node tools/musicBatch.mjs --only crypt --force --seeds-from 47100
//
// One generation in flight at a time, as everywhere in this project. A 70-second piece at 30
// steps takes a couple of minutes on the 5070 Ti, and the audio VAE decode is tiled in the
// graph because the untiled decode does not fit in VRAM.
//
// Music needs different gates from sound effects, and it needs them more than the owner
// expects: nobody can tell from a waveform that a cue dies in its middle or stops mid-bar,
// but the player feels it every time they descend. So loudness is measured in four quarters,
// and a cue is rejected if the quarters swing more than 12 dB or if the file ends while it is
// still loud — a hard cut rather than an ending.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measure, loudness } from './audioMeter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const HOST = process.env.COMFY_HOST || 'http://10.1.1.1:8188';
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

const briefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/music_briefs.json'), 'utf8'));
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/minimax_music3.json'), 'utf8'));
const OUT_DIR = 'assets/music';
const WORK = 'experiments/music';
fs.mkdirSync(path.join(ROOT, WORK), { recursive: true });

const names = has('all') ? Object.keys(briefs.cues) : (arg('only') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!names.length) {
  console.error('usage: node tools/musicBatch.mjs --all | --only crypt,boss [--dry] [--force] [--seeds-from 47001] [--loudness -20]');
  process.exit(2);
}
const SEED_BASE = Number(arg('seeds-from', 47001));
const TARGET_LUFS = Number(arg('loudness', -20));
const DRY = has('dry');

async function json(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function gates(m, want) {
  const fail = [];
  const q = m.quarterDb || [];
  const spread = q.length ? Math.max(...q) - Math.min(...q) : 0;
  if (m.duration < want * 0.8) fail.push(`${m.duration.toFixed(1)}s for a ${want}s cue — the model ended it early`);
  if (m.duration > want + 10) fail.push(`${m.duration.toFixed(1)}s, well over the ${want}s requested`);
  // Music masters come out of this model hot: brief overs that touch full scale for a few dozen
  // samples are inaudible and the level-match pulls them down anyway, while a sustained run of
  // flat-topped samples is a real distortion. Threshold set far above the SFX one for that
  // reason, and the number is printed so the choice can be argued with.
  if (m.clipRun >= 120) fail.push(`${m.clipRun} samples flat-topped in a row: the master is clipped`);
  if (m.leadSec > 4) fail.push(`${m.leadSec.toFixed(1)}s of silence before the music starts`);
  if (spread > 12) fail.push(`${spread.toFixed(1)} dB spread between the four quarters — dead section or runaway ending`);
  // Loop-aware ending rule. The old gate rejected any cue that stopped while still loud, but
  // these cues loop in music.js and the briefs ask for an ending that matches the opening — a
  // seamless loop is a hard cut by construction, and a fade-out there would restart every
  // cycle from silence. So: a cue may either decay, or end at (or near) the level it began at.
  const loopable = Math.abs(m.endDb - m.startDb) <= 8;
  if (m.endDb > -12 && m.tailSec < 0.3 && !loopable) {
    fail.push(`ends at ${m.endDb.toFixed(1)} dB against a ${m.startDb.toFixed(1)} dB start — will not loop and does not resolve`);
  }
  if (m.rmsDb < -32) fail.push(`mean level ${m.rmsDb.toFixed(1)} dBFS is inaudibly thin`);
  return fail;
}

const results = [];
console.log(`music: ${names.length} cue(s) via ${template.model}`);
console.log('cue              length   peak    rms  quarters (dB)          lead  tail  verdict');
for (let i = 0; i < names.length; i++) {
  const name = names[i];
  const cue = briefs.cues[name];
  if (!cue) { console.log(`${name.padEnd(15)} SKIP — no brief in workflows/music_briefs.json`); continue; }
  const shipped = path.join(ROOT, OUT_DIR, `${name}.mp3`);
  if (fs.existsSync(shipped) && !has('force')) { console.log(`${name.padEnd(15)} exists — skipping (--force to redo)`); continue; }

  const graph = JSON.parse(JSON.stringify(template.graph));
  // The brief plus the shared playback instruction: MiniMax writes to the length the brief
  // implies, and a brief that describes layers fading into silence gets an early ending.
  graph['37:13'].inputs.caption = briefs.playback ? `${cue.caption}\n\nPlayback: ${briefs.playback}` : cue.caption;
  graph['37:13'].inputs.lyrics = cue.sections || briefs.sections
    ? (cue.sections || briefs.sections).join('\n') : '[Instrumental]';
  graph['37:13'].inputs.max_duration = cue.seconds;
  graph['37:38'].inputs.seed = SEED_BASE + i;
  graph['35'].inputs.filename_prefix = `music-${name}`;

  const queued = await json(`${HOST}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: `strata-music-${Date.now()}` })
  });
  if (queued.error) { console.log(`${name.padEnd(15)} queue rejected: ${JSON.stringify(queued).slice(0, 300)}`); continue; }
  const id = queued.prompt_id;

  let entry = null;
  for (let t = 0; t < 300 && !entry; t++) {
    await new Promise(r => setTimeout(r, 3000));
    const h = await json(`${HOST}/history/${id}`);
    const done = h[id];
    if (!done) continue;
    const outs = done.outputs || {};
    for (const nodeId of Object.keys(outs)) {
      const o = outs[nodeId];
      if (o && Array.isArray(o.audio) && o.audio.length) { entry = o.audio[0]; break; }
    }
    const st = done.status;
    if (!entry && st && (st.status_str === 'error' || st.status_str === 'failed')) {
      console.log(`${name.padEnd(15)} server error: ${JSON.stringify(st).slice(0, 300)}`);
      break;
    }
  }
  if (!entry) { console.log(`${name.padEnd(15)} no audio came back`); continue; }

  const url = `${HOST}/view?type=output&filename=${encodeURIComponent(entry.filename)}&subfolder=${encodeURIComponent(entry.subfolder || '')}`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const master = path.join(ROOT, WORK, `${name}_master.mp3`);
  fs.writeFileSync(master, buf);

  const m = measure(master);
  const lu = loudness(master);
  const fail = gates(m, cue.seconds);
  console.log(
    `${name.padEnd(15)} ${m.duration.toFixed(1).padStart(6)}s ${m.peakDb.toFixed(1).padStart(6)}  ${m.rmsDb.toFixed(1).padStart(6)}  ` +
    `[${m.quarterDb.join(' ')}]`.padEnd(24) + ` ${(m.leadSec).toFixed(1).padStart(4)}  ${(m.tailSec).toFixed(1).padStart(4)}  ` +
    `${fail.length ? `REJECTED — ${fail.join('; ')}` : `ok (master ${(buf.length / 1024).toFixed(0)} KB, loudness ${lu.toFixed(1)} dBFS)`}`
  );
  results.push({
    name, seed: SEED_BASE + i, seconds: cue.seconds, biome: cue.biome, caption: cue.caption,
    model: template.model, licence: template.licence, measured: m, loudnessDb: Number(lu.toFixed(1)),
    masterBytes: buf.length, accepted: fail.length === 0, failedGates: fail
  });

  if (!DRY && fail.length === 0) {
    // Level-match the soundtrack: six cues generated in separate runs would otherwise play at
    // different volumes and the difference would land on every depth change. Encoded at a
    // conversation-friendly bitrate for the shipped copy, master kept in experiments/.
    const gain = Math.max(-12, Math.min(10, TARGET_LUFS - lu));
    const shipPath = path.join(ROOT, WORK, `${name}_ship.mp3`);
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', master, '-filter:a', `volume=${gain.toFixed(2)}dB`,
      '-c:a', 'libmp3lame', '-q:a', String(arg('bitrate-q', 5)), '-ac', '2', shipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const sm = measure(shipPath);
    const sl = loudness(shipPath);
    fs.mkdirSync(path.join(ROOT, OUT_DIR), { recursive: true });
    fs.copyFileSync(shipPath, shipped);
    const r = results[results.length - 1];
    r.shipped = { gainDb: Number(gain.toFixed(2)), loudnessDb: Number(sl.toFixed(1)), peakDb: Number(sm.peakDb.toFixed(1)), bytes: fs.statSync(shipped).size };
    console.log(`${''.padEnd(15)} shipped ${(fs.statSync(shipped).size / 1024).toFixed(0)} KB at ${sl.toFixed(1)} dBFS (level +${gain.toFixed(1)} dB)`);
  }
  const rec = results[results.length - 1];
  fs.writeFileSync(path.join(ROOT, WORK, `${name}.json`), JSON.stringify(rec, null, 2) + '\n');
}

fs.writeFileSync(path.join(ROOT, WORK, 'results.json'), JSON.stringify(results, null, 2) + '\n');

// Credits file, separate from the music manifest: music.js reads the manifest to pin play
// order, and mixing provenance into it would silently break that contract.
const ok = results.filter(r => r.accepted).length;
if (!DRY) {
  const credPath = path.join(ROOT, OUT_DIR, 'credits.json');
  const prior = fs.existsSync(credPath) ? JSON.parse(fs.readFileSync(credPath, 'utf8')) : { tracks: [] };
  const byName = new Map((prior.tracks || []).map(t => [t.name, t]));
  for (const r of results.filter(x => x.accepted)) {
    byName.set(r.name, {
      name: r.name, biome: r.biome, seed: r.seed, seconds: r.seconds,
      model: 'MiniMax-Music3', licence: 'MiniMax-Music3 Community License',
      machineGenerated: true, loudnessDb: r.shipped ? r.shipped.loudnessDb : r.loudnessDb
    });
  }
  fs.writeFileSync(credPath, JSON.stringify({
    credit: 'Music generated with MiniMax-Music3 (MiniMax-Music3 Community License). All cues are machine-generated.',
    attribution: 'MiniMax-Music3 is fine-tuned from Qwen3-8B (Apache 2.0); its DiT derives from Stability AI stable-audio-tools (MIT) and its VAE from Descript Audio Codec (MIT).',
    tracks: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, null, 2) + '\n');
}
console.log(`\naccepted ${ok}/${results.length}${DRY ? ' (dry run, nothing shipped)' : ` into ${OUT_DIR}`}`);
console.log('masters, seeds and measurements in ' + WORK + '/; whether each cue fits its biome is for the owner to judge');
