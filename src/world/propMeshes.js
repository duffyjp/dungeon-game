// Real low-poly prop geometry (replaces billboard cutouts for solid objects).
//
// Why these are meshes and enemies are still sprites (decided with the user): props are
// the things you walk *past*, so their flatness shows the moment you strafe, while the
// photoreal enemy sprites still read fine at a distance. Sprites stay for anything with
// an organic silhouette until the character pass.
//
// Materials here are MeshStandardMaterial on purpose: the billboard sprites are
// deliberately unlit because the generated art has lighting baked in, but geometry needs
// the headlamp spotlight and torch lights to shape it — that shading is most of what
// makes a prop read as solid.
//
// Everything is deterministic: jitter comes from a hash of the cell, so the same seed
// renders the same dungeon (spec Â§10).

import * as THREE from 'three';
import { CFG } from '../config.js';
import { getTexture, hasNormalFor, getMirroredNormalTexture, hasRoughnessFor, getMirroredRoughnessTexture } from '../render/assets.js';

// ---- shared materials -------------------------------------------------------

const texCache = new Map();
function tex(key, rx = 1, ry = rx) {
  const src = getTexture(key);
  const pending = !!src.userData.placeholder;      // art not loaded yet -> noise stand-in
  const ck = `${key}@${rx},${ry}`;
  const hit = texCache.get(ck);
  // A clone freezes whatever image existed when it was made, so if the generated art
  // arrives after a level was already built, drop the stale clone and rebuild.
  if (hit && hit.userData.pending === pending) return hit;
  if (hit) hit.dispose();
  const t = src.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // Separate U and V: box faces have 0..1 UVs, so a 2.6 m tall column would stretch one
  // tile of stone over its whole height unless V repeats with the aspect ratio.
  t.repeat.set(rx, ry);
  t.userData.pending = pending;
  texCache.set(ck, t);
  return t;
}

// Same idea for bump: a normal map is paired with a tile by name (textures/door_oak ->
// normals/door_oak) and returns null when there is none, so a prop is built exactly as
// before. The normal already arrives as the mirrored composite, which is what stops seams
// showing on the four faces of a column.
const bumpVec = () => new THREE.Vector2(CFG.bumpScale, CFG.bumpScale);   // read at build time; see levelView
function nrm(key, rx = 1, ry = rx) {
  if (!hasNormalFor(key)) return null;
  const ck = `nrm:${key}@${rx},${ry}`;
  const hit = texCache.get(ck);
  if (hit) return hit;
  const t = getMirroredNormalTexture(key).clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  texCache.set(ck, t);
  return t;
}

// Same pattern for the roughness companion. Measured: a normal map alone moves under 1% of
// pixels under this game's lighting, while the sheen it enables is what the eye actually
// picks up as the player walks past a torch.
function rm(key, rx = 1, ry = rx) {
  if (!hasRoughnessFor(key)) return null;
  const ck = `rm:${key}@${rx},${ry}`;
  const hit = texCache.get(ck);
  if (hit) return hit;
  const t = getMirroredRoughnessTexture(key).clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  texCache.set(ck, t);
  return t;
}

// Barely-there biome tint so stonework in the foundry does not match the crypt exactly.
function tint(biome, hex) {
  return new THREE.Color(hex).lerp(new THREE.Color(biome.accent), 0.07).getHex();
}

// Materials are keyed by an explicit name, never by stringifying their options: a
// THREE.Texture's toJSON needs a renderer, so JSON.stringify on a material that has a
// map throws instead of producing a cache key.
const matCache = new Map();
function mat(key, make) {
  let m = matCache.get(key);
  if (!m) {
    m = make();
    m.userData.shared = true;      // levelView.dispose() must not free these
    matCache.set(key, m);
  }
  return m;
}

