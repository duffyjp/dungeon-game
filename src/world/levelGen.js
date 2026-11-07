// Procedural level generation (spec §9).
// Output: a tile grid where 1 = walkable, 0 = wall, plus entry/stair/pin placement.
// Guarantee (spec §9.1) is enforced by buildLevel() looping until validateLevel() passes.

import { CFG } from '../config.js';
import { Rng } from '../util/rng.js';
import { DIRS, bfsField, idx, isOpen, neighbours, chebyshev, openCount } from '../util/grid.js';

const BANDS = [
  { band: 0, biomes: ['crypt'] },
  { band: 1, biomes: ['foundry'] },
  { band: 2, biomes: ['cavern'] },
  { band: 3, biomes: ['vault'] }
];

export function bandFor(depth) { return Math.min(3, Math.floor((depth - 1) / 3)); }
export function tierFor(depth) { return Math.min(4, 1 + Math.floor((depth - 1) / 3)); }
// Which biome a depth sits in. Exported so the preloader can warm the next band's art before
// the player descends into it, instead of restating the band table somewhere else.
export function biomeForDepth(depth) { return BANDS[Math.min(bandFor(depth), BANDS.length - 1)].biomes[0]; }
export function sizeFor(depth) {
  const band = bandFor(depth);
  return CFG.sizes[Math.min(CFG.sizes.length - 1, band)];
}

function makeGrid(w, h) {
  return { w, h, open: new Uint8Array(w * h) };
}

function setOpen(level, x, y, v) {
  if (x < 0 || y < 0 || x >= level.w || y >= level.h) return;
  level.open[idx(level.w, x, y)] = v ? 1 : 0;
}

function carveRecursive(level, rng) {
  // Recursive backtracker over odd-coordinate cells; even rows/cols stay as walls
  // until carved between, producing a perfect maze (100% connected by construction).
  const stack = [{ x: 1, y: 1 }];
  setOpen(level, 1, 1, true);
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const opts = [];
    for (const d of DIRS) {
      const nx = cur.x + d.x * 2, ny = cur.y + d.y * 2;
      if (nx <= 0 || ny <= 0 || nx >= level.w - 1 || ny >= level.h - 1) continue;
      if (level.open[idx(level.w, nx, ny)] === 1) continue;
      opts.push({ nx, ny, mx: cur.x + d.x, my: cur.y + d.y });
    }
    if (!opts.length) { stack.pop(); continue; }
    const c = opts[rng.weighted(opts.map(() => 1))];
    setOpen(level, c.mx, c.my, true);
    setOpen(level, c.nx, c.ny, true);
    stack.push({ x: c.nx, y: c.ny });
  }
}

function braid(level, rng, amount) {
  // Open a fraction of dead ends so the maze has loops. Loop-free mazes make
  // line-of-sight enemies (archers, mages) feel unfair and claustrophobic.
  const ends = [];
  for (let y = 1; y < level.h - 1; y++) {
    for (let x = 1; x < level.w - 1; x++) {
      if (!isOpen(level, x, y)) continue;
      if (openCount(level, x, y) === 1) ends.push({ x, y });
    }
  }
  const wanted = Math.round(ends.length * amount);
  let done = 0;
  rng.shuffle(ends);
  for (const e of ends) {
    if (done >= wanted) break;
    const walls = DIRS
      .map(d => ({ x: e.x + d.x, y: e.y + d.y }))
      .filter(p => p.x > 0 && p.y > 0 && p.x < level.w - 1 && p.y < level.h - 1 && !isOpen(level, p.x, p.y));
    if (!walls.length) continue;
    const hit = walls[rng.weighted(walls.map(() => 1))];
    setOpen(level, hit.x, hit.y, true);
    done++;
  }
}

function carveRooms(level, rng, count) {
  const rooms = [];
  let guard = 0;
  while (rooms.length < count && guard++ < 200) {
    const rw = rng.int(3, 7) * 2 + 1;   // 5..15 tiles
    const rh = rng.int(3, 7) * 2 + 1;
    const x0 = rng.int(1, level.w - rw - 1);
    const y0 = rng.int(1, level.h - rh - 1);
    let clash = false;
    for (const r of rooms) {
      if (x0 < r.x1 + 2 && x0 + rw > r.x0 - 2 && y0 < r.y1 + 2 && y0 + rh > r.y0 - 2) { clash = true; break; }
    }
    if (clash) continue;
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) setOpen(level, x, y, true);
    rooms.push({ x0, y0, x1: x0 + rw - 1, y1: y0 + rh - 1 });
  }
  return rooms;
}

