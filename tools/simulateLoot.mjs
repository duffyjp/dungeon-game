// Headless loot simulation (spec §19).
//   node tools/simulateLoot.mjs [n]
// Asserts the §8 requirements numerically: mean gear score must rise with depth, and
// same-depth drops must actually vary (the "not always the same" requirement).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Rng } from '../src/util/rng.js';
import { makeItem, useQualityTable, bandKey } from '../src/loot/quality.js';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const qualityTable = JSON.parse(readFileSync(join(here, 'data/quality.json'), 'utf8'));
const items = JSON.parse(readFileSync(join(here, 'data/items.json'), 'utf8'));
useQualityTable(qualityTable);

const n = Number(process.argv[2] || 10000);
const gear = items.items.filter(i => i.slot === 'weapon' || i.slot === 'armor');
const depths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14];

function stats(vals) {
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { mean, sd, cv: sd / mean, min: Math.min(...vals), max: Math.max(...vals) };
}

console.log(`simulating ${n} gear drops per depth (uniform family choice)\n`);
console.log('depth  band   mean    stdev    cv%     min   max   tier distribution');
const byDepth = {};
const rng = new Rng('loot-sim');
for (const d of depths) {
  const scores = [];
  const tierCount = new Array(qualityTable.tiers.length).fill(0);
  for (let i = 0; i < n; i++) {
    const item = makeItem(rng.pick(gear), d, rng);
    scores.push(item.score);
    tierCount[item.tierIndex]++;
  }
  byDepth[d] = stats(scores);
  const s = byDepth[d];
  const dist = tierCount.map((c, i) => `${i}:${(c * 100 / n).toFixed(0)}`).join(' ');
  console.log(`${String(d).padStart(5)}  ${bandKey(d).padStart(4)}  ${s.mean.toFixed(1).padStart(6)}  ${s.sd.toFixed(1).padStart(6)}  ${(s.cv * 100).toFixed(1).padStart(5)}  ${String(s.min).padStart(5)}  ${String(s.max).padStart(4)}   ${dist}`);
}

let failures = 0;
console.log('\nchecks:');

// Quality weights are banded, so mean score rises across bands and is flat inside
// one. Assert monotone growth across band representatives, and that a same-depth
// step never drops by more than sampling noise.
const reps = [1, 3, 6, 10, 14];
for (let i = 1; i < reps.length; i++) {
  const a = byDepth[reps[i - 1]], b = byDepth[reps[i]];
  const ok = b.mean > a.mean * 1.05;
  console.log(`  mean score depth ${reps[i - 1]} -> ${reps[i]}: ${a.mean.toFixed(1)} -> ${b.mean.toFixed(1)}  ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failures++;
}
for (let i = 1; i < depths.length; i++) {
  const a = byDepth[depths[i - 1]], b = byDepth[depths[i]];
  if (bandKey(depths[i - 1]) === bandKey(depths[i]) && b.mean < a.mean * 0.95) {
    console.log(`  FAIL mean dropped within band: depth ${depths[i - 1]} -> ${depths[i]}`);
    failures++;
  }
}
for (const d of depths) {
  if (byDepth[d].cv < 0.15) { console.log(`  FAIL depth ${d} drop variance ${(byDepth[d].cv * 100).toFixed(1)}% < 15%`); failures++; }
}
const rng2 = new Rng('same-level');
const same = Array.from({ length: 12 }, () => makeItem(rng2.pick(gear.filter(g => g.id === 'sword_short')), 3, rng2).score);
const spread = Math.max(...same) / Math.min(...same);
console.log(`  same-family same-level sword scores: ${same.join(', ')}  (max/min = ${spread.toFixed(2)})`);
if (spread < 1.15) { console.log('  FAIL identical drops on one level are too similar'); failures++; }
console.log(failures ? `\n${failures} check(s) failed` : '\nall loot checks passed');
process.exit(failures ? 1 : 0);
