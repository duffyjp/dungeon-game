// Level view: turns the generated tile grid into three.js geometry (spec §3, §9.4).
// Floor + ceiling are one plane each; walls are a single InstancedMesh limited to
// wall tiles that actually face walkable space, which keeps draw calls inside budget.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { getTexture, getMirroredTexture, hasAsset, hasNormalFor, getMirroredNormalTexture, hasRoughnessFor, getMirroredRoughnessTexture } from '../render/assets.js';
import { makeProp, makePillar, makeStaircase, makeTorch } from './propMeshes.js';
import { isOpen } from '../util/grid.js';

export function cellToWorld(level, x, y) {
  return { x: (x + 0.5) * CFG.cell, z: (y + 0.5) * CFG.cell };
}
export function worldToCell(wx, wz) {
  return { x: Math.floor(wx / CFG.cell), y: Math.floor(wz / CFG.cell) };
}
export function isWallWorld(level, wx, wz) {
  const c = worldToCell(wx, wz);
  return !isOpen(level, c.x, c.y);
}

// Surface materials use the mirrored composite so tile boundaries cannot show a seam.
// Repeat is halved because the composite already contains 2x2 copies of the source.
function tileTex(key, repeat) {
  const t = getMirroredTexture(key);
  t.repeat.set(repeat[0] / 2, repeat[1] / 2);
  return t;
}

// Bump: an optional tangent-space normal map paired with a tile by name
// (textures/wall_crypt -> normals/wall_crypt). Absent a normal, the material is built
// exactly as before, so the feature can be rolled out tile by tile. The scale is a taste
// knob: below ~0.4 the relief disappears under torch light, above ~1.2 the mortar joints
// start casting their own shadow and read as carved rather than weathered.
const BUMP_SCALE = 1.4;
function tileNormal(key, repeat) {
  if (!hasNormalFor(key)) return null;
  const t = getMirroredNormalTexture(key);
  t.repeat.set(repeat[0] / 2, repeat[1] / 2);
  return t;
}

// Roughness companion, paired the same way (textures/wall_crypt -> roughness/wall_crypt).
// This is the part of the surface detail the player can actually see: measured against the
// game's own lighting, a diffuse normal map alone moves 0.4% of pixels under the headlamp and
// 0.8% beside a torch, which is below the threshold of notice. Adding the sheen map roughly
// triples those numbers, and more importantly it is view-dependent, so the wet highlight
// slides across the worn faces as the player moves — motion the eye reads as relief even
// where a still frame does not show it.
function tileRough(key, repeat) {
  if (!hasRoughnessFor(key)) return null;
  const t = getMirroredRoughnessTexture(key);
  t.repeat.set(repeat[0] / 2, repeat[1] / 2);
  return t;
}

// Radial feather used as alphaMap on floor decals, so a square generated patch fades
// into the floor instead of reading as a pasted tile.
let decalMask = null;
function getDecalMask() {
  if (decalMask) return decalMask;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, s * 0.14, s / 2, s / 2, s * 0.5);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.6, '#a8a8a8');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  decalMask = new THREE.CanvasTexture(c);
  return decalMask;
}

function cloneTex(tex, repeat) {
  const t = tex.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  return t;
}   // kept for one-off materials that must not share the mirrored cache

