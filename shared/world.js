// Deterministic world generation shared by server (authoritative collision/raycasts)
// and client (rendering + prediction). Same seed => identical world on both sides.

import { MAP_SIZE, WATER_LEVEL } from './config.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BIOMES = [
  { id: 0, name: 'Verdant Frontier', ground: [0.34, 0.55, 0.25], ground2: [0.25, 0.42, 0.2] },
  { id: 1, name: 'Neon District',    ground: [0.32, 0.33, 0.38], ground2: [0.24, 0.25, 0.3] },
  { id: 2, name: 'Ashen Wastes',     ground: [0.55, 0.38, 0.27], ground2: [0.36, 0.22, 0.18] },
  { id: 3, name: 'Frostfall Mountains', ground: [0.86, 0.9, 0.95], ground2: [0.7, 0.76, 0.84] },
  { id: 4, name: 'Forgotten Kingdom', ground: [0.48, 0.5, 0.3], ground2: [0.4, 0.38, 0.28] },
];

const BIOME_ANCHORS = [
  { b: 0, x: -150, z: -40 },
  { b: 0, x: -60, z: -170 },
  { b: 1, x: 140, z: -140 },
  { b: 2, x: 150, z: 120 },
  { b: 3, x: -80, z: 170 },
  { b: 3, x: -190, z: 140 },
  { b: 4, x: 0, z: 0 },
];

// Named points of interest. Fixed layout so players learn the map; contents vary by seed.
export const POIS = [
  { name: 'Mossbridge',        x: -150, z: -95,  r: 34, style: 'town',   tier: 1 },
  { name: 'Pinewatch Camp',    x: -175, z: 45,   r: 26, style: 'camp',   tier: 0 },
  { name: 'Lumen Heights',     x: 130,  z: -135, r: 42, style: 'city',   tier: 2 },
  { name: 'Cinder Works',      x: 150,  z: 110,  r: 36, style: 'works',  tier: 1 },
  { name: 'Frostgate Station', x: -65,  z: 160,  r: 30, style: 'cabins', tier: 1 },
  { name: 'Old Crown Keep',    x: 0,    z: 0,    r: 38, style: 'ruins',  tier: 2 },
  { name: 'Saltmarsh Docks',   x: 40,   z: -190, r: 24, style: 'camp',   tier: 0 },
  { name: 'Redline Depot',     x: 175,  z: -20,  r: 22, style: 'works',  tier: 1 },
];

export function biomeAt(x, z) {
  // Perturbed nearest-anchor (Voronoi) regions so borders are not straight lines.
  const px = x + 18 * Math.sin(z * 0.021);
  const pz = z + 18 * Math.sin(x * 0.019);
  let best = 0, bestD = Infinity;
  for (const a of BIOME_ANCHORS) {
    let d = (px - a.x) ** 2 + (pz - a.z) ** 2;
    if (a.b === 4) d *= 2.2; // keep the kingdom compact
    if (d < bestD) { bestD = d; best = a.b; }
  }
  return best;
}

function rawHeight(x, z) {
  let h = 3.2 + 4 * Math.sin(x * 0.018 + 0.5) * Math.cos(z * 0.015)
        + 2.5 * Math.sin(x * 0.043 + z * 0.037)
        + 1.2 * Math.sin(z * 0.09 + 1.3) * Math.sin(x * 0.07);
  // Frostfall hills in the north-west
  const fd = Math.hypot(x + 120, z - 175);
  if (fd < 170) {
    const w = 1 - fd / 170;
    h += w * w * (14 + 8 * Math.sin(x * 0.04) * Math.sin(z * 0.035));
  }
  // Lake in the south-west
  const ld = Math.hypot(x + 40, z + 120);
  if (ld < 38) h -= 7 * (1 - (ld / 38) ** 2);
  // Raised cliffs at the map edge
  const half = MAP_SIZE / 2;
  const edge = half - Math.max(Math.abs(x), Math.abs(z));
  if (edge < 22) h += (22 - edge) * 1.4;
  return h;
}

const POI_BASE = POIS.map((p) => rawHeight(p.x, p.z) < WATER_LEVEL + 1 ? WATER_LEVEL + 1.5 : rawHeight(p.x, p.z));

export function heightAt(x, z) {
  let h = rawHeight(x, z);
  for (let i = 0; i < POIS.length; i++) {
    const p = POIS[i];
    const d = Math.hypot(x - p.x, z - p.z);
    const outer = p.r + 22;
    if (d < outer) {
      let w = d <= p.r ? 1 : 1 - (d - p.r) / 22;
      w = w * w * (3 - 2 * w);
      h = h + (POI_BASE[i] - h) * w;
    }
  }
  return h;
}

// ---------------------------------------------------------------------------
// World construction

const CELL = 16;

