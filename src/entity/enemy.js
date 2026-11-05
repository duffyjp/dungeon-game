// Enemy entity + per-family AI (spec §6, §7).
//
// Fairness rule from the spec: no enemy may deal damage without a visible tell and
// an audio cue first. Every attack here runs through a windup timer that the player
// can see (sprite lean + audio) and step out of.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { getTexture } from '../render/assets.js';
import { makeBillboard } from '../world/levelView.js';
import { moveCircle, hasLineOfSight, findOpenSpot } from '../world/collision.js';
import { isOpen } from '../util/grid.js';
import * as sfx from '../audio/sfx.js';

const AGGRO_RANGE = 14;

export class Enemy {
  constructor(game, fam, tier, cell, opts = {}) {
    const d = game.depth;
    const tierIdx = tier - 1;
    const hpMult = 1 + CFG.depthHpPer * (d - 1);
    const dmgMult = 1 + CFG.depthDmgPer * (d - 1);
    const speedMult = Math.min(CFG.depthSpeedCap, 1 + CFG.depthSpeedPer * (d - 1));

    this.game = game;
    this.fam = fam;
    this.ai = fam.ai;
    this.tier = tier;
    this.name = fam.names[String(tier)] || fam.names['1'];
    this.maxHp = Math.round(fam.hp * hpMult * fam.tierMult.hp[tierIdx] * (opts.hpScale || 1));
    this.hp = this.maxHp;
    this.damage = Math.round(fam.damage * dmgMult * fam.tierMult.dmg[tierIdx]);
    this.speed = fam.speed * speedMult;
    this.radius = fam.radius * (opts.radiusMult || 1);
    this.height = fam.height * (opts.radiusMult || 1);
    this.isBoss = Boolean(opts.boss);
    this.x = (cell.x + 0.5) * CFG.cell;
    this.z = (cell.y + 0.5) * CFG.cell;

    this.state = 'idle';
    this.cooldown = 0;
    this.tell = 0;
    this.tellTotal = 0;
    this.hitFlash = 0;
    this.alive = true;
    this.deathT = 0;
    this.wander = { t: 0, dir: 0 };
    this.slowUntil = 0;
    this.phaseLock = 0;            // ghosts: one wall per 4 s
    this.lastKnown = null;
    this.damageNumbers = [];

    this.group = new THREE.Group();
    const spriteKey = fam.sprites[String(tier)] || fam.sprites['1'];
    this.body = makeBillboard(spriteKey, [this.height * 0.75, this.height], this.x, this.z, this.height / 2);
    this.group.add(this.body);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(this.radius * 2.6, this.radius * 2.0),
      new THREE.MeshBasicMaterial({ map: getTexture('vfx/contact_shadow'), transparent: true, opacity: 0.55, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(this.x, 0.03, this.z);
    this.shadow = shadow;
    this.group.add(shadow);

    if (fam.phasesWalls) this.body.material.opacity = 0.72;
    if (this.isBoss) this.body.scale.setScalar(1.45);
  }

  get attackDef() { return this.fam.attack; }

  distanceToPlayer() {
    const p = this.game.player;
    return Math.hypot(p.x - this.x, p.z - this.z);
  }

  canSeePlayer() {
    const p = this.game.player;
    const dist = this.distanceToPlayer();
    if (dist > AGGRO_RANGE) return false;
    if (this.fam.phasesWalls) return true;      // ghosts sense you regardless of walls
    return hasLineOfSight(this.game.level, this.x, this.z, p.x, p.z);
  }

  update(dt) {
    if (!this.alive) {
      this.deathT += dt;
      this.body.material.opacity = Math.max(0, 1 - this.deathT / 0.45);
      this.body.scale.setScalar(Math.max(0.01, 1 - this.deathT / 0.45));
      this.shadow.material.opacity = Math.max(0, 0.55 * (1 - this.deathT / 0.45));
      return this.deathT < 0.5;
    }

    if (this.hitFlash > 0) {
      this.hitFlash -= dt;
      // Over-bright multiply reads as a white flash on a photoreal sprite without
      // needing a second overlay mesh.
      const f = Math.max(0, this.hitFlash / 0.12);
      const c = 1 + f * 1.8;
      this.body.material.color.setRGB(c, c, c);
      if (this.hitFlash <= 0) this.body.material.color.setRGB(1, 1, 1);
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.phaseLock = Math.max(0, this.phaseLock - dt);
    const slowed = this.slowUntil > this.game.time;
    const speed = slowed ? this.speed * 0.55 : this.speed;
    const seen = this.canSeePlayer();
    if (seen) this.state = this.state === 'idle' ? 'hunt' : this.state;

    switch (this.ai) {
      case 'melee': this.aiMelee(dt, speed, seen); break;
      case 'slime': this.aiSlime(dt, speed, seen); break;
      case 'archer': this.aiArcher(dt, speed, seen); break;
      case 'mage': this.aiMage(dt, speed, seen); break;
      case 'ghost': this.aiGhost(dt, speed, seen); break;
      case 'spider': this.aiSpider(dt, speed, seen); break;
      default: this.aiMelee(dt, speed, seen);
    }

    if (this.tell > 0) this.tell -= dt;
    if (this.tell > 0 && this.tell - dt <= 0) this.landAttack();
    return true;
  }

  // ---- movement helpers ----
  step(dt, speed, tx, tz, ghost = false) {
    const dx = tx - this.x, dz = tz - this.z;
    const len = Math.hypot(dx, dz) || 1;
    const mv = speed * dt;
    const r = moveCircle(this.game.level, this.x, this.z, this.radius,
      (dx / len) * mv, (dz / len) * mv, { ghost });
    this.x = r.x; this.z = r.z;
    this.group.position.set(0, 0, 0);
    this.body.position.set(this.x, this.height / 2, this.z);
    this.shadow.position.set(this.x, 0.03, this.z);
  }

  strafe(dt, speed, sign) {
    const p = this.game.player;
    const dx = p.x - this.x, dz = p.z - this.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len, pz = dx / len;
    const mv = speed * dt * sign;
    const r = moveCircle(this.game.level, this.x, this.z, this.radius, px * mv, pz * mv);
    this.x = r.x; this.z = r.z;
    this.body.position.set(this.x, this.height / 2, this.z);
    this.shadow.position.set(this.x, 0.03, this.z);
  }

  wanderStep(dt) {
    this.wander.t -= dt;
    if (this.wander.t <= 0) {
      this.wander.t = 1.5 + Math.random() * 2.5;
      this.wander.dir = Math.random() * Math.PI * 2;
    }
    const nx = this.x + Math.cos(this.wander.dir) * this.speed * 0.35 * dt;
    const nz = this.z + Math.sin(this.wander.dir) * this.speed * 0.35 * dt;
    const r = moveCircle(this.game.level, this.x, this.z, this.radius, nx - this.x, nz - this.z);
    this.x = r.x; this.z = r.z;
    this.body.position.set(this.x, this.height / 2, this.z);
    this.shadow.position.set(this.x, 0.03, this.z);
  }

  beginTell(kind) {
    const a = this.attackDef;
    this.tell = a.tell;
    this.tellTotal = a.tell;
    this.cooldown = a.cooldown;
    sfx.play(this.fam.sfx.attack, { x: this.x, z: this.z, gain: 0.8 });
    if (kind === 'lean') this.lean = true;
  }

  landAttack() {
    const a = this.attackDef;
    const dist = this.distanceToPlayer();
    if (a.kind === 'melee') {
      if (dist <= a.range + CFG.radius) {
        this.game.damagePlayer(this.damage, this, { arc: a.arc });
      }
      return;
    }
    if (a.kind === 'contact') {
      if (dist <= a.range + CFG.radius) {
        this.game.damagePlayer(this.damage, this, { pierceArmor: a.pierceArmor, slow: a.slow });
      }
      return;
    }
    if (a.kind === 'projectile') {
      this.game.spawnProjectile({
        x: this.x, z: this.z, y: 1.3,
        speed: a.speed, life: a.life, damage: this.damage,
        homing: a.homing || 0, splash: a.splash || 0,
        hostile: true, owner: this,
        sprite: a.splash ? 'vfx/fireball' : 'vfx/magic_orb',
        size: a.splash ? 0.5 : 0.42
      });
    }
  }

  // ---- AI behaviours ----
  aiMelee(dt, speed, seen) {
    const dist = this.distanceToPlayer();
    if (!seen) return this.wanderStep(dt);
    const a = this.attackDef;
    if (this.tell > 0) return;
    if (dist > a.range * 0.85) {
      const p = this.game.player;
      this.step(dt, speed, p.x, p.z);
    } else if (this.cooldown <= 0) {
      this.state = 'windup';
      this.beginTell('lean');
    }
  }

  aiSlime(dt, speed, seen) {
    const dist = this.distanceToPlayer();
    if (!seen) return this.wanderStep(dt);
    if (this.tell > 0) return;
    const a = this.attackDef;
    // Slimes lunge: a short pause (the squelch cue) then a hop toward the player.
    if (dist > a.range * 0.9) {
      const p = this.game.player;
      this.step(dt, speed, p.x, p.z);
      this.body.position.y = this.height / 2 + Math.abs(Math.sin(this.game.time * 6)) * 0.06;
    } else if (this.cooldown <= 0) {
      this.beginTell();
      const p = this.game.player;
      this.step(dt * 3, speed * 2.4, p.x, p.z);
    }
  }

  aiArcher(dt, speed, seen) {
    const dist = this.distanceToPlayer();
    if (!seen) return this.wanderStep(dt);
    const a = this.attackDef;
    if (this.tell > 0) return;
    if (dist < a.minRange * 0.8) {
      const p = this.game.player;
      const awayX = this.x * 2 - p.x, awayZ = this.z * 2 - p.z;
      this.step(dt, speed, awayX, awayZ);
      return;
    }
    if (dist > a.maxRange) {
      const p = this.game.player;
      this.step(dt, speed, p.x, p.z);
      return;
    }
    this.strafe(dt, speed * 0.8, this.game.rng.chance(0.5) ? 1 : -1);
    if (this.cooldown <= 0 && hasLineOfSight(this.game.level, this.x, this.z, this.game.player.x, this.game.player.z)) {
      this.beginTell();
      // glint telegraph so the shot is readable before the arrow exists
      this.game.showGlint(this.x, this.z, this.tell);
    }
  }

  aiMage(dt, speed, seen) {
    const dist = this.distanceToPlayer();
    if (!seen) return this.wanderStep(dt);
    const a = this.attackDef;
    const blink = this.fam.blink;
    if (blink && dist < blink.trigger) {
      // blink away through a random open neighbour
      const spots = [];
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const cx = Math.floor(this.x / CFG.cell) + dx, cy = Math.floor(this.z / CFG.cell) + dy;
          if (isOpen(this.game.level, cx, cy)) {
            const wx = (cx + 0.5) * CFG.cell, wz = (cy + 0.5) * CFG.cell;
            if (Math.hypot(wx - this.game.player.x, wz - this.game.player.z) > blink.distance * 0.7) spots.push({ x: wx, z: wz });
          }
        }
      }
      if (spots.length) {
        const s = spots[Math.floor(Math.random() * spots.length)];
        this.game.spawnVfx('vfx/portal_glow', this.x, this.z, 1.2, 0.5);
        this.x = s.x; this.z = s.z;
        this.body.position.set(this.x, this.height / 2, this.z);
        this.shadow.position.set(this.x, 0.03, this.z);
        this.game.spawnVfx('vfx/portal_glow', this.x, this.z, 1.2, 0.5);
        sfx.play('magic_orb_cast', { x: this.x, z: this.z, gain: 0.5 });
      }
      return;
    }
    if (this.tell > 0) return;
    if (dist > a.maxRange * 0.9) {
      const p = this.game.player;
      this.step(dt, speed, p.x, p.z);
    } else if (this.cooldown <= 0) {
      this.beginTell();
      sfx.play('magic_orb_cast', { x: this.x, z: this.z, gain: 0.6 });
    }
  }

  aiGhost(dt, speed, seen) {
    if (!seen) return this.wanderStep(dt);
    const p = this.game.player;
    const dist = this.distanceToPlayer();
    const a = this.attackDef;
    if (this.tell > 0) return;
    if (dist > a.range * 0.9) {
      const inWall = !isOpen(this.game.level, Math.floor(this.x / CFG.cell), Math.floor(this.z / CFG.cell));
      const los = hasLineOfSight(this.game.level, this.x, this.z, p.x, p.z);
      const ghost = (inWall || !los) && this.phaseLock <= 0;
      if (ghost) this.phaseLock = 4.0;                 // one wall per 4 s (spec §17.8)
      this.step(dt, speed, p.x, p.z, ghost);
      const inside = !isOpen(this.game.level, Math.floor(this.x / CFG.cell), Math.floor(this.z / CFG.cell));
      if (inside && this.phaseLock > 3.0) {
        // never park inside geometry: pop back out
        const s = findOpenSpot(this.game.level, this.x, this.z, 3);
        this.x = s.x; this.z = s.z;
      }
      this.body.position.y = this.height / 2 + Math.sin(this.game.time * 2.2) * 0.12;
    } else if (this.cooldown <= 0) {
      this.beginTell();
    }
  }

  aiSpider(dt, speed, seen) {
    const dist = this.distanceToPlayer();
    if (!seen) return this.wanderStep(dt);
    const a = this.attackDef;
    if (this.tell > 0) return;
    if (this.retreatUntil && this.game.time < this.retreatUntil) {
      const p = this.game.player;
      this.step(dt, speed, this.x * 2 - p.x, this.z * 2 - p.z);
      return;
    }
    if (dist > a.range * 0.9) {
      const p = this.game.player;
      this.step(dt, speed, p.x, p.z);
    } else if (this.cooldown <= 0) {
      this.beginTell();
      this.retreatUntil = this.game.time + 0.9;
    }
  }

  // ---- damage / death ----
  hurt(amount, { crit = false } = {}) {
    if (!this.alive) return false;
    this.hp -= amount;
    this.hitFlash = 0.12;
    this.body.material.color.setRGB(1.6, 1.6, 1.6);
    this.state = 'hunt';
    this.game.showDamage(this.x, this.height * 0.9, this.z, amount, crit);
    sfx.play(this.fam.sfx.hurt, { x: this.x, z: this.z, gain: 0.7 });
    if (this.hp <= 0) {
      this.alive = false;
      sfx.play(this.fam.sfx.death, { x: this.x, z: this.z });
      if (this.isBoss) sfx.play('boss_roar', { x: this.x, z: this.z });
      this.game.onEnemyDeath(this);
      return true;
    }
    // small knockback, blocked by walls
    const p = this.game.player;
    const dx = this.x - p.x, dz = this.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const r = moveCircle(this.game.level, this.x, this.z, this.radius, (dx / len) * 0.25, (dz / len) * 0.25);
    this.x = r.x; this.z = r.z;
    this.body.position.set(this.x, this.height / 2, this.z);
    return true;
  }
}
