// Re-encode hand-picked music into the game's naming scheme, level-matched and small.
//
//   node tools/musicPack.mjs --map "source name= crypt" --map "other= vault,boss"
//
// Why a tool and not a one-liner: three things have to agree or the soundtrack silently
// misbehaves — the file must start with the biome key so music.js can pick it by prefix, the
// level must match its neighbours or the volume jumps on every descent, and the credits file
// has to travel with it because the licence of whatever made the music is not our assumption
// to guess at.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measure, loudness } from './audioMeter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const SRC = path.join(ROOT, arg('src', 'assets/music'));
const OUT = path.join(ROOT, arg('out', 'experiments/music128'));
const BITRATE = arg('bitrate', '128k');
const CODEC = arg('codec', 'mp3');           // mp3 | vorbis
const TARGET = Number(arg('loudness', -20)); // mean frame level in dBFS
const CAP = Number(arg('max-gain', 8));

function arg(n, d = null) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }

const maps = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--map') continue;
  const [srcName, slot] = String(process.argv[i + 1] || '').split('=');
  maps.push({ src: srcName.trim(), slot: slot.trim() });
}
if (!maps.length) {
  console.error('usage: node tools/musicPack.mjs --map "source file name = biome-slot" [--map ...] [--bitrate 128k] [--codec mp3|vorbis] [--loudness -20]');
  console.error('slots are the prefixes music.js matches: crypt, cavern, foundry, vault, boss, title (a trailing _02 gives variety within one biome)');
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });
const ext = CODEC === 'vorbis' ? 'ogg' : 'mp3';
const rows = [];
for (const m of maps) {
  // Accept the map key with or without the extension, and tolerate the accidental double
  // spaces that filenames typed by hand collect. Extension stripping is guarded to a real
  // looking suffix, because these names contain dots that are not extensions — "Step1.5" was
  // being cut to "Step" and three tracks were reported missing.
  const norm = (x) => x.replace(/\.[a-z0-9]{1,4}$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const cands = fs.readdirSync(SRC).filter(f => {
    const key = m.src.replace(/\s+/g, ' ').trim().toLowerCase();
    return norm(f) === norm(m.src) || norm(f) === key || f.replace(/\s+/g, ' ').trim().toLowerCase() === key;
  });
  if (!cands.length) { console.log(`MISS  ${m.src} — no such file in ${path.relative(ROOT, SRC)}`); continue; }
  if (cands.length > 1) { console.log(`SKIP  ${m.src} — ambiguous: ${cands.join(', ')}`); continue; }
  const from = path.join(SRC, cands[0]);

  const inLoud = loudness(from);
  const im = measure(from);
  // A slot may carry a trim: "crypt@24" cuts 24 s from the front, and "crypt@auto" cuts the
  // measured lead-in minus a little breathing room, with a short fade so the cut does not
  // click. Long ambient pieces often start with half a minute of near-silence, which is
  // pleasant on an album and reads as a bug when it is the first thing a new depth plays.
  const at = m.slot.lastIndexOf('@');
  let slot = m.slot, trim = 0;
  if (at > 0) {
    slot = m.slot.slice(0, at).trim();
    const raw = m.slot.slice(at + 1).trim();
    trim = raw === 'auto' ? Math.max(0, im.leadSec - 0.75) : (Number(raw) || 0);
    if (raw !== 'auto' && im.leadSec < trim * 0.5) {
      console.log(`note ${slot}: measured lead-in is ${im.leadSec.toFixed(1)}s but ${trim}s was asked for — trimming into the music`);
    }
  }
  const gain = Math.max(-14, Math.min(CAP, TARGET - inLoud));
  const to = path.join(OUT, `${slot}.${ext}`);
  const codecArgs = CODEC === 'vorbis'
    ? ['-c:a', 'libvorbis', '-q:a', String(arg('vbr', '5'))]
    : ['-c:a', 'libmp3lame', '-b:a', BITRATE];
  const filters = [`volume=${gain.toFixed(2)}dB`];
  if (trim > 0) filters.push(`afade=t=in:st=0:d=${Math.min(0.8, trim / 4).toFixed(2)}`);
  const seek = trim > 0 ? ['-ss', trim.toFixed(2)] : [];
  execFileSync(FFMPEG, ['-y', '-v', 'error', ...seek, '-i', from, '-filter:a', filters.join(','),
    ...codecArgs, '-ac', '2', to], { stdio: ['ignore', 'pipe', 'pipe'] });

  const om = measure(to);
  const ol = loudness(to);
  rows.push({ slot, source: cands[0], trim: Number(trim.toFixed(2)), gainDb: Number(gain.toFixed(1)), inLoud, outLoud: Number(ol.toFixed(1)), inSeconds: im.duration, seconds: om.duration, bytes: fs.statSync(to).size, peak: om.peakDb, clipRun: om.clipRun, lead: om.leadSec });
  console.log(`${slot.padEnd(12)} <- ${cands[0].slice(0, 34).padEnd(35)} ${om.duration.toFixed(0).padStart(4)}s  ${(fs.statSync(to).size / 1024 / 1024).toFixed(2)} MB  level ${inLoud.toFixed(1)} -> ${ol.toFixed(1)} dBFS (gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB)${trim ? `  trimmed ${trim.toFixed(1)}s of silence at the start` : ''}`);
}

const total = rows.reduce((a, r) => a + r.bytes, 0);
console.log(`\n${rows.length} encoded, ${(total / 1024 / 1024).toFixed(1)} MB total into ${path.relative(ROOT, OUT)}`);
console.log('nothing copied into assets/music — check the names above first, then move them');
fs.writeFileSync(path.join(OUT, 'packing.json'), JSON.stringify(rows, null, 2) + '\n');
