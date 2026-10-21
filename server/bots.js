// Simple server-side bots. They act through the same authoritative paths as humans
// (applyInput / fire / pickup / useItem), so they cannot do anything a player cannot.

import { IN, INPUT_DT, WEAPONS, CONSUMABLES, AMMO } from '../shared/config.js';
import { MODE, eyeHeight } from '../shared/physics.js';

export const BOT_NAMES = [
  'Ember', 'Quill', 'Vesper', 'Rook', 'Juniper', 'Sable', 'Thorne', 'Wren', 'Corvid', 'Halcyon',
  'Marlow', 'Brine', 'Kestrel', 'Onyx', 'Pike', 'Sorrel', 'Tamsin', 'Vale', 'Ashby', 'Lark',
];

export function createBrain(match, p) {
  const rng = match?.rng ?? Math.random;
  const ship = match?.ship;
  const flight = ship ? ship.len / ship.speed : 0;
  return {
    ejectAt: ship ? ship.start + 2 + rng() * Math.max(1, flight * 0.85 - 2) : 0,
    landTarget: null, dest: null, nextThink: 0, enemy: null, nextShot: 0,
    strafe: 1, strafeUntil: 0, stuckCheckAt: 0, stuckPos: null, jumpUntil: 0,
    lootId: null, skill: 0.45 + rng() * 0.5,
  };
}

const yawTo = (dx, dz) => Math.atan2(-dx, -dz);

function hasLos(m, p, q) {
  const o = [p.st.x, p.st.y + eyeHeight(p.st), p.st.z];
  const tx = q.st.x - o[0], ty = q.st.y + 1.1 - o[1], tz = q.st.z - o[2];
  const d = Math.hypot(tx, ty, tz);
  if (d < 0.01) return true;
  const hit = m.world.raycast(o[0], o[1], o[2], tx / d, ty / d, tz / d, d);
  return hit.t >= d - 0.3;
}

function weaponScore(type, dist) {
  if (dist < 10) return { shotgun: 5, smg: 4, ar: 3, pistol: 2, sniper: 1 }[type];
  if (dist < 35) return { ar: 5, smg: 4, shotgun: 2, pistol: 3, sniper: 2 }[type];
  return { sniper: 5, ar: 4, pistol: 2, smg: 2, shotgun: 0 }[type];
}

function bestWeaponSlot(p, dist) {
  let best = -1, bestS = -1;
  p.inv.slots.forEach((s, i) => {
    if (!s || s.kind !== 'weapon') return;
    if (s.mag <= 0 && p.inv.ammo[WEAPONS[s.type].ammo] <= 0) return;
    const sc = weaponScore(s.type, dist) + s.rarity * 0.3;
    if (sc > bestS) { bestS = sc; best = i; }
  });
  return best;
}

function wantsLoot(p, item) {
  if (item.kind === 'weapon') {
    const weapons = p.inv.slots.filter((s) => s && s.kind === 'weapon');
    if (p.inv.slots.includes(null)) return weapons.length < 3;
    return false;
  }
  if (item.kind === 'ammo') {
    return p.inv.slots.some((s) => s && s.kind === 'weapon' && WEAPONS[s.type].ammo === item.type)
      && p.inv.ammo[item.type] < AMMO[item.type].max / 2;
  }
  return p.inv.slots.includes(null) || p.inv.slots.some((s) => s && s.kind === 'item' && s.type === item.type && s.count < CONSUMABLES[s.type].stack);
}

function think(m, p, b) {
  const t = m.time, rng = m.rng, s = p.st;
  b.nextThink = t + 0.25 + rng() * 0.15;

  if (s.m === MODE.GLIDE) {
    if (!b.landTarget) {
      const spots = m.world.lootSpots;
      const sp = spots[Math.floor(rng() * spots.length)];
      b.landTarget = { x: sp.x, z: sp.z };
    }
    return;
  }

  // Look for enemies.
  let best = null, bestD = 70;
  for (const q of m.players.values()) {
    if (q === p || !q.alive || !q.participant || q.team === p.team || q.st.m === MODE.SHIP) continue;
    const d = Math.hypot(q.st.x - s.x, q.st.y - s.y, q.st.z - s.z);
    if (d < bestD && hasLos(m, p, q)) { best = q; bestD = d; }
  }
  if (best) {
    if (b.enemy !== best.id) b.nextShot = t + 0.3 + (1 - b.skill) * 0.6;
    b.enemy = best.id;
    const slot = bestWeaponSlot(p, bestD);
    if (slot >= 0 && slot !== p.inv.active && !p.reload) m.switchSlot(p, slot);
    if (t > b.strafeUntil) { b.strafe = rng() < 0.5 ? -1 : 1; b.strafeUntil = t + 0.6 + rng() * 0.9; }
    return;
  }
  b.enemy = null;

  // Heal up when safe.
  if (!p.use) {
    const healIdx = p.inv.slots.findIndex((x) => x && x.kind === 'item'
      && ((CONSUMABLES[x.type].heal && p.hp < CONSUMABLES[x.type].healCap - 10)
       || (CONSUMABLES[x.type].shield && p.sh < CONSUMABLES[x.type].shieldCap - 10)));
    if (healIdx >= 0 && (p.hp < 70 || p.sh < 40)) {
      if (p.inv.active !== healIdx) m.switchSlot(p, healIdx);
      m.useItem(p);
      if (p.use) return;
    }
  } else return;

  // Top up the magazine.
  const cur = p.inv.slots[p.inv.active];
  if (cur && cur.kind === 'weapon' && cur.mag < WEAPONS[cur.type].mag / 2) m.startReload(p);
  else if (!cur || cur.kind !== 'weapon') {
    const ws = bestWeaponSlot(p, 30);
    if (ws >= 0) m.switchSlot(p, ws);
  }

  // Storm awareness: head inside the next circle if we are outside it.
  const storm = m.storm;
  if (storm.active) {
    const target = storm.to;
    const dTo = Math.hypot(s.x - target.x, s.z - target.z);
    const cur = storm.circle(t);
    const dCur = Math.hypot(s.x - cur.x, s.z - cur.z);
    if (dCur > cur.r - 5 || (dTo > target.r * 0.85 && storm.stage === 'shrink') || (dTo > target.r && t > storm.stageEnd - 15)) {
      const a = rng() * Math.PI * 2, r = rng() * target.r * 0.5;
      if (!b.dest || b.dest.kind !== 'storm') b.dest = { kind: 'storm', x: target.x + Math.cos(a) * r, z: target.z + Math.sin(a) * r };
      return;
    }
  }

  // Loot.
  let lootBest = null, lootD = 45;
  for (const l of m.loot.values()) {
    const d = Math.hypot(l.x - s.x, l.z - s.z);
    if (d < lootD && Math.abs(l.y - s.y) < 6 && wantsLoot(p, l.item)) { lootBest = l; lootD = d; }
  }
  if (lootBest) {
    if (lootD < 2.2 && Math.abs(lootBest.y - s.y) < 2.2) { m.pickup(p, lootBest.id); b.dest = null; return; }
    b.dest = { kind: 'loot', x: lootBest.x, z: lootBest.z };
    return;
  }

  // Wander inside the safe zone.
  if (!b.dest || Math.hypot(b.dest.x - s.x, b.dest.z - s.z) < 3) {
    const c = storm.active ? storm.circle(t) : { x: 0, z: 0, r: 150 };
    const a = rng() * Math.PI * 2, r = rng() * c.r * 0.7;
    b.dest = { kind: 'wander', x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r };
  }
}

