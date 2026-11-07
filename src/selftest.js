// In-browser integration self-test, driven by ?selftest=1.
// It exercises the real update loop (not mocks): level build, spawns, melee,
// armour math, auto-equip, salvage, descent, and death. Results are written into
// the DOM so a headless browser run can read them.

import * as THREE from 'three';
import { CFG } from './config.js';
import enemiesData from '../data/enemies.json';
import biomeData from '../data/biomes.json';
import { makeProp } from './world/propMeshes.js';
import { wallMount, textureHasAlpha } from './world/levelView.js';
import { mapWindow } from './ui/minimap.js';
import { isOpen } from './util/grid.js';
import { rollDrops, spawnLevelLoot } from './world/spawner.js';
import { hasAsset, hasRealAlpha, hasNormalFor, hasRoughnessFor, hasHeightFor, getMirroredNormalTexture, getTexture } from './render/assets.js';
import { animationFor, loadFrames, animationSupported, animationDiagnostic, bodyRectFor } from './render/animation.js';
import { sfxEventNames, sfxFileNames } from './audio/sfx.js';
import { trackList as musicTrackList } from './audio/music.js';
import { AUDIO_CREDIT_HTML } from './ui/menus.js';

export async function runSelfTest(game) {
  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push(`${cond ? 'OK' : 'FAIL'} :: ${name}${extra ? ` [${extra}]` : ''}`);
    return cond;
  };
  const step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) game.update(dt); };

  try {
    game.startRun('selftest', 1);
    step(3);

    ok('level built', Boolean(game.level && game.levelView));
    ok('level passes solvability contract', game.level.dist[game.level.stair.y * game.level.w + game.level.stair.x] >= 0,
      `path=${game.level.dist[game.level.stair.y * game.level.w + game.level.stair.x]}`);
    ok('enemies spawned', game.enemies.length > 0, `${game.enemies.length}`);
    ok('starting weapon equipped', game.player.weapon?.id === 'sword_worn', `${game.player.weapon?.label}`);
    ok('no starting armour', game.player.armor === null);

    // --- melee hits an enemy in front of the player
    const e = game.stagePreviewEnemy('orc', 1, 1.5);
    if (!e) ok('staged a test enemy', false);
    game.input.yaw = Math.atan2(e.x - game.player.x, e.z - game.player.z);
    step(2);
    const hp0 = e.hp;
    game.player.attackCd = 0;
    game.attack();
    ok('melee damages an enemy', e.hp < hp0, `${hp0} -> ${e.hp}`);

    // --- kill it and confirm drops appear
    e.hp = 1;
    game.player.attackCd = 0;
    game.attack();
    step(2);
    ok('enemy death produces loot', game.pickups.length > 0, `${game.pickups.length} pickups`);

    // --- two weapon slots: a bow fills its own slot and never steals the blade
    const bladeBefore = game.player.melee;
    const bowDef = game.items.items.find(i => i.id === 'bow_hunting');
    const bowInst = { def: bowDef, id: bowDef.id, slot: 'weapon', sprite: bowDef.sprite, damage: 40, score: 44, tierIndex: 3, color: '#f5a524', label: 'Test Bow', jitter: 1, quality: 1 };
    game.makePickup(bowInst, game.player.x, game.player.z);
    step(2);
    ok('a bow fills the ranged slot without displacing the blade',
      game.player.ranged?.id === 'bow_hunting' && game.player.melee === bladeBefore,
      `ranged=${game.player.ranged?.id} melee=${game.player.melee?.id}`);

    // --- the ranged slot is gated on ammunition, not on owning a bow
    ok('a bow with no arrows cannot be selected',
      game.selectWeaponSlot('ranged') === false && game.player.weaponKind === 'melee',
      `in hand=${game.player.weaponKind}`);
    game.player.arrows = 3;
    ok('with arrows the bow can be drawn',
      game.selectWeaponSlot('ranged') === true && game.player.weaponKind === 'ranged');

    // --- firing spends an arrow and looses a real arrow, not a placeholder
    const arrows0 = game.player.arrows;
    game.player.attackCd = 0;
    game.attack();
    step(1);
    const mine = game.projectiles.filter(p => p.arrow && !p.hostile);
    ok('a shot spends one arrow and flies a real arrow sprite',
      game.player.arrows === arrows0 - 1 && mine.length > 0 && mine[0].assetKey === 'items/arrow',
      `arrows=${game.player.arrows} arrow projectiles=${mine.length} sprite=${mine[0]?.assetKey}`);

    while (game.player.arrows > 0) { game.player.attackCd = 0; game.attack(); step(1); }
    ok('running dry hands the blade back over', game.player.weaponKind === 'melee', `in hand=${game.player.weaponKind}`);
    ok('an empty quiver keeps the ranged slot locked',
      game.selectWeaponSlot('ranged') === false && game.player.canUse('ranged') === false);

    // --- enemy arrows fly at the player (they used to inherit the player's own facing)
    game.player.health = game.player.maxHealth;
    game.player.invuln = 99;
    // The staging helper refuses a wall, so try a few ranges and turns until the archer
    // lands on open floor instead of inside the maze.
    const yaw0 = game.input.yaw;
    let arch = null;
    for (const [d, turn] of [[5, 0], [4, 0], [3, 0], [5, Math.PI / 2], [5, -Math.PI / 2], [4, Math.PI]]) {
      game.input.yaw = yaw0 + turn;
      arch = game.stagePreviewEnemy('archer', 1, d);
      if (arch) break;
    }
    game.input.yaw = yaw0;
    if (!arch) ok('staged an archer', false);
    else {
      const px = game.player.x, pz = game.player.z;
      const d0 = Math.hypot(arch.x - px, arch.z - pz);
      arch.landAttack();
      const shot = game.projectiles[game.projectiles.length - 1];
      step(4);
      const d1 = shot ? Math.hypot(shot.x - px, shot.z - pz) : Infinity;
      ok('an archer shot travels toward the player', Boolean(shot && shot.hostile) && d1 < d0,
        `${d0.toFixed(1)}m -> ${Number.isFinite(d1) ? d1.toFixed(1) + 'm' : 'removed'}`);
      ok('an enemy archer looses an actual arrow', Boolean(shot && shot.arrow && shot.assetKey === 'items/arrow'),
        shot ? shot.assetKey : 'no projectile');
    }

    // --- archers hand over 1-3 arrows when they die, and picking them up refills the quiver
    if (arch) {
      const before = game.player.arrows;
      const drops = rollDrops(game, arch, game.rng);
      const ammo = drops.filter(d => d.item && d.item.slot === 'ammo');
      const n = ammo.reduce((s, d) => s + (d.item.count || 0), 0);
      ok('an archer drops between 1 and 3 arrows', ammo.length === 1 && n >= 1 && n <= 3,
        `${n} arrows across ${ammo.length} drop(s)`);
      ammo.forEach(d => game.onPickup(d));
      ok('arrows go to the quiver instead of becoming gear',
        game.player.arrows === before + n && game.player.ranged?.id === 'bow_hunting',
        `${before} -> ${game.player.arrows}`);
    }

    // --- a treasure pedestal bow comes with a working quiver, so the first bow of a run
    // is a usable weapon and not a promise you have to survive an archer to cash in
    {
      const real = game.makePickup;
      let found = null;
      try {
        game.makePickup = (item, x, z) => ({ item, x, z });
        for (let i = 0; i < 60 && !found; i++) {
          const loot = spawnLevelLoot(game, game.level, game.rng, game.depth);
          const bow = loot.find(p => p.item.def.attack && p.item.def.attack.kind === 'ranged');
          if (bow) found = { bow, loot };
        }
      } finally {
        game.makePickup = real;
      }
      ok('a pedestal bow turns up in the loot tables', Boolean(found),
        found ? 'rolled one within 60 alcove passes' : 'no bow in 60 alcove rolls');
      if (found) {
        const quiver = found.loot.find(p => p.item.slot === 'ammo');
        const gap = quiver ? Math.hypot(quiver.x - found.bow.x, quiver.z - found.bow.z) : Infinity;
        ok('a pedestal bow sits beside 5 arrows',
          Boolean(quiver) && quiver.item.count === CFG.arrowsWithTreasureBow && gap < CFG.cell,
          quiver ? `${quiver.item.count} arrows, ${gap.toFixed(1)} m away` : 'no quiver beside it');
      }
    }

    // --- the playtest cheat: while paused, L then digits jumps the run to that depth
    game.pause();
    for (const code of ['KeyL', 'Digit1', 'Digit0']) game.input.onKey({ code }, true);
    step(3);
    ok('L 1 0 on the pause screen drops the run into depth 10',
      game.depth === 10 && game.state === 'playing' && Boolean(game.level),
      `depth=${game.depth} state=${game.state}`);
    ok('a cheated depth is a real generated level',
      game.level.dist[game.level.stair.y * game.level.w + game.level.stair.x] >= 0,
      `path=${game.level.dist[game.level.stair.y * game.level.w + game.level.stair.x]}`);
    ok('a single pair with a leading zero works too (L 0 5)',
      game.cheatToDepth('05') && game.depth === 5, `depth=${game.depth}`);

    // --- alpha art skips the chroma keyer. A generator that returns RGBA (Qwen-Image-2.1)
    // needs no matte, and the keyer would be actively harmful to it: it samples the border,
    // finds transparency, and keys into the subject.
    {
      const opaque = document.createElement('canvas'); opaque.width = opaque.height = 64;
      const og = opaque.getContext('2d'); og.fillStyle = '#ff00ff'; og.fillRect(0, 0, 64, 64);
      const soft = document.createElement('canvas'); soft.width = soft.height = 64;
      const sg = soft.getContext('2d');
      sg.fillStyle = 'rgba(220,230,240,0.55)'; sg.beginPath(); sg.arc(32, 32, 22, 0, Math.PI * 2); sg.fill();
      ok('an opaque chroma-keyed sprite is still recognised as keyed', hasRealAlpha(opaque, og) === false);
      ok('a sprite with genuine soft transparency is recognised as alpha art', hasRealAlpha(soft, sg) === true);
    }

    // --- damage maths: no armour means full damage to health
    const h0 = game.player.health;
    game.player.invuln = 0;
    game.damagePlayer(25, null);
    ok('unarmoured damage hits health fully', Math.abs((h0 - game.player.health) - 25) < 1.5, `-${(h0 - game.player.health).toFixed(1)}`);

    // --- equipping armour soaks part of the hit
    const armorDef = game.items.items.find(i => i.id === 'armor_chain');
    const armorInst = { def: armorDef, id: armorDef.id, slot: 'armor', sprite: armorDef.sprite, maxDurability: 100, durability: 100, mitigation: 0.27, score: 100, tierIndex: 2, color: '#fff', label: 'Chainmail' };
    game.equip(armorInst);
    const h1 = game.player.health, a1 = game.player.armor.durability;
    game.player.invuln = 0;
    game.damagePlayer(20, null);
    const hpLoss = h1 - game.player.health;
    const armorLoss = a1 - game.player.armor.durability;
    ok('armour mitigates damage', hpLoss < 20 * 0.9, `hp -${hpLoss.toFixed(1)}, armour -${armorLoss.toFixed(1)}`);
    ok('armour bar takes damage', armorLoss > 5, `-${armorLoss.toFixed(1)}`);

    // --- auto-equip on contact for a better weapon, salvage for a worse one
    const goodSword = { def: game.items.items.find(i => i.id === 'sword_great'), id: 'sword_great', slot: 'weapon', sprite: 'items/sword_great', damage: 300, score: 320, tierIndex: 4, color: '#c084fc', label: 'Masterwork Greatsword', jitter: 1, quality: 1 };
    game.makePickup(goodSword, game.player.x, game.player.z);
    step(2);
    ok('walking over better gear auto-equips it', game.player.weapon?.id === 'sword_great', `${game.player.weapon?.label}`);

    const scoreBefore = game.score;
    const junk = { def: game.items.items.find(i => i.id === 'sword_worn'), id: 'sword_worn', slot: 'weapon', sprite: 'items/sword_worn', damage: 5, score: 5, tierIndex: 0, color: '#9aa0a6', label: 'Worn Short Sword', jitter: 1, quality: 1 };
    game.makePickup(junk, game.player.x, game.player.z);
    step(2);
    ok('worse gear is salvaged, not equipped', game.player.weapon?.id === 'sword_great' && game.score > scoreBefore,
      `weapon=${game.player.weapon?.id} score ${scoreBefore} -> ${game.score}`);

    // --- health pickup heals
    const hpBefore = game.player.health;
    game.makePickup({ def: { name: 'Health Draught' }, id: 'potion_health', slot: 'instant', sprite: 'items/potion_health', heal: 30, score: 30, label: 'Health Draught', color: '#4fd18b' }, game.player.x, game.player.z);
    step(2);
    ok('health pickup heals', game.player.health > hpBefore, `${hpBefore.toFixed(0)} -> ${game.player.health.toFixed(0)}`);

    // --- extra life pickup
    const lives0 = game.player.lives;
    game.makePickup({ def: { name: 'Charm' }, id: 'extra_life', slot: 'instant', sprite: 'items/item_extra_life', lives: 1, score: 5, label: 'Charm', color: '#f5a524' }, game.player.x, game.player.z);
    step(2);
    ok('ghost drop grants a life', game.player.lives === lives0 + 1, `${lives0} -> ${game.player.lives}`);

    // --- staircase descent
    const stair = game.levelView.stairWorld;
    game.player.x = stair.x; game.player.z = stair.z;
    const depth0 = game.depth;
    step(120, 1 / 60);              // 2 s of standing on the stairs
    ok('standing on the staircase descends', game.depth === depth0 + 1, `depth ${depth0} -> ${game.depth}`);
    ok('new level rebuilt after descent', Boolean(game.level && game.levelView) && game.enemies.length > 0, `${game.enemies.length} enemies`);

    // --- movement direction must agree with where the camera is actually pointing.
    // Real key events drive it (the input layer re-samples held keys every frame, so
    // poking its flags would just be overwritten), the level grid is temporarily
    // opened so a wall cannot distort the measured vector, and the expected axis comes
    // from the live camera rather than from player.js's own math.
    {
      const lvl = game.level;
      const saved = lvl.open.slice();
      lvl.open.fill(1);                       // 1 = walkable, so nothing blocks the probe
      const press = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      const cases = [
        ['KeyD', 1], ['ArrowRight', 1], ['KeyA', -1], ['ArrowLeft', -1],
        ['KeyW', 1], ['ArrowUp', 1], ['KeyS', -1], ['ArrowDown', -1]
      ];
      const cx = (lvl.w / 2) * CFG.cell, cz = (lvl.h / 2) * CFG.cell;
      const bad = [];
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        game.input.setYaw(yaw);
        for (const [code, want] of cases) {
          const strafe = /D$|A$|Right|Left/.test(code);
          game.player.x = cx; game.player.z = cz;
          const x0 = game.player.x, z0 = game.player.z;
          press(code, true);
          step(8, 1 / 60);
          press(code, false);
          const dx = game.player.x - x0, dz = game.player.z - z0;
          const camYaw = game.camera.rotation.y;      // ground truth: what the player sees
          const ax = strafe ? Math.cos(camYaw) : -Math.sin(camYaw);
          const az = strafe ? -Math.sin(camYaw) : -Math.cos(camYaw);
          const dot = (dx * ax + dz * az) * want;
          const moved = Math.hypot(dx, dz);
          if (moved < 0.05 || dot <= 0) {
            bad.push(`${code}@${Math.round(yaw * 180 / Math.PI)}deg moved=${moved.toFixed(2)} align=${dot.toFixed(2)}`);
          }
        }
      }
      lvl.open.set(saved, 0);
      ok('WASD and arrows move the way the camera points', bad.length === 0, bad.join('; '));
    }

    // --- art wiring. A prop kind that resolves to neither geometry nor a generated asset
    // draws the engine's placeholder noise, which in play looks like a grey blob sitting
    // in a corridor — that is exactly how `rubble` and `cobweb` behaved, so the mapping
    // from generator kinds to art is asserted rather than eyeballed.
    {
      const fakeBiome = { wall: 'wall_crypt', accent: '#7fa8ff' };
      const kinds = ['crate', 'barrel', 'bones', 'cobweb', 'chain_hanging', 'rubble', 'door_oak', 'stone_arch', 'pillar'];
      const broken = kinds.filter(k => {
        if (k === 'pillar') return false;                     // carved column, own builder
        if (makeProp(k, fakeBiome, { x: 2, y: 3 })) return false;   // real geometry
        return !hasAsset(k === 'door_oak' ? 'textures/door_oak' : `props/${k}`);
      });
      ok('every prop kind has geometry or generated art', broken.length === 0, broken.join(','));
    }

    // --- torches must hang on a wall face. They used to be dropped at the centre of the
    // cell, which put a lit sconce floating in mid-air in the middle of a corridor.
    {
      const torches = game.levelView ? game.levelView.torches : [];
      const lvl = game.level;
      const solidAt = (cx, cy) => (cx < 0 || cy < 0 || cx >= lvl.w || cy >= lvl.h) ? 0 : lvl.open[cy * lvl.w + cx];
      const floating = torches.filter(t => {
        const d = t.userData.mount;
        if (!d) return true;
        const cx = Math.floor(t.position.x / CFG.cell), cy = Math.floor(t.position.z / CFG.cell);
        return solidAt(cx + d.x, cy + d.z) === 1;      // pointing at open space, not a wall
      });
      ok('torches are mounted on wall faces', torches.length > 0 && floating.length === 0,
        `torches=${torches.length} floating=${floating.length}`);
    }

    // --- silhouette ramp. The generated art separates tiers by bulk and damage, but if the
    // renderer draws every tier at one family height — a tier-1 wisp and a tier-4 shade both
    // 1.8 m — the corridor never tells you which one is the lesser threat.
    {
      const bad = [];
      for (const f of enemiesData.families) {
        const hs = f.heightByTier;
        if (!Array.isArray(hs) || hs.length !== 4) { bad.push(`${f.id}: no ramp`); continue; }
        if (!(hs[0] < hs[3])) bad.push(`${f.id}: tier 1 not smaller than tier 4`);
        const tallest = f.height * Math.max(...hs);
        if (tallest > CFG.wallH * 0.75) bad.push(`${f.id}: ${tallest.toFixed(2)} m in a ${CFG.wallH} m hall`);
      }
      ok('enemies ramp their silhouette by tier', bad.length === 0, bad.join('; '));
    }

    // --- generated art must be reachable. `vfx/slime_splat` and `vfx/ghost_trail` sat in
    // the manifest for a long time with nothing drawing them, so a slime died by shrinking
    // and a ghost left no trace of having passed. Each is now wired to a family.
    {
      const wired = new Set();
      for (const f of enemiesData.families) {
        if (f.splat) wired.add(f.splat);
        if (f.trail) wired.add(f.trail);
      }
      const missing = ['vfx/slime_splat', 'vfx/ghost_trail'].filter(k => !wired.has(k) || !hasAsset(k));
      ok('splat and trail effects are wired and present', missing.length === 0, missing.join(','));
    }

    // --- death costs a life, zero lives ends the run
    const lives1 = game.player.lives;
    game.player.invuln = 0;
    game.damagePlayer(9999, null);
    ok('death costs a life', game.player.lives === lives1 - 1 && game.state === 'playing', `lives=${game.player.lives} state=${game.state}`);

    // Drain whatever lives remain (the earlier ghost drop may have added one).
    let guard = 0;
    while (game.state === 'playing' && guard++ < 12) {
      game.player.invuln = 0;
      game.damagePlayer(9999, null);
    }
    ok('running out of lives ends the run', game.state === 'gameover' && game.player.lives <= 0,
      `lives=${game.player.lives} state=${game.state} after ${guard} deaths`);
    ok('game over screen shown', document.querySelector('.menu-card .dead') !== null);

    // --- seeded runs are reproducible
    const a = game.buildSeedSnapshot('repro');
    const b = game.buildSeedSnapshot('repro');
    ok('same seed reproduces the same layout', a === b, a === b ? a : 'mismatch');

    // ---- sprite animation (spec 13.8) ------------------------------------
    // A clip that exists on disk proves nothing about the game; what matters is that the
    // frames can be named, that they still have transparency once decoded, and that a
    // walking creature actually changes frame while a standing one does not.
    const animKey = 'enemies/t1/cellar_spider';
    const entry = animationFor(animKey, 'walk');
    ok('an animated clip is registered for a tier-1 enemy', Boolean(entry),
      entry ? `${entry.frames} frames (boomerang of ${entry.uniqueFrames}), ${Math.round(entry.bytes / 1024)} KB` : 'none found');

    // Every species in the data should have a cycle, not just the one that happens to be on
    // screen. Reading the roster rather than a hand-listed key is what turns "the spider
    // animates" into "all enemies animate", and it catches a tier quietly missing from a build.
    const roster = [...new Set((() => {
      const all = [];
      for (const fam of enemiesData.families) for (const key of Object.values(fam.sprites || {})) all.push(key);
      return all;
    })())];
    // 24 sprite slots across the families but 23 distinct drawings: the spider family's
    // tier-4 slot reuses the tier-3 art, which is exactly the kind of thing a count without a
    // Set would report as a missing animation.
    const noWalk = roster.filter(k => !animationFor(k, 'walk'));
    ok('every enemy in the data has a walk cycle', noWalk.length === 0,
      `${roster.length - noWalk.length}/${roster.length} distinct sprites animated` +
      (noWalk.length ? ` — missing: ${noWalk.join(', ')}` : ''));
    const withFlee = roster.filter(k => animationFor(k, 'flee'));
    ok('flee cycles exist only where the AI can retreat', withFlee.length === 3,
      `${withFlee.length} flee cycles — spiders back off in the AI, nothing else runs`);

    // ---- environment surfaces --------------------------------------------
    // Bump mapping has one failure mode that "does it load" cannot see: mirroring a normal
    // map must negate the direction channels, or the relief points the wrong way at every
    // seam and the wall appears to change shape as the player walks past it. So the composite
    // is sampled and the sign flip is asserted.
    // Every surface the biomes reference ships a normal map, so a missing one is a shipping
    // mistake rather than a rollout in progress. The keys come from the biome data, not a
    // hand-written list, so adding a biome cannot slip past this check.
    const surfaceKeys = [...new Set(Object.values(biomeData).flatMap(b => [b.wall, b.floor, b.ceiling].filter(Boolean)).map(k => `textures/${k}`))];
    const missingNormals = surfaceKeys.filter(k => !hasNormalFor(k));
    ok('every biome surface ships a normal map', missingNormals.length === 0,
      `${surfaceKeys.length - missingNormals.length}/${surfaceKeys.length} surfaces paired${missingNormals.length ? ` — missing: ${missingNormals.join(', ')}` : ''}`);
    const missingRough = surfaceKeys.filter(k => !hasRoughnessFor(k));
    ok('every biome surface ships a roughness map', missingRough.length === 0,
      `${surfaceKeys.length - missingRough.length}/${surfaceKeys.length} paired${missingRough.length ? ` — missing: ${missingRough.join(', ')}` : ''}`);
    const missingHeights = surfaceKeys.filter(k => !hasHeightFor(k));
    ok('every biome wall surface ships a height map for displacement', missingHeights.length === 0,
      `${surfaceKeys.length - missingHeights.length}/${surfaceKeys.length} paired${missingHeights.length ? ` — missing: ${missingHeights.join(', ')}` : ''}`);

    // Displacement is geometry, so the honest guard is the vertex/triangle cost of the real
    // scene, read from the renderer rather than estimated in a comment.
    if (game.renderer) {
      game.renderer.render(game.scene, game.camera);
      const info = game.renderer.info.render;
      ok('displacement keeps the live scene inside a sane triangle budget',
        info.triangles < 1500000,
        `${info.triangles.toLocaleString()} triangles, ${info.calls} draw calls, ${CFG.displacementSegments} subdivisions per wall face`);
    }
    const wm2 = game.levelView && game.levelView.wallMesh && game.levelView.wallMesh.material;
    ok('the wall material carries both a normal map and a roughness map',
      Boolean(wm2 && wm2.normalMap && wm2.roughnessMap),
      wm2 ? `normal ${Boolean(wm2.normalMap)} roughness ${Boolean(wm2.roughnessMap)}` : 'no wall material found');

    // ---- props and interface ---------------------------------------------
    // Cobwebs are mounted to the room now, so a web with no wall to mount to is a placement
    // bug rather than a taste question; and a floor decal is only allowed to keep the radial
    // mask while its art is still an opaque square.
    const webProps = ((game.level && game.level.props) || []).filter(p => p.kind === 'cobweb');
    const unmountable = webProps.filter(p => !wallMount(game.level, p.x, p.y));
    ok('every cobweb has a wall to hang from', unmountable.length === 0,
      `${webProps.length} cobwebs in this level${unmountable.length ? ` — ${unmountable.length} have no wall within two cells` : ''}`);
    const decalKeys = ['blood_splatter', 'scorch'];
    const stillOpaque = decalKeys.filter(k => !textureHasAlpha(getTexture(`textures/${k}`).image));
    ok('floor decals carry their own silhouette', stillOpaque.length === 0,
      decalKeys.join(', ') + (stillOpaque.length ? ` — still needs the radial mask: ${stillOpaque.join(', ')}` : ''));
    ok('a bone surface tile exists for the 3D bone piles', hasAsset('textures/bone'),
      hasAsset('textures/bone') ? 'textures/bone, with derived normal and roughness' : 'no textures/bone in the registry');

    const win = mapWindow(game.level, game.player.x, game.player.z, game.minimap.size);
    ok('the minimap window follows the player on a level big enough to scroll',
      win.follow && Math.abs(game.player.x / CFG.cell - (win.ox + win.view / 2)) < 1e-9,
      `level ${game.level.w}x${game.level.h}, view ${win.view} cells, window at ${win.ox.toFixed(1)},${win.oy.toFixed(1)}`);
    ok('fullscreen is exposed on the game', typeof game.toggleFullscreen === 'function');

    // The cobweb fix has to be checked geometrically: a screenshot only proves it looked
    // mounted by luck of the camera. Each web group's sheets are offset toward the wall it
    // was hung on, so the sum of its child positions must point at a solid neighbour cell.
    const meshes = (game.levelView && game.levelView.propMeshes) || [];
    const webs = meshes.filter(m => m.userData && m.userData.propKind === 'cobweb');
    let notHugging = 0;
    for (const w of webs) {
      let cx = 0, cz = 0;
      w.traverse(o => { if (o !== w && o.isMesh) { cx += o.position.x; cz += o.position.z; } });
      const gx = Math.floor(w.position.x / CFG.cell), gy = Math.floor(w.position.z / CFG.cell);
      const sx = Math.sign(cx), sy = Math.sign(cz);
      const solidNeighbour = !isOpen(game.level, gx + sx, gy) || !isOpen(game.level, gx, gy + sy);
      if (!solidNeighbour) notHugging++;
    }
    ok('every cobweb leans against a solid face', webs.length > 0 && notHugging === 0,
      `${webs.length} webs in this level, ${notHugging} not against a wall`);
    const chains = meshes.filter(m => m.userData && m.userData.propKind === 'chain_hanging');
    let boneParts = 0;
    for (const c of chains) {
      c.traverse(o => {
        if (o.isMesh && o.material && o.material.color && Math.abs(o.material.color.getHex() - 0xd9d2bf) < 4) boneParts++;
      });
    }
    ok('a hanging chain ends in a skull, not a bare rod',
      chains.length === 0 || boneParts >= chains.length,
      `${chains.length} chains in this level, ${boneParts} bone-coloured parts on them`);

    // ---- sound bank -------------------------------------------------------
    // The synthesised recipes stay as a fallback, which is exactly why this needs a check:
    // a missing generated clip plays the placeholder and sounds merely thin rather than
    // broken, so it would survive every other test in the suite.
    const sfxEvents = sfxEventNames();
    const sfxFiles = new Set(sfxFileNames());
    const stillSynth = sfxEvents.filter(n => !sfxFiles.has(n));
    ok('every sound event has a generated clip', stillSynth.length === 0,
      `${sfxEvents.length - stillSynth.length}/${sfxEvents.length} events have a file` +
      (stillSynth.length ? ` — still synthesised: ${stillSynth.join(', ')}` : ''));
    const strays = [...sfxFiles].filter(f => !sfxEvents.includes(f));
    ok('no shipped sound file is unreferenced by an event', strays.length === 0,
      strays.length ? strays.join(', ') : `${sfxFiles.size} files, every one named by an event`);

    // ---- soundtrack --------------------------------------------------------
    // music.js picks by filename prefix, so a biome with no matching cue silently gets the
    // wrong mood two thirds of the way down. That is a naming failure and it can be checked.
    const cues = musicTrackList();
    const cueMatches = (n, key) => {
      const tag = String(n).split(/[_-]/)[0].toLowerCase();
      const k = String(key).toLowerCase();
      return tag === k || tag.startsWith(k) || k.startsWith(tag);
    };
    const biomeKeys = Array.isArray(biomeData.order) ? biomeData.order : Object.keys(biomeData).filter(k => k !== 'order');
    const uncovered = biomeKeys.filter(k => !cues.some(t => cueMatches(t, k)));
    ok('every biome has a cue of its own', cues.length > 0 && uncovered.length === 0,
      `${cues.length} cues (${cues.join(', ')})${uncovered.length ? ` — no cue for: ${uncovered.join(', ')}` : ''}`);
    ok('a boss cue and a title cue exist', cues.some(t => cueMatches(t, 'boss')) && cues.some(t => cueMatches(t, 'title')),
      cues.join(', '));
    ok('the audio credit names the models and says the content is machine-generated',
      /ACE-Step/.test(AUDIO_CREDIT_HTML) && /Stable Audio/.test(AUDIO_CREDIT_HTML) && /machine-generated/i.test(AUDIO_CREDIT_HTML),
      AUDIO_CREDIT_HTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

    // "Is bump mapping active?" has two parts, and only the second is interesting. The
    // texture has to be bound to the live material — not a placeholder that happens to be
    // the right type — and turning it up has to change the pixels the player is actually
    // shown. Both are measured against the running scene's own framebuffer, because a number
    // from a purpose-built test page is not evidence about the game.
    if (wm2 && wm2.normalMap && !game.placeholderArt) {
      const gl = game.renderer.getContext();
      const buf = game.renderer.domElement;
      const w = buf.width, h = buf.height;
      const grab = () => {
        game.renderer.render(game.scene, game.camera);
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
      const saved = wm2.normalScale.x;
      const shipped = grab();
      wm2.normalScale.set(0, 0);
      const off = grab();
      wm2.normalScale.set(8, 8);
      const maxed = grab();
      wm2.normalScale.set(saved, saved);
      let dMax = 0, dShip = 0, n = 0;
      for (let i = 0; i < shipped.length; i += 4) {
        dMax += Math.abs(lum(off, i) - lum(maxed, i));
        dShip += Math.abs(lum(shipped, i) - lum(off, i));
        n++;
      }
      ok('the bound normal map is real art, not a placeholder',
        Boolean(wm2.normalMap.image && wm2.normalMap.image.width >= 1024),
        `${wm2.normalMap.image && wm2.normalMap.image.width}px composite, colorSpace ${wm2.normalMap.colorSpace}`);
      // Asserts activity, not visibility: a bound real texture whose strength moves the
      // framebuffer at all is wired correctly. Whether the effect is big enough to notice is
      // a separate, reported number — the shipped strength moves a few hundredths of a
      // percent, which is why it reads as absent, and the honest thing is to print that
      // rather than to set the bar where the assertion would fail.
      // Logged on every run, not only on failure: this number is the standing answer to "is
      // bump mapping doing anything", and it should be in the log rather than re-derived by
      // hand whenever someone doubts it.
      console.info(`[bump] live game, wall ${game.biome && game.biome.wall}: ` +
        `strength 0 vs 8 moves ${(dMax / n / 255 * 100).toFixed(2)}% of the frame, ` +
        `shipped ${saved} vs off moves ${(dShip / n / 255 * 100).toFixed(2)}%`);
      ok('raising bump to 8 moves the live framebuffer',
        (dMax / n / 255 * 100) > 0.05,
        `wall ${game.biome && game.biome.wall}: bump 0 vs 8 moves ${(dMax / n / 255 * 100).toFixed(2)}% of the frame; ` +
        `shipped strength ${saved} vs off moves ${(dShip / n / 255 * 100).toFixed(2)}%`);
    }
    if (hasNormalFor('textures/wall_crypt')) {
      const cv = getMirroredNormalTexture('textures/wall_crypt').image;
      const g2 = cv.getContext('2d', { willReadFrequently: true });
      const s = cv.width / 2;
      const px = (x, y) => { const d = g2.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
      // The invariant mirroring has to deliver is continuity across the seam: the two texels
      // either side of the boundary describe the same surface point seen from opposite sides,
      // so the direction channel must negate and the other must agree. Sampling an arbitrary
      // pair proves nothing; picking a texel where the slope is actually strong is what makes
      // the assertion capable of failing.
      const seamPair = (axis) => {
        for (let k = 0; k < s; k += 3) {
          const a = axis === 'x' ? px(s - 1, k) : px(k, s - 1);
          const b = axis === 'x' ? px(s, k) : px(k, s);
          const strong = axis === 'x' ? Math.abs(a[0] - 128) : Math.abs(a[1] - 128);
          if (strong > 22) return { a, b, strong };
        }
        return null;
      };
      // how far the pair departs from what continuity requires: the negated channel must
      // match 255-value, the other must match itself
      const err = (pair, axis) => {
        if (!pair) return { neg: 999, same: 999 };
        const { a, b } = pair;
        return axis === 'x'
          ? { neg: Math.abs(b[0] - (255 - a[0])), same: Math.abs(b[1] - a[1]) }
          : { neg: Math.abs(b[1] - (255 - a[1])), same: Math.abs(b[0] - a[0]) };
      };
      const hx = seamPair('x'), ex = err(hx, 'x');
      ok('normals stay continuous across the vertical seam (red negates)',
        Boolean(hx) && ex.neg <= 6 && ex.same <= 4,
        hx ? `rgb(${hx.a}) next to rgb(${hx.b}), slope ${hx.strong}, error ${ex.neg}/${ex.same}`
          : 'no strongly sloped texel on the seam');
      const vy = seamPair('y'), ey = err(vy, 'y');
      ok('normals stay continuous across the horizontal seam (green negates)',
        Boolean(vy) && ey.neg <= 6 && ey.same <= 4,
        vy ? `rgb(${vy.a}) next to rgb(${vy.b}), slope ${vy.strong}, error ${ey.neg}/${ey.same}`
          : 'no strongly sloped texel on the seam');
      ok('the normal map is linear data, not colour-managed',
        getMirroredNormalTexture('textures/wall_crypt').colorSpace === THREE.NoColorSpace,
        `colorSpace ${getMirroredNormalTexture('textures/wall_crypt').colorSpace}`);
    }
    const wm = game.levelView && game.levelView.wallMesh && game.levelView.wallMesh.material;
    const wantNormal = wm && Boolean(wm.normalMap) === hasNormalFor(`textures/${(game.biome && game.biome.wall) || ''}`);
    ok('a surface without a normal map is built exactly as before', Boolean(wantNormal),
      `biome wall ${(game.biome && game.biome.wall)} hasNormal=${hasNormalFor(`textures/${game.biome && game.biome.wall}`)} materialHasNormal=${Boolean(wm && wm.normalMap)}`);

    // Decode a sample across the tiers, not just the one sprite: a corrupt or mis-encoded
    // file at tier 4 should fail here rather than show up as a motionless monster three
    // screens deep into a run.
    const sample = ['enemies/t2/grave_spider', 'enemies/t3/void_archmage', 'enemies/t4/iron_reaver'];
    let sampledOk = 0, sampledDetail = [];
    for (const key of sample) {
      const sEntry = animationFor(key, 'walk');
      if (!sEntry) { sampledDetail.push(`${key.split('/').pop()}=no clip`); continue; }
      const sTex = await loadFrames(sEntry);
      if (sTex && sTex.length === sEntry.frames) sampledOk++;
      else sampledDetail.push(`${key.split('/').pop()}=${sTex ? sTex.length : 'decode failed'}/${sEntry.frames}`);
    }
    ok('a sampled clip from each of tiers 2-4 decodes fully', sampledOk === sample.length,
      `${sampledOk}/${sample.length} decoded` + (sampledDetail.length ? ` — ${sampledDetail.join(', ')}` : ''));

    if (entry) {
      ok('this browser can decode animated frames', animationSupported(),
        animationSupported() ? 'ImageDecoder present' : 'no WebCodecs: billboards stay static by design');
      const tex = await loadFrames(entry);
      ok('the animated WebP decodes into the expected frames', Array.isArray(tex) && tex.length === entry.frames,
        tex ? `${tex.length} frames` : `no frames — ${animationDiagnostic()}`);
      if (tex && tex.length) {
        const grab = (t) => {
          const c = document.createElement('canvas'); c.width = t.userData.w; c.height = t.userData.h;
          c.getContext('2d', { willReadFrequently: true }).drawImage(t.image, 0, 0);
          return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        };
        const d0 = grab(tex[0]), dn = grab(tex[Math.min(8, tex.length - 1)]);
        let clear = 0, solid = 0, diff = 0;
        for (let i = 0; i < d0.length; i += 4) {
          const a = d0[i + 3];
          if (a < 40) clear++; else if (a >= 216) solid++;
          if (Math.abs(a - dn[i + 3]) + Math.abs(d0[i] - dn[i]) > 24) diff++;
        }
        const n = d0.length / 4;
        ok('decoded frames keep real transparency',
          (100 * clear / n) > 5 && (100 * solid / n) > 5,
          `${(100 * clear / n).toFixed(1)}% clear, ${(100 * solid / n).toFixed(1)}% opaque`);
        ok('frame 0 and frame 8 are different pictures', (100 * diff / n) > 1,
          `${(100 * diff / n).toFixed(1)}% of pixels differ`);

        const spider = game.enemies.find(e => e.spriteKey === animKey) || game.enemies[0];
        if (spider) {
          // ---- the size-pop regression -------------------------------------
          // A clip cell is a tight crop around the moving silhouette; the still sprite is a
          // padded square. Drawn onto one fixed quad, the animated creature came out about
          // 25% bigger than the same monster standing still, so it jumped size whenever its
          // action changed. This measures the subject in both images and the quad each is
          // drawn with, and requires the on-screen silhouette to agree.
          const subjectBox = (data, W, H) => {
            let x0 = W, y0 = H, x1 = -1, y1 = -1;
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
              if (data[(y * W + x) * 4 + 3] < 40) continue;
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            return x1 < 0 ? null : { w: x1 - x0 + 1, h: y1 - y0 + 1 };
          };
          // Pair the clip and the still from the *same* creature: the sample clip above belongs
          // to whatever the animation section picked, which is not necessarily an enemy that
          // spawned on this level.
          const pair = game.enemies.find(e => animationFor(e.spriteKey, 'walk')) || spider;
          const pEntry = pair && animationFor(pair.spriteKey, 'walk');
          const pFrames = pEntry ? await loadFrames(pEntry) : null;
          const still = pair && pair.baseMap;
          const sw = still && still.image ? (still.image.naturalWidth || still.image.width) : 0;
          const sh = still && still.image ? (still.image.naturalHeight || still.image.height) : 0;
          if (sw && sh && pFrames && pFrames.length) {
            const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
            sc.getContext('2d', { willReadFrequently: true }).drawImage(still.image, 0, 0);
            const sd = sc.getContext('2d').getImageData(0, 0, sw, sh).data;
            const fc = pFrames[0];
            const clipData = grab(fc);
            const clipBox = subjectBox(clipData, fc.userData.w, fc.userData.h);
            const stillBox = subjectBox(sd, sw, sh);
            const rect = bodyRectFor(pEntry, pair.baseQuad[0], pair.baseQuad[1]);
            if (clipBox && stillBox && rect) {
              const stillM = pair.baseQuad[1] * (stillBox.h / sh);
              const clipM = rect.h * (clipBox.h / fc.userData.h);
              ok('an animated monster is the same size as the standing one',
                Math.abs(clipM / stillM - 1) < 0.10,
                `${(100 * (clipM / stillM - 1)).toFixed(0)} % change, ${(pair.spriteKey || '').split('/').pop()} walk clip`);
            } else {
              ok('an animated monster is the same size as the standing one', false,
                `anchor data missing for ${pEntry.file}`);
            }
          }
          // ---- a standing monster is not a different drawing --------------
          // The idle pose used to fall back to the generated still sprite, a separate
          // illustration of the same creature, so stopping in the middle of a corridor turned
          // an orc into a PNG. The walk clip's first frame is parked instead.
          pair.tickAnimation(0, 0);
          const parkedFromClip = pair.body.material.map !== pair.baseMap && pair.body.geometry !== pair.baseGeom;
          ok('a standing monster is drawn from the animation, not the still sprite', parkedFromClip,
            `${(pair.spriteKey || '').split('/').pop()} standing: ` +
            `${pair.body.material.map === pair.baseMap ? 'still PNG' : 'clip frame 0'}, ` +
            `${pair.body.geometry === pair.baseGeom ? 'base quad' : 'clip quad'}`);

          spider.anim.clips.set('walk', { entry, frames: tex });
          spider.anim.idx = -1; spider.anim.action = null; spider.anim.t = 0;
          spider.tickAnimation(0.09, 0.6);
          const first = spider.anim.idx;
          spider.tickAnimation(0.09, 0.6);
          ok('a creature covering ground advances frames',
            spider.anim.idx !== first && spider.anim.action === 'walk',
            `frame ${first} -> ${spider.anim.idx} while ${spider.anim.action}`);
          // Standing no longer swaps to a different illustration: the walk clip's first frame
          // is parked, so the source never changes under the player's eyes.
          spider.tickAnimation(0.016, 0);
          ok('a creature standing still parks on a clip frame instead of changing art',
            spider.anim.action === null && spider.anim.idx === 0 && spider.body.material.map !== spider.baseMap,
            spider.body.material.map === spider.baseMap ? 'fell back to the still sprite' : `parked on frame ${spider.anim.idx}, same source file as walking`);

          // The cycle chosen has to follow what the creature is doing, not merely whether it
          // is moving — otherwise an attack and a walk are the same animation.
          const tell0 = spider.tell, retreat0 = spider.retreatUntil;
          spider.tell = 0.2;
          spider.tickAnimation(0.09, 0.6);
          ok('a striking creature selects the attack cycle', spider.anim.action === 'attack',
            `action ${spider.anim.action}`);
          spider.tell = 0;
          spider.retreatUntil = (game.time || 0) + 1;
          spider.tickAnimation(0.09, 0.6);
          ok('a backing-off creature selects the flee cycle', spider.anim.action === 'flee',
            `action ${spider.anim.action}`);
          spider.tell = tell0; spider.retreatUntil = retreat0;
        }
      }
    }
  } catch (err) {
    results.push(`FAIL :: self-test threw :: ${err.message}`);
    results.push(`      ${String(err.stack).split('\n').slice(1, 4).join(' | ')}`);
  }

  const pass = results.filter(r => r.startsWith('OK')).length;
  const fail = results.filter(r => r.startsWith('FAIL')).length;
  const pre = document.createElement('pre');
  pre.id = 'selftest-results';
  pre.textContent = `SELFTEST ${pass} passed / ${fail} failed\n` + results.join('\n');
  // Rendered on top of the game so a headless screenshot can read the verdict.
  Object.assign(pre.style, {
    position: 'fixed', left: '8px', top: '8px', zIndex: '9999', margin: '0',
    padding: '10px 14px', background: 'rgba(6,8,10,0.92)', color: '#e6e8ea',
    font: '12px/1.45 ui-monospace, monospace', border: `1px solid ${fail ? '#e5484d' : '#46a37c'}`,
    maxHeight: '96vh', overflow: 'auto'
  });
  document.body.appendChild(pre);
  document.title = `SELFTEST ${pass}/${pass + fail}`;
  // Machine-readable copy for the headless harness (tools/runSelfTest.mjs reads these
  // out of the browser's console log, which is more reliable than --dump-dom here).
  for (const r of results) console.log(`SELFTEST| ${r}`);
  console.log(`SELFTEST| SUMMARY ${pass} passed / ${fail} failed`);

  // When driven by tools/runSelfTest.mjs the page posts its verdict to a dev-server
  // endpoint, which is far more reliable than scraping the browser's console output.
  try {
    await fetch('/__selftest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pass, fail, results })
    });
  } catch {
    /* normal play, no harness listening */
  }
  return { pass, fail, results };
}