function placePillars(level, rng, rooms) {
  const props = [];
  for (const r of rooms) {
    if (rng.chance(0.55)) {
      const x = rng.int(r.x0 + 1, r.x1 - 1), y = rng.int(r.y0 + 1, r.y1 - 1);
      if (isOpen(level, x, y)) { setOpen(level, x, y, false); props.push({ x, y, kind: 'pillar' }); }
    }
  }
  return props;
}

function placeDecor(level, rng, props) {
  // Keep the descent and the spawn clear. With billboard props this was invisible —
  // cutouts are transparent, so a door parked on the staircase just looked like scenery
  // until the props became solid geometry and physically stood on top of the way down.
  const cellKey = (x, y) => y * level.w + x;
  const blocked = new Set([cellKey(level.entry.x, level.entry.y), cellKey(level.stair.x, level.stair.y)]);
  for (const d of DIRS) blocked.add(cellKey(level.stair.x + d.x, level.stair.y + d.y));

  const cells = [];
  for (let y = 1; y < level.h - 1; y++) {
    for (let x = 1; x < level.w - 1; x++) {
      if (isOpen(level, x, y) && !blocked.has(cellKey(x, y))) cells.push({ x, y });
    }
  }
  const picked = rng.shuffle(cells).slice(0, Math.min(26, cells.length));
  for (const c of picked) {
    const kind = rng.pick(['crate', 'barrel', 'bones', 'cobweb', 'chain_hanging', 'rubble', 'door_oak', 'stone_arch']);
    props.push({ x: c.x, y: c.y, kind });
  }
  // Floor decals: blood and scorch tell the player where a fight happened.
  const decalCells = rng.shuffle(cells).slice(0, Math.min(14, Math.floor(cells.length / 10)));
  for (const c of decalCells) {
    props.push({ x: c.x, y: c.y, kind: rng.pick(['blood_splatter', 'scorch']), decal: true });
  }
  // Torches: sparse, on wall-adjacent cells. Only the nearest N are lit (§16).
  const wallAdj = cells.filter(c => DIRS.some(d => !isOpen(level, c.x + d.x, c.y + d.y)));
  const torches = rng.shuffle(wallAdj).slice(0, Math.min(CFG.maxTorches, Math.floor(cells.length / 14)));
  return { torches };
}

function deadEnds(level) {
  const out = [];
  for (let y = 1; y < level.h - 1; y++) {
    for (let x = 1; x < level.w - 1; x++) {
      if (isOpen(level, x, y) && openCount(level, x, y) === 1) out.push({ x, y });
    }
  }
  return out;
}

function pickEntry(level, rng) {
  // Entry sits in a corner quadrant, preferring a cell with few open neighbours.
  const quadrants = [[1, 1], [level.w - 2, 1], [1, level.h - 2], [level.w - 2, level.h - 2]];
  const q = quadrants[rng.weighted(quadrants.map(() => 1))];
  let best = null, bestScore = Infinity;
  for (let y = 1; y < level.h - 1; y++) {
    for (let x = 1; x < level.w - 1; x++) {
      if (!isOpen(level, x, y)) continue;
      const d = Math.abs(x - q[0]) + Math.abs(y - q[1]);
      if (d > 8) continue;
      const score = d + openCount(level, x, y) * 3;
      if (score < bestScore) { bestScore = score; best = { x, y }; }
    }
  }
  return best || { x: 1, y: 1 };
}

