// Which assets does the game actually reach, and how much would removing the rest save?
//
//   node tools/assetAudit.mjs              report
//   node tools/assetAudit.mjs --delete     remove what is unreachable and prune the manifests
//   AUDIT_KEEP="assets/images/ui/menu_bg.png" node tools/assetAudit.mjs --delete
//
// Why this is worth a tool: Vite copies whatever the import.meta.glob patterns cover, so a
// file that no code path can name still ships to every visitor. The first version of this
// audit guessed at the naming rules and called 47 of 50 animation clips dead, which would have
// deleted the sprite animation the last two weeks of work went into. The rules below are read
// off the code that resolves keys - src/render/assets.js, src/render/animation.js,
// src/world/levelView.js, src/audio/music.js - and the suite is the backstop: a wrong verdict
// has to show up as a failing check, not as a missing texture in play.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEL = process.argv.includes('--delete');
const KEEP = new Set((process.env.AUDIT_KEEP || '').split(',').map(s => s.trim()).filter(Boolean));
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ---------------------------------------------------------------- what the game can name
// Source and data only. tools/ is deliberately excluded: the QA scripts name specific clips and
// levels, and treating that as "the game uses it" was how the first version went wrong.
const corpusDirs = ['src', 'data'];
const corpusFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name));
    else if (/\.(js|json|html|css)$/.test(e.name)) corpusFiles.push(path.join(dir, e.name));
  }
})(path.join(ROOT, 'src'));
for (const d of ['data']) (function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name));
    else if (/\.(js|json|html|css)$/.test(e.name)) corpusFiles.push(path.join(dir, e.name));
  }
})(path.join(ROOT, d));
for (const f of ['index.html', 'vite.config.js', 'styles.css']) if (fs.existsSync(path.join(ROOT, f))) corpusFiles.push(path.join(ROOT, f));
const corpus = corpusFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const namesKey = (key) => corpus.includes(`'${key}'`) || corpus.includes(`"${key}"`) || corpus.includes('`' + key + '`');
const namesWord = (word) => new RegExp(`['"\`/]${word}['"\`]`).test(corpus);

const IMAGE_ROOT = 'assets/images';
const DERIVED = ['normals', 'roughness', 'heights'];

function walkFiles(dir, re, skipDotted = false) {
  const base = path.join(ROOT, dir);
  const out = [];
  if (!fs.existsSync(base)) return out;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!(skipDotted && e.name.startsWith('_'))) walk(path.join(d, e.name)); continue; }
      if (re.test(e.name)) out.push(path.join(d, e.name));
    }
  })(base);
  return out.map(f => rel(f));
}

// ----------------------------------------------------------- animation clips, by their manifest
// animationFor(spriteKey, action) looks up `${e.sprite}|${e.action}` in
// assets/anim/manifest.json, so a clip is reachable when its sprite key is an enemy sprite the
// game names and its action is one the enemy code asks for.
const animManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/anim/manifest.json'), 'utf8'));
const animEntries = animManifest.entries || [];
const animByFile = new Map(animEntries.map(e => [e.file, e]));

