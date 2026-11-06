// Which generated assets does nothing actually reference?
// Every image in the manifest costs a generation and load time; anything unreferenced is
// either an orphan or reached through a computed key. This prints both, and leaves the
// judgement to a human, because a computed key (`props/${kind}`) is invisible to a grep.
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SCAN = ['src', 'data', 'tools'];
const ROOT_HTML = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const CSS = [];

function collect(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.(js|mjs|css|html|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [];
for (const d of SCAN) if (fs.existsSync(path.join(ROOT, d))) collect(path.join(ROOT, d), files);
for (const h of ROOT_HTML) files.push(path.join(ROOT, h));

const haystack = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/images/manifest.json'), 'utf8'));

// The engine key is the manifest path minus its folder prefix and extension:
// assets/images/vfx/slash_arc.png -> vfx/slash_arc
const keys = manifest.map(r => String(r.path || '')
  .replace(/^assets\/images\//, '')
  .replace(/\.png$/, ''));
const unused = keys.filter(k => !haystack.includes(`'${k}'`) && !haystack.includes(`"${k}"`));
// A stronger signal: if the bare slug appears nowhere either, no computed key can be
// assembling this path, so the asset is very likely dead weight.
const deadSlugs = manifest.map(r => r.slug).filter(s => {
  const safe = String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !new RegExp(`\\b${safe}\\b`).test(haystack);
});

console.log(`scanned ${files.length} files against ${keys.length} manifest keys`);
console.log(`never named by a literal key: ${unused.length} (most are assembled by computed keys)`);
for (const k of unused) console.log('  ' + k);
console.log(`\nslug appears nowhere in the source at all — likely dead weight: ${deadSlugs.length}`);
for (const s of deadSlugs) console.log('  ' + s);
console.log('\nremember: props, items and biome textures are looked up by computed key');
console.log('(props/${kind}, fam.sprites[tier], textures/${biome.wall}), so the first list');
console.log('includes assets that are in use. Check data/*.json and the generator kind');
console.log('lists before deleting anything.');