export function createWorld(seed = 1) {
  const rng = mulberry32(seed);
  const boxes = [];   // solid axis-aligned boxes {minX,minY,minZ,maxX,maxY,maxZ,k}
  const decor = [];   // visual-only props {type,x,y,z,s,r}
  const lootSpots = []; // {x,y,z,tier}
  const half = MAP_SIZE / 2;

  const addBox = (minX, minY, minZ, maxX, maxY, maxZ, k) => {
    boxes.push({ minX, minY, minZ, maxX, maxY, maxZ, k });
  };

  const occupied = []; // footprints used, to avoid overlapping structures {x,z,r}
  const isFree = (x, z, r) => occupied.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r);

  function building(cx, cz, w, d, wallH, floors, door, kind, tier) {
    const base = Math.min(heightAt(cx - w / 2, cz - d / 2), heightAt(cx + w / 2, cz - d / 2),
      heightAt(cx - w / 2, cz + d / 2), heightAt(cx + w / 2, cz + d / 2), heightAt(cx, cz));
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const t = 0.3;
    const floorTop = base + 0.25;
    addBox(x0, base - 1.5, z0, x1, floorTop, z1, 'floor');
    const totalH = wallH * floors;
    const top = floorTop + totalH;
    const doorW = 1.8, doorH = 2.5;
    // Four walls; the door side gets a gap (one per floor on ground level only).
    const walls = [
      { side: 0, a: [x0, z0, x1, z0 + t] },  // north (-z)
      { side: 1, a: [x1 - t, z0, x1, z1] },  // east (+x)
      { side: 2, a: [x0, z1 - t, x1, z1] },  // south (+z)
      { side: 3, a: [x0, z0, x0 + t, z1] },  // west (-x)
    ];
    for (const wl of walls) {
      const [ax0, az0, ax1, az1] = wl.a;
      if (wl.side !== door) { addBox(ax0, floorTop, az0, ax1, top, az1, kind); continue; }
      const horiz = wl.side === 0 || wl.side === 2;
      const mid = horiz ? (ax0 + ax1) / 2 : (az0 + az1) / 2;
      const g0 = mid - doorW / 2, g1 = mid + doorW / 2;
      if (horiz) {
        addBox(ax0, floorTop, az0, g0, top, az1, kind);
        addBox(g1, floorTop, az0, ax1, top, az1, kind);
        addBox(g0, floorTop + doorH, az0, g1, top, az1, kind);
      } else {
        addBox(ax0, floorTop, az0, ax1, top, g0, kind);
        addBox(ax0, floorTop, g1, ax1, top, az1, kind);
        addBox(ax0, floorTop + doorH, g0, ax1, top, g1, kind);
      }
    }
    // Upper floors with a staircase along the inside of the east wall.
    const stepH = 0.45, stepD = 0.6, stairW = 1.4;
    const steps = Math.round(wallH / stepH);
    const sx0 = x1 - t - stairW, sx1 = x1 - t;
    const sz0 = z0 + t + 0.6;
    const szEnd = sz0 + steps * stepD;
    for (let f = 1; f < floors; f++) {
      const fy = floorTop + wallH * (f - 1);
      for (let i = 0; i < steps; i++) {
        addBox(sx0, fy, sz0 + i * stepD, sx1, fy + stepH * (i + 1), sz0 + (i + 1) * stepD, 'stairs');
      }
      const slabTop = floorTop + wallH * f;
      addBox(x0 + t, slabTop - 0.25, z0 + t, sx0, slabTop, z1 - t, 'floor');
      addBox(sx0, slabTop - 0.25, szEnd, x1 - t, slabTop, z1 - t, 'floor');
      lootSpots.push({ x: cx - w / 4, y: slabTop, z: cz + d / 6, tier: tier + 1 });
    }
    addBox(x0 - 0.3, top, z0 - 0.3, x1 + 0.3, top + 0.35, z1 + 0.35, 'roof');
    lootSpots.push({ x: cx - w / 5, y: floorTop, z: cz, tier });
    if (w * d > 120) lootSpots.push({ x: cx + w / 6 - 1.5, y: floorTop, z: cz + d / 4, tier });
    occupied.push({ x: cx, z: cz, r: Math.hypot(w, d) / 2 + 1 });
  }

  function container(cx, cz, rot) {
    const base = heightAt(cx, cz) - 0.3;
    const L = 6, W = 2.5, H = 2.6;
    if (rot) addBox(cx - W / 2, base, cz - L / 2, cx + W / 2, base + H, cz + L / 2, 'container');
    else addBox(cx - L / 2, base, cz - W / 2, cx + L / 2, base + H, cz + W / 2, 'container');
    occupied.push({ x: cx, z: cz, r: 3.5 });
  }

  function crate(cx, cz, s = 1.2) {
    const base = heightAt(cx, cz) - 0.1;
    addBox(cx - s / 2, base, cz - s / 2, cx + s / 2, base + s, cz + s / 2, 'crate');
  }

  function rock(cx, cz, s) {
    const base = heightAt(cx, cz);
    const sx = s * (0.7 + rng() * 0.6), sz = s * (0.7 + rng() * 0.6), sy = s * (0.5 + rng() * 0.6);
    addBox(cx - sx / 2, base - 1, cz - sz / 2, cx + sx / 2, base + sy, cz + sz / 2, 'rock');
    occupied.push({ x: cx, z: cz, r: Math.max(sx, sz) / 2 });
  }

  function tree(cx, cz, biome) {
    const base = heightAt(cx, cz);
    if (base < WATER_LEVEL + 0.3) return;
    const s = 0.8 + rng() * 0.6;
    const trunkH = 3.2 * s;
    addBox(cx - 0.3, base - 0.5, cz - 0.3, cx + 0.3, base + trunkH, cz + 0.3, 'trunk');
    decor.push({ type: biome === 3 ? 'pine_snow' : biome === 2 ? 'deadtree' : 'tree', x: cx, y: base + trunkH, z: cz, s, r: rng() * Math.PI * 2 });
    occupied.push({ x: cx, z: cz, r: 1 });
  }

  // --- Points of interest
  for (const p of POIS) {
    const tier = p.tier;
    const place = (fn, tries = 30, rad = 6) => {
      for (let i = 0; i < tries; i++) {
        const a = rng() * Math.PI * 2, d = rng() * (p.r - rad * 0.5);
        const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
        if (isFree(x, z, rad)) { fn(x, z); return true; }
      }
      return false;
    };
    if (p.style === 'town' || p.style === 'cabins') {
      for (let i = 0; i < 7; i++) place((x, z) => building(x, z, 8 + rng() * 4, 8 + rng() * 4, 3.4, rng() < 0.3 ? 2 : 1, (rng() * 4) | 0, p.style === 'cabins' ? 'cabin' : 'wall', tier), 40, 8);
      for (let i = 0; i < 8; i++) place((x, z) => crate(x, z), 20, 1);
    } else if (p.style === 'city') {
      for (let i = 0; i < 8; i++) place((x, z) => building(x, z, 11 + rng() * 4, 11 + rng() * 4, 3.6, 2 + (rng() < 0.5 ? 1 : 0), (rng() * 4) | 0, 'neon', tier), 40, 10);
      for (let i = 0; i < 10; i++) place((x, z) => crate(x, z, 1.4), 20, 1);
    } else if (p.style === 'works') {
      for (let i = 0; i < 3; i++) place((x, z) => building(x, z, 14 + rng() * 4, 10 + rng() * 3, 4.5, 1, (rng() * 4) | 0, 'metal', tier), 40, 11);
      for (let i = 0; i < 9; i++) place((x, z) => container(x, z, rng() < 0.5), 30, 4);
      for (let i = 0; i < 4; i++) lootSpots.push({ x: p.x + (rng() - 0.5) * p.r, y: heightAt(p.x, p.z), z: p.z + (rng() - 0.5) * p.r, tier });
    } else if (p.style === 'ruins') {
      // Castle keep: a central tower plus broken curtain walls.
      building(p.x, p.z, 12, 12, 4, 3, 2, 'ruin', tier + 1);
      const R = p.r - 6;
      for (let i = 0; i < 16; i++) {
        if (rng() < 0.3) continue; // gaps
        const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 1) / 16) * Math.PI * 2;
        const xA = p.x + Math.cos(a0) * R, zA = p.z + Math.sin(a0) * R;
        const xB = p.x + Math.cos(a1) * R, zB = p.z + Math.sin(a1) * R;
        const h = 2 + rng() * 3.5;
        const base = heightAt((xA + xB) / 2, (zA + zB) / 2) - 1;
        addBox(Math.min(xA, xB) - 0.6, base, Math.min(zA, zB) - 0.6, Math.max(xA, xB) + 0.6, base + h + 1, Math.max(zA, zB) + 0.6, 'ruin');
      }
      for (let i = 0; i < 6; i++) place((x, z) => { rock(x, z, 2); lootSpots.push({ x: x + 2.5, y: heightAt(x + 2.5, z), z, tier }); }, 20, 3);
    } else if (p.style === 'camp') {
      for (let i = 0; i < 3; i++) place((x, z) => building(x, z, 6 + rng() * 2, 6 + rng() * 2, 3, 1, (rng() * 4) | 0, 'cabin', tier), 40, 6);
      for (let i = 0; i < 6; i++) place((x, z) => crate(x, z), 20, 1);
    }
  }

  // --- Wilderness scatter
  for (let i = 0; i < 520; i++) {
    const x = (rng() - 0.5) * (MAP_SIZE - 50), z = (rng() - 0.5) * (MAP_SIZE - 50);
    if (POIS.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + 4)) continue;
    const b = biomeAt(x, z);
    const roll = rng();
    const treeChance = b === 0 ? 0.75 : b === 3 ? 0.55 : b === 4 ? 0.5 : b === 2 ? 0.15 : 0.1;
    if (!isFree(x, z, 2)) continue;
    if (roll < treeChance) tree(x, z, b);
    else if (roll < treeChance + 0.18) rock(x, z, 1.5 + rng() * 3.5);
    else if (roll < treeChance + 0.24) {
      crate(x, z);
      lootSpots.push({ x: x + 1.5, y: heightAt(x + 1.5, z), z, tier: 0 });
    }
  }
  // Scattered ground loot so rotations through the wild are not empty.
  for (let i = 0; i < 40; i++) {
    const x = (rng() - 0.5) * (MAP_SIZE - 60), z = (rng() - 0.5) * (MAP_SIZE - 60);
    const y = heightAt(x, z);
    if (y < WATER_LEVEL) continue;
    lootSpots.push({ x, y, z, tier: 0 });
  }

  // Spatial grid for collision queries.
  const gridN = Math.ceil(MAP_SIZE / CELL) + 2;
  const grid = new Array(gridN * gridN);
  for (let i = 0; i < grid.length; i++) grid[i] = [];
  const cellOf = (v) => Math.max(0, Math.min(gridN - 1, Math.floor((v + half) / CELL) + 1));
  boxes.forEach((b, idx) => {
    for (let gx = cellOf(b.minX); gx <= cellOf(b.maxX); gx++)
      for (let gz = cellOf(b.minZ); gz <= cellOf(b.maxZ); gz++) grid[gx * gridN + gz].push(idx);
  });
  const stamp = new Uint32Array(boxes.length);
  let stampId = 0;

  function queryBoxes(minX, minZ, maxX, maxZ, out) {
    out.length = 0;
    stampId++;
    for (let gx = cellOf(minX); gx <= cellOf(maxX); gx++)
      for (let gz = cellOf(minZ); gz <= cellOf(maxZ); gz++) {
        const cell = grid[gx * gridN + gz];
        for (let i = 0; i < cell.length; i++) {
          const idx = cell[i];
          if (stamp[idx] === stampId) continue;
          stamp[idx] = stampId;
          const b = boxes[idx];
          if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
          out.push(b);
        }
      }
    return out;
  }

  // Ray vs world. Returns distance to first hit (or maxDist) and what was hit.
  function raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = maxDist, hitBox = null;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const t = rayAabb(ox, oy, oz, dx, dy, dz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, best);
      if (t >= 0 && t < best) { best = t; hitBox = b; }
    }
    const tt = rayTerrain(ox, oy, oz, dx, dy, dz, best);
    if (tt >= 0 && tt < best) return { t: tt, terrain: true, box: null };
    return { t: best, terrain: false, box: hitBox, hit: hitBox !== null };
  }

  return {
    seed, boxes, decor, lootSpots, queryBoxes, raycast, heightAt, biomeAt,
    groundAt: heightAt, half,
  };
}