export function updateBot(m, p, dt) {
  if (!p.alive) return;
  const b = p.brain, s = p.st, t = m.time, rng = m.rng;
  if (s.m === MODE.SHIP) { if (t >= b.ejectAt) m.eject(p); return; }
  if (t >= b.nextThink) think(m, p, b);

  let bits = 0, yaw = p.yaw, pitch = 0;
  if (s.m === MODE.GLIDE) {
    if (b.landTarget) {
      yaw = yawTo(b.landTarget.x - s.x, b.landTarget.z - s.z);
      const d = Math.hypot(b.landTarget.x - s.x, b.landTarget.z - s.z);
      bits = d > 4 ? IN.FWD : 0;
      if (d < 30) bits |= IN.CROUCH; // dive when above the target
    }
  } else {
    const e = b.enemy ? m.players.get(b.enemy) : null;
    if (e && e.alive) {
      const ox = s.x, oy = s.y + eyeHeight(s), oz = s.z;
      const dx = e.st.x - ox, dy = e.st.y + 1.1 - oy, dz = e.st.z - oz;
      const hd = Math.hypot(dx, dz), dist = Math.hypot(dx, dy, dz);
      yaw = yawTo(dx, dz);
      pitch = Math.atan2(dy, hd);
      const slot = p.inv.slots[p.inv.active];
      bits = b.strafe > 0 ? IN.RIGHT : IN.LEFT;
      const ideal = slot?.type === 'shotgun' ? 6 : slot?.type === 'sniper' ? 50 : 18;
      if (dist > ideal + 6) bits |= IN.FWD; else if (dist < ideal - 6) bits |= IN.BACK;
      if (slot && slot.kind === 'weapon' && t >= b.nextShot) {
        const err = (0.015 + 0.05 * (1 - b.skill)) * (1 + Math.hypot(e.st.vx, e.st.vz) / 8);
        const ay = yaw + (rng() - 0.5) * 2 * err, ap = pitch + (rng() - 0.5) * 2 * err;
        const cp = Math.cos(ap);
        p.yaw = yaw; p.pitch = pitch;
        m.fire(p, { d: [-Math.sin(ay) * cp, Math.sin(ap), -Math.cos(ay) * cp], rt: t });
        const W = WEAPONS[slot.type];
        b.nextShot = t + (W.auto ? 60 / W.rpm : 60 / W.rpm + 0.12 + rng() * 0.3);
        if (W.auto && rng() < 0.08) b.nextShot += 0.4; // burst pauses
      }
    } else if (b.dest && !p.use) {
      yaw = yawTo(b.dest.x - s.x, b.dest.z - s.z);
      const d = Math.hypot(b.dest.x - s.x, b.dest.z - s.z);
      bits = IN.FWD;
      if (d > 12) bits |= IN.SPRINT;
      if (d < 1.2) b.dest = null;
    }
    // Unstick: if we wanted to move but did not, jump and sidestep.
    if (t >= b.stuckCheckAt) {
      if (b.stuckPos && (bits & IN.FWD) && Math.hypot(s.x - b.stuckPos.x, s.z - b.stuckPos.z) < 0.6) {
        b.jumpUntil = t + 0.4;
        b.strafe = -b.strafe; b.strafeUntil = t + 0.8;
        if (rng() < 0.3) b.dest = null;
      }
      b.stuckPos = { x: s.x, z: s.z };
      b.stuckCheckAt = t + 0.8;
    }
    if (t < b.jumpUntil) bits |= IN.JUMP | (b.strafe > 0 ? IN.RIGHT : IN.LEFT);
  }
  p.yaw = yaw; p.pitch = pitch; p.bits = bits;
  const steps = Math.max(1, Math.round(dt / INPUT_DT));
  for (let i = 0; i < steps && p.alive; i++) m.applyInput(p, bits, yaw);
}
