// Grid helpers + BFS over the open-cell graph. The grid is a Uint8Array of w*h:
// 1 = walkable, 0 = wall. Cell (x,y) -> index y*w + x.

export const DIRS = [
  { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }
];

export function idx(w, x, y) { return y * w + x; }
export function inBounds(level, x, y) { return x >= 0 && y >= 0 && x < level.w && y < level.h; }
export function isOpen(level, x, y) {
  return inBounds(level, x, y) && level.open[idx(level.w, x, y)] === 1;
}
export function openCount(level, x, y) {
  let n = 0;
  for (const d of DIRS) if (isOpen(level, x + d.x, y + d.y)) n++;
  return n;
}
export function neighbours(level, x, y) {
  const out = [];
  for (const d of DIRS) {
    const nx = x + d.x, ny = y + d.y;
    if (isOpen(level, nx, ny)) out.push({ x: nx, y: ny });
  }
  return out;
}

// BFS distance field from a start cell. dist === -1 means unreachable.
export function bfsField(level, sx, sy) {
  const { w, h } = level;
  const dist = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const start = idx(w, sx, sy);
  dist[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w, cy = (cur / w) | 0;
    const d = dist[cur] + 1;
    for (const nd of DIRS) {
      const nx = cx + nd.x, ny = cy + nd.y;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = idx(w, nx, ny);
      if (level.open[ni] !== 1 || dist[ni] !== -1) continue;
      dist[ni] = d;
      queue[tail++] = ni;
    }
  }
  return dist;
}

// Shortest path (cell list) from a to b using a distance field rooted at b.
export function pathTo(level, distFromB, ax, ay) {
  const path = [];
  let x = ax, y = ay, d = distFromB[idx(level.w, x, y)];
  if (d < 0) return null;
  while (true) {
    path.push({ x, y });
    if (d === 0) break;
    let moved = false;
    for (const nd of DIRS) {
      const nx = x + nd.x, ny = y + nd.y;
      if (!isOpen(level, nx, ny)) continue;
      if (distFromB[idx(level.w, nx, ny)] === d - 1) { x = nx; y = ny; d--; moved = true; break; }
    }
    if (!moved) return null;
  }
  return path;
}

export function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
