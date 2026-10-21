// Hitscan combat helpers: hitboxes, lag-compensated position lookup, damage model.

import { PLAYER, RARITIES } from '../shared/config.js';
import { rayAabb } from '../shared/world.js';

export const HEAD_RADIUS = 0.26;

// Body box + head sphere for a player standing at (x,y,z) (feet position).
export function hitboxes(x, y, z, crouched) {
  const bodyTop = crouched ? 0.95 : 1.42;
  const headY = crouched ? 1.12 : 1.6;
  return {
    body: [x - PLAYER.radius, y, z - PLAYER.radius, x + PLAYER.radius, y + bodyTop, z + PLAYER.radius],
    head: [x, y + headY, z],
  };
}

export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxT) return -1;
  return t;
}

// Returns { t, head } for the closest hit on this target within maxT, or null.
export function rayPlayer(o, d, pos, crouched, maxT) {
  const hb = hitboxes(pos.x, pos.y, pos.z, crouched);
  let best = null;
  const th = raySphere(o[0], o[1], o[2], d[0], d[1], d[2], hb.head[0], hb.head[1], hb.head[2], HEAD_RADIUS, maxT);
  if (th >= 0) best = { t: th, head: true };
  const b = hb.body;
  const tb = rayAabb(o[0], o[1], o[2], d[0], d[1], d[2], b[0], b[1], b[2], b[3], b[4], b[5], best ? best.t : maxT);
  if (tb >= 0 && (!best || tb < best.t)) best = { t: tb, head: false };
  return best;
}

// Position history ring for lag compensation.
export function recordHistory(p, time) {
  p.history.push({ t: time, x: p.st.x, y: p.st.y, z: p.st.z, c: p.st.c });
  while (p.history.length > 40) p.history.shift();
}

export function positionAt(p, time) {
  const h = p.history;
  if (h.length === 0 || time >= h[h.length - 1].t) return { x: p.st.x, y: p.st.y, z: p.st.z, c: p.st.c };
  if (time <= h[0].t) return h[0];
  for (let i = h.length - 1; i > 0; i--) {
    const a = h[i - 1], b = h[i];
    if (time >= a.t) {
      const k = (time - a.t) / (b.t - a.t || 1);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, c: k < 0.5 ? a.c : b.c };
    }
  }
  return h[0];
}

export function damageFor(weapon, rarity, dist, head) {
  let dmg = weapon.dmg * RARITIES[rarity].dmg;
  if (dist > weapon.falloffStart) {
    const k = Math.min(1, (dist - weapon.falloffStart) / Math.max(1, weapon.range - weapon.falloffStart));
    dmg *= 1 - (1 - weapon.falloffMin) * k;
  }
  if (head) dmg *= weapon.headMult;
  return dmg;
}

// Random direction inside a cone of half-angle `spread` around d (unit vector).
export function applySpread(d, spread, rng) {
  if (spread <= 0) return d;
  // Build an orthonormal basis around d
  const up = Math.abs(d[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  let ux = up[1] * d[2] - up[2] * d[1], uy = up[2] * d[0] - up[0] * d[2], uz = up[0] * d[1] - up[1] * d[0];
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const vx = d[1] * uz - d[2] * uy, vy = d[2] * ux - d[0] * uz, vz = d[0] * uy - d[1] * ux;
  const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * Math.tan(spread);
  const x = d[0] + (ux * Math.cos(a) + vx * Math.sin(a)) * r;
  const y = d[1] + (uy * Math.cos(a) + vy * Math.sin(a)) * r;
  const z = d[2] + (uz * Math.cos(a) + vz * Math.sin(a)) * r;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

export function viewDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