const M = {
  wood: () => mat('wood', () => new THREE.MeshStandardMaterial({
    color: 0x8a6a44, roughness: 0.82, metalness: 0.02, map: tex('textures/door_oak'), normalMap: nrm('textures/door_oak'), roughnessMap: rm('textures/door_oak'), normalScale: bumpVec()
  })),
  woodPlain: () => mat('woodPlain', () => new THREE.MeshStandardMaterial({ color: 0x9a7a52, roughness: 0.86, metalness: 0.02 })),
  iron: () => mat('iron', () => new THREE.MeshStandardMaterial({ color: 0x6b7076, roughness: 0.68, metalness: 0.22 })),
  stone: (biome) => mat(`stone:${biome.wall}`, () => new THREE.MeshStandardMaterial({
    color: 0x9a958c, roughness: 0.9, metalness: 0.04, map: tex(`textures/${biome.wall}`), normalMap: nrm(`textures/${biome.wall}`), roughnessMap: rm(`textures/${biome.wall}`), normalScale: bumpVec()
  })),
  // uprights and lintels: repeat the wall tile along V so it keeps its aspect
  stoneTall: (biome) => mat(`stoneTall:${biome.wall}`, () => new THREE.MeshStandardMaterial({
    color: 0x9a958c, roughness: 0.9, metalness: 0.04, map: tex(`textures/${biome.wall}`, 1, 3), normalMap: nrm(`textures/${biome.wall}`, 1, 3), roughnessMap: rm(`textures/${biome.wall}`, 1, 3), normalScale: bumpVec()
  })),
  bone: () => mat('bone', () => new THREE.MeshStandardMaterial({ color: 0xd9d2bf, roughness: 0.7, metalness: 0.02 })),
  brass: () => mat('brass', () => new THREE.MeshStandardMaterial({ color: 0x8f7338, roughness: 0.5, metalness: 0.3 })),
  door: () => mat('doorSlab', () => new THREE.MeshStandardMaterial({
    color: 0xbfae94, roughness: 0.8, metalness: 0.03, map: tex('textures/door_oak'), normalMap: nrm('textures/door_oak'), roughnessMap: rm('textures/door_oak'), normalScale: bumpVec()
  })),
  column: () => mat('column', () => new THREE.MeshStandardMaterial({
    color: 0xb9b3a8, roughness: 0.9, metalness: 0.03, map: tex('textures/pillar'), normalMap: nrm('textures/pillar'), roughnessMap: rm('textures/pillar'), normalScale: bumpVec()
  })),
  plinth: () => mat('plinth', () => new THREE.MeshStandardMaterial({
    color: 0x8f8a80, roughness: 0.85, map: tex('textures/pillar', 0.5), normalMap: nrm('textures/pillar', 0.5), roughnessMap: rm('textures/pillar', 0.5), normalScale: bumpVec()
  })),
  plinthTop: () => mat('plinthTop', () => new THREE.MeshStandardMaterial({ color: 0x9c968b, roughness: 0.8 })),
  // Dressed stone with no map: on small blocks a wall tile stretches into something that
  // looks like wood grain, and a bench of pale planks is exactly what the staircase
  // turned into when its treads were textured. Flat stone reads as cut masonry.
  dressed: (biome) => mat(`dressed:${biome.wall}`, () => new THREE.MeshStandardMaterial({
    color: tint(biome, 0x625c53), roughness: 0.95, metalness: 0.03
  })),
  dressedDark: (biome) => mat(`dressedDark:${biome.wall}`, () => new THREE.MeshStandardMaterial({
    color: tint(biome, 0x4c4841), roughness: 0.95, metalness: 0.03
  })),
  // unlit on purpose: the shaft mouth must not respond to the headlamp, or it stops
  // reading as a hole and starts reading as a painted panel
  shaft: () => mat('shaft', () => new THREE.MeshBasicMaterial({ color: 0x04060a, toneMapped: false })),
  // Flame: emissive but not blown out. At 2.2 the cone photographed as a white spike
  // floating in the corridor, which read as a spear tip rather than a fire. The fix is not
  // less brightness but colour that survives tone mapping — ACES pulls a bright warm
  // emissive toward white, so these are authored as saturated orange and marked
  // toneMapped: false, which keeps the hue instead of desaturating it.
  flame: () => mat('flame', () => new THREE.MeshStandardMaterial({
    color: 0x2b1405, emissive: 0xff6a12, emissiveIntensity: 1.15, roughness: 1, toneMapped: false
  })),
  // the inside of the fire, hotter and smaller, which is what gives the cone shape instead
  // of reading as a flat orange blob
  flameCore: () => mat('flameCore', () => new THREE.MeshStandardMaterial({
    color: 0x3a2409, emissive: 0xffb347, emissiveIntensity: 1.6, roughness: 1, toneMapped: false
  })),
  // Wrought iron as it actually behaves here: no environment map exists in this scene, so
  // a high-metalness surface has nothing to reflect and goes chalky straight in front of
  // the headlamp. Dark colour, low metalness, high roughness is what reads as iron.
  ironDark: () => mat('ironDark', () => new THREE.MeshStandardMaterial({
    color: 0x474b52, roughness: 0.78, metalness: 0.18
  }))
};

