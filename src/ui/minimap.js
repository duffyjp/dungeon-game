// Minimap: canvas-drawn from the grid. Explored cells only, staircase revealed once
// seen (or by stair-sense at depth >= 5). Enemy pips only when actually visible.

import { CFG } from '../config.js';
import { idx } from '../util/grid.js';

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
    const cell = size / Math.max(level.w, level.h);
    g.clearRect(0, 0, size, size);
    g.fillStyle = 'rgba(8,10,13,0.72)';
    g.fillRect(0, 0, size, size);

    for (let y = 0; y < level.h; y++) {
      for (let x = 0; x < level.w; x++) {
        const i = idx(level.w, x, y);
        if (!this.explored[i]) continue;
        if (level.open[i]) {
          g.fillStyle = 'rgba(150,162,178,0.55)';
          g.fillRect(x * cell, y * cell, cell + 0.6, cell + 0.6);
        } else {
          g.fillStyle = 'rgba(20,24,30,0.9)';
          g.fillRect(x * cell, y * cell, cell + 0.6, cell + 0.6);
        }
      }
    }

    const si = idx(level.w, level.stair.x, level.stair.y);
    if (this.stairSeen || stairSense) {
      g.fillStyle = stairSense && !this.stairSeen ? 'rgba(245,165,36,0.45)' : '#f5a524';
      g.fillRect(level.stair.x * cell, level.stair.y * cell, cell + 0.6, cell + 0.6);
    }

    for (const e of enemies) {
      if (!e.alive || !e.visible) continue;
      const cx = (e.x / CFG.cell) * cell, cz = (e.z / CFG.cell) * cell;
      g.fillStyle = e.isBoss ? '#ff5a4a' : '#e0483d';
      g.beginPath();
      g.arc(cx, cz, Math.max(1.6, cell * 0.35), 0, Math.PI * 2);
      g.fill();
    }

    const px = (player.x / CFG.cell) * cell, pz = (player.z / CFG.cell) * cell;
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
