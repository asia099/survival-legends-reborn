import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../shared/world.js';
import { createMoveState, stepMove, supportHeight, MODE } from '../shared/physics.js';
import { IN, INPUT_DT, PLAYER } from '../shared/config.js';

// A tiny hand-built world: flat ground at y=0 with one wall, so results are exact.
function flatWorld(boxes = []) {
  return {
    boxes,
    heightAt: () => 0,
    queryBoxes(minX, minZ, maxX, maxZ, out) {
      out.length = 0;
      for (const b of boxes) if (!(b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ)) out.push(b);
      return out;
    },
  };
}

const run = (s, bits, yaw, steps, w) => { let dmg = 0; for (let i = 0; i < steps; i++) dmg += stepMove(s, bits, yaw, INPUT_DT, w); return dmg; };

test('falls under gravity and lands on the ground', () => {
  const w = flatWorld();
  const s = createMoveState(0, 5, 0);
  run(s, 0, 0, 120, w);
  assert.equal(s.y, 0);
  assert.equal(s.g, true);
  assert.equal(s.vy, 0);
});

test('walks forward (-Z at yaw 0) at walk speed and sprints faster', () => {
  const w = flatWorld();
  const s = createMoveState(0, 0, 0); s.g = true;
  run(s, IN.FWD, 0, 60, w); // 1 second
  assert.ok(s.z < -4.5 && s.z > -5.6, `z=${s.z}`);
  assert.ok(Math.abs(s.x) < 1e-9);
  const s2 = createMoveState(0, 0, 0); s2.g = true;
  run(s2, IN.FWD | IN.SPRINT, 0, 60, w);
  assert.ok(s2.z < s.z - 2, 'sprint should be faster than walking');
});

test('yaw rotates movement: yaw -PI/2 moves toward +X', () => {
  const w = flatWorld();
  const s = createMoveState(0, 0, 0); s.g = true;
  run(s, IN.FWD, -Math.PI / 2, 60, w);
  assert.ok(s.x > 4.5, `x=${s.x}`);
  assert.ok(Math.abs(s.z) < 1e-6);
});

test('walls block movement', () => {
  const wall = { minX: -5, maxX: 5, minY: 0, maxY: 3, minZ: -3, maxZ: -2.5, k: 'wall' };
  const w = flatWorld([wall]);
  const s = createMoveState(0, 0, 0); s.g = true;
  run(s, IN.FWD, 0, 180, w);
  assert.ok(s.z >= wall.maxZ + PLAYER.radius - 1e-6, `walked into the wall: z=${s.z}`);
});

test('steps up onto low obstacles but not tall ones', () => {
  const step = { minX: -5, maxX: 5, minY: 0, maxY: 0.4, minZ: -10, maxZ: -2, k: 'stairs' };
  const w = flatWorld([step]);
  const s = createMoveState(0, 0, 0); s.g = true;
  run(s, IN.FWD, 0, 90, w);
  assert.ok(s.z < -3, 'should have walked onto the step');
  assert.ok(Math.abs(s.y - 0.4) < 1e-9, `y=${s.y}`);
});

test('jumping reaches roughly the expected apex and lands', () => {
  const w = flatWorld();
  const s = createMoveState(0, 0, 0); s.g = true;
  stepMove(s, IN.JUMP, 0, INPUT_DT, w);
  let maxY = 0;
  for (let i = 0; i < 120; i++) { stepMove(s, 0, 0, INPUT_DT, w); maxY = Math.max(maxY, s.y); }
  const apex = PLAYER.jumpVelocity ** 2 / (2 * PLAYER.gravity);
  assert.ok(Math.abs(maxY - apex) < 0.25, `apex ${maxY} vs ${apex}`);
  assert.equal(s.g, true);
});

test('high falls deal damage; gliding does not', () => {
  const w = flatWorld();
  const s = createMoveState(0, 40, 0);
  const dmg = run(s, 0, 0, 300, w);
  assert.ok(dmg > 20, `fall damage ${dmg}`);
  const g = createMoveState(0, 40, 0); g.m = MODE.GLIDE;
  const dmg2 = run(g, 0, 0, 600, w);
  assert.equal(dmg2, 0);
  assert.equal(g.m, MODE.GROUND, 'landing ends the glide');
});

test('simulation is deterministic (client prediction == server)', () => {
  const world = createWorld(42);
  const x = -150, z = -95;
  const y = supportHeight(world, x, z, world.heightAt(x, z) + 0.6);
  const a = createMoveState(x, y, z), b = createMoveState(x, y, z);
  const inputs = [];
  let seed = 7;
  for (let i = 0; i < 600; i++) { seed = (seed * 1103515245 + 12345) % 2147483648; inputs.push([seed & 0xff & ~IN.CROUCH, ((seed >> 8) % 628) / 100]); }
  for (const [bits, yaw] of inputs) stepMove(a, bits, yaw, INPUT_DT, world);
  for (const [bits, yaw] of inputs) stepMove(b, bits, yaw, INPUT_DT, world);
  assert.deepEqual(a, b);
});

test('generated world is identical for the same seed and has loot spots', () => {
  const a = createWorld(1234), b = createWorld(1234);
  assert.equal(a.boxes.length, b.boxes.length);
  assert.deepEqual(a.boxes[10], b.boxes[10]);
  assert.ok(a.lootSpots.length > 60, `loot spots ${a.lootSpots.length}`);
  const ray = a.raycast(0, 200, 0, 0, -1, 0, 500);
  assert.ok(ray.t < 500, 'downward ray should hit something');
});