// Deterministic per-cell jitter in [-1, 1].
function jitter(x, y, salt = 0) {
  let h = (x * 73856093) ^ (y * 19349663) ^ (salt * 83492791);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

function mesh(geo, material, pos, rot) {
  const m = new THREE.Mesh(geo, material);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

// Drop a piece so its lowest point rests on the floor. Tumbled blocks are rotated, and a
// box tipped onto a corner otherwise hovers a hand's width above the ground, which reads
// instantly as a rendering mistake rather than as debris.
const _box = new THREE.Box3();
function settle(m, sink = 0.01) {
  m.updateMatrixWorld(true);
  _box.setFromObject(m);
  if (_box.isEmpty()) return m;
  m.position.y -= _box.min.y - sink;
  return m;
}

// ---- prop builders ----------------------------------------------------------

function crate() {
  const g = new THREE.Group();
  const body = mesh(new THREE.BoxGeometry(1.0, 0.9, 1.0), M.wood(), [0, 0.45, 0]);
  g.add(body);
  // lid + corner bands: cheap geometry, but it is the silhouette that sells a box
  g.add(mesh(new THREE.BoxGeometry(1.06, 0.08, 1.06), M.woodPlain(), [0, 0.94, 0]));
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    g.add(mesh(new THREE.BoxGeometry(0.07, 0.9, 0.07), M.iron(), [sx * 0.5, 0.45, sz * 0.5]));
  }
  g.add(mesh(new THREE.BoxGeometry(1.04, 0.09, 0.09), M.iron(), [0, 0.62, 0]));
  g.add(mesh(new THREE.BoxGeometry(0.09, 0.09, 1.04), M.iron(), [0, 0.28, 0]));
  return g;
}

function barrel() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.4, 0.44, 1.15, 10), M.wood(), [0, 0.575, 0]));
  for (const y of [0.2, 0.6, 0.98]) {
    g.add(mesh(new THREE.CylinderGeometry(0.455, 0.455, 0.07, 10, 1, true), M.iron(), [0, y, 0]));
  }
  g.add(mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 10), M.woodPlain(), [0, 1.16, 0]));
  return g;
}

function bones() {
  const g = new THREE.Group();
  const longBone = new THREE.CapsuleGeometry(0.055, 0.45, 3, 6);
  for (let i = 0; i < 5; i++) {
    const a = jitter(i, 11, 3) * Math.PI;
    const m = mesh(longBone, M.bone(), [jitter(i, 3) * 0.42, 0.06, jitter(i, 7) * 0.42]);
    m.rotation.set(Math.PI / 2, 0, a);
    g.add(m);
  }
  const skull = new THREE.SphereGeometry(0.14, 8, 6);
  g.add(mesh(skull, M.bone(), [jitter(9, 2) * 0.3, 0.13, jitter(9, 8) * 0.3]));
  g.add(mesh(new THREE.SphereGeometry(0.09, 7, 5), M.bone(), [-0.3, 0.09, 0.24]));
  return g;
}

function chain() {
  const g = new THREE.Group();
  // Links are deliberately chunky: a thin metal torus 6 m down a corridor is invisible
  // under a headlamp, and an invisible prop is worse than no prop.
  const link = new THREE.TorusGeometry(0.1, 0.034, 6, 10);
  const top = CFG.wallH - 0.06;
  for (let i = 0; i < 12; i++) {
    const m = mesh(link, M.iron(), [0, top - i * 0.18, 0]);
    m.rotation.y = i % 2 ? Math.PI / 2 : 0;
    g.add(m);
  }
  const endY = top - 12 * 0.18 - 0.14;
  g.add(mesh(new THREE.TorusGeometry(0.15, 0.05, 6, 10), M.iron(), [0, endY, 0], [Math.PI / 2, 0, 0]));
  g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.45, 6), M.iron(), [0, endY - 0.35, 0]));
  return g;
}

