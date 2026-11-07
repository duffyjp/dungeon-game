// Enemy entity + per-family AI (spec §6, §7).
//
// Fairness rule from the spec: no enemy may deal damage without a visible tell and
// an audio cue first. Every attack here runs through a windup timer that the player
// can see (sprite lean + audio) and step out of.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { getTexture, getSoftShadowTexture } from '../render/assets.js';
import { makeBillboard } from '../world/levelView.js';
import { animationFor, loadFrames, frameIndex, bodyRectFor } from '../render/animation.js';
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
    // Height carries part of the threat read. The generated art separates tiers by bulk
    // and damage, but a tier-1 wisp and a tier-4 shade are the same family and were being
    // drawn the same size, so a corridor never told you which one was the lesser threat.
    // `heightByTier` in data/enemies.json lets each family ramp its silhouette.
    this.height = fam.height * (opts.radiusMult || 1) * ((fam.heightByTier || [])[tierIdx] || 1);
    this.isBoss = Boolean(opts.boss);
    this.x = (cell.x + 0.5) * CFG.cell;
    this.z = (cell.y + 0.5) * CFG.cell;

    this.state = 'idle';
    this.lastX = this.x;
    this.lastZ = this.z;
    this.trailT = 0;
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
    this.spriteKey = spriteKey;
    this.body = makeBillboard(spriteKey, [this.height * 0.75, this.height], this.x, this.z, this.height / 2);
    this.baseMap = this.body.material.map;
    // The quad the still sprite was sized for, kept so an animated clip can be put back onto
    // it at the right scale (see bodyRectFor) and so returning to idle restores it exactly.
    this.baseGeom = this.body.geometry;
    this.baseQuad = [this.height * 0.75, this.height];
    // Frame animation state. The offset is random per creature so a room of the same species
    // does not step in lockstep. Clips are decoded once per (sprite, action) and shared by
    // every creature of that kind; the per-clip quad is shared the same way.
    this.anim = { t: 0, offset: Math.random() * 8, idx: -1, action: null, clips: new Map(), asked: new Set(), quads: new Map() };
    this.group.add(this.body);

    // Contact shadow follows the same tier ramp as the silhouette, so a knee-high wisp
    // does not sit in a puddle sized for a shade. Hovering and wall-phasing creatures get
    // a smaller, fainter pool because their body is not really standing on the floor.
    const ramp = this.height / fam.height;
    const hover = Boolean(fam.phasesWalls);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(
        this.radius * 2.6 * ramp * (hover ? 0.62 : 1),
        this.radius * 2.0 * ramp * (hover ? 0.62 : 1)
      ),
      new THREE.MeshBasicMaterial({
        map: getSoftShadowTexture(), transparent: true,
        opacity: hover ? 0.3 : 0.42, depthWrite: false
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(this.x, 0.03, this.z);
    shadow.userData.baseOpacity = hover ? 0.3 : 0.42;
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
      this.shadow.material.opacity = Math.max(0,
        (this.shadow.userData.baseOpacity || 0.42) * (1 - this.deathT / 0.45));
      return this.deathT < 0.5;
    }

    // Ghosts shed vapour where they have been. Measuring real movement rather than state,
    // because the trail should follow the body and not the AI's mood: a ghost that drifted
    // through a wall should still mark the corridor behind it.
    const moved = Math.hypot(this.x - this.lastX, this.z - this.lastZ);
    this.lastX = this.x; this.lastZ = this.z;
    this.tickAnimation(dt, moved);
    if (this.fam.trail) {
      this.trailT -= dt;
      if (this.trailT <= 0 && moved > 0.004) {
        this.trailT = 0.34;
        // 0.55 s life, and the same number again is no coincidence to be read carelessly:
        // the last argument caps the puff at 55% opacity, which keeps the vapour see-through
        // and mutes whatever the keying left at its fringe
        this.game.spawnVfx(this.fam.trail, this.x, this.z,
          Math.max(0.7, this.radius * 2), 0.55, this.height * 0.45, 0.55);
      }
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

  // ---- sprite animation ----
  // Which cycle to play, from what the creature is actually doing: the telegraph before a
  // hit is the attack, a spider's back-off is the flee, and anything else that covers ground
  // is the walk. Movement is measured from the position change rather than read from the AI's
  // state — the same reason the ghost trail is measured — so a creature that shuffled while
  // "hunting" and one that stood still in the same state do not look identical.
  //
  // A sprite with no clip for the current action, or a browser without WebCodecs, falls back
  // to the still sprite and behaves exactly as it did before this existed.
  tickAnimation(dt, moved) {
    const a = this.anim;
    const retreating = Boolean(this.retreatUntil) && this.game.time < this.retreatUntil;
    const action = this.tell > 0 ? 'attack' : retreating ? 'flee' : moved > 0.004 ? 'walk' : null;

    if (action && !a.asked.has(action) && !a.clips.has(action)) {
      a.asked.add(action);                       // ask once, whether or not a clip exists
      const entry = animationFor(this.spriteKey, action);
      if (entry) {
        loadFrames(entry).then(tex => { if (tex) a.clips.set(action, { entry, frames: tex }); });
      }
    }

    if (action && action === a.action) {
      const clip = a.clips.get(action);
      if (!clip) return;
      a.t += dt;
      const i = frameIndex(clip.entry, a.t, a.offset);
      if (i !== a.idx) {
        a.idx = i;
        this.applyAnimMap(clip.frames[i], clip.entry);
      }
      return;
    }

    a.action = action;
    a.idx = -1;
    a.t = 0;
    const clip = action ? a.clips.get(action) : null;
    this.applyAnimMap(clip ? clip.frames[0] : null, clip ? clip.entry : null);
  }

  applyAnimMap(tex, entry = null) {
    const before = this.body.material.map;
    this.body.material.map = tex || this.baseMap;
    // A material rebuild is only needed when a map appears or disappears; swapping one
    // texture for another does not need one, and this runs on every frame of every monster.
    if (!before !== !this.body.material.map) this.body.material.needsUpdate = true;

    // And the quad has to follow the image. A clip cell is a tight crop of the composed frame
    // while the still sprite is padded, so the same quad draws the animated creature larger
    // than the standing one - a slime would jump size every time it started walking. The
    // per-clip quad is computed once per clip and shared by every creature of that kind.
    const geom = entry ? this.clipQuad(entry) : this.baseGeom;
    if (geom && this.body.geometry !== geom) this.body.geometry = geom;
  }

  clipQuad(entry) {
    const cached = this.anim.quads.get(entry.file);
    if (cached) return cached;
    const r = bodyRectFor(entry, this.baseQuad[0], this.baseQuad[1]);
    const geom = r
      ? (() => { const g = new THREE.PlaneGeometry(r.w, r.h); g.translate(r.dx, r.dy, 0); return g; })()
      : this.baseGeom;
    this.anim.quads.set(entry.file, geom);
    return geom;
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
      // Aim at the player, with a few degrees of spread so a volley is threatening but not
      // inevitable. Anything that does not state a direction here used to fall back to the
      // player's own facing, which is how archers ended up shooting backwards.
      const dx = this.game.player.x - this.x, dz = this.game.player.z - this.z;
      const ang = Math.atan2(dx, dz) + ((a.spread || 0) * Math.PI / 180) * (Math.random() * 2 - 1);
      const dir = { x: Math.sin(ang), z: Math.cos(ang) };
      const muzzle = this.radius + 0.25;
      this.game.spawnProjectile({
        x: this.x + dir.x * muzzle, z: this.z + dir.z * muzzle, y: a.arrow ? 1.25 : 1.3,
        dir,
        speed: a.speed, life: a.life, damage: this.damage,
        homing: a.homing || 0, splash: a.splash || 0,
        hostile: true, owner: this,
        arrow: Boolean(a.arrow),
        sprite: a.arrow ? 'items/arrow' : (a.splash ? 'vfx/fireball' : 'vfx/magic_orb'),
        size: a.arrow ? 0.44 : (a.splash ? 0.5 : 0.42)
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
      // Families that are mostly body leave something behind. The sprite existed in the
      // manifest and nothing drew it, so a slime died by shrinking — a balloon losing air
      // rather than a thing coming apart.
      if (this.fam.splat) {
        const fx = this.game.spawnVfx(this.fam.splat, this.x, this.z, Math.max(1.1, this.radius * 3), 0.9, 0.045);
        fx.mesh.rotation.x = -Math.PI / 2;      // a splat is on the floor, not facing you
        fx.mesh.userData.billboard = false;
      }
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
