// Shared audio measurement: decode a file to mono PCM and describe it numerically.
//
// Used by tools/sfxBatch.mjs and tools/musicBatch.mjs so a sound effect and a music cue are
// judged on the same numbers. The SFX batch carried its own copy of this code until the music
// pass, and that copy had already been corrected twice — sharing it is what keeps the next
// correction from being applied in only one place.
//
// Why decode in Node instead of using ffmpeg's filters: this ffmpeg build has no working
// signalstats/astats output (verified by measurement, not assumption), so the statistics are
// computed here from samples.
import { execFileSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';

export function pcm(file, rate = 22050) {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(rate), '-'],
    { maxBuffer: 256 * 1024 * 1024 });
  const n = raw.length >> 1;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = raw.readInt16LE(i * 2) / 32768;
  return { s, rate };
}

export function db(v) { return 20 * Math.log10(Math.max(v, 1e-7)); }

export function measure(file, frameMs = 20) {
  const { s, rate } = pcm(file);
  const win = Math.floor(rate * (frameMs / 1000));
  const frames = [];
  let peak = 0, energy = 0, zeroCross = 0, clipRun = 0, clipWorst = 0;
  for (let i = 0; i < s.length; i++) {
    const a = Math.abs(s[i]);
    if (a > peak) peak = a;
    energy += s[i] * s[i];
    // Real clipping is a run of samples pinned at full scale, not merely a loud peak: a file
    // touching -0.2 dBFS is fine and gets levelled, while flat-topped runs are permanent.
    if (a >= 0.995) { clipRun++; if (clipRun > clipWorst) clipWorst = clipRun; } else clipRun = 0;
    if (i > 0 && (s[i] > 0) !== (s[i - 1] > 0)) zeroCross++;
  }
  for (let f = 0; f + win <= s.length; f += win) {
    let acc = 0;
    for (let i = f; i < f + win; i++) acc += s[i] * s[i];
    frames.push(Math.sqrt(acc / win));
  }
  const maxFrame = Math.max(...frames, 1e-7);
  const startFrame = frames.slice(0, Math.max(1, Math.floor(0.3 * rate / win))).reduce((a, b) => Math.max(a, b), 0);
  const first = frames.findIndex(v => v > 0.1 * maxFrame);
  let last = frames.length - 1;
  while (last > 0 && frames[last] <= 0.1 * maxFrame) last--;
  // Loudness in four quarters, which is what catches a cue that dies in the middle or ends in
  // a wall of noise: a single mean value hides both.
  const quarters = [0, 1, 2, 3].map(q => {
    const a = frames.slice(Math.floor(frames.length * q / 4), Math.floor(frames.length * (q + 1) / 4));
    return a.length ? Math.sqrt(a.reduce((t, v) => t + v * v, 0) / a.length) : 0;
  });
  return {
    duration: s.length / rate,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(energy / s.length)),
    clipRun: clipWorst,
    silenceRatio: frames.filter(v => v < 0.012).length / frames.length,
    activeSec: first < 0 ? 0 : (last - first + 1) * (frameMs / 1000),
    leadSec: first < 0 ? 99 : first * (frameMs / 1000),
    onsetSec: (() => { const i = frames.findIndex(v => v > 0.3 * maxFrame); return i < 0 ? 99 : i * (frameMs / 1000); })(),
    tailSec: (frames.length - 1 - last) * (frameMs / 1000),
    tailRatio: (() => { const t = frames.slice(Math.floor(frames.length * 0.9)); return (t.reduce((a, b) => a + b, 0) / Math.max(t.length, 1)) / maxFrame; })(),
    endDb: db(frames[frames.length - 1] / maxFrame),
    // Level of the first third of a second, relative to peak. Music that loops needs its end
    // to match its start; a fade-out there means a silent gap every cycle.
    startDb: db(startFrame / maxFrame),
    quarterDb: quarters.map(q => Number(db(q).toFixed(1))),
    zcr: zeroCross / (s.length / rate)
  };
}

// Band profile and a tempo proxy, for judging what a cue is *for* without listening to it.
//
// The first version of this labelled four low-pass filters as four bands, which made every
// track look spectrally identical: a low-pass at 4 kHz is nearly the whole signal, so the
// "bands" were cumulative energies, not bands. Bands are now differences of cumulative
// low-pass energy, and tools/audioProfileSelftest.mjs checks the result against pure tones,
// because a naming decision that rests on a broken meter is worse than guessing honestly.
export function profile(file) {
  const { s, rate } = pcm(file);
  const lpEnergy = (f0) => {
    const w = 2 * Math.PI * f0 / rate;
    const Q = 0.707, cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * Q);
    const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = b0, a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, acc = 0;
    for (let i = 0; i < s.length; i++) {
      const x = s[i];
      const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      acc += y * y;
    }
    return acc / s.length;
  };
  const e110 = lpEnergy(110), e500 = lpEnergy(500), e2000 = lpEnergy(2000), eAll = lpEnergy(Math.min(9000, rate / 2 - 100));
  const band = {
    sub: Math.max(e110, 0),
    low: Math.max(e500 - e110, 0),
    mid: Math.max(e2000 - e500, 0),
    high: Math.max(eAll - e2000, 0)
  };
  const e = { sub: Math.sqrt(band.sub), low: Math.sqrt(band.low), mid: Math.sqrt(band.mid), high: Math.sqrt(band.high) };
  // Onset proxy: 20 ms frames whose energy rises more than 4 dB over the previous frame.
  const win = Math.floor(rate * 0.02);
  let prev = 0, onsets = 0, frames = 0;
  for (let f = 0; f + win <= s.length; f += win) {
    let acc = 0;
    for (let i = f; i < f + win; i++) acc += s[i] * s[i];
    const rms = Math.sqrt(acc / win);
    frames++;
    if (prev > 1e-5 && rms > prev * 1.58) onsets++;
    prev = Math.max(rms, prev * 0.9);
  }
  const total = e.sub + e.low + e.mid + e.high || 1;
  return {
    bandDb: { sub: db(e.sub), low: db(e.low), mid: db(e.mid), high: db(e.high) },
    darkness: Number(((e.sub + e.low) / total).toFixed(3)),
    brightness: Number(((e.mid + e.high) / total).toFixed(3)),
    onsetRate: Number((onsets / (frames * 0.02)).toFixed(2))   // events per second
  };
}

// A perceptual-ish loudness: mean of frame log-loudness, closer to how a change in level
// reads than an overall RMS, and used to keep the soundtrack at a consistent volume.
export function loudness(file, frameMs = 50) {
  const { s, rate } = pcm(file);
  const win = Math.floor(rate * (frameMs / 1000));
  let acc = 0, n = 0;
  for (let f = 0; f + win <= s.length; f += win) {
    let e = 0;
    for (let i = f; i < f + win; i++) e += s[i] * s[i];
    acc += Math.sqrt(e / win); n++;
  }
  return db(acc / Math.max(n, 1));
}
