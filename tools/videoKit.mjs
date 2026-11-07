// Shared maths for the animation pass (spec 13.8): turn an approved billboard into a
// start frame, key the model's frames back out, and measure what came home.
//
// Nothing here talks to ComfyUI. A video model costs minutes per clip, so the parts that
// can be wrong must be provable offline: backdrop choice, keying and measurement are pure
// functions and tools/testVideoKit.mjs exercises them against the real sprites.
//
// The keying rule is the same shape as src/render/chromaKey.js — sample the border, key by
// colour distance plus a chroma test — but generalised. The old keyer hard-codes magenta
// because that is what Z-Image was asked to paint. Here the backdrop is *our* choice, so
// the rule is expressed against whichever axis that choice makes, and the choice itself is
// made per sprite by measuring the sprite.

// Backdrops worth considering. Each is high-chroma so the chroma test can do the work when
// the model drifts the backdrop brightness, and none of them is a colour a dungeon sprite
// is likely to be made of — "likely" being settled by measurement, not by taste.
export const BACKDROPS = [
  { name: 'green',    rgb: [0, 200, 0] },
  { name: 'magenta',  rgb: [230, 0, 220] },
  { name: 'cyan',     rgb: [0, 200, 200] },
  { name: 'blue',     rgb: [24, 40, 214] },
  { name: 'yellow',   rgb: [232, 214, 0] },
  { name: 'red',      rgb: [232, 40, 26] }
];

// Unit vector along which the backdrop's colour departs from grey. The chroma of any pixel
// projected onto this axis is how much of the backdrop's hue that pixel contains.
export function spillAxis(rgb) {
  const m = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const d = [rgb[0] - m, rgb[1] - m, rgb[2] - m];
  const L = Math.hypot(d[0], d[1], d[2]);
  if (!L) return { axis: [0, 0, 0], length: 0 };
  return { axis: [d[0] / L, d[1] / L, d[2] / L], length: L };
}

// Signed amount of backdrop hue in one pixel. Large positive means the pixel is backdrop-ish
// even if distance keying missed it (the model loves a soft gradient behind the subject).
export function hueAlong(r, g, b, axis) {
  const m = (r + g + b) / 3;
  return (r - m) * axis[0] + (g - m) * axis[1] + (b - m) * axis[2];
}

// How strongly the sprite's own opaque pixels collide with a candidate backdrop.
// Returns the 95th percentile hue-along-axis over the sprite, as a fraction of the
// backdrop's own saturation. Under ~0.35 the backdrop keys cleanly without eating the
// subject; over ~0.6 the subject starts disappearing with the background.
export function collision(px, w, h, channels, rgb) {
  const { axis, length } = spillAxis(rgb);
  if (!length) return { worst: 1, ratio: 1 };
  const vals = [];
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 20000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * channels;
      const a = channels === 4 ? px[i + 3] : 255;
      if (a < 200) continue;                       // only solid subject pixels
      vals.push(hueAlong(px[i], px[i + 1], px[i + 2], axis));
    }
  }
  if (!vals.length) return { worst: 0, ratio: 0 };
  vals.sort((p, q) => p - q);
  const worst = vals[Math.floor(vals.length * 0.95)];
  return { worst, ratio: worst / length };
}

// Choose the backdrop for a sprite by measuring the sprite, not by guessing.
export function pickBackdrop(px, w, h, channels) {
  const scored = BACKDROPS.map(b => ({ ...b, ...collision(px, w, h, channels, b.rgb) }));
  scored.sort((p, q) => p.ratio - q.ratio);
  return {
    choice: scored[0],
    table: scored.map(s => `${s.name} ${s.ratio.toFixed(2)}`).join('  '),
    risky: scored[0].ratio > 0.45
  };
}

// Paint the sprite onto a flat backdrop at a given scale inside a larger canvas, so the
// subject has room to move without leaving the frame. Returns RGBA pixel buffer.
export function composeStartFrame(sprite, sw, sh, channels, canvas, backdrop, scale = 0.8) {
  const { w, h } = canvas;
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = backdrop[0]; out[i * 4 + 1] = backdrop[1]; out[i * 4 + 2] = backdrop[2]; out[i * 4 + 3] = 255;
  }
  const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
  const ox = Math.round((w - dw) / 2), oy = Math.round((h - dh) / 2);
  // Foot-anchored: the subject's feet should land where the game will plant them, so the
  // vertical centre of the sprite, not its geometric centre, is the thing we keep centred.
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y / dh) * sh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x / dw) * sw));
      const s = (sy * sw + sx) * channels;
      const a = channels === 4 ? sprite[s + 3] : 255;
      if (a === 0) continue;
      const t = ((oy + y) * w + (ox + x)) * 4;
      const af = a / 255;
      out[t] = Math.round(sprite[s] * af + out[t] * (1 - af));
      out[t + 1] = Math.round(sprite[s + 1] * af + out[t + 1] * (1 - af));
      out[t + 2] = Math.round(sprite[s + 2] * af + out[t + 2] * (1 - af));
      out[t + 3] = 255;
    }
  }
  return out;
}

