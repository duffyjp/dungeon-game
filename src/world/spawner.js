// Enemy and loot placement for a level (spec §6 spawn rules, §8.1 drop table).

import enemiesData from '../../data/enemies.json';
import itemsData from '../../data/items.json';
import { CFG } from '../config.js';
import { chebyshev, isOpen } from '../util/grid.js';
import { Enemy } from '../entity/enemy.js';
import { makeItem } from '../loot/quality.js';

export function tierForDepth(depth) {
  return Math.min(4, 1 + Math.floor((depth - 1) / 3));
}

export function bandForDepth(depth) {
  return Math.min(3, Math.floor((depth - 1) / 3));
}

// Exported because the preloader has to ask the same question the spawner does: which families
// may appear at this depth. Duplicating the rule would let the two drift, and a level that
// spawns something unprepared hitches exactly as badly as one with no preloading at all.
export function eligibleFamilies(depth) {
  const band = bandForDepth(depth);
  return enemiesData.families
    .filter(f => depth >= f.fromDepth)
    .map(f => ({ fam: f, w: f.weight[band] || 0 }))
    .filter(e => e.w > 0);
}

export function spawnLevelEnemies(game, level, rng, depth) {
  const count = Math.min(CFG.enemyMax, Math.round(CFG.enemyBase + CFG.enemyPerDepth * depth));
  const tier = tierForDepth(depth);
  const placed = [{ x: level.entry.x, y: level.entry.y }];
  const out = [];
  let stairGuardUsed = 0;

  const pool = eligibleFamilies(depth);
  const weights = pool.map(e => e.w);

  for (const cell of level.spawnable) {
    if (out.length >= count) break;
    const nearStair = chebyshev(cell, level.stair) <= 3;
    if (cell.x === level.stair.x && cell.y === level.stair.y) continue;
    if (nearStair) {
      if (stairGuardUsed >= CFG.stairGuard) continue;   // never on the staircase
      stairGuardUsed++;
    }
    let tooClose = false;
    for (const p of placed) {
      if (chebyshev(cell, p) < CFG.spawnSeparation) { tooClose = true; break; }
    }
    if (tooClose) continue;

    const entry = pool[rng.weighted(weights)];
    const e = new Enemy(game, { ...entry.fam, tierMult: enemiesData.tierMult }, tier, cell);
    placed.push(cell);
    out.push(e);
    game.scene.add(e.group);
  }

  // Miniboss every 3rd depth (spec §17.7): a depth spike so bands do not blur together.
  if (depth % 3 === 0 && level.spawnable.length) {
    const bossable = pool.filter(e => e.fam.id === 'orc' || e.fam.id === 'mage');
    const pick = (bossable.length ? bossable : pool)[rng.weighted((bossable.length ? bossable : pool).map(() => 1))];
    const cell = level.spawnable.find(c => chebyshev(c, level.stair) > 4 && chebyshev(c, level.entry) > 6)
      || level.spawnable[0];
    const boss = new Enemy(game, { ...pick.fam, tierMult: enemiesData.tierMult }, tier, cell, {
      boss: true, hpScale: 4
    });
    out.push(boss);
    game.scene.add(boss.group);
    game.toast(`Something large is awake: ${boss.name}`, '#f5a524');
  }

  return out;
}

// Loot alcoves: guaranteed gear in dead ends, so exploring the maze pays.
export function spawnLevelLoot(game, level, rng, depth) {
  const out = [];
  const gearIds = itemsData.items.filter(i => i.slot === 'weapon' || i.slot === 'armor').map(i => i.id);
  for (const a of level.alcoves) {
    const defId = rng.pick(gearIds);
    const def = itemsData.items.find(i => i.id === defId);
    const item = makeItem(def, depth, rng);
    const cx = (a.x + 0.5) * CFG.cell, cz = (a.y + 0.5) * CFG.cell;
    const p = game.makePickup(item, cx, cz, { pedestal: true });
    if (p) out.push(p);
    // A treasure bow sits beside a quiver. Without it the first bow of a run is a dead
    // pickup: you would have to survive long enough to meet an archer before the find paid.
    if (p && def.attack && def.attack.kind === 'ranged') {
      const arrowDef = itemsData.items.find(i => i.slot === 'ammo');
      if (arrowDef) {
        const ammo = makeItem(arrowDef, depth, rng);
        ammo.count = CFG.arrowsWithTreasureBow;
        ammo.label = `${arrowDef.name} x${ammo.count}`;
        ammo.score = ammo.count * 2;
        const quiver = game.makePickup(ammo, cx + CFG.cell * 0.3, cz + CFG.cell * 0.3);
        if (quiver) out.push(quiver);
      }
    }
  }
  return out;
}

// Drop roll for a killed enemy (§8.1). Bosses get a guaranteed boosted drop.
export function rollDrops(game, enemy, rng) {
  const depth = game.depth;
  const fam = enemy.fam;
  const out = [];
  for (const d of fam.drops || []) {
    const chance = d.chance * (enemy.isBoss ? 1.6 : 1);
    if (!rng.chance(chance)) continue;
    const def = itemsData.items.find(i => i.id === d.item);
    if (!def) continue;
    const bonus = enemy.isBoss ? 2 : 0;
    out.push(game.makePickup(makeItem(def, depth, rng, bonus), enemy.x, enemy.z));
  }
  // Archers carry ammunition, and always hand it over: that is what keeps the bow a
  // resource you spend rather than a free upgrade. A boss archer carries a bundle.
  if (fam.ammo) {
    const def = itemsData.items.find(i => i.id === fam.ammo.item);
    if (def) {
      const n = rng.int(fam.ammo.min, fam.ammo.max) + (enemy.isBoss ? 3 : 0);
      const inst = makeItem(def, depth, rng);
      inst.count = n;
      inst.label = n > 1 ? `${def.name} x${n}` : def.name;
      inst.score = n * 2;
      out.push(game.makePickup(inst, enemy.x, enemy.z));
    }
  }

  if (!out.length) {
    const coin = itemsData.items.find(i => i.id === 'coin');
    out.push(game.makePickup(makeItem(coin, depth, rng), enemy.x, enemy.z));
  }
  return out;
}

export { enemiesData, itemsData };