export function generateLevel(depth, seed, rng) {
  const size = sizeFor(depth);
  const level = makeGrid(size, size);
  carveRecursive(level, rng);
  const band = bandFor(depth);
  braid(level, rng, Math.min(CFG.braidCap, CFG.braidBase + CFG.braidPerBand * band));
  const rooms = carveRooms(level, rng, rng.int(CFG.roomsMin, CFG.roomsMax));
  const props = placePillars(level, rng, rooms);
  for (const p of props) p.decal = false;

  level.entry = pickEntry(level, rng);
  const dist = bfsField(level, level.entry.x, level.entry.y);

  // Staircase = farthest reachable cell, so the level is always solvable and never
  // a corridor you can walk straight down.
  let stair = null, best = -1;
  for (let y = 1; y < level.h - 1; y++) {
    for (let x = 1; x < level.w - 1; x++) {
      const i = idx(level.w, x, y);
      if (level.open[i] === 1 && dist[i] > best) { best = dist[i]; stair = { x, y }; }
    }
  }
  if (!stair) stair = { x: level.w - 2, y: level.h - 2 };
  level.stair = stair;
  level.dist = dist;
  level.pathLen = dist[idx(level.w, stair.x, stair.y)];

  const diameter = (() => {
    let m = 0;
    for (let i = 0; i < dist.length; i++) if (dist[i] > m) m = dist[i];
    return m;
  })();
  level.diameter = diameter;

  const { torches } = placeDecor(level, rng, props);
  level.torches = torches;
  level.props = props;

  // Loot alcoves: guaranteed drops in dead ends, gives the maze a reason to explore.
  const ends = deadEnds(level).filter(e => chebyshev(e, level.entry) > 4 && chebyshev(e, level.stair) > 3);
  const alcoveCount = rng.int(CFG.lootAlcoves[0], CFG.lootAlcoves[1]);
  level.alcoves = rng.shuffle(ends).slice(0, alcoveCount);

  // Spawn candidates: far enough from the player, not on the stairs.
  const spawnable = [];
  for (let y = 1; y < level.h - 1; y++) {
    for (let x = 1; x < level.w - 1; x++) {
      const i = idx(level.w, x, y);
      if (level.open[i] !== 1) continue;
      const d = dist[i];
      if (d < CFG.spawnDistMin || d > CFG.spawnDistMax) continue;
      if (x === stair.x && y === stair.y) continue;
      spawnable.push({ x, y, d });
    }
  }
  level.spawnable = rng.shuffle(spawnable);
  level.biome = BANDS[band].biomes[0];
  level.band = band;
  level.depth = depth;
  level.seed = seed;
  return level;
}

export function buildLevel(depth, runSeed, attempts = CFG.maxGenAttempts) {
  let last = null;
  for (let a = 0; a < attempts; a++) {
    const seed = `${runSeed}:${depth}:${a}`;
    const rng = new Rng(seed);
    const lvl = generateLevel(depth, seed, rng);
    last = lvl;
    const { ok } = validateLevel(lvl);
    if (ok) return lvl;
  }
  return last;   // callers must surface this: validateLevel().ok tells them why
}

export function validateLevel(level) {
  const problems = [];
  const { w, h } = level;
  const entry = level.entry, stair = level.stair;
  if (!isOpen(level, entry.x, entry.y)) problems.push('entry not walkable');
  if (!isOpen(level, stair.x, stair.y)) problems.push('stair not walkable');

  // §9.1 (1) staircase reachable from entry
  const d = level.dist || bfsField(level, entry.x, entry.y);
  const stairDist = d[idx(w, stair.x, stair.y)];
  if (stairDist < 0) problems.push('stair unreachable from entry');
  // §9.1 (2) must actually be a maze, not a hallway
  if (stairDist >= 0 && level.diameter > 0 && stairDist < 0.55 * level.diameter) {
    problems.push(`shortest path ${stairDist} < 0.55 x diameter ${level.diameter}`);
  }
  // §9.1 (3) every enemy and pickup is reachable
  for (const s of level.spawnable || []) if (d[idx(w, s.x, s.y)] < 0) { problems.push('unreachable spawn cell'); break; }
  for (const a of level.alcoves || []) if (d[idx(w, a.x, a.y)] < 0) { problems.push('unreachable alcove'); break; }
  // §9.1 (4) entry and stairs well separated
  if (stairDist >= 0 && stairDist < 6) problems.push(`entry/stairs too close (${stairDist})`);
  // §9.1 (5) no fully enclosed walkable cell
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!isOpen(level, x, y)) continue;
      if (DIRS.every(dir => !isOpen(level, x + dir.x, y + dir.y))) {
        if (!(x === entry.x && y === entry.y) && !(x === stair.x && y === stair.y)) {
          problems.push(`enclosed cell at ${x},${y}`);
          y = h; break;
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, stairDist, diameter: level.diameter };
}

export { chebyshev, isOpen, neighbours };
