// Drop rolls + the quality system (spec §8). This is the module that makes drops
// non-repeating: an independent tier roll and a continuous jitter per drop.
//
// The table is injected rather than imported so this module also runs under plain
// Node (the headless harness in tools/ uses it without a bundler).

let quality = null;
export function useQualityTable(table) { quality = table; }
function table() {
  if (!quality) throw new Error('quality table not loaded — call useQualityTable() first');
  return quality;
}

export function tiers() { return table().tiers; }

export function bandKey(depth) {
  if (depth <= 2) return '1-2';
  if (depth <= 5) return '3-5';
  if (depth <= 9) return '6-9';
  return '10+';
}

export function rollTierIndex(depth, rng, bonus = 0) {
  const weights = table().tierWeights[bandKey(depth)].slice();
  // A bonus shifts mass toward higher tiers rather than just adding a flat tier,
  // so a miniboss drop at depth 2 is strong for depth 2, not depth 7 gear.
  for (let b = 0; b < bonus; b++) {
    for (let i = weights.length - 1; i > 0; i--) {
      const move = weights[i] * 0.6;
      weights[i] -= move;
      weights[i + 1] += move;
    }
  }
  return rng.weighted(weights);
}

// itemDef: entry from data/items.json. rng: seeded. Returns an item instance.
export function makeItem(itemDef, depth, rng, bonus = 0) {
  const T = table().tiers;
  const tierIndex = Math.min(T.length - 1, rollTierIndex(depth, rng, bonus));
  const tier = T[tierIndex];
  const [j0, j1] = table().jitter;
  const jitter = j0 + (j1 - j0) * rng.next();
  // Past the final tier band the dungeon keeps scaling, so gear has to keep pace.
  // This scales the stat rather than the tier weights: an endless run should not
  // become "everything is a Relic", it should become "the numbers keep climbing".
  const endless = depth > 10 ? 1 + 0.06 * (depth - 10) : 1;
  const qualityMult = tier.mult * jitter * endless;

  const inst = {
    def: itemDef,
    id: itemDef.id,
    slot: itemDef.slot,
    sprite: itemDef.sprite,
    tierIndex,
    tier,
    jitter,
    quality: qualityMult,
    color: tier.color
  };

  if (itemDef.slot === 'weapon') {
    inst.damage = Math.max(1, Math.round(itemDef.base * qualityMult));
    inst.score = inst.damage + tierIndex * 4;
    inst.label = nameWithPrefix(itemDef, tierIndex, rng);
  } else if (itemDef.slot === 'armor') {
    inst.maxDurability = Math.max(1, Math.round(itemDef.base * qualityMult));
    inst.mitigation = Math.min(0.55, itemDef.mitigation * (0.85 + 0.3 * jitter));
    inst.score = Math.round(inst.maxDurability * 0.4) + itemDef.tierRank * 12 + tierIndex * 4;
    inst.label = nameWithPrefix(itemDef, tierIndex, rng);
  } else if (itemDef.slot === 'score') {
    const [v0, v1] = itemDef.value;
    inst.value = rng.int(v0, v1) * (1 + Math.floor(depth / 3));
    inst.score = inst.value;
    inst.label = `${inst.value} coin`;
  } else if (itemDef.slot === 'instant' && itemDef.heal) {
    const [h0, h1] = itemDef.heal;
    inst.heal = rng.int(h0, h1);
    inst.score = inst.heal;
    inst.label = `${itemDef.name} (+${inst.heal})`;
  } else {
    inst.score = 5;
    inst.label = itemDef.name;
  }
  return inst;
}

function nameWithPrefix(itemDef, tierIndex, rng) {
  const list = table().prefixes[String(tierIndex)] || [''];
  const prefix = rng.pick(list);
  const base = itemDef.name.replace(/^(Worn|Fine|Refined|Masterwork|Relic of the Deep)\s+/, '');
  return prefix ? `${prefix} ${base}` : base;
}

// Compare helper used by the auto-equip rule (§8.4)
export function isBetter(candidate, current) {
  if (!current) return true;
  if (!candidate || candidate.slot !== current.slot) return false;
  return candidate.score > current.score;
}