function arch(biome) {
  const g = new THREE.Group();
  const h = 2.6;
  g.add(mesh(new THREE.BoxGeometry(0.42, h, 0.5), M.stoneTall(biome), [-1.0, h / 2, 0]));
  g.add(mesh(new THREE.BoxGeometry(0.42, h, 0.5), M.stoneTall(biome), [1.0, h / 2, 0]));
  g.add(mesh(new THREE.BoxGeometry(2.5, 0.34, 0.6), M.stoneTall(biome), [0, h + 0.17, 0]));
  g.add(mesh(new THREE.BoxGeometry(0.34, 0.3, 0.66), M.stoneTall(biome), [0, h + 0.49, 0]));   // keystone
  for (const sx of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(0.6, 0.18, 0.68), M.dressed(biome), [sx * 1.0, 0.09, 0]));
  }
  return g;
}

function door(biome) {
  const g = new THREE.Group();
  // stone reveal + timber slab: a door is the clearest test of real geometry, because
  // it sits flush in a wall and a billboard never lines up with the wall it belongs to
  g.add(mesh(new THREE.BoxGeometry(0.24, 2.7, 0.34), M.stoneTall(biome), [-0.86, 1.35, 0]));
  g.add(mesh(new THREE.BoxGeometry(0.24, 2.7, 0.34), M.stoneTall(biome), [0.86, 1.35, 0]));
  g.add(mesh(new THREE.BoxGeometry(1.96, 0.26, 0.34), M.stoneTall(biome), [0, 2.72, 0]));
  g.add(mesh(new THREE.BoxGeometry(1.5, 2.6, 0.14), M.door(), [0, 1.3, 0]));
  for (const y of [0.55, 1.35, 2.15]) {
    g.add(mesh(new THREE.BoxGeometry(1.52, 0.1, 0.17), M.iron(), [0, y, 0]));
  }
  g.add(mesh(new THREE.SphereGeometry(0.08, 8, 6), M.brass(), [0.55, 1.25, 0.12]));
  return g;
}

function pillar(biome) {
  const g = new THREE.Group();
  const h = CFG.wallH;
  // eight sides rather than a cylinder: reads as a carved column and stays cheap
  g.add(mesh(new THREE.CylinderGeometry(0.34, 0.38, h - 0.5, 8), M.column(), [0, (h - 0.5) / 2 + 0.22, 0]));
  g.add(mesh(new THREE.BoxGeometry(0.92, 0.22, 0.92), M.dressed(biome), [0, 0.11, 0]));
  g.add(mesh(new THREE.BoxGeometry(0.92, 0.24, 0.92), M.dressed(biome), [0, h - 0.12, 0]));
  return g;
}

function staircase(biome) {
  const g = new THREE.Group();
  // The floor is one unbroken plane, so a real hole is not on the table — and a stair
  // that descends away from you hides its own treads behind the first riser when the eye
  // is at 1.6 m (an earlier version of this photographed as a pale bench). So the shaft
  // is drawn as an *opening in the floor*: a low stone kerb around a black interior, with
  // the treads kept below the kerb top so they are visible from above. That constraint is
  // the whole design: everything inside stays under kerb height.
  const W = 1.7, D = 1.3, kerb = 0.26;
  // kerb along the far and side edges; the near edge is the threshold you walk over
  g.add(mesh(new THREE.BoxGeometry(W + 0.36, kerb, 0.18), M.dressed(biome), [0, kerb / 2, -D / 2 - 0.09]));
  for (const sx of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(0.18, kerb, D + 0.36), M.dressed(biome), [sx * (W / 2 + 0.09), kerb / 2, 0]));
  }
  // the shaft interior: unlit, so the headlamp cannot light it and the eye reads depth
  const mouth = mesh(new THREE.PlaneGeometry(W, D), M.shaft(), [0, 0.03, 0]);
  mouth.rotation.x = -Math.PI / 2;
  g.add(mouth);
  // treads stepping away from you, all below the kerb top so none of them is occluded
  for (let i = 0; i < 3; i++) {
    const y = 0.2 - i * 0.07;
    g.add(mesh(new THREE.BoxGeometry(W - 0.04, y, 0.26), M.dressed(biome), [0, y / 2, D / 2 - 0.18 - i * 0.27]));
  }
  // jamb and lintel at the far end: the frame is what makes the opening findable from
  // across a room, and it hides the seam where the black interior meets the wall
  for (const sx of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(0.2, 1.5, 0.2), M.dressedDark(biome), [sx * (W / 2 + 0.1), 0.75, -D / 2 - 0.1]));
  }
  g.add(mesh(new THREE.BoxGeometry(W + 0.5, 0.26, 0.32), M.dressed(biome), [0, 1.62, -D / 2 - 0.1]));
  return g;
}

