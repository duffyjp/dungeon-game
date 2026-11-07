// Read a WebP container without any WebP library.
//
// ffmpeg on this machine cannot re-read the animated WebP it just wrote, and webpmux/cwebp
// are not installed, so "did the encode do what we asked?" cannot be answered by piping it
// back through the tool that made it. The container itself is trivial to walk: RIFF chunks.
// This reports what the file actually declares — animation present, loop count, frame count,
// frame durations, and whether the alpha flag is set — which is enough to catch an encoder
// that silently dropped transparency or wrote one frame instead of thirty-one.
//
// Chunk layout, from the WebP extended-format spec:
//   VP8X  flags(1) reserved(3) canvasW-1(3) canvasH-1(3)
//   ANIM  backgroundColor(4) loopCount(2)
//   ANMF  x(3) y(3) w-1(3) h-1(3) duration(3) flags(1) then the frame's own VP8/VP8L + ALPH

const fourcc = (b, o) => b.toString('ascii', o, o + 4);
const le24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

export function readWebp(buf) {
  if (buf.length < 12 || fourcc(buf, 0) !== 'RIFF' || fourcc(buf, 8) !== 'WEBP') {
    throw new Error('not a RIFF/WEBP file');
  }
  const out = {
    bytes: buf.length, chunks: [], extended: false, animated: false, alpha: false,
    canvas: null, loopCount: null, background: null, frames: []
  };
  let off = 12;
  while (off + 8 <= buf.length) {
    const type = fourcc(buf, off);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    out.chunks.push(type);

    if (type === 'VP8X' && size >= 10) {
      const flags = buf[body];
      out.extended = true;
      out.alpha = Boolean(flags & 0x10);
      out.animated = Boolean(flags & 0x02);
      out.exif = Boolean(flags & 0x04);
      out.icc = Boolean(flags & 0x08);
      out.canvas = [le24(buf, body + 4) + 1, le24(buf, body + 7) + 1];
    } else if (type === 'ANIM' && size >= 6) {
      out.background = buf.readUInt32LE(body);
      out.loopCount = buf.readUInt16LE(body + 4);
    } else if (type === 'ANMF') {
      const f = {
        x: le24(buf, body), y: le24(buf, body + 3),
        w: le24(buf, body + 6) + 1, h: le24(buf, body + 9) + 1,
        durationMs: le24(buf, body + 12),
        // Bit 1 of the ANMF flags means "blend": 0 -> dispose to background between frames,
        // which is what a sprite cycle needs or the previous frame smears into the next.
        blend: Boolean(buf[body + 15] & 0x02),
        payload: []
      };
      // Walk the frame's own sub-chunks so an ALPH inside a frame is not missed.
      let p = body + 18, end = body + size;
      while (p + 8 <= end) {
        const t = fourcc(buf, p);
        f.payload.push(t);
        if (t === 'ALPH') out.alpha = true;
        const s = buf.readUInt32LE(p + 4);
        p += 8 + s + (s & 1);
      }
      out.frames.push(f);
    } else if (type === 'ALPH') {
      out.alpha = true;
    } else if ((type === 'VP8 ' || type === 'VP8L') && !out.extended) {
      // A simple (non-extended) file: VP8L is lossless and may carry alpha; VP8 with an
      // ALPH chunk would have shown above.
      out.simple = type === 'VP8L' ? 'VP8L' : 'VP8';
    }

    off = body + size + (size & 1);              // chunks are word-aligned
  }
  out.frameDurations = out.frames.map(f => f.durationMs);
  out.blendAll = out.frames.length ? out.frames.every(f => f.blend) : null;
  return out;
}