export function buildLevelView(level, biome) {
  const group = new THREE.Group();
  const wUnits = level.w * CFG.cell;
  const hUnits = level.h * CFG.cell;

  // ---- floor
  const floorTex = tileTex(`textures/${biome.floor}`, [level.w, level.h]);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(wUnits, hUnits),
    new THREE.MeshStandardMaterial({
      map: floorTex,
      normalMap: tileNormal(`textures/${biome.floor}`, [level.w, level.h]),
      normalScale: new THREE.Vector2(BUMP_SCALE, BUMP_SCALE),
      roughnessMap: tileRough(`textures/${biome.floor}`, [level.w, level.h]),
      roughness: 0.92, metalness: 0.04
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(wUnits / 2, 0, hUnits / 2);
  floor.receiveShadow = true;
  group.add(floor);

  // ---- ceiling
  const ceilKey = biome.ceiling ? `textures/${biome.ceiling}` : `textures/${biome.wall}`;
  const ceilTex = tileTex(ceilKey, [level.w, level.h]);
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(wUnits, hUnits),
    new THREE.MeshStandardMaterial({
      map: ceilTex,
      normalMap: tileNormal(ceilKey, [level.w, level.h]),
      normalScale: new THREE.Vector2(BUMP_SCALE, BUMP_SCALE),
      roughnessMap: tileRough(ceilKey, [level.w, level.h]),
      roughness: 0.98, metalness: 0
    })
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(wUnits / 2, CFG.wallH, hUnits / 2);
  group.add(ceil);

  // ---- walls (instanced)
  const instances = [];
  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      if (isOpen(level, x, y)) continue;
      // skip wall blocks with no walkable neighbour: never visible from inside
      let visible = false;
      for (let dy = -1; dy <= 1 && !visible; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < level.w && ny < level.h && isOpen(level, nx, ny)) { visible = true; break; }
        }
      }
      if (visible) instances.push({ x, y });
    }
  }
  const wallTex = tileTex(`textures/${biome.wall}`, [1, CFG.wallH / CFG.cell]);
  const wallMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(CFG.cell, CFG.wallH, CFG.cell),
    new THREE.MeshStandardMaterial({
      map: wallTex,
      normalMap: tileNormal(`textures/${biome.wall}`, [1, CFG.wallH / CFG.cell]),
      normalScale: new THREE.Vector2(BUMP_SCALE, BUMP_SCALE),
      roughnessMap: tileRough(`textures/${biome.wall}`, [1, CFG.wallH / CFG.cell]),
      roughness: 0.88, metalness: 0.08
    }),
    instances.length
  );
  const m = new THREE.Matrix4();
  instances.forEach((c, i) => {
    m.makeTranslation((c.x + 0.5) * CFG.cell, CFG.wallH / 2, (c.y + 0.5) * CFG.cell);
    wallMesh.setMatrixAt(i, m);
  });
  wallMesh.instanceMatrix.needsUpdate = true;
  wallMesh.castShadow = false;      // dungeon lighting is faked; real shadow maps here cost too much
  wallMesh.receiveShadow = false;
  group.add(wallMesh);

  // ---- decorative props
  const propMeshes = [];
  for (const p of level.props) {
    const wx = (p.x + 0.5) * CFG.cell, wz = (p.y + 0.5) * CFG.cell;
    if (p.decal) {
      // Floor decals lie flat and never billboard. Generated decals have no alpha and
      // hard square edges, so a radial alpha mask feathers them into the floor.
      const decal = new THREE.Mesh(
        new THREE.PlaneGeometry(CFG.cell * 1.3, CFG.cell * 1.3),
        new THREE.MeshBasicMaterial({
          map: getTexture(`textures/${p.kind}`),
          alphaMap: getDecalMask(),
          transparent: true, opacity: 0.72, depthWrite: false, toneMapped: false
        })
      );
      decal.rotation.x = -Math.PI / 2;
      decal.rotation.z = Math.random() * Math.PI * 2;
      decal.position.set(wx, 0.02, wz);
      group.add(decal);
      continue;
    }
    if (p.kind === 'pillar') {
      // collision is the wall instance; the column is the carved detail on top of it
      const col = makePillar(biome);
      col.position.set(wx, 0, wz);
      group.add(col);
      propMeshes.push(col);
      continue;
    }
    // Solid objects are real geometry now, so strafing past a crate shows its sides.
    // Anything makeProp declines (still-organic shapes) falls back to a billboard.
    const solid = makeProp(p.kind, biome, p);
    if (solid) {
      solid.position.x += wx;
      solid.position.z += wz;
      group.add(solid);
      propMeshes.push(solid);
      continue;
    }
    const key = p.kind === 'door_oak' ? 'textures/door_oak' : `props/${p.kind}`;
    // A prop kind with no art must be skipped, not drawn: the placeholder stand-in is a
    // development aid, and in play it shows up as a grey blob sitting in a corridor.
    if (!hasAsset(key)) {
      console.warn(`[levelView] no art for prop "${p.kind}" — skipping`);
      continue;
    }
    const mesh = makeBillboard(key, propSize(p.kind), wx, wz);
    group.add(mesh);
    propMeshes.push(mesh);
  }

  // ---- torches: mounted on a wall face; only the nearest few get a PointLight (§16)
  const torchMeshes = [];
  for (const t of level.torches) {
    const dir = wallDirection(level, t.x, t.y);
    if (!dir) continue;               // an all-open cell has no face; skip rather than float
    const cx = (t.x + 0.5) * CFG.cell, cz = (t.y + 0.5) * CFG.cell;
    const mx = cx + dir.x * (CFG.cell / 2 - 0.07);
    const mz = cz + dir.z * (CFG.cell / 2 - 0.07);
    const sconce = makeTorch(biome, t);
    sconce.position.set(mx, 1.55, mz);
    // the bracket plate is the group's +z side, so point +z into the wall and the arm,
    // cup and flame hang out into the corridor where they belong
    sconce.rotation.y = Math.atan2(dir.x, dir.z);
    sconce.userData.world = { x: mx - dir.x * 0.4, z: mz - dir.z * 0.4 };
    sconce.userData.mount = dir;
    group.add(sconce);
    torchMeshes.push(sconce);
  }

  // ---- staircase: descending steps facing the way the player approaches
  const st = cellToWorld(level, level.stair.x, level.stair.y);
  const stair = makeStaircase(biome);
  stair.position.set(st.x, 0, st.z);
  const entryW = cellToWorld(level, level.entry.x, level.entry.y);
  stair.rotation.y = Math.atan2(entryW.x - st.x, entryW.z - st.z);
  stair.userData.world = st;
  group.add(stair);

  const glow = new THREE.PointLight(biome.accent, 2.4, 9, 2);
  // low, at the mouth of the shaft: light coming up out of the opening is what tells the
  // player this is a way down and not a decoration
  glow.position.set(st.x, 0.22, st.z - 0.3);
  group.add(glow);

  return {
    group,
    wallMesh,
    torches: torchMeshes,
    propMeshes,
    stairMesh: stair,
    stairWorld: st,
    dispose() {
      group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const mm of mats) {
            // Prop materials and their textures are cached and reused across levels, so
            // tearing down one level must not free what the next level is about to draw.
            if (mm.userData && mm.userData.shared) continue;
            if (mm.map) mm.map.dispose();
            mm.dispose();
          }
        }
      });
    }
  };
}

