// Circle-vs-tilegrid collision with wall sliding, plus grid line-of-sight.
// Cell edges are axis-aligned AABBs, so this stays cheap enough to run for every
// entity every frame.

import { CFG } from '../config.js';
import { isOpen } from '../util/grid.js';

function blockedAt(level, wx, wz) {
  return !isOpen(level, Math.floor(wx / CFG.cell), Math.floor(wz / CFG.cell));
}

// Returns the resolved world position for a circle of `r` trying to move by (dx, dz).
// Movement is resolved per axis so the body slides along walls instead of sticking.
export function moveCircle(level, x, z, r, dx, dz, { ghost = false } = {}) {
  if (ghost) return { x: x + dx, z: z + dz };

  let nx = x + dx;
  if (hitsWall(level, nx, z, r)) nx = x;
  let nz = z + dz;
  if (hitsWall(level, nx, nz, r)) nz = z;

  if (blockedAt(level, nx, nz)) return { x, z };   // safety: never end inside a wall
  return { x: nx, z: nz };
}

function hitsWall(level, x, z, r) {
  const minX = Math.floor((x - r) / CFG.cell);
  const maxX = Math.floor((x + r) / CFG.cell);
  const minZ = Math.floor((z - r) / CFG.cell);
  const maxZ = Math.floor((z + r) / CFG.cell);
  for (let cy = minZ; cy <= maxZ; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (isOpen(level, cx, cy)) continue;
      // AABB of the wall cell
      const x0 = cx * CFG.cell, x1 = x0 + CFG.cell;
      const z0 = cy * CFG.cell, z1 = z0 + CFG.cell;
      const closestX = Math.max(x0, Math.min(x, x1));
      const closestZ = Math.max(z0, Math.min(z, z1));
      const ddx = x - closestX, ddz = z - closestZ;
      if (ddx * ddx + ddz * ddz < r * r) return true;
    }
  }
  return false;
}

// Grid line-of-sight between two world points (supercover Bresenham).
export function hasLineOfSight(level, ax, az, bx, bz) {
  const x0 = Math.floor(ax / CFG.cell), y0 = Math.floor(az / CFG.cell);
  const x1 = Math.floor(bx / CFG.cell), y1 = Math.floor(bz / CFG.cell);
  if (x0 === x1 && y0 === y1) return true;

  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  let guard = 0;
  while (guard++ < 4096) {
    if (!isOpen(level, x, y)) return false;
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return false;
}

// Clamp a world position into open space, spiralling outwards. Used on respawn and
// when spawning entities so nothing is ever placed inside geometry.
export function findOpenSpot(level, wx, wz, maxCells = 8) {
  if (!blockedAt(level, wx, wz)) return { x: wx, z: wz };
  const cx = Math.floor(wx / CFG.cell), cy = Math.floor(wz / CFG.cell);
  for (let r = 1; r <= maxCells; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isOpen(level, cx + dx, cy + dy)) {
          return { x: (cx + dx + 0.5) * CFG.cell, z: (cy + dy + 0.5) * CFG.cell };
        }
      }
    }
  }
  const e = level.entry;
  return { x: (e.x + 0.5) * CFG.cell, z: (e.y + 0.5) * CFG.cell };
}