function torch(biome, cell = { x: 0, y: 0 }) {
  const g = new THREE.Group();
  // A wall sconce, not a chalice. Earlier proportions (a fat bracket slab, a brass cup
  // wider than the fire) put all the visual weight on the metal, so the flame read as a
  // gold spike. The metal is also kept low-metalness: nothing in this scene has an
  // environment map, and metalness without reflections just goes chalky under the lamp.
  g.add(mesh(new THREE.BoxGeometry(0.12, 0.2, 0.05), M.ironDark(), [0, 0, 0.025]));
  g.add(mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.44, 6), M.ironDark(), [0, 0.16, -0.15], [-0.62, 0, 0]));
  // small grease cup at the end of the arm — deliberately narrower than the flame
  g.add(mesh(new THREE.CylinderGeometry(0.075, 0.05, 0.12, 8), M.ironDark(), [0, 0.36, -0.31]));
  g.add(mesh(new THREE.TorusGeometry(0.075, 0.016, 6, 10), M.brass(), [0, 0.42, -0.31], [Math.PI / 2, 0, 0]));
  // Fire, not a traffic cone. A single clean cone photographed as a solid orange hat, so
  // the flame is a cluster of three licks at slightly different leans, hung from a group
  // based at the cup rim — main.js flickers that group, and the base has to be the pivot
  // or the fire jumps off the sconce as it wobbles.
  const flame = new THREE.Group();
  flame.position.set(0, 0.44, -0.31);
  flame.add(mesh(new THREE.ConeGeometry(0.085, 0.32, 7), M.flame(), [0, 0.16, 0], [0.10, 0.3, 0.07]));
  flame.add(mesh(new THREE.ConeGeometry(0.05, 0.2, 6), M.flameCore(), [0.015, 0.12, 0], [-0.12, 0, -0.10]));
  flame.add(mesh(new THREE.ConeGeometry(0.03, 0.12, 5), M.flame(), [-0.055, 0.07, 0.03], [0.25, 0, 0.35]));
  g.add(flame);
  g.userData.flame = flame;
  g.userData.phase = (jitter(cell.x, cell.y, 5) + 1) * Math.PI;   // no two torches in step
  return g;
}

function pedestal() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.5, 8), M.plinth(), [0, 0.25, 0]));
  g.add(mesh(new THREE.BoxGeometry(0.72, 0.12, 0.72), M.plinthTop(), [0, 0.56, 0]));
  return g;
}

function rubble(biome) {
  const g = new THREE.Group();
  // Broken masonry: a low scatter of tumbled blocks plus one toppled column drum, which
  // is what makes it read as collapsed architecture instead of a pile of cubes. This used
  // to be a billboard looking up `props/rubble`, an asset that was never generated, so
  // the engine drew its procedural placeholder noise — a grey blob sitting in corridors.
  for (let i = 0; i < 7; i++) {
    const w = 0.26 + ((jitter(i, 1) + 1) / 2) * 0.3;
    const h = 0.14 + ((jitter(i, 2) + 1) / 2) * 0.2;
    const d = 0.26 + ((jitter(i, 3) + 1) / 2) * 0.3;
    const m = mesh(new THREE.BoxGeometry(w, h, d), M.dressedDark(biome),
      [jitter(i, 4) * 0.55, 0, jitter(i, 5) * 0.55]);
    m.rotation.set(jitter(i, 7) * 0.22, jitter(i, 6) * Math.PI, jitter(i, 8) * 0.22);
    g.add(settle(m));
  }
  g.add(settle(mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.72, 8), M.dressed(biome),
    [0.16, 0, -0.12], [Math.PI / 2, 0.35, 0])));
  for (let i = 0; i < 5; i++) {
    g.add(settle(mesh(new THREE.TetrahedronGeometry(0.085), M.dressed(biome),
      [jitter(i, 11) * 0.72, 0, jitter(i, 13) * 0.72], [0, jitter(i, 12) * Math.PI, 0])));
  }
  return g;
}