// Which wall face a wall-mounted fixture should hang on. Returns a unit direction from
// the cell centre toward a neighbouring wall (the map edge counts as wall), or null when
// the cell is open on all four sides and has nothing to mount to. Where several faces are
// available it prefers one whose opposite neighbour is open, so the flame lights along the
// corridor instead of into a dead-end alcove.
function wallDirection(level, x, y) {
  const at = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= level.w || cy >= level.h) return 0;   // outside = solid
    return level.open[cy * level.w + cx];
  };
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const faces = dirs.filter(([dx, dy]) => at(x + dx, y + dy) !== 1);
  if (faces.length === 0) return null;
  const facing = faces.find(([dx, dy]) => at(x - dx, y - dy) === 1);
  const [dx, dy] = facing || faces[0];
  return { x: dx, z: dy };
}

function propSize(kind) {
  switch (kind) {
    case 'crate': return [1.2, 1.2];
    case 'barrel': return [1.0, 1.3];
    case 'bones': return [1.3, 0.6];
    case 'cobweb': return [1.8, 1.8];
    case 'chain_hanging': return [0.7, 3.0];
    case 'door_oak': return [1.8, 2.8];
    case 'stone_arch': return [2.6, 3.2];
    default: return [1.4, 0.8];
  }
}

export function makeBillboard(assetKey, size, wx, wz, centerY) {
  const [sw, sh] = size;
  const mat = new THREE.MeshBasicMaterial({
    map: getTexture(assetKey),
    transparent: true,
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    toneMapped: false
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), mat);
  mesh.position.set(wx, centerY ?? sh / 2, wz);
  mesh.userData.billboard = true;
  mesh.userData.assetKey = assetKey;
  return mesh;
}

export function billboardTowards(mesh, camera) {
  // upright (Y-only) billboarding so standing sprites never tilt (spec §3)
  const dx = camera.position.x - mesh.position.x;
  const dz = camera.position.z - mesh.position.z;
  // Set, do not add: an extra roll below has to be applied to a known orientation or it
  // would compound every frame and spin the sprite up into a blur.
  mesh.rotation.set(0, Math.atan2(dx, dz), 0);
  if (mesh.userData.roll) mesh.rotateZ(mesh.userData.roll);
}
