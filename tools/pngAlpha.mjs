// Does this PNG actually contain transparency? Read it and count.
//   node tools/pngAlpha.mjs file.png [more.png ...]
//
// A file can be colour type 6 — "it has an alpha channel" — and still be completely opaque,
// which is exactly how a model that was asked for a transparent background passes a naive
// check: it paints the background white and writes alpha 255 across the whole frame. So this
// decodes the pixels and reports the shares: fully clear, soft edge, and fully opaque. No
// image library involved — an 8-bit non-interlaced PNG is zlib plus a per-scanline filter,
// which is small enough to do here and means the check runs in CI with no dependencies.
import fs from 'fs';
import zlib from 'zlib';

const FILTER_NONE = 0, SUB = 1, UP = 2, AVERAGE = 3, PAETH = 4;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

export function analyzePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, ihdr = null;
  const idat = [];
  let trns = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0), h: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12]
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8) return { ...ihdr, unsupported: `bit depth ${ihdr.depth}` };
  if (ihdr.interlace !== 0) return { ...ihdr, unsupported: 'interlaced' };
  if (ihdr.color === 3) {
    // Palette: alpha, if any, lives in the tRNS chunk.
    const channels = 1;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    return measure(ihdr, channels, raw, trns);
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[ihdr.color];
  if (!channels) throw new Error('unknown colour type ' + ihdr.color);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return measure(ihdr, channels, raw, trns);
}

function measure(ihdr, channels, raw, trns) {
  const { w, h } = ihdr;
  const bpp = channels;                       // bytes per pixel, 8-bit
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === SUB) v += a;
      else if (filter === UP) v += b;
      else if (filter === AVERAGE) v += (a + b) >> 1;
      else if (filter === PAETH) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
    prev = cur;
  }

  let clear = 0, soft = 0, opaque = 0, sr = 0, sg = 0, sb = 0, total = 0;
  for (let i = 0; i < w * h; i++) {
    total++;
    let a = 255;
    if (channels === 4) a = out[i * 4 + 3];
    else if (channels === 2) a = out[i * 2 + 1];
    else if (trns) {
      // Palette / greyscale / RGB: transparent if the index or colour matches tRNS.
      const v = channels === 1 ? out[i] : out.readUInt16BE(i * 2);
      a = (v === trns.readUInt16BE(0)) ? 0 : 255;
    }
    if (a === 0) clear++;
    else if (a < 255) { soft++; sr += out[i * channels]; sg += out[i * channels + 1]; sb += out[i * channels + 2]; }
    else opaque++;
  }
  const pct = n => +(n / total * 100).toFixed(1);
  const n = Math.max(1, soft);
  const softMean = soft ? `rgb(${Math.round(sr / n)}, ${Math.round(sg / n)}, ${Math.round(sb / n)})` : '—';
  return {
    w, h, colorType: channels === 4 ? 6 : channels === 2 ? 4 : channels === 3 ? 2 : 0,
    clear: pct(clear), soft: pct(soft), opaque: pct(opaque), softMean,
    verdict: pct(clear) >= 15 && pct(opaque) >= 15
      ? 'REAL TRANSPARENCY — background is genuinely absent'
      : pct(clear) < 1
        ? 'NO TRANSPARENCY — the background is painted, not removed'
        : 'partial — check by eye'
  };
}

if (process.argv[1] && process.argv[1].includes('pngAlpha')) {
  for (const f of process.argv.slice(2)) {
    try {
      const r = analyzePng(fs.readFileSync(f));
      console.log(`${f}\n  ${r.w}x${r.h} colour type ${r.colorType} — clear ${r.clear}%, soft ${r.soft}% (${r.softMean}), opaque ${r.opaque}% — ${r.verdict || r.unsupported}`);
    } catch (e) {
      console.log(`${f}\n  could not analyse: ${e.message}`);
    }
  }
}
