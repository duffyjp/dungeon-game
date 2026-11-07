// One-off repair: a PowerShell Set-Content round-trip re-encoded UTF-8 comments as CP1252,
// turning every em dash into "â€". Rewritten in Node because the shell cannot be trusted to
// pass a non-ASCII string through intact — the same class of mistake that produced the
// damage in the first place.
import fs from 'node:fs';

const PAIRS = [['â€”', '\u2014'], ['â€“', '\u2013'], ['Ã©', '\u00e9'], ['â€œ', '\u201c'], ['â€\u009d', '\u201d'], ['Â§', '\u00a7']];
const files = process.argv.slice(2);
for (const f of files) {
  let t = fs.readFileSync(f, 'utf8');
  let n = 0;
  for (const [bad, good] of PAIRS) {
    const c = (t.match(new RegExp(bad, 'g')) || []).length;
    if (c) { t = t.split(bad).join(good); n += c; }
  }
  if (n) fs.writeFileSync(f, t, 'utf8');
  console.log(`${f}: ${n} sequence(s) repaired`);
}
const left = files.map(f => [f, (fs.readFileSync(f, 'utf8').match(/â€|Ã©/g) || []).length]);
console.log(left.map(([f, c]) => `${f}: ${c} remaining`).join('\n'));