// Surface textures are named by the biome table (`wall: "wall_crypt"`, a bare slug that
// levelView prefixes with textures/), by decal kinds picked in levelGen, and by literal
// 'textures/x' keys in propMeshes. Substring searching alone missed all three.
const surfaceSlugs = new Set();
for (const v of Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/biomes.json'), 'utf8')))) {
  if (v && typeof v === 'object') for (const f of ['wall', 'floor', 'ceiling']) if (v[f]) surfaceSlugs.add(v[f]);
}
for (const mm of corpus.matchAll(/textures\/([a-z0-9_]+)/gi)) surfaceSlugs.add(mm[1]);
for (const mm of corpus.matchAll(/kind:\s*[A-Za-z]+\.pick\(\[([^\]]+)\]/g)) {
  for (const q of mm[1].matchAll(/['"]([a-z0-9_]+)['"]/g)) surfaceSlugs.add(q[1]);
}

const rows = [];
function record(p, used, why) {
  const abs = path.join(ROOT, p);
  rows.push({ path: p, bytes: fs.statSync(abs).size, used, why: why || '' });
}

// images: keyed by folder/stem (assets.js builds URLS from the glob and hasAsset takes a key)
for (const p of walkFiles(IMAGE_ROOT, /\.(png|webp)$/i, true)) {
  if (p.endsWith('manifest.json')) continue;
  const rest = p.slice(IMAGE_ROOT.length + 1);
  const parts = rest.split('/');
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  const folder = parts.length > 1 ? parts[parts.length - 2] : '';
  const key = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/${stem}` : stem;

  if (DERIVED.includes(folder)) {
    // assets.js: hasAsset(`normals/${key.split('/').pop()}`) - a derived map is used exactly
    // when the surface it mirrors is used.
    const used = surfaceSlugs.has(stem);
    record(p, used, used ? `derived map for textures/${stem}` : `no surface names ${stem}`);
    continue;
  }
  if (folder === 'enemies') { record(p, namesKey(key), `enemy sprite ${key}`); continue; }
  if (folder === 'items') { record(p, namesKey(key), `item sprite ${key}`); continue; }
  if (folder === 'props') {
    // levelView.js builds `props/${p.kind}` from world generation, so the kind literal is the
    // name to look for, not the path.
    record(p, namesKey(key) || namesWord(stem), `prop kind ${stem}`);
    continue;
  }
  if (folder === 'textures') { record(p, surfaceSlugs.has(stem), `surface texture ${stem}`); continue; }
  record(p, namesKey(key), `key ${key}`);
}

// animation clips
for (const p of walkFiles('assets/anim', /\.(webp|mp4|mov)$/i)) {
  if (p.endsWith('manifest.json')) continue;
  const file = p.split('/').pop();
  const e = animByFile.get(file);
  if (!e) { record(p, false, 'not listed in assets/anim/manifest.json — the game cannot look it up'); continue; }
  const spriteNamed = namesKey(e.sprite);
  const actionUsed = namesWord(e.action);
  record(p, spriteNamed && actionUsed, `clip ${e.sprite} | ${e.action}${spriteNamed ? '' : ' (sprite not named by data)'}`);
}

// sound effects: a file only plays if an event of that name exists (the self-test already
// asserts the converse, that every event has a file)
const sfxSrc = fs.readFileSync(path.join(ROOT, 'src/audio/sfx.js'), 'utf8');
const sfxEvents = new Set();
for (const mm of sfxSrc.matchAll(/\n {2}([a-z_]+): ?\(/g)) sfxEvents.add(mm[1]);
for (const p of walkFiles('assets/audio/sfx', /\.(mp3|ogg|wav|m4a)$/i)) {
  const stem = p.split('/').pop().replace(/\.[^.]+$/, '');
  record(p, sfxEvents.has(stem), `sfx event ${stem}${sfxEvents.has(stem) ? '' : ' — no such event in src/audio/sfx.js'}`);
}

// music: music.js matches the cue to a biome by filename prefix, so the cue name never appears
// in source. Matching the prefix rule is the only correct test.
const biomes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/biomes.json'), 'utf8'));
const biomeKeys = Array.isArray(biomes.order) ? biomes.order : Object.keys(biomes).filter(k => k !== 'order');
const musicSlots = [...biomeKeys, 'boss', 'title', 'menu', 'caverns'];
for (const p of walkFiles('assets/music', /\.(mp3|ogg|wav)$/i)) {
  const stem = p.split('/').pop().replace(/\.[^.]+$/, '');
  const tag = stem.split(/[_-]/)[0].toLowerCase();
  const hit = musicSlots.some(k => tag === k.toLowerCase() || tag.startsWith(k.toLowerCase()) || k.toLowerCase().startsWith(tag));
  record(p, hit, `music cue "${stem}" -> ${hit ? 'matches a biome, boss or title slot' : 'matches no biome, boss or title slot'}`);
}

const dead = rows.filter(r => !r.used);
const sum = (a) => a.reduce((t, r) => t + r.bytes, 0);

const byDir = new Map();
for (const r of rows) {
  const d = r.path.split('/').length > 2 ? r.path.split('/').slice(0, 3).join('/') : r.path.split('/').slice(0, 2).join('/');
  const e = byDir.get(d) || { n: 0, bytes: 0, dead: 0, deadBytes: 0 };
  e.n++; e.bytes += r.bytes;
  if (!r.used) { e.dead++; e.deadBytes += r.bytes; }
  byDir.set(d, e);
}

console.log(`scanned ${rows.length} files, ${(sum(rows) / 1048576).toFixed(1)} MB inside the shipping globs`);
console.log('');
for (const [d, e] of [...byDir.entries()].sort((a, b) => b[1].deadBytes - a[1].deadBytes)) {
  console.log(`${d.padEnd(24)} ${String(e.n).padStart(4)} files ${(e.bytes / 1048576).toFixed(2).padStart(6)} MB   unreachable: ${String(e.dead).padStart(3)}   ${(e.deadBytes / 1048576).toFixed(2)} MB`);
}
console.log(`\n--- unreachable (${dead.length} files, ${(sum(dead) / 1048576).toFixed(2)} MB) ---`);
for (const r of dead.sort((a, b) => b.bytes - a.bytes)) console.log(`${(r.bytes / 1024).toFixed(0).padStart(6)} KB  ${r.path}   (${r.why})`);

const suspect = rows.filter(r => r.used && /derived map|prop kind/.test(r.why));
console.log(`\nspot check that the rules are not inventing usage: ${suspect.length} derived/prop files matched, e.g. ${suspect.slice(0, 4).map(s => s.path.split('/').pop()).join(', ')}`);

if (!DEL && process.argv.includes('--check')) {
  // Used by tools/checkBuild.mjs: unreachable assets are a regression, not a backlog.
  console.log(`\n${dead.length} unreachable files, ${(sum(dead) / 1048576).toFixed(2)} MB shipped for nothing`);
  process.exit(dead.length ? 1 : 0);
}
if (!DEL) { console.log('\nnothing removed: re-run with --delete (AUDIT_KEEP="path,..." to spare a file)'); process.exit(0); }

const removable = dead.filter(r => !KEEP.has(r.path));
for (const r of removable) fs.rmSync(path.join(ROOT, r.path));
console.log(`\ndeleted ${removable.length} files, ${(sum(removable) / 1048576).toFixed(2)} MB freed`);

// Prune provenance manifests so they cannot point at files that no longer exist - but keep the
// records. Each entry carries the prompt, seed, model and source URL, which is the recipe for
// regenerating the asset if the decision to drop it turns out to have been wrong.
const removedPath = path.join(ROOT, 'assets/images/removed.json');
const archive = fs.existsSync(removedPath) ? JSON.parse(fs.readFileSync(removedPath, 'utf8')) : [];
const imgManPath = path.join(ROOT, 'assets/images/manifest.json');
const imgMan = JSON.parse(fs.readFileSync(imgManPath, 'utf8'));
const droppedImg = imgMan.filter(e => !fs.existsSync(path.join(ROOT, e.path)));
const kept = imgMan.filter(e => fs.existsSync(path.join(ROOT, e.path)));
archive.push(...droppedImg.map(e => ({ ...e, removedAt: new Date().toISOString().slice(0, 10), removedBy: 'assetAudit' })));
fs.writeFileSync(removedPath, JSON.stringify(archive, null, 2) + '\n');
fs.writeFileSync(imgManPath, JSON.stringify(kept, null, 2) + '\n');
const animManPath = path.join(ROOT, 'assets/anim/manifest.json');
const animMan = JSON.parse(fs.readFileSync(animManPath, 'utf8'));
const keptAnim = (animMan.entries || []).filter(e => fs.existsSync(path.join(ROOT, 'assets/anim', e.file)));
const droppedAnim = (animMan.entries || []).length - keptAnim.length;
animMan.entries = keptAnim;
fs.writeFileSync(animManPath, JSON.stringify(animMan, null, 2) + '\n');
console.log(`manifests pruned: ${droppedImg.length} image entries archived to assets/images/removed.json, ${droppedAnim} animation entries`);
console.log('now rebuild and run the suite: the checks are what prove these were genuinely unused');
