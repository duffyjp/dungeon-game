// STRATA: Descent — game orchestration (spec §4 loop, §7 combat, §8 pickups, §9 descent).
//
// Run flow: menu -> playing -> (paused) -> death -> respawn or gameover.
// Every level goes through buildLevel(), which only returns a level that passes the
// solvability contract in §9.1; if generation could not satisfy it, we surface that
// rather than shipping an unbeatable maze.

import * as THREE from 'three';
import { CFG } from './config.js';
import { Rng } from './util/rng.js';
import { buildLevel, validateLevel, tierFor, bandFor } from './world/levelGen.js';
import { buildLevelView, billboardTowards, cellToWorld } from './world/levelView.js';
import { hasLineOfSight, findOpenSpot } from './world/collision.js';
import { spawnLevelEnemies, spawnLevelLoot, rollDrops, tierForDepth, enemiesData } from './world/spawner.js';
import { Enemy } from './entity/enemy.js';
import { Pickup } from './entity/pickup.js';
import { Player, Viewmodel } from './entity/player.js';
import { Projectile, Vfx, DamageNumber } from './entity/effects.js';
import { Input } from './input.js';
import { Hud } from './ui/hud.js';
import { Minimap } from './ui/minimap.js';
import { Toasts } from './ui/toasts.js';
import { Menus } from './ui/menus.js';
import * as sfx from './audio/sfx.js';
import * as music from './audio/music.js';
import { preloadAll, hasAsset, assetKeys, assetUrl } from './render/assets.js';
import { loadSettings, saveRun, bestRuns } from './util/storage.js';
import { isBetter, useQualityTable } from './loot/quality.js';
import biomes from '../data/biomes.json';
import levels from '../data/levels.json';
import itemsData from '../data/items.json';
import qualityTable from '../data/quality.json';

useQualityTable(qualityTable);

const params = new URLSearchParams(location.search);

