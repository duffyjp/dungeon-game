// STRATA: Descent — game orchestration (spec §4 loop, §7 combat, §8 pickups, §9 descent).
//
// Run flow: menu -> playing -> (paused) -> death -> respawn or gameover.
// Every level goes through buildLevel(), which only returns a level that passes the
// solvability contract in §9.1; if generation could not satisfy it, we surface that
// rather than shipping an unbeatable maze.

import * as THREE from 'three';
import { CFG } from './config.js';
import { Rng } from './util/rng.js';
import { buildLevel, validateLevel, tierFor, bandFor, biomeForDepth } from './world/levelGen.js';
import { buildLevelView, billboardTowards, cellToWorld } from './world/levelView.js';
import { hasLineOfSight, findOpenSpot } from './world/collision.js';
import { spawnLevelEnemies, spawnLevelLoot, rollDrops, tierForDepth, enemiesData } from './world/spawner.js';
import { Enemy } from './entity/enemy.js';
import { Pickup } from './entity/pickup.js';
import { Player, Viewmodel } from './entity/player.js';
import { Projectile, Vfx, DamageNumber, unitQuad } from './entity/effects.js';
import { Input } from './input.js';
import { Hud } from './ui/hud.js';
import { Minimap } from './ui/minimap.js';
import { Toasts } from './ui/toasts.js';
import { Menus } from './ui/menus.js';
import * as sfx from './audio/sfx.js';
import * as music from './audio/music.js';
import { preloadAll, hasAsset, assetKeys, assetUrl, warmAssets } from './render/assets.js';
import { loadFrames, cachedFrameTextures } from './render/animation.js';
import { biomeAssetKeys, propAssetKeys, enemyAssetKeys, enemyClipEntries, commonAssetKeys, nextTierAssetKeys, vfxAssetKeys } from './world/levelAssets.js';
import { loadSettings, saveRun, bestRuns } from './util/storage.js';
import { isBetter, useQualityTable } from './loot/quality.js';
import biomes from '../data/biomes.json';
import levels from '../data/levels.json';
import itemsData from '../data/items.json';
import qualityTable from '../data/quality.json';

useQualityTable(qualityTable);

const params = new URLSearchParams(location.search);

// ?bump=N re-scales every surface normal map in the scene. It exists because "is the bump
// mapping even on?" is a question that should be answered by a number on screen, not by
// squinting: load the same depth with ?bump=0 and ?bump=8 and the difference is undeniable,
// while the shipped value is deliberately modest.
{
  const b = Number(params.get('bump'));
  if (params.has('bump') && Number.isFinite(b)) CFG.bumpScale = b;
  // ?disp=N sets subdivisions per wall face; 0 turns displacement off entirely and returns
  // the walls to a 24-vertex box.
  const d = Number(params.get('disp'));
  if (params.has('disp') && Number.isFinite(d)) CFG.displacementSegments = Math.max(1, Math.round(d));
}

export class Game {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.overlay = document.getElementById('overlay');

