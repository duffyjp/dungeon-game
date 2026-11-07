// Menus: main menu, pause, settings, how-to-play, game over (spec §10).
// All text is real DOM text; generated frames are CSS backgrounds.

import { hasMusic, trackList, playTrack, stopMusic } from '../audio/music.js';
import { saveSettings, bestRuns } from '../util/storage.js';
import * as sfx from '../audio/sfx.js';

// Music and effects in this game are machine-generated, and the models are named here because
// the licences say so: the MiniMax-Music3 community licence requires the model name to appear
// in the product UI (that pass was rejected by the owner and is no longer shipped, so the
// obligation went away with it), and Stability's community licence is the same kind of terms
// plus an owner-supplied ACE-Step credit for the soundtrack. Kept as one exported constant so
// the test can assert it exists and no screen can quietly drop it.
export const AUDIO_CREDIT_HTML = `<p class="fine">Soundtrack by the project owner, generated with <b>ACE-Step 1.5</b>; sound effects with Stable Audio 3. Music and audio are machine-generated.</p>`;

export class Menus {
  constructor(game) {
    this.game = game;
    this.root = game.overlay;
    this.panel = document.createElement('div');
    this.panel.className = 'menu hidden';
    this.root.appendChild(this.panel);
  }

  hide() { this.panel.classList.add('hidden'); }
  show(html) {
    this.panel.innerHTML = html;
    this.panel.classList.remove('hidden');
    this.panel.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        sfx.initAudio();
        sfx.play('menu_click');
        const act = b.dataset.act;
        const args = argOf(b);
        // menu-local actions win, otherwise fall through to the game
        if (typeof this[act] === 'function') this[act](...args);
        else if (typeof this.game[act] === 'function') this.game[act](...args);
        else console.warn('[menu] unknown action', act);
      });
    });
    this.panel.querySelectorAll('[data-set]').forEach(inp => {
      inp.addEventListener('input', () => {
        this.game.settings[inp.dataset.set] = (inp.type === 'range' || inp.type === 'number') ? Number(inp.value) : inp.checked;
        this.game.applySettings();
        saveSettings(this.game.settings);
      });
    });
  }

  showMain() {
    stopMusic();
    // The main card carries the author and the source, nothing else. The model/attribution
    // notice the audio licences ask for lives on the How to Play card (AUDIO_CREDIT_HTML), which
    // the self-test still asserts - the menu being clean is not a reason to drop a disclosure.
    this.show(`
      <div class="menu-card">
        <h1 class="title">STRATA</h1>
        <p class="sub">Descent</p>
        <div class="seedrow"><input id="seed" placeholder="seed — blank for a random one" value=""></div>
        <div class="btngrid">
          <button class="primary" data-act="actNewRun">NEW RUN</button>
          <button data-act="actSeededRun">RUN WITH SEED</button>
          <button data-act="showSettings">SETTINGS</button>
          <button data-act="showHow">HOW TO PLAY</button>
        </div>
        <p class="fine stat">a game by <b>duffyjp</b> ·
          <a href="https://github.com/duffyjp/dungeon-game" target="_blank" rel="noopener">github.com/duffyjp/dungeon-game</a></p>
      </div>`);
  }

  actNewRun() { this.game.startRun(String(Math.floor(Math.random() * 1e6))); }
  actSeededRun() {
    const v = this.panel.querySelector('#seed')?.value?.trim();
    this.game.startRun(v || String(Math.floor(Math.random() * 1e6)));
  }
  actRetrySameSeed() { this.game.startRun(this.game.runSeed, 1); }
  actShowMain() { this.game.showMenu(); }
  actResume() { this.game.resume(); }
  actFullscreen() { this.game.toggleFullscreen(); }

  showPause() {
    this.show(`
      <div class="menu-card">
        <h2>PAUSED</h2>
        <div class="row btns"><button data-act="actResume">RESUME</button></div>
        ${settingsHtml(this.game.settings)}
        <div class="row btns"><button data-act="actFullscreen">FULLSCREEN (V)</button></div>
        <div class="row btns"><button data-act="actShowMain">QUIT TO MENU</button></div>
        <div class="cheatline">playtest: L then digits jumps to that depth (L 0 5 → depth 5)</div>
      </div>`);
  }

  showSettings() {
    this.show(`
      <div class="menu-card">
        <h2>SETTINGS</h2>
        ${settingsHtml(this.game.settings)}
        <div class="row btns"><button data-act="showMain">BACK</button></div>
      </div>`);
  }

  showMain2() { this.showMain(); }

  showHow() {
    this.show(`
      <div class="menu-card how">
        <h2>HOW TO PLAY</h2>
        <ul>
          <li>Mouse look, <b>WASD</b> to move, <b>Shift</b> to jog, <b>left click</b> to attack.</li>
          <li>Walk over gear to auto-equip it if it is better; worse gear is salvaged for score.</li>
          <li><b>Armour</b> soaks most damage until it breaks — descending repairs 35% of it.</li>
          <li>Find the <b>staircase</b> and stand on it to descend. Every level is solvable.</li>
          <li>Slimes heal you, ghosts give lives, orcs drop swords, archers bows and arrows, mages armour.</li>
          <li>1 is the blade, 2 is the bow. A bow costs an arrow, and an empty quiver closes it.</li>
          <li>Enemies telegraph every attack. Watch for the wind-up, step out, then hit.</li>
          <li><b>Esc</b> pause · <b>M</b> mute music · <b>V</b> fullscreen (escape leaves it) · <b>E</b> accept an equipment prompt.</li>
        </ul>
        ${AUDIO_CREDIT_HTML}
        <div class="row btns"><button data-act="showMain">BACK</button></div>
      </div>`);
  }

  showGameOver(res) {
    const runs = this.game.bestRuns();
    const rows = runs.map(r => `<tr><td>${r.depth}</td><td>${r.kills}</td><td>${r.score}</td><td class="fine">${r.seed}</td></tr>`).join('');
    this.show(`
      <div class="menu-card">
        <h2 class="dead">GAME OVER</h2>
        <p class="big">Depth ${res.depth} · ${res.kills} kills · ${res.score} score</p>
        <p class="fine">seed ${res.seed} — same seed, same dungeon</p>
        ${rows ? `<table class="runs"><thead><tr><th>depth</th><th>kills</th><th>score</th><th>seed</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
        <div class="row btns">
          <button data-act="actRetrySameSeed">RETRY THIS DUNGEON</button>
          <button data-act="actNewRun">NEW DUNGEON</button>
        </div>
      </div>`);
  }
}

function settingsHtml(s) {
  return `
    <div class="settings">
      <label>Sensitivity <input data-set="sensitivity" type="range" min="0.0008" max="0.006" step="0.0001" value="${s.sensitivity}"></label>
      <label>FOV <input data-set="fov" type="range" min="75" max="100" step="1" value="${s.fov}"></label>
      <label>Volume <input data-set="volume" type="range" min="0" max="1" step="0.05" value="${s.volume}"></label>
      <label class="chk"><input data-set="compareMode" type="checkbox" ${s.compareMode ? 'checked' : ''}> Ask before equipping better gear</label>
      <label class="chk"><input data-set="autoFullscreen" type="checkbox" ${s.autoFullscreen ? 'checked' : ''}> Go fullscreen when a run starts</label>
    </div>`;
}

function argOf(b) {
  const a = b.dataset.args;
  if (!a) return [];
  try { return JSON.parse(a); } catch { return [a]; }
}
