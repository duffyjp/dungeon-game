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
    if (this.game.state !== 'playing') return;
    this.canvas.requestPointerLock?.();
  }

  setYaw(y) { this.yaw = y; }

  onKey(e, down) {
    const k = e.code;
    this.keys.set(k, down);
    if (!down) return;
    if (k === 'Escape') {
      if (this.game.state === 'playing') this.game.pause();
      else if (this.game.state === 'paused') this.game.resume();
      return;
    }
    if (this.game.state !== 'playing') return;
    if (k === 'KeyE') this._pendingInteract = true;
    if (k === 'KeyM') this.game.toggleMusicMute();
    if (k === 'KeyR' && e.ctrlKey) return;
    if (k === 'KeyF') this._pendingInteract = true;
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
