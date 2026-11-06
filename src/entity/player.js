// Player: movement, camera, melee/ranged attacks, health/armour/lives state.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { getTexture } from '../render/assets.js';
import { moveCircle } from '../world/collision.js';

export class Player {
  constructor(game) {
    this.game = game;
    this.x = 0; this.z = 0; this.y = CFG.eye;
    this.yaw = 0; this.pitch = 0;
    this.health = CFG.maxHealth;
    this.maxHealth = CFG.maxHealth;
    this.lives = CFG.startLives;
    this.melee = null;          // item instance in the melee slot
    this.ranged = null;         // item instance in the ranged slot (a bow)
    this.weapon = null;         // whichever of the two is currently in hand
    this.arrows = 0;            // every shot spends one; a bow without arrows cannot be drawn
    this.armor = null;          // item instance with .durability
    this.invuln = 0;
    this.attackCd = 0;
    this.swingT = 0;
    this.drawT = 0;
    this.walkPhase = 0;
    this.speedNow = 0;
    this.slowUntil = 0;
    this.hurtFlash = 0;
    this.slow = { until: 0, factor: 1 };
  }

  get alive() { return this.health > 0; }

  // Which of the two weapon slots is currently in hand.
  get weaponKind() { return this.weapon && this.weapon === this.ranged ? 'ranged' : 'melee'; }

  // A bow is only usable while there is an arrow to spend, so the ranged slot is gated on
  // ammunition and not merely on owning a bow.
  canUse(kind) {
    if (kind === 'melee') return Boolean(this.melee);
    return Boolean(this.ranged) && this.arrows > 0;
  }

  // Put one slot in hand. Refuses a bow with no arrows and returns null so the caller can
  // say why instead of silently handing over an empty pair of hands.
  selectWeapon(kind) {
    if (!this.canUse(kind)) return null;
    this.weapon = kind === 'ranged' ? this.ranged : this.melee;
    return this.weapon;
  }

  place(level) {
    const e = level.entry;
    this.x = (e.x + 0.5) * CFG.cell;
    this.z = (e.y + 0.5) * CFG.cell;
    // face into the maze rather than into a wall
    let best = 0, bestOpen = -1;
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const nx = this.x + Math.sin(a) * CFG.cell, nz = this.z + Math.cos(a) * CFG.cell;
      const open = this.game.level.open[Math.floor(nz / CFG.cell) * this.game.level.w + Math.floor(nx / CFG.cell)];
      if (open && bestOpen < 0) { bestOpen = open; best = a; }
    }
    this.yaw = best;
  }

  heal(amount) {
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    return Math.round(this.health - before);
  }

  repairArmor(frac) {
    if (!this.armor) return 0;
    const before = this.armor.durability;
    this.armor.durability = Math.min(this.armor.maxDurability, this.armor.durability + this.armor.maxDurability * frac);
    return Math.round(this.armor.durability - before);
  }

  // Damage resolution exactly as spec §5
  takeDamage(raw, opts = {}) {
    if (this.invuln > 0) return { blocked: true, toHp: 0 };
    let mitigation = 0;
    const broken = !this.armor || this.armor.durability <= 0;
    if (!broken && !opts.pierceArmor) mitigation = Math.min(CFG.mitigationCap, this.armor.mitigation);
    const dmg = raw * (1 - mitigation);

    let toHp = dmg;
    if (!broken && !opts.pierceArmor) {
      const toArmor = dmg * CFG.armorSoak;
      toHp = dmg * (1 - CFG.armorSoak);
      this.armor.durability -= toArmor;
      if (this.armor.durability <= 0) {
        this.armor.durability = 0;
        this.game.onArmorBroken();
      }
    }
    this.health -= toHp;
    this.hurtFlash = 0.45;
    if (opts.slow) this.slow = { until: this.game.time + opts.slow, factor: 0.5 };
    return { toHp: Math.round(toHp), mitigation, broken };
  }

  update(dt, input, camera) {
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt);
    if (this.drawT > 0) this.drawT = Math.max(0, this.drawT - dt);

    const yaw = input.yaw, pitch = input.pitch;
    this.yaw = yaw;
    this.pitch = Math.max(-85 * Math.PI / 180, Math.min(85 * Math.PI / 180, pitch));

    const slowed = this.slow.until > this.game.time;
    const base = input.jog ? CFG.jog : CFG.walk;
    const speed = base * (slowed ? this.slow.factor : 1);

    let fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    // The camera is rotated by (yaw + PI) — three.js cameras look down their local -Z —
    // so the camera's actual right axis is (cos(yaw+PI), -sin(yaw+PI)), i.e. the NEGATIVE
    // of (cos yaw, -sin yaw). Using the un-flipped vector mirrored A/D (and Left/Right).
    let rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);
    let mx = 0, mz = 0;
    if (input.fwd) { mx += fx; mz += fz; }
    if (input.back) { mx -= fx; mz -= fz; }
    if (input.right) { mx += rx; mz += rz; }
    if (input.left) { mx -= rx; mz -= rz; }
    const len = Math.hypot(mx, mz);
    this.speedNow = len ? speed : 0;
    if (len) {
      const mv = speed * dt;
      const r = moveCircle(this.game.level, this.x, this.z, CFG.radius, (mx / len) * mv, (mz / len) * mv);
      this.x = r.x; this.z = r.z;
      this.walkPhase += mv * 1.9;
    }

    camera.position.set(this.x, CFG.eye + Math.sin(this.walkPhase) * 0.035, this.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = this.yaw + Math.PI;
    camera.rotation.x = this.pitch;
    camera.rotation.z = Math.sin(this.walkPhase * 2) * 0.006 * (this.speedNow / CFG.walk);
  }

  aimDir() {
    const cy = this.yaw + Math.PI;
    return { x: -Math.sin(cy), z: -Math.cos(cy) };
  }

  canAttack() { return this.attackCd <= 0 && this.weapon; }

  startAttack() {
    const w = this.weapon;
    if (!w) return null;
    const a = w.def.attack;
    this.attackCd = a.cooldown;
    if (a.kind === 'ranged') {
      this.drawT = a.draw;
      return { kind: 'ranged', a, weapon: w };
    }
    this.swingT = 0.45;
    return { kind: 'melee', a, weapon: w };
  }
}

