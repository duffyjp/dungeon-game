// What displacement would cost, before writing a line of shader.
//
// A displacement map moves vertices, so the question is never "does the engine support it"
// (it does) but "how many vertices does this level put on the GPU, and what wavelength of
// relief can those vertices actually express". A wall cell is 2 m across; with n subdivisions
// per face, the finest bump that can be represented is about 2/n metres. Below the detail
// size in the artwork, displacement cannot add crispness — it can only wobble the silhouette.
import { generateLevel } from '../src/world/levelGen.js';
import { isOpen } from '../src/util/grid.js';
import { Rng } from '../src/util/rng.js';
import { CFG } from '../src/config.js';

function wallInstances(lvl) {
  // Same rule levelView uses: one instanced box per wall cell that borders an open cell, so
  // rock buried inside the map is never drawn and costs nothing.
  let n = 0;
  for (let y = 0; y < lvl.h; y++) {
    for (let x = 0; x < lvl.w; x++) {
      if (isOpen(lvl, x, y)) continue;
      if (isOpen(lvl, x + 1, y) || isOpen(lvl, x - 1, y) || isOpen(lvl, x, y + 1) || isOpen(lvl, x, y - 1)) n++;
    }
  }
  return n;
}

const tris = (s) => 12 * s * s;
const verts = (s) => 6 * (s + 1) * (s + 1);

for (const s of [4, 6, 8, 12]) {
  console.log(`  s=${String(s).padEnd(3)} finest expressible relief ≈ ${(CFG.cell / s).toFixed(2)} m across a ${CFG.cell} m cell`);
}
console.log('depth  level     wall cells   tris s=1   tris s=4   tris s=6   tris s=8   verts s=8');
for (const depth of [1, 4, 7, 10, 13]) {
  const lvl = generateLevel(depth, `probe${depth}`, new Rng(`probe${depth}`));
  const n = wallInstances(lvl);
  console.log(
    `${String(depth).padEnd(6)} ${(`${lvl.w}x${lvl.h}`).padEnd(9)} ${String(n).padStart(10)} ` +
    `${String(n * tris(1) / 1000).padStart(9)}k ${String(n * tris(4) / 1000).padStart(9)}k ` +
    `${String(n * tris(6) / 1000).padStart(9)}k ${String(n * tris(8) / 1000).padStart(9)}k ` +
    `${String(n * verts(8) / 1000).padStart(9)}k`
  );
}
console.log('\nfor scale: a 1280x720 frame is 0.92 M pixels; a corridor wall covering a third of it');
console.log('is ~300 k pixels, so 8 subdivisions across a 2 m cell is roughly one vertex per pixel.');
