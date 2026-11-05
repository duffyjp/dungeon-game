// In-browser integration self-test, driven by ?selftest=1.
// It exercises the real update loop (not mocks): level build, spawns, melee,
// armour math, auto-equip, salvage, descent, and death. Results are written into
// the DOM so a headless browser run can read them.

import { CFG } from './config.js';

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
