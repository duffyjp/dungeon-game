// Headless physics/geometry smoke test.
//   node tools/testMovement.mjs
// Covers the pieces every fight depends on: wall collision, wall sliding,
// line-of-sight, and safe respawn placement.
import { CFG } from '../src/config.js';
import { buildLevel } from '../src/world/levelGen.js';
import { moveCircle, hasLineOfSight, findOpenSpot } from '../src/world/collision.js';
import { isOpen, idx } from '../src/util/grid.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

const level = buildLevel(2, 'movement-test');

console.log('wall penetration:');
{
  // find a walkable cell adjacent to a wall, then shove hard into it
  let start = null, wallDir = null;
  for (let y = 1; y < level.h - 1 && !start; y++) {
    for (let x = 1; x < level.w - 1; x++) {
      if (!isOpen(level, x, y)) continue;
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!isOpen(level, x + d[0], y + d[1])) { start = { x, y }; wallDir = d; break; }
      }
    }
  }
  const wx = (start.x + 0.5) * CFG.cell, wz = (start.y + 0.5) * CFG.cell;
  let p = { x: wx, z: wz };
  for (let i = 0; i < 40; i++) {
    p = moveCircle(level, p.x, p.z, CFG.radius, wallDir[0] * 0.4, wallDir[1] * 0.4);
  }
  check('never ends inside a wall after 40 forced steps', isOpen(level, Math.floor(p.x / CFG.cell), Math.floor(p.z / CFG.cell)),
    `ended at cell ${Math.floor(p.x / CFG.cell)},${Math.floor(p.z / CFG.cell)}`);
  const movedCells = Math.hypot(p.x - wx, p.z - wz) / CFG.cell;
  check('did not penetrate more than a body radius', movedCells < 1.0, `travelled ${movedCells.toFixed(2)} cells into the wall`);
}

console.log('wall sliding:');
{
  // Need a cell with a wall directly "below" it and open space to the right, so a
  // push that is mostly into the wall should stop in z while still sliding in x.
  let found = null;
  for (let y = 1; y < level.h - 1 && !found; y++) {
    for (let x = 1; x < level.w - 2; x++) {
      if (isOpen(level, x, y) && !isOpen(level, x, y + 1) && isOpen(level, x + 1, y)) found = { x, y };
    }
  }
  if (found) {
    const wx = (found.x + 0.5) * CFG.cell, wz = (found.y + 0.5) * CFG.cell;
    const p = moveCircle(level, wx, wz, CFG.radius, 0.4, 1.4);   // mostly into the wall
    check('blocked in the wall axis', p.z - wz < 0.01, `dz=${(p.z - wz).toFixed(2)}`);
    check('still slides along the wall', p.x - wx > 0.39, `dx=${(p.x - wx).toFixed(2)}`);
  } else {
    check('found a slide configuration to test', false);
  }
}

console.log('line of sight:');
{
  const e = level.entry;
  const ex = (e.x + 0.5) * CFG.cell, ez = (e.y + 0.5) * CFG.cell;
  check('LOS to own cell', hasLineOfSight(level, ex, ez, ex, ez));
  // pick a cell two steps away with a wall between (a T-junction back wall)
  let blockedPair = null;
  for (let y = 1; y < level.h - 2 && !blockedPair; y++) {
    for (let x = 1; x < level.w - 2; x++) {
      if (isOpen(level, x, y) && !isOpen(level, x + 1, y) && isOpen(level, x + 2, y)) {
        blockedPair = { a: { x, y }, b: { x: x + 2, y } };
      }
    }
  }
  if (blockedPair) {
    const ax = (blockedPair.a.x + 0.5) * CFG.cell, az = (blockedPair.a.y + 0.5) * CFG.cell;
    const bx = (blockedPair.b.x + 0.5) * CFG.cell, bz = (blockedPair.b.y + 0.5) * CFG.cell;
    check('wall blocks LOS', !hasLineOfSight(level, ax, az, bx, bz));
  }
  // corridor straight ahead must be visible
  const st = level.stair;
  const sx = (st.x + 0.5) * CFG.cell, sz = (st.y + 0.5) * CFG.cell;
  const d = Math.hypot(sx - ex, sz - ez);
  check('far cells do not report LOS through walls (statistical)', d > 6);
}

console.log('placement safety:');
{
  const spot = findOpenSpot(level, 0.1, 0.1);         // corner of the map, inside a wall
  check('findOpenSpot escapes solid geometry', isOpen(level, Math.floor(spot.x / CFG.cell), Math.floor(spot.z / CFG.cell)));
  const e = level.entry;
  const spot2 = findOpenSpot(level, (e.x + 0.5) * CFG.cell, (e.y + 0.5) * CFG.cell);
  check('findOpenSpot keeps an already-open position', spot2.x === (e.x + 0.5) * CFG.cell);
}

console.log(failures ? `\n${failures} movement check(s) failed` : '\nall movement checks passed');
process.exit(failures ? 1 : 0);