// Sample the backdrop from the frame's own border band, exactly as the runtime keyer does:
// the model never reproduces the colour we asked for, so measure it per frame.
export function borderBackdrop(px, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const add = (x, y) => { const i = (y * w + x) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; };
  for (let x = 0; x < w; x++) for (let y = 0; y < band; y++) { add(x, y); add(x, h - 1 - y); }
  for (let y = band; y < h - band; y++) for (let x = 0; x < band; x++) { add(x, y); add(w - 1 - x, y); }
  return { r: r / n, g: g / n, b: b / n };
}

// Key one frame against a known backdrop hue. Returns RGBA with the backdrop made
// transparent and its hue pulled out of the soft edge band (despill).
export function keyFrame(px, w, h, opts = {}) {
  const feather = opts.feather ?? 0.12;
  const threshold = opts.threshold ?? 0.18;
  const bg = opts.backdrop || borderBackdrop(px, w, h);
  const { axis, length } = spillAxis([bg.r, bg.g, bg.b]);
  // Chroma gate scales with how saturated the observed backdrop actually is: a washed-out
  // backdrop needs a looser gate than a vivid one or the soft band never keys out.
  const gate = 0.5 * length;
  const out = Buffer.from(px);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const r = px[p], g = px[p + 1], b = px[p + 2];
    const dist = Math.sqrt(((r - bg.r) ** 2 + (g - bg.g) ** 2 + (b - bg.b) ** 2) / (3 * 255 * 255));
    const hue = hueAlong(r, g, b, axis);
    let alpha = 1;
    if (dist <= threshold || hue > gate) alpha = 0;
    else if (dist < threshold + feather || hue > gate * 0.6) {
      alpha = Math.min((dist - threshold) / feather, Math.max(0, (gate - hue) / (gate * 0.4)));
    }
    alpha = Math.max(0, Math.min(1, alpha));
    if (alpha > 0 && alpha < 1 && hue > 0) {
      // Despill only the semi-transparent band: those pixels are a mix of subject and
      // backdrop, so subtracting the backdrop's hue component is the right correction.
      // Touching fully opaque pixels would tint the subject itself.
      const s = hue * 0.8;
      out[p] = Math.max(0, Math.round(r - Math.max(0, s * axis[0])));
      out[p + 1] = Math.max(0, Math.round(g - Math.max(0, s * axis[1])));
      out[p + 2] = Math.max(0, Math.round(b - Math.max(0, s * axis[2])));
    }
    out[p + 3] = Math.round(alpha * 255);
  }
  return { rgba: out, bg, gate };
}

// What is actually in a keyed frame.
export function frameStats(rgba, w, h) {
  let clear = 0, soft = 0, opaque = 0, sx = 0, sy = 0, n = 0, cr = 0, cg = 0, cb = 0;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = rgba[i + 3];
      if (a < 8) { clear++; continue; }
      if (a < 200) soft++; else {
        opaque++;
        cr += rgba[i]; cg += rgba[i + 1]; cb += rgba[i + 2];
        sx += x; sy += y; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  const total = w * h;
  return {
    clear: +(100 * clear / total).toFixed(1),
    soft: +(100 * soft / total).toFixed(1),
    coverage: +(100 * (soft + opaque) / total).toFixed(1),
    mean: n ? [Math.round(cr / n), Math.round(cg / n), Math.round(cb / n)] : null,
    centroid: n ? [sx / n, sy / n] : null,
    bbox: n ? [x0, y0, x1, y1] : null
  };
}

// Integer translate, so re-anchoring frames never resamples them.
export function shift(rgba, w, h, dx, dy) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < w; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= w) continue;
      const s = (y * w + x) * 4, t = (ty * w + tx) * 4;
      out[t] = rgba[s]; out[t + 1] = rgba[s + 1]; out[t + 2] = rgba[s + 2]; out[t + 3] = rgba[s + 3];
    }
  }
  return out;
}

export function silhouetteIoU(a, b, w, h) {
  let both = 0, either = 0;
  for (let i = 3; i < a.length; i += 4) {
    const A = a[i] >= 128, B = b[i] >= 128;
    if (A && B) both++;
    if (A || B) either++;
  }
  return either ? both / either : 0;
}

