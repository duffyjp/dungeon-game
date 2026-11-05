// Floor pickups: float, glow with rarity colour, magnetise, apply on contact (§8.4).

import * as THREE from 'three';
import { CFG } from '../config.js';
import { getTexture } from '../render/assets.js';
import * as sfx from '../audio/sfx.js';

export class Pickup {
  constructor(game, item, x, z, opts = {}) {
    this.game = game;
    this.item = item;
    this.x = x; this.z = z;
    this.taken = false;
    this.age = 0;
    this.baseY = opts.pedestal ? 0.95 : 0.55;
    this.y = this.baseY;

    this.group = new THREE.Group();

    if (opts.pedestal) {
      const ped = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 1.4),
        new THREE.MeshBasicMaterial({ map: getTexture('props/loot_pedestal'), transparent: true, alphaTest: 0.35, toneMapped: false })
      );
      ped.position.set(x, 0.7, z);
      ped.userData.billboard = true;
      this.pedestal = ped;
      this.group.add(ped);
    }

    const size = item.slot === 'score' ? 0.35 : 0.62;
    this.body = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: getTexture(`items/${item.sprite.split('/').pop()}`), transparent: true, alphaTest: 0.3, toneMapped: false })
    );
    this.body.position.set(x, this.y, z);
    this.body.userData.billboard = true;
    this.group.add(this.body);

    // rarity halo: cheap readable signal that a drop is worth walking to
    const glow = new THREE.PointLight(new THREE.Color(item.color || '#ffffff'), item.tierIndex >= 2 ? 1.5 : 0.55, 3.5, 2);
    glow.position.set(x, this.y, z);
    this.glow = glow;
    this.group.add(glow);
  }

  update(dt, player) {
    if (this.taken) return false;
    this.age += dt;
    this.y = this.baseY + Math.sin(this.age * 2.2) * 0.06;
    this.body.position.y = this.y;
    this.glow.position.y = this.y;
    if (this.pedestal) this.pedestal.position.y = 0.7;

    const dx = player.x - this.x, dz = player.z - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist < CFG.magnetRadius + 0.35) {
      // magnet: drift the item toward the player rather than snapping, so the
      // pickup reads as physical
      this.x += dx * dt * 3.2;
      this.z += dz * dt * 3.2;
      this.body.position.x = this.x;
      this.body.position.z = this.z;
      this.glow.position.x = this.x;
      this.glow.position.z = this.z;
    }
    if (dist < CFG.magnetRadius) {
      this.taken = true;
      this.game.onPickup(this);
      return false;
    }
    return true;
  }

  dispose() {
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
