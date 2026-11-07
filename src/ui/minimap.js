// Minimap: canvas-drawn from the grid. Explored cells only, staircase revealed once
// seen (or by stair-sense at depth >= 5). Enemy pips only when actually visible.

import { CFG } from '../config.js';
import { idx } from '../util/grid.js';

// The visible window of the map, as a function so it can be asserted rather than inferred
// from pixels. Follow mode is off when the whole level already fits the view.
export function mapWindow(level, px, pz, size, cfg = CFG) {
  const span = Math.max(level.w, level.h);
  const follow = Boolean(cfg.mapFollow) && span > cfg.mapViewCells;
  const view = follow ? cfg.mapViewCells : span;
  return {
    follow,
    view,
    pxPerCell: size / view,
    ox: follow ? px / cfg.cell - view / 2 : 0,
    oy: follow ? pz / cfg.cell - view / 2 : 0
  };
}

export class Minimap {
  constructor(root, size = 180) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.canvas.className = 'minimap';
    this.g = this.canvas.getContext('2d');
    root.appendChild(this.canvas);
  }

  attach(level) {
    this.level = level;
    this.explored = new Uint8Array(level.w * level.h);
    this.stairSeen = false;
  }

  // reveal cells around the player; this is what "explored" means
  reveal(px, pz, radius = 5.5) {
    const { level } = this;
    const cx = Math.floor(px / CFG.cell), cy = Math.floor(pz / CFG.cell);
    const r = Math.ceil(radius);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= level.w || y >= level.h) continue;
        if (Math.hypot(x - cx, y - cy) > radius) continue;
        this.explored[idx(level.w, x, y)] = 1;
      }
    }
    const si = idx(level.w, level.stair.x, level.stair.y);
    if (this.explored[si]) this.stairSeen = true;
  }

  draw(player, enemies, biome, stairSense) {
    const { level, g, size } = this;
    // Follow mode: the map is a window that travels with the player, instead of the whole
    // level shrunk to fit and a marker crawling around it. Cells are drawn at a fixed,
    // readable size and only the visible range is touched, so a 33x33 level costs the same
    // per frame as a 9x9 one. North stays up: rotating the map under the player would fight
    // the compass read the stair sense and enemy pips are meant to give.
    const win = mapWindow(level, player.x, player.z, size);
    const follow = win.follow;
    const cell = win.pxPerCell;
    const ox = win.ox, oy = win.oy;
    const X = (gx) => (gx - ox) * cell;
    const Y = (gy) => (gy - oy) * cell;
    const x0 = Math.max(0, Math.floor(ox) - 1), x1 = Math.min(level.w - 1, Math.ceil(ox + win.view) + 1);
    const y0 = Math.max(0, Math.floor(oy) - 1), y1 = Math.min(level.h - 1, Math.ceil(oy + win.view) + 1);

    g.clearRect(0, 0, size, size);
    g.fillStyle = 'rgba(8,10,13,0.72)';
    g.fillRect(0, 0, size, size);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = idx(level.w, x, y);
        if (!this.explored[i]) continue;
        g.fillStyle = level.open[i] ? 'rgba(150,162,178,0.55)' : 'rgba(20,24,30,0.9)';
        g.fillRect(X(x), Y(y), cell + 0.6, cell + 0.6);
      }
    }

    const si = idx(level.w, level.stair.x, level.stair.y);
    if (this.stairSeen || stairSense) {
      g.fillStyle = stairSense && !this.stairSeen ? 'rgba(245,165,36,0.45)' : '#f5a524';
      g.fillRect(X(level.stair.x), Y(level.stair.y), cell + 0.6, cell + 0.6);
    }

    for (const e of enemies) {
      if (!e.alive || !e.visible) continue;
      const cx = X(e.x / CFG.cell), cz = Y(e.z / CFG.cell);
      if (cx < -cell || cz < -cell || cx > size + cell || cz > size + cell) continue;
      g.fillStyle = e.isBoss ? '#ff5a4a' : '#e0483d';
      g.beginPath();
      g.arc(cx, cz, Math.max(1.6, cell * 0.35), 0, Math.PI * 2);
      g.fill();
    }

    // In follow mode the player is by construction at the centre of the canvas, and drawing
    // it there rather than from its own coordinates keeps the arrow steady when the map
    // window quantises to whole cells under it.
    const px = follow ? size / 2 : X(player.x / CFG.cell);
    const pz = follow ? size / 2 : Y(player.z / CFG.cell);
    g.save();
    g.translate(px, pz);
    g.rotate(-(player.yaw + Math.PI));
    g.fillStyle = biome.accent;
    g.beginPath();
    g.moveTo(0, -cell * 0.9);
    g.lineTo(cell * 0.6, cell * 0.7);
    g.lineTo(-cell * 0.6, cell * 0.7);
    g.closePath();
    g.fill();
    g.restore();
  }
}