// How much actually changed between two frames. A clip can pass every consistency gate and
// still be a still photograph — the model is quite capable of that, especially at CFG 1 —
// so movement is measured on its own terms: how much of the silhouette's coverage moved,
// and how much the pixels inside it changed. A frame compared with itself scores zero here,
// which is exactly the failure this exists to catch.
export function motionBetween(a, b, w, h) {
  let changed = 0, both = 0, cd = 0;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const A = a[p + 3], B = b[p + 3];
    if (Math.abs(A - B) > 64) changed++;
    if (A >= 200 && B >= 200) {
      both++;
      cd += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    }
  }
  return {
    coverageDelta: +(100 * changed / (w * h)).toFixed(2),
    colourDelta: both ? +(cd / both / 3).toFixed(1) : 0
  };
}

// Median of a list, used as the anchor a clip is aligned to: the median survives one bad
// frame, the mean does not.
export function median(list) {
  if (!list.length) return 0;
  const s = [...list].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
}

// Re-anchor a clip so the subject's average position is the same in every frame. The model
// drifts the whole figure a few pixels between frames; left in, that reads as the creature
// sliding across the floor rather than moving its legs. Integer shifts only, so nothing is
// resampled and the matte stays as sharp as the model drew it.
export function alignFrames(frames, W, H) {
  const seen = frames.map(f => frameStats(f, W, H));
  const anchors = seen.map(s => s.centroid).filter(Boolean);
  if (anchors.length < 2) return { aligned: frames, anchor: null };
  const ax = median(anchors.map(a => a[0])), ay = median(anchors.map(a => a[1]));
  const aligned = frames.map((f, i) => {
    const c = seen[i].centroid;
    return c ? shift(f, W, H, Math.round(ax - c[0]), Math.round(ay - c[1])) : f;
  });
  return { aligned, anchor: [ax, ay] };
}

// Contact sheet: every frame of a clip in one image, over a checkerboard so holes in the
// matte are visible instead of hiding behind black.
export function contactSheet(frames, w, h, cell = 128, cols = 6) {
  const rows = Math.ceil(frames.length / cols);
  const pad = 8;
  const SW = cols * (cell + pad) + pad, SH = rows * (cell + pad) + pad;
  const out = Buffer.alloc(SW * SH * 3);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const q = ((x >> 4) + (y >> 4)) & 1 ? 60 : 92;
      const p = (y * SW + x) * 3;
      out[p] = q; out[p + 1] = q; out[p + 2] = q;
    }
  }
  frames.forEach((f, k) => {
    const ox = pad + (k % cols) * (cell + pad), oy = pad + Math.floor(k / cols) * (cell + pad);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const s = (Math.floor((y / cell) * h) * w + Math.floor((x / cell) * w)) * 4;
        const a = f[s + 3] / 255, t = ((oy + y) * SW + (ox + x)) * 3;
        for (let c = 0; c < 3; c++) out[t + c] = Math.round(f[s + c] * a + out[t + c] * (1 - a));
      }
    }
  });
  return { buffer: out, w: SW, h: SH };
}

// Per-action floor for the facing gate, shared by the runner and the re-measurer so a clip
// cannot pass under one rule and fail under the other. A fleeing figure is seen from behind,
// and from behind a creature legitimately occupies a narrower box — measured at ~0.48 for a
// spider tucking its legs — while a figure that ran off into the distance reached 0.067.
export const ACTION_BOX_FLOOR = { flee: 0.45 };

