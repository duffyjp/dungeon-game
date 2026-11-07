// Self-test for the band profiler in tools/audioMeter.mjs.
//
// Run: node tools/audioProfileSelftest.mjs
//
// The profiler decides which of the owner's tracks becomes the crypt cue and which becomes the
// boss cue, so it gets the same treatment as everything else here: it is checked against
// signals whose answer is known, not trusted because the numbers look plausible.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { profile } from './audioMeter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const TMP = path.join(ROOT, 'experiments/profiletest');
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${detail}`);
  cond ? pass++ : fail++;
};

function tone(hz, seconds = 3) {
  const f = path.join(TMP, `tone_${hz}.wav`);
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}`,
    '-ar', '22050', '-ac', '1', f], { stdio: ['ignore', 'pipe', 'pipe'] });
  return f;
}

// Which band owns a pure tone. Bands split at 110 / 500 / 2000 Hz.
const expect = [[60, 'sub'], [90, 'sub'], [300, 'low'], [900, 'mid'], [1500, 'mid'], [5000, 'high']];
for (const [hz, band] of expect) {
  const p = profile(tone(hz));
  const winner = Object.entries(p.bandDb).sort((a, b) => b[1] - a[1])[0][0];
  ok(`tone ${hz} Hz lands in ${band}`, winner === band, `bands ${Object.entries(p.bandDb).map(([k, v]) => k + ' ' + v.toFixed(0)).join(' ')}`);
}

// Darkness must actually separate a bass tone from a bright one; the first version of this
// profiler reported 0.47-0.49 for every track, which is what a broken band split looks like.
const dark = profile(tone(80)).darkness;
const light = profile(tone(5000)).darkness;
ok('darkness separates 80 Hz from 5 kHz', dark > 0.8 && light < 0.2, `80 Hz ${dark}, 5 kHz ${light}`);

// Onset proxy: a tone gated at 2 per second should read roughly 2 onsets per second.
const gated = path.join(TMP, 'gated.wav');
let gatedOk = true;
try {
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-af', 'atremolo=f=2:d=0.95', '-ar', '22050', '-ac', '1', gated], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch { gatedOk = false; }
if (gatedOk) {
  const p = profile(gated);
  ok('onset rate on a 2 Hz gated tone', p.onsetRate > 1.2 && p.onsetRate < 4, `${p.onsetRate}/s`);
  const steady = profile(tone(440)).onsetRate;
  ok('a steady tone reads fewer onsets than a gated one', steady < p.onsetRate, `steady ${steady} vs gated ${p.onsetRate}`);
} else {
  console.log('skip onset self-test: this ffmpeg build has no atremolo filter');
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
