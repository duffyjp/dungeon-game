// HUD: health bar, armour bar, lives, depth/score, equipped gear, crosshair,
// hurt vignette (spec §10). DOM/CSS text only — never baked into generated images.

import { CFG } from '../config.js';
import { getTexture } from '../render/assets.js';

const el = (id, tag = 'div', cls = '') => {
  const n = document.createElement(tag);
  n.id = id;
  if (cls) n.className = cls;
  return n;
};

export class Hud {
  constructor(root) {
    this.root = root;
    this.el = {};

    const hud = el('hud', 'div', 'hud');

    // health
    const hp = el('hp', 'div', 'bar bar-hp');
    hp.innerHTML = `
      <div class="bar-frame"><div class="bar-fill hp-fill"></div><div class="bar-value"></div></div>
      <div class="bar-label">HEALTH</div>`;
    this.el.hpFill = hp.querySelector('.hp-fill');
    this.el.hpValue = hp.querySelector('.bar-value');
    hud.appendChild(hp);

    // armour — always visible; empty state renders as a disabled bar (spec §10)
    const ar = el('armor', 'div', 'bar bar-armor');
    ar.innerHTML = `
      <div class="bar-frame"><div class="bar-fill armor-fill"></div><div class="bar-value"></div>
      <div class="armor-broken">BROKEN</div></div>
      <div class="bar-label">ARMOUR</div>`;
    this.el.armorFill = ar.querySelector('.armor-fill');
    this.el.armorValue = ar.querySelector('.bar-value');
    this.el.armorBroken = ar.querySelector('.armor-broken');
    this.el.armorBar = ar;
    hud.appendChild(ar);

    // lives
    const lives = el('lives', 'div', 'lives');
    this.el.lives = lives;
    hud.appendChild(lives);

    // depth / score
    const top = el('topline', 'div', 'topline');
    top.innerHTML = `<div class="depth"></div><div class="score"></div><div class="seed"></div>`;
    this.el.depth = top.querySelector('.depth');
    this.el.score = top.querySelector('.score');
    this.el.seed = top.querySelector('.seed');
    hud.appendChild(top);

    // equipped gear
    const gear = el('gear', 'div', 'gear');
    gear.innerHTML = `<div class="gear-weapon"><canvas width="56" height="56"></canvas><span class="wname"></span></div>
                      <div class="gear-armor"><canvas width="56" height="56"></canvas><span class="aname"></span></div>`;
    this.el.weaponCanvas = gear.querySelector('.gear-weapon canvas');
    this.el.weaponName = gear.querySelector('.wname');
    this.el.armorCanvas = gear.querySelector('.gear-armor canvas');
    this.el.armorName = gear.querySelector('.aname');
    this.el.gearWeapon = gear.querySelector('.gear-weapon');
    this.el.gearArmor = gear.querySelector('.gear-armor');
    hud.appendChild(gear);

    // crosshair
    const cross = el('cross', 'div', 'crosshair');
    this.el.cross = cross;
    hud.appendChild(cross);

    // banner (depth title)
    const banner = el('banner', 'div', 'banner');
    this.el.banner = banner;
    hud.appendChild(banner);

    // damage vignette
    const vig = el('vignette', 'div', 'vignette');
    this.el.vignette = vig;
    hud.appendChild(vig);

    // interact hint (stairs)
    const hint = el('hint', 'div', 'hint');
    this.el.hint = hint;
    hud.appendChild(hint);

    root.appendChild(hud);
    this.lastLives = -1;
  }

  setDepth(depth, seed) {
    this.el.depth.textContent = `DEPTH ${depth}`;
    this.el.seed.textContent = `seed ${seed}`;
  }

  setScore(score) { this.el.score.textContent = String(score); }

  update(player, opts = {}) {
    const hpPct = Math.max(0, player.health / player.maxHealth);
    this.el.hpFill.style.width = `${hpPct * 100}%`;
    this.el.hpValue.textContent = `${Math.max(0, Math.round(player.health))}`;
    this.el.hpFill.parentElement.classList.toggle('low', hpPct < 0.3);

    const has = Boolean(player.armor);
    const pct = has ? Math.max(0, player.armor.durability / player.armor.maxDurability) : 0;
    this.el.armorFill.style.width = `${pct * 100}%`;
    this.el.armorValue.textContent = has ? `${Math.max(0, Math.round(player.armor.durability))}` : '--';
    this.el.armorBar.classList.toggle('empty', !has);
    this.el.armorBroken.classList.toggle('on', has && player.armor.durability <= 0);

    if (player.lives !== this.lastLives) {
      this.lastLives = player.lives;
      this.el.lives.innerHTML = '';
      for (let i = 0; i < Math.min(player.lives, CFG.livesCap); i++) {
        const c = document.createElement('canvas');
        c.width = c.height = 30;
        drawIcon(c, 'ui/icon_skull_life');
        this.el.lives.appendChild(c);
      }
      if (player.lives > CFG.livesCap) {
        const over = document.createElement('span');
        over.className = 'lives-overflow';
        over.textContent = `x${player.lives}`;
        this.el.lives.appendChild(over);
      }
    }

    this.el.cross.classList.toggle('drawing', Boolean(opts.drawing));
    this.el.vignette.style.opacity = String(Math.min(0.75, player.hurtFlash));
    this.el.hint.style.opacity = opts.stairHint ? '1' : '0';
    if (opts.stairHintText) this.el.hint.textContent = opts.stairHintText;
  }

  setGear(player) {
    const w = player.weapon;
    drawIcon(this.el.weaponCanvas, w ? w.sprite : null);
    this.el.weaponName.textContent = w ? `${w.label} · ${w.damage}` : 'none';
    this.el.weaponName.style.color = w ? w.color : '#6b7076';
    const a = player.armor;
    drawIcon(this.el.armorCanvas, a ? a.sprite : null);
    this.el.armorName.textContent = a ? `${a.label} · ${a.maxDurability}` : 'none';
    this.el.armorName.style.color = a ? a.color : '#6b7076';
  }

  flashGear(which) {
    const node = which === 'weapon' ? this.el.gearWeapon : this.el.gearArmor;
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  banner(title, sub, ms = 2000) {
    this.el.banner.innerHTML = `<h1>${title}</h1><p>${sub}</p>`;
    this.el.banner.classList.add('on');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => this.el.banner.classList.remove('on'), ms);
  }
}

// HUD icons sample the generated sprites; CSS text stays real text.
export function drawIcon(canvas, assetKey) {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!assetKey) {
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(8, 8); g.lineTo(canvas.width - 8, canvas.height - 8);
    g.moveTo(canvas.width - 8, 8); g.lineTo(8, canvas.height - 8);
    g.stroke();
    return;
  }
  const tex = getTexture(assetKey);
  const img = tex && tex.image;
  if (img && img.width) {
    const s = Math.min(canvas.width, canvas.height);
    g.drawImage(img, (canvas.width - s) / 2, (canvas.height - s) / 2, s, s);
  }
}
