// Case-sensitivity audit for hosting.
//   node tools/caseCheck.mjs
//
// Windows resolves "Wall_Crypt.png" and "wall_crypt.png" to the same file. GitHub Pages,
// the CI runner, and every other Linux box do not: a reference whose case is off loads a
// 404 and the game quietly substitutes a placeholder. This compares every asset key the
// source and data actually name against the exact spelling on disk.
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const IMAGE_DIR = path.join(ROOT, 'assets/images');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Keys as they exist on disk, in exact case. Archive folders (underscore-prefixed) are not
// reachable by the game, so they must not be treated as available.
const exact = new Set();
const loose = new Map();
for (const f of walk(IMAGE_DIR)) {
  const rel = f.slice(IMAGE_DIR.length + 1).replace(/\\/g, '/');
  if (rel.split('/').some(seg => seg.startsWith('_'))) continue;
  if (!/\.png$/i.test(rel)) continue;
  const key = rel.replace(/\.png$/i, '');
  exact.add(key);
  loose.set(key.toLowerCase(), key);
}

const files = [];
(function collect(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p);
    else if (/\.(js|mjs|json|html)$/.test(e.name)) files.push(p);
  }
})(path.join(ROOT, 'src'));
for (const d of ['data']) {
  for (const e of fs.readdirSync(path.join(ROOT, d))) files.push(path.join(ROOT, d, e));
}
for (const h of fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))) files.push(path.join(ROOT, h));

const KEY_RE = /(["'`])((?:textures|enemies|items|vfx|props|ui)\/[A-Za-z0-9_\/-]+)\1/g;
const refs = new Map();          // key -> where it was named
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(KEY_RE)) {
    // Ignore keys named in a comment: the code does not ask for them, so a missing file
    // there is documentation, not a bug.
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (text.slice(lineStart, m.index).includes('//')) continue;
    if (!refs.has(m[2])) refs.set(m[2], path.relative(ROOT, f));
  }
}

const mismatches = [];
const missing = [];
for (const [key, from] of refs) {
  if (exact.has(key)) continue;
  const near = loose.get(key.toLowerCase());
  if (near) mismatches.push(`${key}  written in ${from}\n        disk spells it  ${near}`);
  else missing.push(`${key}  written in ${from}`);
}

console.log(`${exact.size} images available, ${refs.size} distinct asset keys referenced by source and data`);
if (mismatches.length) {
  console.log(`CASE MISMATCHES — would 404 on Linux: ${mismatches.length}`);
  for (const m of mismatches) console.log('  ' + m);
}
if (missing.length) {
  console.log(`referenced but not on disk (the game draws a placeholder): ${missing.length}`);
  for (const m of missing) console.log('  ' + m);
}
if (!mismatches.length && !missing.length) console.log('every referenced key matches the file on disk exactly');
process.exit(mismatches.length ? 1 : 0);