// ---- viewmodel: generated weapon sprite pinned bottom-right, swung on attack ----
export class Viewmodel {
  constructor(camera) {
    this.camera = camera;
    this.group = new THREE.Group();
    // Slightly larger and a touch closer than before: at 0.30 m the painted blade read as
    // an object resting in the corner of the frame rather than something being held. The
    // mesh is depthTest:false with renderOrder 999, so it can never clip into geometry —
    // these two numbers are the whole dial for weapon presence.
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.35, 0.35),
      new THREE.MeshBasicMaterial({ map: getTexture('items/sword_worn'), transparent: true, alphaTest: 0.3, depthTest: false, toneMapped: false })
    );
    this.mesh.renderOrder = 999;
    this.group.add(this.mesh);
    this.base = new THREE.Vector3(0.225, -0.205, -0.47);
    this.mesh.position.copy(this.base);
    this.mesh.rotation.z = -0.5;
    this.group.renderOrder = 999;
    camera.add(this.group);
    this.swing = 0;
    this.recoil = 0;
  }

  setWeapon(item) {
    this.mesh.material.map = getTexture(item.sprite);
    this.mesh.material.needsUpdate = true;
  }

  trigger(kind) {
    if (kind === 'melee') this.swing = 1;
    else this.recoil = 1;
  }

  update(dt, player) {
    const bob = Math.sin(player.walkPhase) * 0.012 * (player.speedNow / CFG.walk);
    if (this.swing > 0) this.swing = Math.max(0, this.swing - dt * 2.6);
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 5.5);
    const s = this.swing;
    const arc = Math.sin(s * Math.PI);
    this.mesh.position.set(
      this.base.x + arc * -0.18 + bob,
      this.base.y + arc * 0.10 + bob * 0.6 - this.recoil * 0.04,
      this.base.z + arc * 0.12
    );
    this.mesh.rotation.z = -0.5 + arc * 1.25;
    this.mesh.rotation.y = arc * -0.5;
  }

  dispose() {
    this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.camera.remove(this.group);
  }
}