// Slab test. Returns entry distance in [0, maxT] or -1.
export function rayAabb(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1, maxT) {
  let tmin = 0, tmax = maxT;
  if (Math.abs(dx) < 1e-9) { if (ox < x0 || ox > x1) return -1; }
  else {
    let a = (x0 - ox) / dx, b = (x1 - ox) / dx;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > tmin) tmin = a; if (b < tmax) tmax = b;
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dy) < 1e-9) { if (oy < y0 || oy > y1) return -1; }
  else {
    let a = (y0 - oy) / dy, b = (y1 - oy) / dy;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > tmin) tmin = a; if (b < tmax) tmax = b;
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dz) < 1e-9) { if (oz < z0 || oz > z1) return -1; }
  else {
    let a = (z0 - oz) / dz, b = (z1 - oz) / dz;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > tmin) tmin = a; if (b < tmax) tmax = b;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

// Adaptive ray march against the height field, refined by bisection.
export function rayTerrain(ox, oy, oz, dx, dy, dz, maxT) {
  let t = 0;
  let prevT = 0;
  if (oy - heightAt(ox, oz) < 0) return 0;
  while (t < maxT) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    const gap = y - heightAt(x, z);
    if (gap < 0) {
      let lo = prevT, hi = t;
      for (let i = 0; i < 8; i++) {
        const m = (lo + hi) / 2;
        if (oy + dy * m - heightAt(ox + dx * m, oz + dz * m) < 0) hi = m; else lo = m;
      }
      return hi;
    }
    prevT = t;
    t += Math.min(6, Math.max(0.35, gap * 0.5));
  }
  return -1;
}
