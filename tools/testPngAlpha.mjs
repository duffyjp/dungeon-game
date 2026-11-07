// Tests for the PNG alpha analyser — the tool that decides whether a "transparent" asset
// actually is one, so it needs to be right.
//   node tools/testPngAlpha.mjs
//
// Fixtures are built here rather than stored: an 8-bit PNG is a zlib stream of filtered
// scanlines, which is small enough to write inline and means the test has no binary
// dependencies and cannot drift from the files it is meant to judge.
import zlib from 'zlib';
import assert from 'node:assert/strict';
import { analyzePng } from './pngAlpha.mjs';

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

// PNG requires a CRC over chunk type+data.
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function makePng(w, h, colorType, pixelFn) {
  const channels = { 2: 3, 6: 4, 0: 1 }[colorType];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(0);                                     // filter type: none
    for (let x = 0; x < w; x++) raw.push(...pixelFn(x, y));
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
}

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('OK   :: ' + name); }
  else { fail++; console.log('FAIL :: ' + name + (detail ? ' [' + detail + ']' : '')); }
}

// 1. RGB, no alpha at all — what the chroma-keyed shipping art looks like.
const opaque = makePng(16, 16, 2, () => [255, 0, 255]);
const a = analyzePng(opaque);
check('an opaque RGB file reports no transparency', a.clear === 0 && a.soft === 0 && a.opaque === 100,
  `clear ${a.clear} soft ${a.soft} opaque ${a.opaque}`);
check('and is judged as painted, not cut out', a.verdict.includes('NO TRANSPARENCY'), a.verdict);

// 2. RGBA whose alpha channel is 255 everywhere: colour type 6, still completely opaque.
//    This is the exact false positive the analyser exists to catch.
const fakeAlpha = makePng(16, 16, 6, () => [255, 255, 255, 255]);
const b = analyzePng(fakeAlpha);
check('an RGBA file with an all-opaque alpha channel is still called opaque',
  b.clear === 0 && b.opaque === 100, `clear ${b.clear} opaque ${b.opaque}`);
check('and the colour type does not fool the verdict', b.verdict.includes('NO TRANSPARENCY'), b.verdict);

// 3. A real cutout: left half opaque subject, right half fully clear.
const cut = makePng(16, 16, 6, (x) => (x < 8 ? [220, 230, 240, 255] : [0, 0, 0, 0]));
const c = analyzePng(cut);
check('a genuine cutout reports half clear and half opaque', c.clear === 50 && c.opaque === 50,
  `clear ${c.clear} opaque ${c.opaque}`);
check('and is judged as real transparency', c.verdict.includes('REAL TRANSPARENCY'), c.verdict);

// 4. Soft edges are counted, and their colour is measured — that is where a fringe shows up.
const soft = makePng(10, 10, 6, () => [180, 90, 210, 128]);
const d = analyzePng(soft);
check('a fully semi-transparent frame counts as soft, not clear or opaque',
  d.soft === 100 && d.clear === 0 && d.opaque === 0, `soft ${d.soft}`);
check('and the soft band colour is reported', d.softMean === 'rgb(180, 90, 210)', d.softMean);

console.log(`PNG alpha analyser: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
