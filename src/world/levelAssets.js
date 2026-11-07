// Everything a depth is going to ask for, worked out before it is drawn.
//
// The game loads textures lazily, which is convenient and terrible: the first wraith of tier 2
// downloads its sprite mid-fight, the first foundry wall downloads a 512 px tile as you round a
// corner, and every animated monster decodes its clip when it first moves. Each of those is a
// frame or ten of hitch, in the one moment the player is paying attention.
//
// So a level's needs are enumerable from the data, and they are enumerated here rather than
// discovered at draw time: biome surfaces and their derived maps, the prop kinds that were
// actually generated for this level, the enemy families the spawner is allowed to place at this
// depth and their animation clips, plus a one-time set of art that any moment could need.
import enemiesData from '../../data/enemies.json';
import { assetKeys, hasAsset } from '../render/assets.js';
import { animationFor } from '../render/animation.js';
import { tierForDepth, eligibleFamilies } from './spawner.js';

export const DERIVED_FOLDERS = ['normals', 'roughness', 'heights'];

// Props come in two flavours: a mesh that looks up `props/<kind>`, and a material that reuses a
// surface tile. levelView.js and propMeshes.js make that choice; this table has to agree with
// them, and the self-test counts any key a level draws without having listed it here.
const PROP_AS_SURFACE = new Set(['door_oak', 'pillar', 'bones', 'cobweb', 'blood_splatter', 'scorch', 'rubble', 'stone_arch']);
const SURFACE_FOR_PROP = { door_oak: 'textures/door_oak', pillar: 'textures/pillar', bones: 'textures/bone', cobweb: 'textures/cobweb', rubble: null, stone_arch: null, blood_splatter: null, scorch: null };

function surfaceKeyForProp(kind) {
  if (SURFACE_FOR_PROP[kind]) return SURFACE_FOR_PROP[kind];
  if (PROP_AS_SURFACE.has(kind)) return `textures/${kind}`;
  return `props/${kind}`;
}

function withDerived(key, out) {
  out.add(key);
  const stem = key.split('/').pop();
  for (const folder of DERIVED_FOLDERS) {
    const d = `${folder}/${stem}`;
    if (hasAsset(d)) out.add(d);
  }
}

// Surfaces the level's biome will tile: walls, floor, ceiling (the ceiling falls back to the
// wall texture when a biome has none, which is what levelView does).
export function biomeAssetKeys(biome) {
  const out = new Set();
  for (const key of [biome.wall, biome.floor, biome.ceiling || biome.wall]) {
    if (key) withDerived(`textures/${key}`, out);
  }
  return out;
}

export function propAssetKeys(level) {
  const out = new Set();
  for (const p of level.props || []) {
    const key = surfaceKeyForProp(p.kind);
    if (hasAsset(key)) withDerived(key, out);
  }
  return out;
}

// Enemy art for this depth: the families the spawner is actually allowed to place, drawn at
// this tier. The tier's own sprite, not all four - a tier 1 level never shows a tier 2 reskin.
export function enemyAssetKeys(depth) {
  const tier = tierForDepth(depth);
  const out = new Set();
  for (const { fam } of eligibleFamilies(depth)) {
    const key = fam.sprites[String(tier)] || fam.sprites['1'];
    if (key && hasAsset(key)) out.add(key);
  }
  return out;
}

// Clips for the sprites above. The game parks a standing monster on frame 0 of its walk cycle,
// so a clip is not optional decoration any more: it is the monster's normal appearance.
export function enemyClipEntries(spriteKeys) {
  const out = [];
  for (const key of spriteKeys) {
    for (const action of ['walk', 'attack', 'flee']) {
      const e = animationFor(key, action);
      if (e) out.push(e);
    }
  }
  return out;
}

// Art that can be needed at any moment in the run: every item icon and pickup sprite (the
// viewmodel and the loot pedestal), every effect, and the HUD frames. Loaded once, reused by
// every depth afterwards, and small enough that guessing wrong is not worth the complexity.
export function commonAssetKeys() {
  const out = new Set();
  for (const k of assetKeys()) {
    if (k.startsWith('items/') || k.startsWith('vfx/') || k.startsWith('ui/')) out.add(k);
  }
  return out;
}

// Effect sprites are a closed set and each one is a separate material, so each is a separate
// chance for the driver to build a shader mid-fight. Listing them lets the loader prewarm them.
export function vfxAssetKeys() {
  return assetKeys().filter(k => k.startsWith('vfx/'));
}

// The next tier's monsters are worth warming in the background: at three depths per tier the
// first level of a new band is exactly where a cold download hurts most, and waiting for a
// quiet moment keeps that download off the moment of descent.
export function nextTierAssetKeys(depth) {
  if (tierForDepth(depth) >= 4) return new Set();
  const next = new Set();
  const tier = tierForDepth(depth) + 1;
  for (const fam of enemiesData.families) {
    const key = fam.sprites[String(tier)];
    if (key && hasAsset(key) && !fam.sprites[String(tierForDepth(depth))]) next.add(key);
    if (key && hasAsset(key) && depth + 3 >= (fam.fromDepth || 1)) next.add(key);
  }
  return next;
}
