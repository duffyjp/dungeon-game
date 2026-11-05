// Chroma-key pipeline (spec §11).
//
// Z-Image Turbo is text-to-image with no alpha channel, so every entity sprite is
// generated on a flat backdrop and keyed here at load time. Runtime keying means
// zero build dependencies and it re-keys whenever an asset is regenerated.
//
// The backdrop colour is *sampled from the image border* rather than assumed,
// because the model never produces an exact #ff00ff.

// Exported so the QA harness (keycheck.html) reports the exact colour the game keys
// against, rather than a reimplementation that could drift.
export function sampleBackdrop(d, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const add = (x, y) => {
    const i = (y * w + x) * 4;
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < band; y++) { add(x, y); add(x, h - 1 - y); }
  }
  for (let y = band; y < h - band; y++) {
    for (let x = 0; x < band; x++) { add(x, y); add(w - 1 - x, y); }
  }
  return { r: r / n, g: g / n, b: b / n };
}

// Returns the same canvas, mutated: backdrop becomes transparent, magenta cast
// is despilled off the subject's edges.
export function chromaKeyCanvas(canvas, opts = {}) {
  const feather = opts.feather ?? 0.10;
  const threshold = opts.threshold ?? 0.20;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const bg = sampleBackdrop(d, w, h);

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const dist = Math.sqrt(
      ((r - bg.r) ** 2 + (g - bg.g) ** 2 + (b - bg.b) ** 2) / (3 * 255 * 255)
    );

    // Absolute-chroma test, independent of the sampled border colour. Thin props
    // (arrows, bows) come back with a *gradient* backdrop, so border sampling misses
    // the far side of the image and magenta survives (measured in keycheck.html:
    // arrow 10 %, bow_war 8 %, bow_long 6 %, sword_long 6 %, ghost_trail 6 %).
    // A pixel only counts here if it is strongly red+blue with almost no green, which
    // the sprite subjects themselves never are. The brightness floor is low because
    // some outputs (items/arrow) come back as a *gradient* backdrop whose corners are
    // dark; keycheck.html reports "subject eaten" so this stays verifiable.
    const chroma = (Math.min(r, b) - g) / 255;
    const absolute = chroma > 0.28 && Math.min(r, b) > 55;

    let alpha = 1;
    if (dist <= threshold || absolute) alpha = 0;
    else if (dist < threshold + feather || chroma > 0.18) {
      alpha = Math.min((dist - threshold) / feather, Math.max(0, (0.28 - chroma) / 0.10));
    }

    if (alpha > 0) {
      // Despill: pull the backdrop hue out of near-edge subject pixels.
      const spill = Math.max(
        0,
        Math.min(r - bg.r, b - bg.b) * (1 - Math.min(1, g / Math.max(1, bg.g)))
      );
      if (spill > 8) {
        d[i] = Math.max(0, r - spill * 0.75);
        d[i + 2] = Math.max(0, b - spill * 0.75);
      }
    }
    // Canvas 2D stores straight (non-premultiplied) alpha, so the colour channels
    // are left alone; only the alpha ramp changes.
    d[i + 3] = Math.round(alpha * 255);
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Debug helper: renders the 50%-offset tiling test for a texture (spec §13.6).
export function tileOffsetTest(sourceCanvas) {
  const s = sourceCanvas.width;
  const out = document.createElement('canvas');
  out.width = out.height = s;
  const g = out.getContext('2d');
  const half = s / 2;
  g.drawImage(sourceCanvas, -half, -half);
  g.drawImage(sourceCanvas, half, -half);
  g.drawImage(sourceCanvas, -half, half);
  g.drawImage(sourceCanvas, half, half);
  return out;
}
