// Character movement. Deterministic given (state, input, dt, world), which lets the
// client predict its own movement and replay unacknowledged inputs after a server correction.

import { PLAYER as P, IN, MAP_SIZE, WATER_LEVEL } from './config.js';

export const MODE = { GROUND: 0, GLIDE: 1, SHIP: 2 };

export function createMoveState(x = 0, y = 0, z = 0) {
  return { x, y, z, vx: 0, vy: 0, vz: 0, g: false, c: false, m: MODE.GROUND };
}

export function copyMoveState(dst, src) {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.g = src.g; dst.c = src.c; dst.m = src.m;
  return dst;
}

export function playerHeight(s) { return s.c ? P.crouchHeight : P.height; }
export function eyeHeight(s) { return s.c ? P.crouchEyeHeight : P.eyeHeight; }

const tmp = [];

function moveToward(cur, target, maxDelta) {
  const d = target - cur;
  return Math.abs(d) <= maxDelta ? target : cur + Math.sign(d) * maxDelta;
}

function headroomBlocked(s, world, fromY, toY) {
  const r = P.radius;
  world.queryBoxes(s.x - r, s.z - r, s.x + r, s.z + r, tmp);
  for (const b of tmp) {
    if (b.minY >= toY || b.maxY <= fromY) continue;
    if (circleBoxDist2(s.x, s.z, b) < r * r) return true;
  }
  return false;
}

function circleBoxDist2(x, z, b) {
  const cx = x < b.minX ? b.minX : x > b.maxX ? b.maxX : x;
  const cz = z < b.minZ ? b.minZ : z > b.maxZ ? b.maxZ : z;
  return (x - cx) * (x - cx) + (z - cz) * (z - cz);
}

// Highest walkable surface under the player's footprint that is not above refY.
export function supportHeight(world, x, z, refY) {
  let h = world.heightAt(x, z);
  const r = P.radius * 0.85;
  world.queryBoxes(x - r, z - r, x + r, z + r, tmp);
  for (const b of tmp) {
    if (b.maxY > refY || b.maxY <= h) continue;
    if (circleBoxDist2(x, z, b) < r * r) h = b.maxY;
  }
  return h;
}

function resolveHorizontal(s, world) {
  const r = P.radius;
  const h = playerHeight(s);
  for (let iter = 0; iter < 2; iter++) {
    world.queryBoxes(s.x - r, s.z - r, s.x + r, s.z + r, tmp);
    for (const b of tmp) {
      if (b.maxY <= s.y + 0.001 || b.minY >= s.y + h) continue;
      const d2 = circleBoxDist2(s.x, s.z, b);
      if (d2 >= r * r) continue;
      // Step up onto low obstacles (stairs, curbs) if there is headroom.
      if (b.maxY - s.y <= P.stepHeight && s.m === MODE.GROUND
          && !headroomBlocked(s, world, b.maxY, b.maxY + h)) {
        s.y = b.maxY;
        continue;
      }
      if (d2 > 1e-10) {
        const cx = Math.min(Math.max(s.x, b.minX), b.maxX);
        const cz = Math.min(Math.max(s.z, b.minZ), b.maxZ);
        const d = Math.sqrt(d2);
        const nx = (s.x - cx) / d, nz = (s.z - cz) / d;
        s.x = cx + nx * r; s.z = cz + nz * r;
        const vn = s.vx * nx + s.vz * nz;
        if (vn < 0) { s.vx -= vn * nx; s.vz -= vn * nz; }
      } else {
        // Center inside the box: push out along the axis of least penetration.
        const pen = [s.x - b.minX, b.maxX - s.x, s.z - b.minZ, b.maxZ - s.z];
        let k = 0;
        for (let i = 1; i < 4; i++) if (pen[i] < pen[k]) k = i;
        if (k === 0) { s.x = b.minX - r; s.vx = Math.min(s.vx, 0); }
        else if (k === 1) { s.x = b.maxX + r; s.vx = Math.max(s.vx, 0); }
        else if (k === 2) { s.z = b.minZ - r; s.vz = Math.min(s.vz, 0); }
        else { s.z = b.maxZ + r; s.vz = Math.max(s.vz, 0); }
      }
    }
  }
}