// Procedural web: a small canvas of radial spokes and sagging arcs. The generated
// `textures/cobweb` tile is a seamless surface texture with its own background, which is
// wrong for a hanging veil, so this is drawn in code instead of spending an art slot.
let webTex = null;
function webTexture() {
  if (webTex) return webTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(238,242,248,0.95)';
  g.lineWidth = 2.2;
  const cx = 24, cy = 24;                       // anchored in the corner
  const spokes = 7;
  const pts = [];
  for (let i = 0; i <= spokes; i++) {
    const a = (Math.PI / 2) * (i / spokes);
    const r = 230;
    const ex = cx + Math.cos(a) * r, ey = cy + Math.sin(a) * r;
    g.beginPath();
    g.moveTo(cx, cy);
    // spokes sag slightly, the way a real web does under its own weight
    g.quadraticCurveTo((cx + ex) / 2, (cy + ey) / 2 + 18, ex, ey);
    g.stroke();
    pts.push([ex, ey]);
  }
  g.lineWidth = 1.5;
  for (let ring = 1; ring <= 6; ring++) {
    const f = ring / 6.5;
    g.beginPath();
    for (let i = 0; i <= spokes; i++) {
      const [ex, ey] = pts[i];
      const x = cx + (ex - cx) * f, y = cy + (ey - cy) * f + 10 * f;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  webTex = new THREE.CanvasTexture(c);
  webTex.colorSpace = THREE.SRGBColorSpace;
  return webTex;
}

function cobweb() {
  const g = new THREE.Group();
  const sheet = new THREE.PlaneGeometry(1.5, 1.15);
  const m = mat('cobweb', () => new THREE.MeshStandardMaterial({
    map: webTexture(), transparent: true, opacity: 0.5, roughness: 1, metalness: 0,
    side: THREE.DoubleSide, depthWrite: false, color: 0xdfe4ea
  }));
  // two crossing sheets hung from the ceiling; from any corridor angle at least one reads
  for (const rot of [0, Math.PI / 2]) {
    const q = mesh(sheet, m, [0, CFG.wallH - 0.62, 0], [0.18, rot, 0.1]);
    g.add(q);
  }
  // a short drape down the corner catches the headlamp on the way past
  g.add(mesh(new THREE.PlaneGeometry(0.7, 1.3), m, [0.42, CFG.wallH - 1.5, -0.42], [0, Math.PI / 4, 0]));
  return g;
}

// ---- public API -------------------------------------------------------------

// Returns a Group positioned at the world origin; the caller places it. Returns null for
// kinds that should stay sprites, so levelView can fall back instead of dropping detail.
export function makeProp(kind, biome, cell = { x: 0, y: 0 }) {
  let g = null;
  switch (kind) {
    case 'crate': g = crate(); break;
    case 'barrel': g = barrel(); break;
    case 'bones': g = bones(); break;
    case 'chain_hanging': g = chain(); break;
    case 'stone_arch': g = arch(biome); break;
    case 'door_oak': g = door(biome); break;
    case 'rubble': g = rubble(biome); break;
    case 'cobweb': g = cobweb(biome); break;
    default: return null;
  }
  g.rotation.y = (jitter(cell.x, cell.y, 1) + 1) * Math.PI * 0.5;
  g.position.set(jitter(cell.x, cell.y, 2) * 0.12, 0, jitter(cell.x, cell.y, 3) * 0.12);
  g.userData.solid = true;
  return g;
}

export function makePillar(biome) { return pillar(biome); }
export function makeStaircase(biome) { return staircase(biome); }
export function makeTorch(biome, cell) { return torch(biome, cell); }
export function makePedestal() { return pedestal(); }

// Called when a level is torn down: the shared caches hold materials that reference
// biome textures, which stay valid across levels, so nothing to dispose here — but the
// per-level groups are released by their parent group being removed.
export function disposePropCaches() {
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
  for (const t of texCache.values()) t.dispose();
  texCache.clear();
}