// The single place a clip is judged. tools/animClip.mjs calls it after generating, and
// tools/animMeasure.mjs calls it again over clips that already exist, so a gate can be
// tightened across a whole phase without spending a second of GPU time. Keeping it in one
// function is what stops those two from quietly disagreeing about what "good" meant.
export function scoreClip({ frames, W, H, requested, srcKeyed, motionFloor = 3.0, iouFloor = 0.30, boxFloor = 0.85 }) {
  const stats = frames.map(f => frameStats(f, W, H));
  const srcCov = srcKeyed ? frameStats(srcKeyed, W, H).coverage : stats[0].coverage;
  const boxArea = b => b ? (b[2] - b[0] + 1) * (b[3] - b[1] + 1) : 0;
  const rows = frames.map((f, i) => {
    const c = stats[i].centroid, c0 = stats[0].centroid;
    const m = i ? motionBetween(f, frames[i - 1], W, H) : { coverageDelta: 0, colourDelta: 0 };
    const loop = i === frames.length - 1 && frames.length > 1
      ? motionBetween(f, frames[0], W, H) : null;
    return {
      frame: i,
      clear: stats[i].clear, coverage: stats[i].coverage,
      iouPrev: +(i ? silhouetteIoU(f, frames[i - 1], W, H) : 1).toFixed(3),
      iouSource: +(srcKeyed ? silhouetteIoU(f, srcKeyed, W, H) : 1).toFixed(3),
      driftPx: +(c && c0 ? Math.hypot(c[0] - c0[0], c[1] - c0[1]) : 0).toFixed(1),
      colourDrift: stats[i].mean && stats[0].mean
        ? Math.max(...stats[i].mean.map((v, ch) => Math.abs(v - stats[0].mean[ch]))) : 0,
      moved: m.coverageDelta, shifted: m.colourDelta,
      // How much of the first frame's bounding box this frame still occupies. A creature
      // that turns sideways narrows in both axes at once, which is the one failure mode
      // centroid drift cannot see: the figure stays put and simply rotates out of view.
      boxRatio: stats[0].bbox && stats[i].bbox
        ? +(boxArea(stats[i].bbox) / boxArea(stats[0].bbox)).toFixed(3) : 1,
      bbox: stats[i].bbox,
      loopMoved: loop ? loop.coverageDelta : null
    };
  });

  const moving = rows.slice(1).map(r => r.moved);
  const meanMove = moving.length ? +(moving.reduce((p, q) => p + q, 0) / moving.length).toFixed(2) : 0;
  // Movement relative to the subject rather than the frame. Measured across this phase: an
  // archer walk and a slime walk look equally like walks but move 0.54% and 1.02% of the
  // frame, because the archer simply has fewer pixels to move. As a share of their own
  // silhouettes both land at 4.4-4.6%, which is the band the eye reads as stepping. A frame
  // compared with itself still scores zero, so the "it is a still photograph" failure mode
  // stays caught.
  const relMove = stats[0].coverage ? +(meanMove / stats[0].coverage * 100).toFixed(1) : 0;
  const ious = rows.map(r => r.iouSource).sort((p, q) => p - q);
  const medianIou = ious.length ? ious[Math.floor(ious.length / 2)] : 0;
  const minIoU = Math.min(...rows.map(r => r.iouPrev));
  const minCov = Math.min(...rows.map(r => r.coverage));
  const maxDrift = Math.max(...rows.map(r => r.driftPx));
  const maxColour = Math.max(...rows.map(r => r.colourDrift));
  const minClear = Math.min(...rows.map(r => r.clear));
  const minSrc = Math.min(...rows.map(r => r.iouSource));
  const minBox = Math.min(...rows.map(r => r.boxRatio));

  const gates = [
    ['frame count', rows.length === requested, `${rows.length} of ${requested}`],
    ['backdrop keyed every frame', minClear >= 8, `worst clear ${minClear}%`],
    ['subject never vanishes', minCov >= 0.55 * srcCov, `worst coverage ${minCov}% against source ${srcCov}%`],
    ['neighbour frames agree', minIoU >= iouFloor, `worst consecutive IoU ${minIoU.toFixed(3)}`],
    ['identity held', rows.every(r => r.iouSource >= 0.25), `worst IoU against the source still ${minSrc.toFixed(3)}`],
    // First frame judged against the clip's own typical overlap, not a fixed number. The
    // gate exists to catch the model repainting the creature instead of animating it, and a
    // fixed 0.6 fails thin-limbed sprites for the wrong reason: a spider's legs are a few
    // pixels wide, so a couple of pixels of wobble drops overlap to ~0.4 for every frame,
    // first one included. Measured: the spider attack's first frame scores 0.41 against a
    // clip median of 0.40 — the first frame is no less faithful than any other frame.
    ['first frame faithful', rows[0].iouSource >= Math.min(0.6, 0.8 * medianIou),
      `first frame ${rows[0].iouSource.toFixed(3)} against this clip's median ${medianIou.toFixed(3)} (floor ${Math.min(0.6, 0.8 * medianIou).toFixed(3)})`],
    ['camera stayed put', maxDrift <= 40, `largest pre-alignment drift ${maxDrift}px`],
    ['no recolouring', maxColour <= 60, `largest channel drift ${maxColour}`],
    ['the subject actually moves', relMove >= motionFloor,
      `mean movement ${relMove}% of the subject's own silhouette per step, floor ${motionFloor}%`],
    // 0.85 comes from measurement, not taste: the clip that visibly rotated the creature
    // away bottoms out at 0.78-0.82 here while the ones that stepped in place stay above
    // 0.87. It is a proxy — a rotation that happened to preserve its box would slip through,
    // and a thin prop swinging through the bounding box can trip it honestly — which is why
    // every clip still gets a contact sheet and why a human decision is recorded as a waiver
    // rather than by quietly lowering the number.
    ['subject kept its facing', minBox >= boxFloor,
      `smallest silhouette box ${(minBox * 100).toFixed(0)}% of the first frame, floor ${(boxFloor * 100).toFixed(0)}%`],
  ];
  return { rows, gates, summary: { meanMove, relMove, medianIou, minIoU, minCov, maxDrift, maxColour, minClear, minSrc, minBox, srcCov } };
}