    // Performance A/B knobs, so a suspected cause can be tested without editing code:
    //   ?ratio=1    render at 1 device pixel per CSS pixel instead of up to 2 (that is 4x the
    //               fragments, and every fragment runs every light)
    //   ?lights=6   size the pooled torch lights - each one is a BRDF evaluation per fragment
    //   ?aa=0       drop multisample antialiasing (cheap to lose above 1x, costly at 2x)
    //   ?disp=0     flat walls instead of height-displaced ones
    //   ?profile=1  frame-time percentiles on screen, with the CPU/GPU split
    const q = new URLSearchParams(location.search);
    this.q = q;
    if (Number(q.get('lights')) > 0) CFG.lightPool = Number(q.get('lights'));
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: q.get('aa') !== '0', powerPreference: 'high-performance' });
    this.ratioCap = Number(q.get('ratio')) > 0 ? Number(q.get('ratio')) : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.ratioCap));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.perfOn = q.get('profile') === '1';
    this.noScene = q.get('noscene') === '1';
    this.perf = { iv: [], upSum: 0, rdSum: 0, n: 0, since: 0, minIv: Infinity };
    if (this.perfOn) {
      const d = document.createElement('div');
      d.className = 'perfhud';
      document.body.appendChild(d);
      this.perfHud = d;
    }

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
    // A fullscreen transition changes the drawing-buffer size, and the compositor settles a
    // beat after the event fires. Resize on the event and once more on the next frame, or the
    // scene keeps the old aspect and looks stretched on one side.
    document.addEventListener('fullscreenchange', () => {
      this.onResize();
      requestAnimationFrame(() => this.onResize());
    });
  }

  // ---------------------------------------------------------------- fullscreen
  // Real element fullscreen, not the browser's own F11: that hides browser chrome but leaves
  // the canvas at its CSS size, so the picture is the same resolution stretched over a bigger
  // window. Going through requestFullscreen lets the renderer resize to the panel's native
  // pixel count, which is the difference between a bigger window and a sharper one.
  async toggleFullscreen() {
    const el = document.documentElement;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return false;
      }
      const req = el.requestFullscreen
        ? el.requestFullscreen({ navigationUI: 'hide' })
        : el.webkitRequestFullscreen ? Promise.resolve(el.webkitRequestFullscreen()) : null;
      if (!req) {
        this.toast('Fullscreen is not available in this browser', '#e0483d');
        return false;
      }
      await req;
      this.onResize();
      return Boolean(document.fullscreenElement);
    } catch (err) {
      // Browsers refuse fullscreen that was not triggered by a gesture the user made, which
      // is a policy outcome rather than a bug — say so instead of failing silently.
      this.toast(`Fullscreen refused by the browser: ${err.name || err.message}`, '#e0483d');
      return false;
    }
  }

  // ---------------------------------------------------------------- lifecycle
  async boot() {
    const keys = assetKeys();
    this.loadedAssetCount = keys.length;
    // The self-test exercises logic only, so it does not wait on decoding tens of
    // megabytes of generated art. Use ?selftest=1&assets=1 to test the art path too.
    const skipArt = params.get('selftest') && params.get('assets') !== '1';
    if (skipArt) this.placeholderArt = true;
    // Nothing heavy is decoded before the menu: the library used to be loaded up front, which
    // delayed first play by several seconds and still left the animated clips arriving during
    // play. Boot loads only what the harness asks for (?assets=1 warms everything so the art
    // checks have real pixels), and the first descent takes the common set behind the progress
    // bar along with its own level art.
    const wantAll = params.get('assets') === '1';
    const { failed } = skipArt || !wantAll ? { loaded: 0, failed: [] } : await preloadAll(keys);
    if (failed.length) console.warn('[assets] failed to load:', failed.slice(0, 8));
    console.info(`[assets] ${keys.length} generated images available from z_image_turbo${skipArt ? ' (skipped in selftest)' : ''}`);
    this.applyFrameAssets();
    await music.loadManifest();
    // The sound bank is small (35 files, ~1.4 MB) and the first things a player hears are menu
    // clicks, so it is fetched in the background while the menu is up rather than on first use.
    // If the first descent arrives before it finishes, the loading bar picks up the remainder.
    sfx.warmAll().then((r) => { this.sfxWarmed = true; if (r.failed) console.warn('[sfx] effects failed to decode:', r.failed); }).catch(() => {});
    this.state = 'menu';
    this.showMenu();
    // Awaited on the demo/QA path so a harness that photographs or probes a depth does not
    // arrive while its art is still loading.
    if (params.get('demo')) await this.startRun(params.get('seed') || 'demo', Number(params.get('depth') || 1));
    this.loop();
  }

  // The menu is not a black page with a card on it any more: a real depth-1 crypt is built and
  // orbited slowly behind it, the way Minecraft shows a landscape behind its title. Everything
  // the menu needs is the same level pipeline the game uses, so nothing here is a second
  // renderer to keep honest - only the run-only parts (banner, HUD, music cue, level_start
  // sting, state transition) are switched off.
  showMenu() {
    this.state = 'menu';
    this.menus.showMain();
    this.enterMenuChrome();
    // ?menuworld=0 skips the backdrop for the QA tools, which decide a page has finished by
    // waiting for it to go quiet - a permanently orbiting scene never does. ?orbit=0 slows it to
    // a standstill instead, so a screenshot can still show the world behind the card.
    if (params.get('menuworld') === '0') return;
    if (!this.level) {
      this.menuWorld = this.loadLevel(1, 0, { menu: true }).catch((e) => {
        console.warn('[menu] could not build the backdrop level:', e.message);
      });
    }
  }

  enterMenuChrome() {
    document.body.classList.add('menu-view');
    this.overlay.classList.add('no-chrome');
    if (this.viewmodel) this.viewmodel.group.visible = false;
  }

  exitMenuChrome() {
    document.body.classList.remove('menu-view');
    this.overlay.classList.remove('no-chrome');
    if (this.viewmodel) this.viewmodel.group.visible = true;
  }

  // Ambient upkeep while the menu is up: the camera turns, torches flicker, the light pool
  // follows it, and standing monsters keep breathing. No player control, no AI, no combat -
  // the world is a view, not a simulation the player can affect.
  updateMenu(dt) {
    this.time += dt;
    const orbit = params.has('orbit') ? Number(params.get('orbit')) : CFG.menuOrbitDegPerSec;
    this.menuYaw = (this.menuYaw || this.player.yaw) + THREE.MathUtils.degToRad(orbit) * dt;
    this.player.yaw = this.menuYaw;
    this.camera.position.set(this.player.x, CFG.eye, this.player.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.menuYaw);
    this.camera.rotateX(THREE.MathUtils.degToRad(CFG.menuPitchDeg));
    for (const e of this.enemies) if (e.alive) e.tickAnimation(dt, 0);
    this.billboardAll();
    this.updateLights(dt);
    this.updateFlames(dt);
    this.updateVisibility(dt);
  }

  async startRun(seed = this.runSeed, depth = 1) {
    sfx.initAudio();
    sfx.resumeAudio();
    this.runSeed = String(seed);
    this.depth = depth;
    this.score = 0;
    this.kills = 0;
    this.player.health = CFG.maxHealth;
    this.player.lives = CFG.startLives;
    this.player.melee = null;
    this.player.ranged = null;
    this.player.weapon = null;
    this.player.arrows = 0;
    this.player.armor = null;
    this.equipInitial();
    this.toasts.clear();
    // A page cannot put itself in fullscreen; the browser only allows it on a gesture the user
    // made. The click that started this run is that gesture, so the screen goes big here rather
    // than making the player hunt for a button. Opt out with the settings checkbox or
    // ?fullscreen=0. The QA and harness paths skip it so screenshots and tests keep a stable
    // viewport, and entering fullscreen can drop the pointer lock, so the lock is asked for
    // after the transition settles as well as before it.
    this.state = 'loading';
    this.exitMenuChrome();
    this.menus.hide();
    const autoFs = this.settings.autoFullscreen !== false && params.get('fullscreen') !== '0'
      && !params.get('selftest') && !params.get('demo');
    if (autoFs && !document.fullscreenElement) {
      // Do not also ask for the lock here: Chrome refuses a pointer lock requested while the
      // fullscreen transition is in flight and logs a scary denial for it. The lock is requested
      // when the transition lands, and the click-to-lock fallback covers any refusal after that.
      this.toggleFullscreen().then((ok) => { if (ok) this.input.requestLock(); });
    } else {
      this.input.requestLock();
    }
    await this.loadLevel(depth);
  }

  equipInitial() {
    const def = itemsData.items.find(i => i.id === itemsData.startingWeapon);
    const inst = { def, id: def.id, slot: 'weapon', sprite: def.sprite, damage: def.base, score: def.base, tierIndex: 0, color: '#e6e8ea', label: def.name, quality: 1, jitter: 1 };
    this.player.melee = inst;
    this.player.selectWeapon('melee');
    this.viewmodel.setWeapon(inst);
    this.hud.setGear(this.player);
  }

  // Wrapped so the in-flight load is reachable: `await game.loading` is how the harness, and
  // anything else, waits for a depth that was started by a key press rather than by a call site
  // it controls.
  loadLevel(depth, retry = 0, opts = {}) {
    this.loading = this._loadLevel(depth, retry, opts);
    return this.loading;
  }

  async _loadLevel(depth, retry = 0, opts = {}) {
    const menu = Boolean(opts.menu);
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
      await this.loadLevel(depth, retry + 1, opts);
      return;
    }
    this.clearLevel();
    this.level = level;
    this.depth = depth;
    this.rng = new Rng(`${this.runSeed}:L${depth}`);

    const biome = biomes[level.biome];
    this.biome = biome;
    // Everything this depth is going to draw arrives before it is playable. Loading it lazily
    // instead meant a new biome's walls, a tier's first monster and that monster's first step
    // each downloaded and decoded mid-fight, which is the hitching the owner heard about.
    // In menu mode the state stays 'menu' and no progress card is shown: the backdrop appears
    // when it is ready, and the card the player is reading is the menu itself.
    if (!menu) this.state = 'loading';
    await this.preloadLevelAssets(level, biome, menu);
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

    // ?at=loot stands next to the nearest treasure pedestal and looks at it; add &bow=1 to
    // pick the nearest pedestal holding a bow, which is the one that has to show a quiver.
    if (params.get('at') === 'loot') this.standAtNearestLoot(Boolean(params.get('bow')));

    const previewed = params.get('preview') ? this.stagePreviewEnemy(params.get('preview'), Number(params.get('tier') || 1)) : null;
    // ?previewshoot=1 makes the staged creature loose its shot immediately, so a screenshot
    // can see what a projectile actually looks like leaving the muzzle.
    if (previewed && params.get('previewshoot')) {
      previewed.cooldown = 0;
      previewed.landAttack();
      // Nudge the frozen shot clear of the shooter's own art, which also has an arrow
      // painted on it, so a screenshot can tell the two apart.
      const pr = this.projectiles[this.projectiles.length - 1];
      if (pr) { pr.x += pr.dx * 1.6; pr.z += pr.dz * 1.6; pr.mesh.position.set(pr.x, pr.y, pr.z); }
    }

    // QA aid: ?arrows=6 hands over a bow and a quiver, ?shoot fires once on arrival, and
    // ?freeze holds shots in mid-air so a screenshot can look at an arrow in flight.
    if (params.get('arrows')) {
      const bowDef = itemsData.items.find(i => i.id === 'bow_war');
      this.equip({ def: bowDef, id: bowDef.id, slot: 'weapon', sprite: bowDef.sprite, damage: 22, score: 26, tierIndex: 2, color: '#f5a524', label: 'War Bow', jitter: 1, quality: 1 });
      this.player.arrows = Number(params.get('arrows')) || 3;
      this.selectWeaponSlot('ranged');
      this.hud.setGear(this.player);
      if (params.get('shoot')) {
        this.player.attackCd = 0;
        this.attack();
        // ?mark=1 pushes the frozen shot downrange: at arm's length it hides behind the
        // viewmodel, which tells a screenshot nothing.
        const pr = this.projectiles[this.projectiles.length - 1];
        if (pr && params.get('mark')) {
          pr.x += pr.dx * 2.6; pr.z += pr.dz * 2.6; pr.y = 1.5;
          pr.mesh.position.set(pr.x, pr.y, pr.z);
          // ?turn=90 swings the head round after the shot, so the same frozen arrow can be
          // photographed crossing the view instead of receding down it.
          if (params.get('turn')) {
            const t = this.player.yaw + Number(params.get('turn')) * Math.PI / 180;
            this.player.yaw = t; this.input.setYaw(t);
          }
        }
      }
    }
    if (params.get('freeze')) this.freezeProjectiles = true;
    // ?pause=1 comes back paused, which is how you photograph the pause card.
    if (params.get('pause')) setTimeout(() => this.pause(), 120);

    if (!menu) {
      this.hud.setDepth(depth, this.runSeed);
      const tier = tierForDepth(depth);
      this.hud.banner(`DEPTH ${depth}`, `${biome.name}${tier > 1 ? ` · ${['', 'Tier 2', 'Tier 3', 'Tier 4'][tier - 1]} threat` : ''}`, 2200);
      sfx.play('level_start');
      music.playNext(`depth ${depth}`, { biome: level.biome, boss: this.enemies.some(e => e.isBoss) });
    }
    console.info(`[level]${menu ? ' menu backdrop' : ''} depth=${depth} seed=${level.seed} size=${level.w} path=${check.stairDist}/${check.diameter} enemies=${this.enemies.length}`);

    // The scene exists now, so bring the GPU up to speed before the player can move. three.js
    // uploads a texture the first time it is drawn and compiles a material's shader the first
    // time that combination is used - and both land as a stall on the first frames of a level.
    // The profiler showed a 1078 ms spike at entry and programs climbing from 12 to 21 in the
    // middle of a fight, neither of which a network panel can reveal: the bytes were already
    // there, it was the driver doing the work at the worst possible moment.
    // Effects, projectiles and damage numbers make their materials the first time they are
    // used, and this GPU has no parallel shader compile - each new variant blocks the main
    // thread where the player feels it. Put one of each off-level so the compile pass below
    // covers them, then clear the props away. The materials stay cached either way.
    if (!menu) {
      const fxWarmed = this.prewarmEffects();
      await this.warmGpu();
      this.clearWarmEffects();
    }
    this.hideLoadProgress();
    if (menu) {
      // The backdrop is ready: start the orbit from wherever the player was placed and keep the
      // run chrome (weapon in hand, HUD) off the screen.
      this.menuYaw = this.player.yaw;
      this.enterMenuChrome();
    } else if (this.state === 'loading') {
      this.state = 'playing';
    }
  }

  // Spawn one of every effect kind (and a damage number, crit and normal, plus a pickup glint)
  // far below the level, where the camera will never see it.
  prewarmEffects() {
    let n = 0;
    for (const key of vfxAssetKeys()) { this.spawnVfx(key, -900, -900, 1, 0.05); n++; }
    this.showGlint(-900, -900, 0.05);
    this.showDamage(-900, 1, -900, 12, false);
    this.showDamage(-900, 1, -900, 34, true);
    return n;
  }

  clearWarmEffects() {
    for (const f of this.effects) this.scene.remove(f.mesh);
    for (const nm of this.numbers) this.scene.remove(nm.mesh);
    for (const g of this.glints) this.scene.remove(g.mesh);
    this.effects.length = 0; this.numbers.length = 0; this.glints.length = 0;
  }

  // Push every texture this depth can draw to the GPU and compile every shader variant the
  // scene will need, while the loading card is still up.
  async warmGpu() {
    const t0 = performance.now();
    const seen = new Set();
    let uploads = 0;
    const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'displacementMap'];
    const touch = (tex) => {
      if (!tex || !tex.isTexture || seen.has(tex)) return;
      seen.add(tex);
      try { this.renderer.initTexture(tex); uploads++; } catch (e) { /* one bad texture is not worth failing a level over */ }
    };
    this.scene.traverse(o => {
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) for (const k of MAPS) touch(m[k]);
    });
    // Animation frames are bound only when a monster moves, so first draw is normally mid-fight.
    for (const tex of cachedFrameTextures()) touch(tex);

    const before = this.renderer.info.programs.length;
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch (e) {
      this.renderer.compile(this.scene, this.camera);
    }
    this.lastGpuWarm = { uploads, programs: this.renderer.info.programs.length, compiled: this.renderer.info.programs.length - before, ms: Math.round(performance.now() - t0) };
    console.info(`[gpu] depth ${this.depth}: ${this.lastGpuWarm.uploads} textures uploaded, ${before} -> ${this.lastGpuWarm.programs} programs, ${(this.lastGpuWarm.ms / 1000).toFixed(1)}s`);
    return this.lastGpuWarm;
  }

  // Download and decode everything this depth will draw before it becomes playable, with a
  // progress bar so the wait has a shape. The expensive part is usually not the request but the
  // decode plus the mirror/downscale passes, and animation clips are worse still: a clip is 18
  // frames pushed through ImageDecoder and canvas copies, which is the stutter people feel when
  // a monster first moves.
  async preloadLevelAssets(level, biome, quiet = false) {
    const enemyKeys = enemyAssetKeys(this.depth);
    const keys = new Set([...biomeAssetKeys(biome), ...propAssetKeys(level), ...enemyKeys]);
    // Item icons, effects and HUD frames can be needed at any moment in the run, so they ride
    // along with the first descent rather than delaying the menu.
    if (!this.commonWarmed) { this.commonWarmed = true; for (const k of commonAssetKeys()) keys.add(k); }
    const clips = enemyClipEntries(enemyKeys);
    // The sound bank is part of the blocking load on the first depth: 35 files, about 1.4 MB,
    // and play() used to fetch and decode an effect the first time it fired. That is a network
    // round trip inside a sword swing - 56 ms for a single already-cached effect on the dev
    // server, because even a cached file pays a 304 revalidation.
    const sfxJobs = this.sfxWarmed ? 0 : sfx.warmableCount();
    const total = keys.size + clips.length + sfxJobs;
    const t0 = performance.now();
    let done = 0;
    const show = (d, t) => { if (!quiet) this.showLoadProgress(d, t); };
    show(0, total);
    await warmAssets(keys, (d) => { done = d; show(done, total); });
    done = keys.size;
    await Promise.all(clips.map(e => loadFrames(e).then(() => { done++; show(done, total); })));
    if (sfxJobs) {
      await sfx.warmAll((d) => { done = keys.size + clips.length + d; show(done, total); });
      this.sfxWarmed = true;
    }
    // The card stays up: _loadLevel hides it after the GPU has been brought up to speed, so the
    // upload and shader-compile work is inside the wait rather than inside the first fight.
    this.lastPreload = { depth: this.depth, images: keys.size, clips: clips.length, sfx: sfxJobs, ms: Math.round(performance.now() - t0) };
    console.info(`[preload] depth ${this.depth}: ${keys.size} images, ${clips.length} clips and ${sfxJobs} effects in ${(this.lastPreload.ms / 1000).toFixed(1)}s`);

    // While the player is fighting, warm what the next band will need. A biome or tier change
    // lands on a descent, and paying for it at the moment of the transition is exactly the
    // hitch this whole pass is trying to remove. Music is warmed here rather than in the bar:
    // a cue is 2-5 MB, and a track that starts mid-download is heard as a slow fade-in.
    const later = [...nextTierAssetKeys(this.depth), ...biomeAssetKeys(biomes[biomeForDepth(this.depth + 3)] || {})];
    setTimeout(() => {
      if (later.length) warmAssets(later).catch(() => {});
      music.warmTracksFor(level.biome);
    }, 2500);
  }

  showLoadProgress(done, total) {
    if (!this.loadEl) {
      const el = document.createElement('div');
      el.className = 'loadcard';
      el.setAttribute('aria-live', 'polite');
      el.innerHTML = '<div class="loadtitle">DESCENT</div><div class="loadbar"><i></i></div><div class="loadfine"></div>';
      document.body.appendChild(el);
      this.loadEl = el;
    }
    const pct = total ? Math.round((done / total) * 100) : 0;
    this.loadEl.querySelector('.loadbar i').style.width = `${pct}%`;
    this.loadEl.querySelector('.loadfine').textContent = `depth ${this.depth} · ${done}/${total} assets`;
    this.loadEl.hidden = false;
  }

  hideLoadProgress() { if (this.loadEl) this.loadEl.hidden = true; }

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

  // Playtest cheat, typed on the pause screen: L then one or two digits jumps the run to
  // that depth. Deliberately a remembered chord rather than a menu button, so it cannot
  // fire by accident mid-fight, and it goes through the ordinary level-load path so a
  // jumped-to depth is a real generated level with real spawns, not a shortcut past the
  // generator.
  async cheatToDepth(digits) {
    const n = parseInt(String(digits), 10);
    if (!Number.isFinite(n) || n < 1) return false;
    const depth = Math.min(99, n);
    this.depth = depth;
    // Awaited, so the resume does not hand the player back control before the jumped-to depth
    // has finished preparing.
    await this.loadLevel(depth);
    this.resume();
    this.toast(`cheat: depth ${depth}`, '#f5a524', 2000);
    console.info(`[cheat] jumped to depth ${depth}`);
    return true;
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
    if (!this.perfOn) {
      if (this.state === 'playing') this.update(dt);
      else if (this.state === 'menu' && this.level) this.updateMenu(dt);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // With ?profile=1 the loop reports what a frame actually cost. render() returns before the
    // GPU is done, so the number that matters is the interval between frames - that is the one
    // the player feels, and it includes whatever the GPU is holding back. The update/render split
    // is the CPU attribution: if the interval is 30 ms and the CPU parts are 3 ms, the cost is
    // in the fragment work, not the game logic.
    const t0 = performance.now();
    if (this.state === 'playing') this.update(dt);
    else if (this.state === 'menu' && this.level) this.updateMenu(dt);
    const t1 = performance.now();
    // ?noscene=1 answers the one question the other knobs cannot: if the frame interval is still
    // ~33 ms with nothing rendered, the ceiling is the display or the browser's compositing, not
    // our drawing at all.
    if (!this.noScene) this.renderer.render(this.scene, this.camera);
    const t2 = performance.now();
    // Only measure a real gap between two rAF callbacks. Seeding the first sample with the clock
    // delta put a fake 2-16 ms value into the buffer and made `raf min` meaningless.
    if (this._lastFrame) this.samplePerf(t2 - this._lastFrame, t1 - t0, t2 - t1);
    this._lastFrame = t2;
  }

  samplePerf(intervalMs, updateMs, renderMs) {
    const p = this.perf;
    p.iv.push(intervalMs);
    if (p.iv.length > 900) p.iv.shift();
    // The shortest interval seen is the cadence the browser is handing us. If the median sits on
    // it, the game is not slow - the frame clock is.
    p.minIv = Math.min(p.minIv || Infinity, intervalMs);
    p.upSum += updateMs; p.rdSum += renderMs; p.n++;
    p.since += intervalMs;
    if (p.since < 2000) return;
    p.since = 0;
    const s = p.iv.slice().sort((a, b) => a - b);
    const q = f => s[Math.min(s.length - 1, Math.floor(s.length * f))];
    const info = this.renderer.info.render;
    const line = `[perf] frame p50 ${q(0.5).toFixed(1)}ms p95 ${q(0.95).toFixed(1)} p99 ${q(0.99).toFixed(1)} ` +
      `max ${s[s.length - 1].toFixed(1)} (raf min ${p.minIv.toFixed(1)}, ${p.iv.length ? (1000 / (s.reduce((a, b) => a + b, 0) / s.length)).toFixed(0) : 0} loops/s) | ` +
      `cpu update ${(p.upSum / p.n).toFixed(1)}ms + submit ${(p.rdSum / p.n).toFixed(1)}ms | ` +
      `${info.calls} draws, ${(info.triangles / 1000).toFixed(0)}k tris, ${this.renderer.info.programs.length} programs | ` +
      `pixel ratio ${this.renderer.getPixelRatio()}, ${this.lightPool.length} pooled lights`;
    console.info(line);
    this.perfLine = line;
    if (this.perfHud) {
      this.perfHud.textContent =
        `frame p50 ${q(0.5).toFixed(1)}  p95 ${q(0.95).toFixed(0)}  p99 ${q(0.99).toFixed(0)}  max ${s[s.length - 1].toFixed(0)} ms` +
        `  ·  cpu ${(p.upSum / p.n).toFixed(1)}+${(p.rdSum / p.n).toFixed(1)} ms` +
        `  ·  ${info.calls} draws ${(info.triangles / 1000).toFixed(0)}k tris` +
        `  ·  ${this.renderer.getPixelRatio()}x pixels, ${this.lightPool.length} lights`;
    }
    p.upSum = 0; p.rdSum = 0; p.n = 0;
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
    // The map used to be repainted every frame: a 2D canvas full of cell rectangles, inside the
    // frame budget, for something that only needs to keep up with the player's dot. At 20 Hz it
    // looks identical and stops competing with the scene.
    this._mapT = (this._mapT || 0) - dt;
    if (this._mapT <= 0) {
      this._mapT = 1 / CFG.minimapHz;
      this._mapDraws = (this._mapDraws || 0) + 1;
      this.minimap.draw(this.player, this.enemies, this.biome, this.depth >= CFG.stairSenseDepth);
    }
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
    if (this.player.arrows <= 0) {
      // Should not happen while the switch guard holds, but a bow with no arrows is a
      // stick, so refuse the shot and put the sword back rather than fire nothing.
      sfx.play('bow_empty');
      this.selectWeaponSlot('melee');
      return;
    }
    const dir = this.player.aimDir();
    const crit = Math.random() < (a.crit || 0.15);
    const dmg = Math.max(1, Math.round(w.damage * (0.92 + Math.random() * 0.16) * (crit ? a.critMult : 1)));
    // spawnProjectile, not a bare push: the mesh has to go into the scene. Pushing the
    // projectile onto the list alone meant the player's own arrows were never drawn.
    this.spawnProjectile({
      x: this.player.x + dir.x * 0.4, z: this.player.z + dir.z * 0.4, y: 1.35,
      speed: a.speed, life: a.range / a.speed, damage: dmg, hostile: false,
      // items/arrow, not vfx/arrow: the arrow sprite was generated into the items folder,
      // and this path was pointing at a file that never existed, so the shot rendered as
      // the grey placeholder.
      sprite: 'items/arrow', size: 0.44, arrow: true, dir, crit
    });
    this.spendArrow();
    sfx.play('bow_draw');
    setTimeout(() => sfx.play('bow_release'), Math.round((a.draw || 0.3) * 1000));
  }

  // Spend one arrow. Running dry hands the sword back over immediately.
  spendArrow() {
    const p = this.player;
    p.arrows = Math.max(0, p.arrows - 1);
    if (p.arrows === 0) {
      p.selectWeapon('melee');
      this.viewmodel.setWeapon(p.weapon);
      this.toast('Out of arrows — blade back in hand', '#e0a030', 1800);
    }
    this.hud.setGear(p);
  }

  // Keys 1 and 2. A bow you do not own, or own with nothing to shoot, is refused with a
  // reason instead of swapping to an empty hand.
  selectWeaponSlot(kind) {
    const p = this.player;
    const before = p.weapon;
    const w = p.selectWeapon(kind);
    if (!w) {
      sfx.play('bow_empty');
      if (kind === 'ranged' && !p.ranged) this.toast('No bow — archers drop them', '#9aa0a6', 1600);
      else if (kind === 'ranged') this.toast('No arrows left — archers carry them', '#e0a030', 1800);
      return false;
    }
    // selectWeapon already moved the hand, so compare against what it held beforehand.
    // Comparing against the new weapon instead would skip the viewmodel update every time
    // the switch was real, leaving a sword in your hands while the bow was drawn.
    if (w === before) return true;
    this.viewmodel.setWeapon(w);
    this.hud.setGear(p);
    sfx.play('weapon_swap');
    return true;
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

    if (item.slot === 'ammo') {
      const n = item.count || 1;
      p.arrows += n;
      sfx.play('pickup_gear');
      this.toast(`+${n} arrow${n === 1 ? '' : 's'} (${p.arrows}) — press 2`, '#c9a227', 1600);
      this.hud.setGear(p);
      return;
    }

    if (item.slot === 'weapon' || item.slot === 'armor') {
      // Bows and blades live in different slots now, so a bow is never "better" than the
      // sword in hand — it goes in the other slot and both are kept.
      const ranged = item.def && item.def.attack && item.def.attack.kind === 'ranged';
      const current = item.slot === 'armor' ? p.armor : (ranged ? p.ranged : p.melee);
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
      const ranged = item.def && item.def.attack && item.def.attack.kind === 'ranged';
      if (ranged) {
        p.ranged = item;
        this.hud.flashGear('ranged');
        // The viewmodel follows the bow only if the bow is what is in hand — a fresh bow
        // does not yank the sword out of your grip.
        if (p.weaponKind === 'ranged' || !p.melee) {
          p.selectWeapon('ranged');
          this.viewmodel.setWeapon(p.weapon);
        }
      } else {
        p.melee = item;
        this.hud.flashGear('weapon');
        // If the blade is what is in hand, the hand has to follow the new sword. Forgetting
        // this leaves you swinging the sword you just replaced.
        if (p.weaponKind === 'melee') {
          p.weapon = item;
          this.viewmodel.setWeapon(item);
        }
      }
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
      unitQuad,
      new THREE.MeshBasicMaterial({ map: undefined, color: 0xfff2c0, transparent: true, opacity: 0.5, toneMapped: false })
    );
    mesh.scale.set(0.9, 0.9, 1);
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
  // Debug view: stand in an open cell beside the nearest treasure pedestal and face it.
  standAtNearestLoot(bowOnly = false) {
    const level = this.level;
    const want = this.pickups.filter(p => p.item &&
      (!bowOnly || (p.item.def.attack && p.item.def.attack.kind === 'ranged')));
    if (!want.length) {
      console.warn('[debug] no pedestal loot' + (bowOnly ? ' with a bow' : '') + ' in this level');
      return;
    }
    let best = null, bd = Infinity;
    for (const p of want) {
      const d = Math.abs(Math.floor(p.x / CFG.cell) - level.entry.x) +
                Math.abs(Math.floor(p.z / CFG.cell) - level.entry.y);
      if (d < bd) { bd = d; best = p; }
    }
    const cx = Math.floor(best.x / CFG.cell), cy = Math.floor(best.z / CFG.cell);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= level.w || ny >= level.h) continue;
      if (level.open[ny * level.w + nx] !== 1) continue;
      // Step one cell further back when the corridor allows it: from arm's length a
      // pedestal fills the frame and the quiver at its foot is below the view.
      let sx = nx, sy = ny;
      const bx = cx + dx * 2, by = cy + dy * 2;
      if (bx >= 0 && by >= 0 && bx < level.w && by < level.h && level.open[by * level.w + bx] === 1) {
        sx = bx; sy = by;
      }
      const stand = cellToWorld(level, sx, sy);
      this.player.x = stand.x; this.player.z = stand.z;
      this.player.yaw = Math.atan2(best.x - stand.x, best.z - stand.z);
      this.input.setYaw(this.player.yaw);
      return;
    }
  }

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
      '--frame-banner': 'ui/frame_banner',
      // The menu card's emblem: the same generated blade the game ships, not a separate asset.
      '--emblem-sword': 'items/sword_long'
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

const DEFAULT_SETTINGS = { sensitivity: 0.0022, fov: CFG.fov, volume: 0.7, compareMode: false, autoFullscreen: true };

export { CFG, tierFor, bandFor, levels };
