// Load a rendered clip from disk the one correct way.
//
// Keying and re-anchoring decide what every downstream tool sees — the gates, the review
// sheet, and the atlases and animations that would ship. If each tool re-implemented that
// step, a subtle difference would mean the artefact promoted into the game was not the
// artefact that was measured. So the pipeline reads clips through this module only.
import fs from 'fs';
import path from 'path';
import { decodePng } from './pngio.mjs';
import { keyFrame, alignFrames } from './videoKit.mjs';

// Raw frames as ffmpeg split them out of the clip: RGBA buffers, all the same size.
export function readFrames(dir) {
  const files = fs.readdirSync(path.join(dir, 'frames')).filter(f => /^f\d+\.png$/.test(f)).sort();
  const list = files.map(f => {
    const dec = decodePng(fs.readFileSync(path.join(dir, 'frames', f)));
    const W = dec.w, H = dec.h;
    if (dec.channels === 4) return { W, H, rgba: dec.px };
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0, p = 0; i < W * H; i++, p += dec.channels) {
      rgba[i * 4] = dec.px[p]; rgba[i * 4 + 1] = dec.px[p + 1]; rgba[i * 4 + 2] = dec.px[p + 2]; rgba[i * 4 + 3] = 255;
    }
    return { W, H, rgba };
  });
  return { files, list, W: list[0]?.W || 0, H: list[0]?.H || 0 };
}

// Keyed against each frame's own observed backdrop, then re-anchored to the clip's median
// centroid — the exact sequence the gates ran on.
export function keyedAligned(dir) {
  const { files, list, W, H } = readFrames(dir);
  if (!list.length) return { files, frames: [], W, H, anchor: null };
  const keyed = list.map(r => keyFrame(r.rgba, W, H).rgba);
  const { aligned, anchor } = alignFrames(keyed, W, H);
  return { files, frames: aligned, W, H, anchor };
}

export function readMeta(dir) {
  const p = path.join(dir, 'results.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}
