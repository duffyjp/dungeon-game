// Seeded PRNG. Level layout, spawns, drops and quality rolls MUST use these.
// Math.random() is allowed only for cosmetic jitter (see spec §14).

export function hashSeed(str) {
  // FNV-1a -> 32 bit
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(a) {
  let s = a >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
    this.next = mulberry32(this.seed);
  }
  float(min = 0, max = 1) { return min + (max - min) * this.next(); }
  int(min, max) { return Math.floor(this.float(min, max + 1)); }      // inclusive
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  // weighted pick over array of numbers (weights) -> index
  weighted(weights) {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return 0;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

// Fisher-Yates shuffle-bag helper (used by the music system, §12.1)
export class ShuffleBag {
  constructor(rng) { this.rng = rng; this.bag = []; }
  next(items) {
    if (this.bag.length === 0) this.bag = this.rng.shuffle(items);
    return this.bag.pop();
  }
}
