// Input: pointer-lock mouse look, WASD, mouse buttons, hotkeys (spec §3).

export class Input {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    this.keys = new Map();
    this.yaw = 0;
    this.pitch = 0;
    this.jog = false;
    this.fwd = this.back = this.left = this.right = false;
    this.fire = false;
    this.sensitivity = 0.0022;
    this.locked = false;
    this._pendingFire = false;
    this._pendingInteract = false;

    window.addEventListener('keydown', e => this.onKey(e, true));
    window.addEventListener('keyup', e => this.onKey(e, false));
    canvas.addEventListener('mousedown', e => {
      if (!this.locked) { this.requestLock(); return; }
      if (e.button === 0) this._pendingFire = true;
    });
    window.addEventListener('mouseup', e => { if (e.button === 0) this.fire = false; });
    window.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = Math.max(-1.48, Math.min(1.48, this.pitch));
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked && this.game.state === 'playing') this.game.pause();
    });
    window.addEventListener('contextmenu', e => e.preventDefault());
  }

  requestLock() {
    // 'loading' counts too: a run now spends time preparing its assets, and the pointer lock
    // needs the click that started the run. Refusing the request during that window is how the
    // game ended up needing an extra click before the mouse looked around.
    if (this.game.state !== 'playing' && this.game.state !== 'loading') return;
    // Chrome returns a promise that rejects when the request was not made from a real gesture -
    // which is normal for the follow-up request after a fullscreen transition. Letting that
    // rejection escape puts an uncaught DOMException in the console for no reason.
    const r = this.canvas.requestPointerLock?.();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  }

  setYaw(y) { this.yaw = y; }

  onKey(e, down) {
    const k = e.code;
    this.keys.set(k, down);
    if (!down) return;
    if (k === 'Escape') {
      // Unpausing also drops any half-typed cheat sequence, so digits typed later cannot
      // land in a sequence the player thinks they abandoned.
      clearTimeout(this._cheatT);
      this._cheat = null;
      if (this.game.state === 'playing') this.game.pause();
      else if (this.game.state === 'paused') this.game.resume();
      return;
    }
    // V for the view. F is taken by interact, and F11 is the browser's own window chrome,
    // which stretches the same picture instead of rendering at the panel's pixel count.
    // Ahead of the paused/playing guards deliberately: toggling from the pause menu is the
    // common case, and Escape then V should not require unpausing first.
    if (k === 'KeyV' || k === 'F11') {
      e.preventDefault();
      this.game.toggleFullscreen();
      return;
    }
    // Playtest cheat, typed while paused: L then up to two digits (L 0 5 → depth 5,
    // L 1 0 → depth 10). It commits when the second digit lands, or 900 ms after the last
    // one, which is what lets a single digit like "L 5" work without waiting for a partner.
    if (this.game.state === 'paused') {
      if (k === 'KeyL') { this.startCheat(); return; }
      // The sequence is a string, and while it is empty it is still active, so test for
      // null rather than truthiness — "L" alone leaves it as an empty string waiting for
      // its first digit.
      if (this._cheat !== null && this._cheat !== undefined) this.pushCheat(k);
      return;
    }
    if (this.game.state !== 'playing') return;
    if (k === 'KeyE') this._pendingInteract = true;
    if (k === 'KeyM') this.game.toggleMusicMute();
    if (k === 'KeyR' && e.ctrlKey) return;
    if (k === 'KeyF') this._pendingInteract = true;
    // 1 = blade, 2 = bow. The game itself decides whether the request is allowed.
    if (k === 'Digit1' || k === 'Numpad1') this.game.selectWeaponSlot('melee');
    if (k === 'Digit2' || k === 'Numpad2') this.game.selectWeaponSlot('ranged');
  }

  startCheat() {
    clearTimeout(this._cheatT);
    this._cheat = '';
  }

  pushCheat(code) {
    const d = /^Digit(\d)$/.exec(code)?.[1] ?? /^Numpad(\d)$/.exec(code)?.[1];
    if (!d) { this.commitCheat(); return; }   // any other key ends the sequence
    this._cheat += d;
    clearTimeout(this._cheatT);
    if (this._cheat.length >= 2) this.commitCheat();
    else this._cheatT = setTimeout(() => this.commitCheat(), 900);
  }

  commitCheat() {
    clearTimeout(this._cheatT);
    const seq = this._cheat;
    this._cheat = null;
    if (seq) this.game.cheatToDepth(seq);
  }

  sample() {
    const k = this.keys;
    this.fwd = !!k.get('KeyW') || !!k.get('ArrowUp');
    this.back = !!k.get('KeyS') || !!k.get('ArrowDown');
    this.left = !!k.get('KeyA') || !!k.get('ArrowLeft');
    this.right = !!k.get('KeyD') || !!k.get('ArrowRight');
    this.jog = !!k.get('ShiftLeft') || !!k.get('ShiftRight');
    const out = {
      fwd: this.fwd, back: this.back, left: this.left, right: this.right,
      jog: this.jog, yaw: this.yaw, pitch: this.pitch
    };
    return out;
  }

  consumeFire() {
    const f = this._pendingFire;
    this._pendingFire = false;
    return f;
  }
  consumeInteract() {
    const f = this._pendingInteract;
    this._pendingInteract = false;
    return f;
  }
}
