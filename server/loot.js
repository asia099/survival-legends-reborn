// Server-side loot tables and inventory operations. Clients only request actions;
// every item that exists was created here.

import { WEAPONS, CONSUMABLES, AMMO, INVENTORY_SLOTS, RARITIES } from '../shared/config.js';

const RARITY_WEIGHTS = [
  [52, 28, 13, 5, 1.8, 0.2],   // tier 0: wilderness / small camps
  [36, 30, 20, 10, 3.6, 0.4],  // tier 1: towns
  [20, 27, 28, 16, 8, 1],      // tier 2: city / keep
  [8, 18, 32, 24, 15, 3],      // tier 3: upper floors of high-tier POIs
];
const WEAPON_WEIGHTS = { pistol: 24, smg: 22, ar: 25, shotgun: 18, sniper: 11 };
const CONSUMABLE_WEIGHTS = { bandage: 40, shieldcell: 30, medkit: 12, shieldpack: 18 };

function pickWeighted(rng, table) {
  const entries = Array.isArray(table) ? table.map((w, i) => [i, w]) : Object.entries(table);
  let total = 0;
  for (const [, w] of entries) total += w;
  let roll = rng() * total;
  for (const [k, w] of entries) { roll -= w; if (roll <= 0) return k; }
  return entries[entries.length - 1][0];
}

export function makeWeapon(type, rarity) {
  return { kind: 'weapon', type, rarity, mag: WEAPONS[type].mag };
}

export function rollItems(rng, tier) {
  const t = Math.max(0, Math.min(3, tier));
  const roll = rng();
  if (roll < 0.45) {
    const type = pickWeighted(rng, WEAPON_WEIGHTS);
    const rarity = Number(pickWeighted(rng, RARITY_WEIGHTS[t]));
    const w = makeWeapon(type, rarity);
    return [w, { kind: 'ammo', type: WEAPONS[type].ammo, count: AMMO[WEAPONS[type].ammo].pickup }];
  }
  if (roll < 0.75) {
    const type = pickWeighted(rng, CONSUMABLE_WEIGHTS);
    const count = type === 'bandage' ? 3 + Math.floor(rng() * 3) : type === 'shieldcell' ? 2 + Math.floor(rng() * 2) : 1;
    return [{ kind: 'item', type, count }];
  }
  const type = pickWeighted(rng, { light: 35, medium: 32, shells: 20, heavy: 13 });
  return [{ kind: 'ammo', type, count: AMMO[type].pickup }];
}

export function spawnWorldLoot(world, rng, nextId) {
  const loot = new Map();
  const spawnChance = [0.6, 0.8, 0.95, 1];
  for (const s of world.lootSpots) {
    if (rng() > spawnChance[Math.min(3, s.tier)]) continue;
    const items = rollItems(rng, s.tier);
    items.forEach((item, i) => {
      const id = nextId();
      loot.set(id, { id, x: s.x + i * 0.8, y: s.y, z: s.z + i * 0.3, item });
    });
  }
  return loot;
}

export function itemLabel(item) {
  if (item.kind === 'weapon') return `${RARITIES[item.rarity].name} ${WEAPONS[item.type].name}`;
  if (item.kind === 'item') return `${CONSUMABLES[item.type].name} x${item.count}`;
  return `${AMMO[item.type].name} x${item.count}`;
}

export function createInventory() {
  return {
    slots: new Array(INVENTORY_SLOTS).fill(null),
    active: 0,
    ammo: { light: 0, medium: 0, shells: 0, heavy: 0 },
  };
}

/**
 * Add an item to the inventory. Returns { taken: bool, leftover: item|null, dropped: item|null }.
 * `dropped` is an item displaced from the active slot (weapon swap) that must go back on the ground.
 */
export function addItem(inv, item) {
  if (item.kind === 'ammo') {
    const max = AMMO[item.type].max;
    const space = max - inv.ammo[item.type];
    if (space <= 0) return { taken: false, leftover: item, dropped: null };
    const n = Math.min(space, item.count);
    inv.ammo[item.type] += n;
    const leftover = item.count - n > 0 ? { ...item, count: item.count - n } : null;
    return { taken: true, leftover, dropped: null };
  }
  if (item.kind === 'item') {
    const max = CONSUMABLES[item.type].stack;
    let count = item.count;
    for (const s of inv.slots) {
      if (s && s.kind === 'item' && s.type === item.type && s.count < max) {
        const n = Math.min(max - s.count, count);
        s.count += n; count -= n;
        if (count === 0) break;
      }
    }
    if (count > 0) {
      const free = inv.slots.indexOf(null);
      if (free >= 0) { inv.slots[free] = { kind: 'item', type: item.type, count }; count = 0; }
    }
    if (count === item.count) return { taken: false, leftover: item, dropped: null };
    return { taken: true, leftover: count > 0 ? { ...item, count } : null, dropped: null };
  }
  // Weapon: first free slot, otherwise swap with the active slot.
  const free = inv.slots.indexOf(null);
  if (free >= 0) { inv.slots[free] = { ...item }; return { taken: true, leftover: null, dropped: null }; }
  const dropped = inv.slots[inv.active];
  inv.slots[inv.active] = { ...item };
  return { taken: true, leftover: null, dropped };
}

export function serializeInventory(inv) {
  return {
    slots: inv.slots.map((s) => (s ? { ...s } : null)),
    active: inv.active,
    ammo: { ...inv.ammo },
  };
}
