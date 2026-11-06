// Projectiles, one-shot VFX quads, and floating damage numbers.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { getTexture } from '../render/assets.js';
import { hasLineOfSight } from '../world/collision.js';
import * as sfx from '../audio/sfx.js';

// Where a shot with no stated direction should go.
function aimAtPlayer(p, game) {
  if (!p.hostile) return game.playerLook();      // the player's own shot flies where they look
  const dx = game.player.x - p.x, dz = game.player.z - p.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}

export class Projectile {
  constructor(game, cfg) {
    this.game = game;
    this.x = cfg.x; this.z = cfg.z; this.y = cfg.y ?? 1.3;
    this.speed = cfg.speed;
    this.life = cfg.life ?? 2;
    this.damage = cfg.damage;
    this.homing = cfg.homing || 0;
    this.splash = cfg.splash || 0;
    this.hostile = cfg.hostile !== false;
    this.owner = cfg.owner;
    this.size = cfg.size || 0.4;
    this.dead = false;

    // Direction. A hostile shot with no explicit direction has to aim at the player. The
    // old fallback here was game.playerLook() — the *player's* facing — which is why an
    // archer loosed its arrow off in whatever direction you happened to be looking.
    const dir = cfg.dir || aimAtPlayer(this, game);
    this.dx = dir.x; this.dz = dir.z;

    this.arrow = Boolean(cfg.arrow);
    this.assetKey = cfg.sprite;   // kept for the self-test and for debugging shots
    this.age = 0;
    this.wobble = Math.random() * Math.PI * 2;

    // An arrow reads as an arrow only at a decent length; the sprite is a square quad with
    // the shaft running along its diagonal, so 0.44 m gives a shaft about 0.6 m long.
    const size = this.arrow ? Math.max(cfg.size || 0, 0.44) : (cfg.size || 0.4);
    this.size = size;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: getTexture(cfg.sprite), transparent: true, alphaTest: 0.2, toneMapped: false })
    );
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.userData.billboard = true;
    this.mesh.userData.ignoreScale = true;
  }

  update(dt) {
    if (this.dead) return false;
    // A QA hook (?freeze=1) holds shots in place so a screenshot can actually look at one.
    // Orientation still updates, which is the whole point of freezing one.
    const still = Boolean(this.game.freezeProjectiles);
    if (!still) this.life -= dt;
    if (this.life <= 0) return false;

    if (this.homing > 0) {
      const t = this.hostile ? this.game.player : this.game.nearestEnemy(this.x, this.z, 20);
      if (t) {
        const tx = (t.x ?? 0) - this.x, tz = (t.z ?? 0) - this.z;
        const len = Math.hypot(tx, tz) || 1;
        const k = Math.min(1, this.homing * dt);
        this.dx += (tx / len - this.dx) * k;
        this.dz += (tz / len - this.dz) * k;
        const n = Math.hypot(this.dx, this.dz) || 1;
        this.dx /= n; this.dz /= n;
      }
    }

    const step = still ? 0 : this.speed * dt;
    this.x += this.dx * step;
    this.z += this.dz * step;
    this.mesh.position.set(this.x, this.y, this.z);

    if (this.arrow) {
      // Fly point-first. The billboard pass turns the quad to face the camera while keeping
      // it upright, so the shaft has to be rolled inside that plane. The generated arrow
      // art lies nose-up-right at 45 degrees, which is what the PI/4 accounts for; the
      // small flutter is the shaft shivering in flight.
      this.age += dt;
      const camx = this.game.camera.position.x - this.x;
      const camz = this.game.camera.position.z - this.z;
      const camLen = Math.hypot(camx, camz) || 1;
      // across: the part of the flight that runs sideways on screen. toward: the part that
      // is closing on the camera. Together they cover every angle without a discontinuity.
      const across = (this.dx * camz - this.dz * camx) / camLen;
      const toward = (this.dx * camx + this.dz * camz) / camLen;
      const k = Math.max(-1, Math.min(1, across / 0.55));
      let roll = Math.PI / 4 - (Math.PI / 2) * k;
      // An arrow running across your view lies along its path. One travelling almost exactly
      // at you has no sideways direction to borrow, so it stands nose-down instead — the
      // head coming at you, not the feathers.
      if (toward > 0.25 && Math.abs(k) < 0.4) roll += Math.PI;
      this.roll = roll + Math.sin(this.age * 26 + this.wobble) * 0.035;
      this.mesh.userData.roll = this.roll;
    }

    // walls stop everything except magic that is explicitly splash-cast
    const cx = Math.floor(this.x / CFG.cell), cy = Math.floor(this.z / CFG.cell);
    if (!this.game.level.open[cy * this.game.level.w + cx]) {
      this.impact(null);
      return false;
    }

    if (this.hostile) {
      const p = this.game.player;
      if (Math.hypot(p.x - this.x, p.z - this.z) < CFG.radius + this.size * 0.5) {
        this.impact(p);
        return false;
      }
    } else {
      const hit = this.game.enemyAt(this.x, this.z, this.size * 0.6 + 0.15);
      if (hit) { this.impact(hit); return false; }
    }
    return true;
  }

  impact(target) {
    this.dead = true;
    this.game.spawnVfx(this.splash ? 'vfx/fireball' : 'vfx/hit_spark', this.x, this.z, 0.9, 0.28);
    if (this.splash > 0) {
      sfx.play('fireball_impact', { x: this.x, z: this.z });
      if (this.hostile) {
        const p = this.game.player;
        if (Math.hypot(p.x - this.x, p.z - this.z) <= this.splash) this.game.damagePlayer(this.damage, this.owner);
      }
      return;
    }
    if (!target) { sfx.play('arrow_impact', { x: this.x, z: this.z, gain: 0.6 }); return; }
    if (this.hostile) {
      this.game.damagePlayer(this.damage, this.owner);
    } else {
      target.hurt(this.damage, { crit: this.crit });
      sfx.play('arrow_impact', { x: this.x, z: this.z });
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class Vfx {
  // maxOpacity caps the effect below full strength for its whole life. Translucent effects
  // (a ghost's vapour, a wet splat) keep whatever the generated art picked up at their
  // soft fringe — a magenta cast off the keying field, for one — and a ceiling makes that
  // cast subtle enough to live with while the art itself is being re-authored.
  constructor(key, x, z, size = 1, life = 0.3, y, maxOpacity = 1) {
    this.life = life;
    this.maxLife = life;
    this.maxOpacity = maxOpacity;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: getTexture(key), transparent: true, depthWrite: false, toneMapped: false })
    );
    this.mesh.position.set(x, y ?? 1.2, z);
    this.mesh.userData.billboard = true;
  }
  update(dt) {
    this.life -= dt;
    const t = Math.max(0, this.life / this.maxLife);
    this.mesh.material.opacity = t * this.maxOpacity;
    this.mesh.scale.setScalar(1 + (1 - t) * 0.6);
    return this.life > 0;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

// Floating damage numbers: canvas-textured sprites, DOM-free so they sit in the world.
const digitCache = new Map();
function numberTexture(text, color, crit) {
  const key = text + color + (crit ? 'c' : '');
  if (digitCache.has(key)) return digitCache.get(key);
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.font = `${crit ? 900 : 700} ${crit ? 44 : 36}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.9)';
  g.shadowBlur = 8;
  g.fillStyle = color;
  g.fillText(text, 64, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  digitCache.set(key, tex);
  return tex;
}

export class DamageNumber {
  constructor(text, x, y, z, color = '#ffffff', crit = false) {
    this.life = crit ? 1.1 : 0.85;
    this.maxLife = this.life;
    this.y = y;
    this.x = x; this.z = z;
    this.vy = 1.4;
    const s = crit ? 1.5 : 1.1;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(s, s * 0.5),
      new THREE.MeshBasicMaterial({ map: numberTexture(text, color, crit), transparent: true, depthWrite: false, toneMapped: false })
    );
    this.mesh.position.set(x, y, z);
    this.mesh.userData.billboard = true;
  }
  update(dt) {
    this.life -= dt;
    this.y += this.vy * dt;
    this.vy -= dt * 1.6;
    this.mesh.position.y = this.y;
    this.mesh.material.opacity = Math.min(1, this.life / this.maxLife * 1.6);
    return this.life > 0;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