/**
 * Advance one fixed step. Returns impact fall damage (0 if none). Mutates `s`.
 * bits: IN bitfield, yaw: camera yaw in radians.
 */
export function stepMove(s, bits, yaw, dt, world) {
  if (s.m === MODE.SHIP) return 0;

  let fx = 0, fz = 0;
  if (bits & IN.FWD) fz -= 1;
  if (bits & IN.BACK) fz += 1;
  if (bits & IN.LEFT) fx -= 1;
  if (bits & IN.RIGHT) fx += 1;
  const len = Math.hypot(fx, fz);
  if (len > 0) { fx /= len; fz /= len; }
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const wx = fx * cos + fz * sin;
  const wz = -fx * sin + fz * cos;

  // Crouch (only on foot; standing up requires headroom)
  const wantCrouch = (bits & IN.CROUCH) !== 0 && s.m === MODE.GROUND;
  if (wantCrouch) s.c = true;
  else if (s.c && !headroomBlocked(s, world, s.y + P.crouchHeight, s.y + P.height)) s.c = false;

  const inWater = s.y < WATER_LEVEL - 0.5;
  const wasGrounded = s.g;

  if (s.m === MODE.GLIDE) {
    const maxDv = 20 * dt;
    s.vx = moveToward(s.vx, wx * P.glideSpeed, maxDv);
    s.vz = moveToward(s.vz, wz * P.glideSpeed, maxDv);
    const fall = (bits & IN.CROUCH) ? P.diveFallSpeed : P.glideFallSpeed;
    s.vy = s.vy > -fall ? Math.max(s.vy - P.gravity * dt, -fall) : moveToward(s.vy, -fall, 40 * dt);
  } else {
    let speed = P.walkSpeed;
    if (s.c) speed = P.crouchSpeed;
    else if ((bits & IN.SPRINT) && (bits & IN.FWD) && !(bits & IN.AIM)) speed = P.sprintSpeed;
    if (inWater) speed *= P.waterSpeedMult;
    const accel = (s.g ? P.groundAccel : P.airAccel) * dt;
    const dvx = wx * speed - s.vx, dvz = wz * speed - s.vz;
    const dl = Math.hypot(dvx, dvz);
    if (dl > accel) { s.vx += (dvx / dl) * accel; s.vz += (dvz / dl) * accel; }
    else { s.vx += dvx; s.vz += dvz; }
    if (s.g && (bits & IN.JUMP) && !s.c) { s.vy = P.jumpVelocity; s.g = false; }
    s.vy = Math.max(s.vy - P.gravity * dt, -P.terminalVelocity);
  }

  // Horizontal integrate + collide
  s.x += s.vx * dt; s.z += s.vz * dt;
  const lim = MAP_SIZE / 2 - 1;
  if (s.x < -lim) { s.x = -lim; s.vx = 0; } else if (s.x > lim) { s.x = lim; s.vx = 0; }
  if (s.z < -lim) { s.z = -lim; s.vz = 0; } else if (s.z > lim) { s.z = lim; s.vz = 0; }
  resolveHorizontal(s, world);

  // Vertical integrate + collide
  const preY = s.y;
  s.y += s.vy * dt;
  let fallDamage = 0;
  if (s.vy <= 0) {
    const gh = supportHeight(world, s.x, s.z, preY + 0.05);
    if (s.y <= gh) {
      const impact = -s.vy;
      s.y = gh; s.vy = 0; s.g = true;
      if (s.m === MODE.GLIDE) s.m = MODE.GROUND;
      else if (!wasGrounded && impact > P.safeFallSpeed) fallDamage = (impact - P.safeFallSpeed) * P.fallDamagePerMps;
    } else if (wasGrounded && s.m === MODE.GROUND && s.y - gh < 0.4) {
      s.y = gh; s.vy = 0; s.g = true; // stick to slopes and stairs going down
    } else {
      s.g = false;
    }
  } else {
    s.g = false;
    const h = playerHeight(s);
    const r = P.radius;
    world.queryBoxes(s.x - r, s.z - r, s.x + r, s.z + r, tmp);
    for (const b of tmp) {
      if (b.minY < preY + h - 0.05 || b.minY >= s.y + h) continue;
      if (circleBoxDist2(s.x, s.z, b) < r * r) { s.y = b.minY - h; s.vy = 0; }
    }
  }
  return fallDamage;
}
