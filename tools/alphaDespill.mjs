// Remove the colour cast that a model leaves in the semi-transparent band of an RGBA sprite.
//   node tools/alphaDespill.mjs in.png out.png
//
// Qwen-Image-2.1 asked for a transparent background produces real alpha, but the soft edge
// band comes back violet no matter what the input background was — measured rgb(179,113,207)
// from a white-field input, rgb(166,89,200) from a magenta-field one. In game that band is
// drawn over stone, so a violet fringe is exactly the pink-halo complaint returning in a new
// form. Opaque pixels are left completely alone: the art you approved stays as approved, and
// only the near-transparent edge is pulled toward the subject's own core colour.
import fs from 'fs';
import { decodePng, encodePng } from './pngio.mjs';
import { analyzePng } from './pngAlpha.mjs';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) { console.error('usage: node tools/alphaDespill.mjs in.png out.png'); process.exit(2); }

const before = analyzePng(fs.readFileSync(src));
const { w, h, channels, px } = decodePng(fs.readFileSync(src));
if (channels !== 4) { console.error(`${src} is not RGBA (channels ${channels}) — nothing to despill`); process.exit(1); }

// The subject's own average colour, from pixels that are fully opaque.
let sr = 0, sg = 0, sb = 0, n = 0;
for (let i = 0; i < w * h; i++) {
  const a = px[i * 4 + 3];
  if (a === 255) { sr += px[i * 4]; sg += px[i * 4 + 1]; sb += px[i * 4 + 2]; n++; }
}
if (!n) { console.error('no opaque pixels: nothing to sample the subject colour from'); process.exit(1); }
const core = [sr / n, sg / n, sb / n];

let touched = 0;
for (let i = 0; i < w * h; i++) {
  const o = i * 4;
  const a = px[o + 3];
  if (a === 0 || a === 255) continue;                 // only the soft band
  const r = px[o], g = px[o + 1], b = px[o + 2];
  const tint = Math.min(r, b) - g;                    // positive = magenta/violet lean
  if (tint <= 6) continue;
  const k = Math.min(0.8, tint / 90 + 0.35);          // stronger cast, stronger correction
  px[o] = Math.round(r + (core[0] - r) * k);
  px[o + 1] = Math.round(g + (core[1] - g) * k);
  px[o + 2] = Math.round(b + (core[2] - b) * k);
  touched++;
}

fs.writeFileSync(dest, encodePng(w, h, 4, px));
const after = analyzePng(fs.readFileSync(dest));

console.log(`subject core colour rgb(${core.map(Math.round).join(', ')}); edge pixels adjusted: ${touched}`);
console.log(`before  clear ${before.clear}%  soft ${before.soft}% (${before.softMean})  opaque ${before.opaque}%`);
console.log(`after   clear ${after.clear}%  soft ${after.soft}% (${after.softMean})  opaque ${after.opaque}%`);
console.log(`wrote ${dest}`);