export class Game {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.overlay = document.getElementById('overlay');

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CFG.fov, innerWidth / innerHeight, 0.05, 160);
    this.scene.add(this.camera);

    this.ambient = new THREE.AmbientLight(0x101418, 0.9);
    this.scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0x223044, 0x0a0a0c, 0.25);
    this.scene.add(this.hemi);

    // pooled torch lights: only the nearest N are ever lit (§16)
    this.lightPool = [];
    for (let i = 0; i < CFG.lightPool; i++) {
      const l = new THREE.PointLight(0xffb35c, 0, 9, 2);
      this.scene.add(l);
      this.lightPool.push(l);
    }
    // Wider, softer cone than the photoreal pass used. Flat painted walls no longer hide
    // the cone's edge behind grit, so a tight penumbra reads as a hard disc of light
    // pasted onto the wall instead of light falling off.
    // Wider and softer than a flashlight: on painted walls a tight cone showed as a hard
    // disc pasted onto the masonry. The lower intensity and steeper falloff keep the near
    // wall from washing out to flat pale under ACES while the far corridor stays dark.
    this.headlamp = new THREE.SpotLight(0xfff0dd, 18, 26, Math.PI / 3.2, 0.95, 1.45);
    this.headlamp.position.set(0, 0, 0);
    this.camera.add(this.headlamp);
    this.headlamp.target.position.set(0, -0.15, -1);
    this.camera.add(this.headlamp.target);

    this.viewmodel = new Viewmodel(this.camera);
    this.hud = new Hud(this.overlay);
    this.minimap = new Minimap(this.overlay);
    this.toasts = new Toasts(this.overlay);
    this.input = new Input(this.canvas, this);
    this.menus = new Menus(this);

    this.player = new Player(this);
    this.items = itemsData;
    this.state = 'boot';
    this.time = 0;
    this.enemies = [];
    this.pickups = [];
    this.projectiles = [];
    this.effects = [];
    this.numbers = [];
    this.glints = [];
    this.depth = 1;
    this.score = 0;
    this.kills = 0;
    this.runSeed = params.get('seed') || String(Math.floor(Math.random() * 1e6));
    this.rng = new Rng(`${this.runSeed}:sys`);
    this.settings = loadSettings(DEFAULT_SETTINGS);
    this.applySettings();
    this.compareMode = this.settings.compareMode;
    this.pendingCompare = null;
    this.stairHold = 0;
    this.clock = new THREE.Clock();
    this._visT = 0;

    addEventListener('resize', () => this.onResize());
  }

  // ---------------------------------------------------------------- lifecycle
  async boot() {
    const keys = assetKeys();
    this.loadedAssetCount = keys.length;
    // The self-test exercises logic only, so it does not wait on decoding tens of
    // megabytes of generated art. Use ?selftest=1&assets=1 to test the art path too.
    const skipArt = params.get('selftest') && params.get('assets') !== '1';
    if (skipArt) this.placeholderArt = true;
    const { failed } = skipArt ? { loaded: 0, failed: [] } : await preloadAll(keys);
    if (failed.length) console.warn('[assets] failed to load:', failed.slice(0, 8));
    console.info(`[assets] ${keys.length} generated images available from z_image_turbo${skipArt ? ' (skipped in selftest)' : ''}`);
    this.applyFrameAssets();
    await music.loadManifest();
    this.state = 'menu';
    this.menus.showMain();
    if (params.get('demo')) this.startRun(params.get('seed') || 'demo', Number(params.get('depth') || 1));
    this.loop();
  }

  startRun(seed = this.runSeed, depth = 1) {
    sfx.initAudio();
    sfx.resumeAudio();
    this.runSeed = String(seed);
    this.depth = depth;
    this.score = 0;
    this.kills = 0;
    this.player.health = CFG.maxHealth;
    this.player.lives = CFG.startLives;
    this.player.weapon = null;
    this.player.armor = null;
    this.equipInitial();
    this.toasts.clear();
    this.loadLevel(depth);
    this.state = 'playing';
    this.menus.hide();
    this.input.requestLock();
  }

  equipInitial() {
    const def = itemsData.items.find(i => i.id === itemsData.startingWeapon);
    const inst = { def, id: def.id, slot: 'weapon', sprite: def.sprite, damage: def.base, score: def.base, tierIndex: 0, color: '#e6e8ea', label: def.name, quality: 1, jitter: 1 };
    this.player.weapon = inst;
    this.viewmodel.setWeapon(inst);
    this.hud.setGear(this.player);
  }

  loadLevel(depth, retry = 0) {
    const level = buildLevel(depth, this.runSeed);
    const check = validateLevel(level);
    if (!check.ok) {
      // Never hide an unbeatable maze. Regenerate with a fresh seed, loudly.
      console.error('[levelgen] level failed validation:', check.problems, level.seed);
      if (retry >= 3) {
        this.toast('Could not generate a valid level for this seed', '#e0483d', 6000);
        console.error('[levelgen] giving up after', retry + 1, 'attempts');
        return;
      }
      this.runSeed = `${this.runSeed}!${retry + 1}`;
      this.loadLevel(depth, retry + 1);
      return;
    }
    this.clearLevel();
    this.level = level;
    this.depth = depth;
    this.rng = new Rng(`${this.runSeed}:L${depth}`);

    const biome = biomes[level.biome];
    this.biome = biome;
    this.levelView = buildLevelView(level, biome);
    this.scene.add(this.levelView.group);

    this.scene.fog = new THREE.FogExp2(new THREE.Color(biome.fog), biome.fogDensity);
    this.scene.background = new THREE.Color(biome.fog);
    this.ambient.color = new THREE.Color(biome.ambient);
    this.ambient.intensity = biome.ambientIntensity * 9;
    for (const l of this.lightPool) { l.color = new THREE.Color(biome.torchColor); l.distance = biome.torchRange; }

    this.player.place(level);
    this.input.setYaw(this.player.yaw);
    this.player.invuln = CFG.respawnInvuln;

    // ?at=stair and ?at=prop:<kind> stand the player beside one specific thing, looking at
    // it, so a prop can be judged in real gameplay lighting from a URL instead of by
    // walking a level hoping to bump into one. Both take the open neighbour nearest the
    // entry as the vantage: standing *on* the target puts the camera inside the geometry,
    // and on the staircase it also starts the descend timer.
    const at = params.get('at');
    if (at === 'stair' || (at && at.startsWith('prop'))) {
      let target = null;
      if (at === 'stair') {
        target = level.stair;
      } else {
        const kind = at.split(':')[1] || 'rubble';
        const pool = kind === 'torch' ? level.torches : level.props.filter(p => p.kind === kind);
        let bestD = Infinity;
        for (const p of pool) {
          const d = Math.abs(p.x - level.entry.x) + Math.abs(p.y - level.entry.y);
          if (d < bestD) { bestD = d; target = p; }
        }
        if (pool.length === 0) console.warn(`[debug] no "${kind}" prop in this level`);
      }
      if (target) {
        let best = null, bestD = Infinity;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const cx = target.x + dx, cy = target.y + dy;
          if (cx < 0 || cy < 0 || cx >= level.w || cy >= level.h) continue;
          if (level.open[cy * level.w + cx] !== 1) continue;
          const d = Math.abs(cx - level.entry.x) + Math.abs(cy - level.entry.y);
          if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
        }
        if (best) {
          const stand = cellToWorld(level, best.x, best.y);
          const tgt = cellToWorld(level, target.x, target.y);
          this.player.x = stand.x; this.player.z = stand.z;
          this.player.yaw = Math.atan2(tgt.x - stand.x, tgt.z - stand.z);
          this.input.setYaw(this.player.yaw);
        }
      }
    }

    this.enemies = spawnLevelEnemies(this, level, this.rng, depth);
    this.pickups = spawnLevelLoot(this, level, this.rng, depth);
    this.minimap.attach(level);

    if (params.get('preview')) this.stagePreviewEnemy(params.get('preview'), Number(params.get('tier') || 1));

    this.hud.setDepth(depth, this.runSeed);
    const tier = tierForDepth(depth);
    this.hud.banner(`DEPTH ${depth}`, `${biome.name}${tier > 1 ? ` · ${['', 'Tier 2', 'Tier 3', 'Tier 4'][tier - 1]} threat` : ''}`, 2200);
    sfx.play('level_start');
    music.playNext(`depth ${depth}`);
    console.info(`[level] depth=${depth} seed=${level.seed} size=${level.w} path=${check.stairDist}/${check.diameter} enemies=${this.enemies.length}`);
  }

  clearLevel() {
    for (const e of this.enemies) this.scene.remove(e.group);
    for (const p of this.pickups) { this.scene.remove(p.group); p.dispose(); }
    for (const pr of this.projectiles) { this.scene.remove(pr.mesh); pr.dispose(); }
    for (const fx of this.effects) { this.scene.remove(fx.mesh); fx.dispose(); }
    for (const n of this.numbers) { this.scene.remove(n.mesh); n.dispose(); }
    this.enemies = []; this.pickups = []; this.projectiles = []; this.effects = []; this.numbers = []; this.glints = [];
    if (this.levelView) { this.scene.remove(this.levelView.group); this.levelView.dispose(); this.levelView = null; }
  }

  descend() {
    this.score += this.depth * CFG.scorePerDepth;
    const repaired = this.player.repairArmor(CFG.armorRepairOnDescent);
    this.depth += 1;
    sfx.play('stairs_complete');
    if (repaired > 0) this.toast(`armour repaired +${repaired}`, '#5b8fd6');
    this.loadLevel(this.depth);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    document.exitPointerLock?.();
    this.menus.showPause();
    music.duck(true);
  }
  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.menus.hide();
    music.duck(false);
    this.input.requestLock();
  }

  onPlayerDeath() {
    this.player.lives -= 1;
    sfx.play('player_death');
    music.duck(this.player.lives > 0);
    if (this.player.lives <= 0) {
      this.state = 'gameover';
      document.exitPointerLock?.();
      saveRun({ seed: this.runSeed, depth: this.depth, kills: this.kills, score: this.score });
      this.menus.showGameOver({ depth: this.depth, kills: this.kills, score: this.score, seed: this.runSeed });
      return;
    }
    this.toast(`A life spent. ${this.player.lives} remain.`, '#e0483d', 3200);
    // Respawn at the level entry with full health and armour (spec §4).
    const entryCell = cellToWorld(this.level, this.level.entry.x, this.level.entry.y);
    const spot = findOpenSpot(this.level, entryCell.x, entryCell.z);
    this.player.x = spot.x; this.player.z = spot.z;
    this.player.health = this.player.maxHealth;
    if (this.player.armor) this.player.armor.durability = this.player.armor.maxDurability;
    this.player.invuln = CFG.respawnInvuln;
    this.input.setYaw(this.player.yaw);
  }

  toggleMusicMute() {
    this.musicMuted = !this.musicMuted;
    music.setMusicMuted(this.musicMuted);
    this.toast(`music ${this.musicMuted ? 'muted' : 'on'}`, '#9aa0a6');
  }

  applySettings() {
    this.input.sensitivity = this.settings.sensitivity;
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    sfx.setMasterVolume(this.settings.volume);
    this.compareMode = this.settings.compareMode;
  }

  // ---------------------------------------------------------------- frame
  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.state === 'playing') this.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  update(dt) {
    this.time += dt;
    const inp = this.input.sample();
    this.player.update(dt, inp, this.camera);
    this.applyShake(dt);
    this.viewmodel.update(dt, this.player);

    // ---- attacks
    if (this.input.consumeFire() && this.state === 'playing') this.attack();
    if (this.pendingCompare && this.input.consumeInteract()) this.acceptCompare();

    // ---- entities
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const keep = this.enemies[i].update(dt);
      if (!keep) { this.scene.remove(this.enemies[i].group); this.enemies.splice(i, 1); }
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const keep = this.pickups[i].update(dt, this.player);
      if (!keep) { this.scene.remove(this.pickups[i].group); this.pickups.splice(i, 1); }
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const keep = this.projectiles[i].update(dt);
      if (!keep) { this.scene.remove(this.projectiles[i].mesh); this.projectiles.splice(i, 1); }
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (!this.effects[i].update(dt)) { this.scene.remove(this.effects[i].mesh); this.effects.splice(i, 1); }
    }
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      if (!this.numbers[i].update(dt)) { this.scene.remove(this.numbers[i].mesh); this.numbers.splice(i, 1); }
    }
    for (let i = this.glints.length - 1; i >= 0; i--) {
      this.glints[i].t -= dt;
      if (this.glints[i].t <= 0) { this.scene.remove(this.glints[i].mesh); this.glints.splice(i, 1); }
    }

    this.billboardAll();
    this.updateLights(dt);
    this.updateFlames(dt);
    this.updateStairs(dt);
    this.updateVisibility(dt);

    this.minimap.reveal(this.player.x, this.player.z, 5.5);
    this.minimap.draw(this.player, this.enemies, this.biome, this.depth >= CFG.stairSenseDepth);
    this.hud.update(this.player, {
      drawing: this.player.drawT > 0,
      stairHint: this.stairHold > 0,
      stairHintText: `descending… ${Math.round((this.stairHold / CFG.stairHold) * 100)}%`
    });
    this.hud.setScore(this.score);
  }

  billboardAll() {
    const lists = [
      this.levelView ? this.levelView.propMeshes : [],
      this.levelView ? this.levelView.torches : [],
      this.levelView ? [this.levelView.stairMesh] : [],
      this.enemies.map(e => e.body),
      this.pickups.map(p => p.body).concat(this.pickups.map(p => p.pedestal).filter(Boolean)),
      this.projectiles.map(p => p.mesh),
      this.effects.map(f => f.mesh),
      this.numbers.map(n => n.mesh),
      this.glints.map(g => g.mesh)
    ];
    for (const list of lists) for (const m of list) if (m && m.userData.billboard) billboardTowards(m, this.camera);
  }

  updateLights(dt) {
    if (!this.levelView) return;
    const torches = this.levelView.torches;
    const camPos = this.camera.position;
    const sorted = torches
      .map(t => ({ t, d: (t.position.x - camPos.x) ** 2 + (t.position.z - camPos.z) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.lightPool.length);
    for (let i = 0; i < this.lightPool.length; i++) {
      const l = this.lightPool[i];
      const s = sorted[i];
      if (!s) { l.intensity = 0; continue; }
      const flick = 0.82 + Math.sin(this.time * (7 + i * 1.7)) * 0.09 + Math.sin(this.time * (2.3 + i)) * 0.09;
      // userData.world sits a little off the wall face, so the corridor lights evenly
      // instead of the whole pool hugging the masonry
      const wp = s.t.userData.world || s.t.position;
      l.position.set(wp.x, 1.9, wp.z);
      l.intensity = 12 * flick * Math.min(1, 40 / Math.max(1, s.d));
    }
  }

  // Torch flames wobble with the same rhythm the pooled lights already flicker at, so the
  // visible fire and the light it casts agree. Each sconce has its own phase from its
  // cell, so a hall of torches never pulses in lockstep. The flame group is based at the
  // cup rim, which is why scaling it does not slide the fire off the bracket.
  updateFlames() {
    if (!this.levelView) return;
    for (const t of this.levelView.torches) {
      const f = t.userData.flame;
      if (!f) continue;
      const p = t.userData.phase || 0;
      const h = 1 + Math.sin(this.time * 8.5 + p) * 0.11 + Math.sin(this.time * 3.1 + p * 2) * 0.06;
      f.scale.set(2 - h, h, 2 - h);      // spreads as it shortens, the way a flame does
      f.rotation.z = Math.sin(this.time * 5.5 + p) * 0.1;
    }
  }

  updateStairs(dt) {
    if (!this.levelView) return;
    const s = this.levelView.stairWorld;
    const dist = Math.hypot(this.player.x - s.x, this.player.z - s.z);
    if (dist < 1.2) {
      this.stairHold += dt;
      if (this.stairHold >= CFG.stairHold) {
        this.stairHold = 0;
        this.descend();
      }
      if (this.stairHold === dt) sfx.play('stairs_start');
    } else {
      this.stairHold = 0;
    }
  }

  updateVisibility(dt) {
    this._visT -= dt;
    if (this._visT > 0) return;
    this._visT = 0.2;
    for (const e of this.enemies) {
      if (!e.alive) { e.visible = false; continue; }
      const d = Math.hypot(e.x - this.player.x, e.z - this.player.z);
      e.visible = d < 22 && hasLineOfSight(this.level, e.x, e.z, this.player.x, this.player.z);
    }
  }

  // ---------------------------------------------------------------- combat
  attack() {
    const w = this.player.weapon;
    if (!w || !this.player.canAttack()) return;
    const act = this.player.startAttack();
    if (!act) return;
    const a = act.a;
    this.viewmodel.trigger(act.kind);
    sfx.play(w.def.sfx || 'swing_whoosh');

    if (act.kind === 'melee') {
      const dir = this.player.aimDir();
      const hits = [];
      for (const e of this.enemies) {
        if (!e.alive) continue;
        const dx = e.x - this.player.x, dz = e.z - this.player.z;
        const d = Math.hypot(dx, dz);
        if (d > a.range + e.radius) continue;
        const dot = (dx / d) * dir.x + (dz / d) * dir.z;
        const halfArc = (a.arc * Math.PI / 180) / 2;
        if (Math.acos(Math.max(-1, Math.min(1, dot))) > halfArc) continue;
        hits.push({ e, d });
      }
      hits.sort((p, q) => p.d - q.d);
      const max = a.cleave || 1;
      hits.slice(0, max).forEach(({ e }) => {
        const [j0, j1] = [0.9, 1.1];
        const jit = j0 + (j1 - j0) * Math.random();
        const crit = Math.random() < (a.crit || 0.12);
        const dmg = Math.max(1, Math.round(w.damage * jit * (crit ? a.critMult : 1)));
        e.hurt(dmg, { crit });
        // 1.6 m, not 1.4: the swing has 0.22 s to be read while the player is moving, and
        // at 1.4 the arc was a sliver in the corner of the eye
        this.spawnVfx('vfx/slash_arc', (this.player.x + e.x) / 2, (this.player.z + e.z) / 2, 1.6, 0.22, 1.35);
      });
      if (!hits.length) sfx.play('swing_whoosh');
      return;
    }

    // ranged
    const dir = this.player.aimDir();
    const crit = Math.random() < (a.crit || 0.15);
    const dmg = Math.max(1, Math.round(w.damage * (0.92 + Math.random() * 0.16) * (crit ? a.critMult : 1)));
    this.projectiles.push(new Projectile(this, {
      x: this.player.x + dir.x * 0.4, z: this.player.z + dir.z * 0.4, y: 1.35,
      speed: a.speed, life: a.range / a.speed, damage: dmg, hostile: false,
      sprite: 'vfx/arrow', size: 0.34, dir, crit
    }));
    sfx.play('bow_draw');
    setTimeout(() => sfx.play('bow_release'), Math.round((a.draw || 0.3) * 1000));
  }

  damagePlayer(amount, source, opts = {}) {
    if (this.state !== 'playing' || !this.player.alive) return;
    const res = this.player.takeDamage(amount, opts);
    if (res.blocked) return;
    sfx.play('player_hurt');
    this.hud.update(this.player);
    if (source) {
      const dx = source.x - this.player.x, dz = source.z - this.player.z;
      this.shake(Math.min(0.35, res.toHp / 60), Math.atan2(dx, dz) - this.player.yaw);
    }
    if (res.toHp > 0) this.toast(`-${res.toHp}${res.pierce ? ' (pierces armour)' : ''}`, '#e0483d', 1200);
    if (this.player.health <= 0) {
      this.player.health = 0;
      this.onPlayerDeath();
    }
  }

  applyShake(dt) {
    const sh = this.camera.userData.shake || 0;
    if (sh <= 0) return;
    const bearing = this.camera.userData.bearing || 0;
    const amt = sh * 0.22;
    this.camera.position.x += Math.cos(bearing) * amt * (Math.random() - 0.5);
    this.camera.position.z += Math.sin(bearing) * amt * (Math.random() - 0.5);
    this.camera.position.y += amt * (Math.random() - 0.5);
    this.camera.userData.shake = Math.max(0, sh - dt * 2.2);
  }

  shake(amount, bearing) {
    this.camera.userData.shake = amount;
    this.camera.userData.bearing = bearing;
  }

  onArmorBroken() {
    sfx.play('armor_break');
    this.toast('Your armour breaks.', '#f5a524');
  }

  onEnemyDeath(enemy) {
    this.kills += 1;
    const tier = enemy.isBoss ? 2 : 1;
    this.score += CFG.scorePerKill * tier * enemy.tier;
    rollDrops(this, enemy, this.rng);
    // slime split (spec §17.9)
    const split = enemy.fam.split;
    if (split && !enemy.isBoss && this.rng.chance(split.chance)) {
      for (let i = 0; i < split.count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const cell = {
          x: Math.floor((enemy.x + Math.cos(ang) * 1.4) / CFG.cell),
          y: Math.floor((enemy.z + Math.sin(ang) * 1.4) / CFG.cell)
        };
        if (!this.level.open[cell.y * this.level.w + cell.x]) continue;
        const child = new Enemy(this, { ...enemy.fam, tierMult: { hp: [1, 1, 1, 1], dmg: [1, 1, 1, 1] } }, 1, cell, { hpScale: split.hpScale });
        this.enemies.push(child);
        this.scene.add(child.group);
      }
    }
  }

  // ---------------------------------------------------------------- pickups
  makePickup(item, x, z, opts = {}) {
    const p = new Pickup(this, item, x, z, opts);
    this.pickups.push(p);
    this.scene.add(p.group);
    return p;
  }

  onPickup(pickup) {
    const item = pickup.item;
    const p = this.player;
    if (item.slot === 'score') {
      this.score += item.score;
      sfx.play('salvage');
      return;
    }
    if (item.slot === 'instant') {
      if (item.heal) {
        const got = p.heal(item.heal);
        sfx.play('heal');
        this.toast(`+${got} health`, '#4fd18b');
      }
      if (item.lives) {
        if (p.lives < CFG.livesCap) { p.lives += item.lives; this.toast('+1 life', '#f5a524'); }
        else { this.score += 150; this.toast('lives full — +150', '#f5a524'); }
        sfx.play('extra_life');
      }
      if (item.repair) {
        const got = p.repairArmor(item.repair);
        this.toast(got > 0 ? `armour +${got}` : 'no armour to repair', got > 0 ? '#5b8fd6' : '#9aa0a6');
        sfx.play('equip_upgrade');
      }
      this.hud.update(p);
      return;
    }

    if (item.slot === 'weapon' || item.slot === 'armor') {
      const current = item.slot === 'weapon' ? p.weapon : p.armor;
      if (!isBetter(item, current)) {
        this.score += item.score;
        sfx.play('salvage');
        this.toast(`salvaged ${item.label} +${item.score}`, '#9aa0a6');
        return;
      }
      if (this.compareMode) {
        this.pendingCompare = { item, slot: item.slot };
        const cur = item.slot === 'weapon'
          ? { label: current?.label, stat: `${current?.damage ?? 0} dmg` }
          : { label: current?.label, stat: `${current?.maxDurability ?? 0} dur` };
        const nxt = item.slot === 'weapon' ? { label: item.label, stat: `${item.damage} dmg` } : { label: item.label, stat: `${item.maxDurability} dur` };
        this.toast(`EQUIP ${nxt.label} (${nxt.stat}) over ${cur.label || 'nothing'} (${cur.stat})?  [E]`, item.color, 3000);
        sfx.play('pickup_gear');
        return;
      }
      this.equip(item);
    }
  }

  acceptCompare() {
    if (!this.pendingCompare) return;
    this.equip(this.pendingCompare.item);
    this.pendingCompare = null;
  }

  equip(item) {
    const p = this.player;
    if (item.slot === 'weapon') {
      p.weapon = item;
      this.viewmodel.setWeapon(item);
      this.hud.flashGear('weapon');
    } else {
      item.durability = item.maxDurability;
      p.armor = item;
      this.hud.flashGear('armor');
    }
    const old = item.slot === 'weapon' ? `${item.damage} dmg` : `${item.maxDurability} dur`;
    this.toast(`EQUIPPED ${item.label} (${old})`, item.color);
    sfx.play('equip_upgrade');
    this.hud.setGear(p);
    this.hud.update(p);
  }

  // ---------------------------------------------------------------- helpers
  spawnProjectile(cfg) {
    const pr = new Projectile(this, cfg);
    this.projectiles.push(pr);
    this.scene.add(pr.mesh);
    return pr;
  }

  spawnVfx(key, x, z, size, life, y, maxOpacity) {
    const fx = new Vfx(key, x, z, size, life, y, maxOpacity);
    this.effects.push(fx);
    this.scene.add(fx.mesh);
    return fx;
  }

  showDamage(x, y, z, amount, crit) {
    const n = new DamageNumber(`${Math.round(amount)}${crit ? '!' : ''}`, x, y, z, crit ? '#f5a524' : '#ffffff', crit);
    this.numbers.push(n);
    this.scene.add(n.mesh);
  }

  showGlint(x, z, life) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({ map: undefined, color: 0xfff2c0, transparent: true, opacity: 0.5, toneMapped: false })
    );
    mesh.position.set(x, 1.35, z);
    mesh.userData.billboard = true;
    this.glints.push({ mesh, t: Math.min(0.3, life) });
    this.scene.add(mesh);
  }

  playerLook() { return this.player.aimDir(); }

  enemyAt(x, z, pad) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (Math.hypot(e.x - x, e.z - z) < e.radius + pad) return e;
    }
    return null;
  }

  nearestEnemy(x, z, maxDist) {
    let best = null, bd = maxDist;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  toast(text, color, ms) { this.toasts.show(text, color, ms); }

  // QA affordance: ?preview=orc&tier=2 stages one enemy 3 m in front of the player
  // so a freshly generated sprite can be reviewed in-scene without a full run.
  stagePreviewEnemy(familyId, tier, dist = 3.2) {
    const fam = enemiesData.families.find(f => f.id === familyId);
    if (!fam) { console.warn('[preview] unknown family', familyId); return; }
    const dir = this.player.aimDir();
    const cell = {
      x: Math.floor((this.player.x + dir.x * dist) / CFG.cell),
      y: Math.floor((this.player.z + dir.z * dist) / CFG.cell)
    };
    if (!this.level.open[cell.y * this.level.w + cell.x]) return;
    const e = new Enemy(this, { ...fam, tierMult: enemiesData.tierMult }, tier, cell);
    e.x = this.player.x + dir.x * dist;
    e.z = this.player.z + dir.z * dist;
    e.body.position.set(e.x, e.height / 2, e.z);
    e.shadow.position.set(e.x, 0.03, e.z);
    e.cooldown = 999;         // do not hit the reviewer in the face
    this.enemies.push(e);
    this.scene.add(e.group);
    return e;
  }

  // Layout fingerprint for a seed — used by the self-test to prove reproducibility.
  buildSeedSnapshot(seed) {
    const l = buildLevel(1, seed);
    let sum = 0;
    for (let i = 0; i < l.open.length; i++) sum = (sum * 31 + l.open[i]) >>> 0;
    return `${l.w}x${l.h} grid=${sum} entry=${l.entry.x},${l.entry.y} stair=${l.stair.x},${l.stair.y} path=${l.pathLen} enemies=${l.spawnable.length}`;
  }

  bestRuns() { return bestRuns(); }

  applyFrameAssets() {
    // CSS frames come from the generated UI sprites when they exist.
    const map = {
      '--frame-health': 'ui/bar_frame_health',
      '--frame-armor': 'ui/bar_frame_armor',
      '--frame-panel': 'ui/frame_panel',
      '--frame-banner': 'ui/frame_banner'
    };
    const root = document.documentElement;
    for (const [varName, key] of Object.entries(map)) {
      if (hasAsset(key)) root.style.setProperty(varName, `url(${assetUrl(key)})`);
    }
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }
}

const DEFAULT_SETTINGS = { sensitivity: 0.0022, fov: CFG.fov, volume: 0.7, compareMode: false };

export { CFG, tierFor, bandFor, levels };
