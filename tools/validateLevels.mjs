// Headless level-generation test (spec §19).
//   node tools/validateLevels.mjs [count]
// Asserts the §9.1 solvability contract over many depths and prints a path-length histogram.
import { buildLevel, validateLevel } from '../src/world/levelGen.js';

const count = Number(process.argv[2] || 200);
let failures = 0;
const hist = new Map();
const perBand = {};

for (let i = 0; i < count; i++) {
  const depth = 1 + (i % 12);
  const lvl = buildLevel(depth, `test-seed-${i}`);
  const v = validateLevel(lvl);
  const band = lvl.band;
  perBand[band] = perBand[band] || { n: 0, ok: 0, paths: [] };
  perBand[band].n++;
  perBand[band].paths.push(v.stairDist);
  if (v.ok) perBand[band].ok++;
  else {
    failures++;
    if (failures <= 5) console.log(`FAIL depth=${depth} seed=${lvl.seed} :: ${v.problems.join('; ')}`);
  }
  hist.set(v.stairDist, (hist.get(v.stairDist) || 0) + 1);
}

console.log(`\nlevels generated: ${count}   passed: ${count - failures}   failed: ${failures}`);
for (const [band, s] of Object.entries(perBand)) {
  const sorted = s.paths.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`  band ${band}: ${s.ok}/${s.n} passed   median entry->stair path = ${median} cells`);
}

const keys = [...hist.keys()].sort((a, b) => a - b);
console.log('\nshortest entry->stair path histogram (cells):');
for (const k of keys) {
  const n = hist.get(k);
  if (n * 100 / count < 0.5) continue;
  console.log(`  ${String(k).padStart(3)} : ${'#'.repeat(Math.max(1, Math.round(n / 2)))} ${n}`);
}
process.exit(failures ? 1 : 0);
