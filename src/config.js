// Tuning constants. Every value here is a starting point per GAME_DESIGN_SPEC.md §16
// and is expected to move under the §19 tuning harness. Nothing gameplay-critical is
// hard-coded inside system code; import from here.
export const CFG = {
  // world
  cell: 2.0,                 // metres per grid cell
  wallH: 3.6,                // wall height
  eye: 1.65,                 // camera height
  fogNear: 2.0,
  fogFar: 34.0,

  // player
  radius: 0.35,
  walk: 3.2,
  jog: 4.6,
  fov: 85,
  maxHealth: 100,
  startLives: 3,
  livesCap: 5,
  respawnInvuln: 2.5,
  magnetRadius: 0.6,
  stairHold: 1.5,
  armorRepairOnDescent: 0.35,
  armorSoak: 0.65,           // fraction of mitigated damage that hits the armour bar
  mitigationCap: 0.55,

  // difficulty scaling per depth (spec §6.2)
  depthHpPer: 0.18,
  depthDmgPer: 0.15,
  depthSpeedPer: 0.04,
  depthSpeedCap: 1.35,

  // levels
  // levels  (indexed directly by band 0..3; odd tile counts)
  // Tuned against tools/validateLevels.mjs so median entry->stair walk time stays
  // inside the 60-150 s per-level target of §2 once exploration and combat are added.
  sizes: [21, 25, 29, 33],
  braidBase: 0.15,
  braidPerBand: 0.05,
  braidCap: 0.35,
  roomsMin: 3,
  roomsMax: 7,
  maxGenAttempts: 8,
  stairSenseDepth: 5,

  // spawning
  enemyBase: 7,
  enemyPerDepth: 1.6,
  enemyMax: 34,
  spawnDistMin: 8,
  spawnDistMax: 40,
  spawnSeparation: 4,
  stairGuard: 2,
  lootAlcoves: [2, 4],

  // lights
  lightPool: 6,
  torchSpacingMin: 3,
  maxTorches: 16,

  // audio
  sfxVoices: 6,
  musicCrossfade: 1.2,
  musicDuck: 0.2,

  // loot
  // A bow found on a treasure pedestal comes with a quiver, so the find is a working
  // weapon the moment you pick it up instead of a promise you have to keep.
  arrowsWithTreasureBow: 5,

  // score
  scorePerDepth: 100,
  scorePerKill: 10,
  scoreKillTierMult: 1.6
};
