// Queue a whole phase of animation clips — strictly one generation in flight.
//
//   node tools/animBatch.mjs                       tier-1 families, walk/attack/flee
//   node tools/animBatch.mjs --actions walk        every tier-1 sprite, one action
//   node tools/animBatch.mjs --tiers t1,t2 --force
//
// The video box has one card and the 14B model fills it, so parallelism here buys nothing
// and costs failed runs. This driver is deliberately a serial for-loop that shells out to
// tools/animClip.mjs: the sequencing is the point, and keeping the child process separate
// means one clip crashing cannot take the queue down with it.
//
// Clips already ACCEPTED are skipped unless --force, so an interrupted phase resumes where
// it stopped. Rejected clips are retried, because a rejection is usually one unlucky seed.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const TIERS = (arg('tiers', 't1')).split(',').map(s => s.trim()).filter(Boolean);
const ACTIONS = (arg('actions', 'walk,attack,flee')).split(',').map(s => s.trim()).filter(Boolean);
const FORCE = process.argv.includes('--force');
const LIMIT = Number(arg('limit', 0));
// Seeds advance per clip; see the loop. 44500-44511 are the clips already on disk.
const SEED_BASE = Number(arg('seed', 44520));

const FAMILIES = {
  slime: ['slime', 'acid_slime', 'caustic_ooze', 'void_slime'],
  orc: ['orc_grunt', 'orc_brute', 'orc_warlord', 'iron_reaver'],
  archer: ['goblin_archer', 'bone_archer', 'venom_archer', 'hollow_ranger'],
  mage: ['hedge_mage', 'storm_mage', 'void_archmage', 'doomspeaker'],
  ghost: ['wisp', 'wraith', 'dread_spectre', 'hungering_shade'],
  spider: ['cellar_spider', 'grave_spider', 'bone_spider']
};

const jobs = [];
for (const tier of TIERS) {
  const i = ['t1', 't2', 't3', 't4'].indexOf(tier);
  if (i < 0) { console.error(`unknown tier ${tier}`); process.exit(2); }
  for (const [, names] of Object.entries(FAMILIES)) {
    if (!names[i]) continue;
    for (const a of ACTIONS) jobs.push({ sprite: `enemies/${tier}/${names[i]}`, action: a });
  }
}
if (LIMIT > 0) jobs.length = LIMIT;

// Read the record the clips themselves maintain, rather than a progress file that can
// disagree with it — but only trust the parts of it that are still on disk. An index entry
// whose folder has been deleted is not a finished clip, and skipping it would silently leave
// a hole in the phase.
const listPath = path.join(ROOT, 'experiments', 'anim', 'list.json');
const done = fs.existsSync(listPath) ? JSON.parse(fs.readFileSync(listPath, 'utf8')) : [];
const stillThere = e => fs.existsSync(path.join(ROOT, 'experiments', 'anim', e.id, 'frames'));
const accepted = new Set(done.filter(e => e.verdict === 'ACCEPTED' && stillThere(e)).map(e => e.id));

console.log(`phase: ${TIERS.join(',')} × ${ACTIONS.join(',')} = ${jobs.length} clip(s), one at a time`);
const queue = jobs.filter(j => FORCE || !accepted.has(`${path.basename(j.sprite)}__${j.action}`));
if (queue.length !== jobs.length) console.log(`skipping ${jobs.length - queue.length} already accepted`);

const results = [];
const startedAll = Date.now();
for (let i = 0; i < queue.length; i++) {
  const j = queue[i];
  // A seed per clip, not one seed for the phase. With a shared seed a retry reproduces the
  // exact clip that already failed, which makes "run it again" meaningless; distinct seeds
  // mean a rejection is one unlucky draw rather than a verdict on the sprite.
  const seed = SEED_BASE + i;
  console.log(`\n=== ${i + 1}/${queue.length}  ${j.sprite}  ${j.action}  seed ${seed} ===`);
  const t0 = Date.now();
  let ok = false, out = '';
  try {
    out = execFileSync(process.execPath,
      [path.join(ROOT, 'tools', 'animClip.mjs'), '--sprite', j.sprite, '--action', j.action, '--seed', String(seed)],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    ok = true;
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  // Echo only the decision lines; the per-frame table is in results.json for anyone who
  // wants it, and 18 of them in this console would bury the summary.
  for (const line of out.split(/\r?\n/)) {
    if (/^(sprite|backdrop|sampling|queued|generated in|ffmpeg split|ACCEPTED|REJECTED|  FAIL|  WARNING|got |note:)/.test(line.trim())) {
      console.log(line.replace(/^/, '  '));
    }
  }
  results.push({ id: `${path.basename(j.sprite)}__${j.action}`, ok, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`  -> ${ok ? 'accepted' : 'rejected'} in ${results.at(-1).seconds}s`);
}

console.log('\nphase summary');
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.id}  ${r.seconds}s`);
const passed = results.filter(r => r.ok).length;
console.log(`${passed}/${results.length} accepted   total ${Math.round((Date.now() - startedAll) / 60000)} min`);
console.log('review: npm run qa:anim — nothing reached assets/images; promotion is a separate, deliberate step');
process.exit(passed === results.length ? 0 : 1);
