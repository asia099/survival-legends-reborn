import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../server/match.js';
import { AccountStore } from '../server/accounts.js';
import { Storm } from '../server/storm.js';
import { addItem, createInventory, makeWeapon } from '../server/loot.js';
import { mulberry32 } from '../shared/world.js';
import { MODE, supportHeight } from '../shared/physics.js';
import { IN, MATCH, QUICK_STORM_PHASES, WEAPONS, PICKUP_RANGE } from '../shared/config.js';

const DT = 1 / 30;

function setup({ humans = 2, bots = 0, teamSize = 1 } = {}) {
  const accounts = new AccountStore(null);
  const m = new Match({ seed: 99, accounts, quick: true, rng: mulberry32(5), log: () => {} });
  const players = [];
  for (let i = 0; i < humans; i++) {
    const inbox = [];
    const { account } = accounts.login(null, `Tester${i}`);
    const p = m.addPlayer({ name: account.name, account, send: (msg) => inbox.push(msg) });
    p.inbox = inbox;
    players.push(p);
  }
  m.settings.bots = bots;
  m.settings.teamSize = teamSize;
  return { m, accounts, players };
}

function startLive(m, host) {
  m.handleMessage(host, { t: 'start' });
  assert.equal(m.phase, 'countdown');
  for (let i = 0; i < (MATCH.countdown + 0.5) / DT; i++) m.tick(DT);
  assert.equal(m.phase, 'live');
}

// Find open flat ground with clear line of sight along -Z for `dist` meters.
function openSpot(m, dist = 12) {
  const w = m.world;
  for (let x = -200; x < 200; x += 7) for (let z = -200; z < 200; z += 7) {
    const y0 = w.heightAt(x, z), y1 = w.heightAt(x, z - dist);
    if (Math.abs(y0 - y1) > 0.3 || y0 < 0) continue;
    const near = w.queryBoxes(x - 3, z - dist - 3, x + 3, z + 3, []);
    if (near.length) continue;
    const ray = w.raycast(x, y0 + 1.5, z, 0, 0, -1, dist);
    if (ray.t >= dist) return { x, z };
  }
  throw new Error('no open spot');
}

function place(m, p, x, z) {
  p.st.x = x; p.st.z = z;
  p.st.y = supportHeight(m.world, x, z, m.world.heightAt(x, z) + 0.6);
  p.st.vx = p.st.vy = p.st.vz = 0;
  p.st.m = MODE.GROUND; p.st.g = true; p.st.c = false;
  p.history.length = 0;
  p.lastInputAt = m.time + 999; // suppress idle physics noise during the test
}

function aimAt(shooter, target) {
  const dx = target.st.x - shooter.st.x, dy = target.st.y + 1.1 - (shooter.st.y + 1.6), dz = target.st.z - shooter.st.z;
  const d = Math.hypot(dx, dy, dz);
  shooter.yaw = Math.atan2(-dx, -dz);
  shooter.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return [dx / d, dy / d, dz / d];
}

test('storm shrinks through every phase and ends at the final circle', () => {
  const s = new Storm(QUICK_STORM_PHASES, mulberry32(1));
  s.start(0);
  let t = 0, changes = 0;
  while (s.stage !== 'done' && t < 1000) { t += 0.5; if (s.update(t)) changes++; }
  assert.equal(s.stage, 'done');
  assert.equal(changes, QUICK_STORM_PHASES.length * 2);
  assert.equal(s.circle(t).r, 0);
  // Each new circle lies inside the previous one.
  const s2 = new Storm(QUICK_STORM_PHASES, mulberry32(2));
  s2.start(0);
  let prev = s2.from;
  for (let k = 0; k < 200 && s2.stage !== 'done'; k++) {
    const to = s2.to;
    assert.ok(Math.hypot(to.x - prev.x, to.z - prev.z) + to.r <= prev.r + 1e-6);
    s2.update(s2.stageEnd);
    if (s2.stage === 'wait') prev = s2.from;
  }
});

test('inventory: stacking, slot limits and weapon swap', () => {
  const inv = createInventory();
  for (let i = 0; i < 5; i++) assert.equal(addItem(inv, makeWeapon('ar', 1)).taken, true);
  inv.active = 2;
  const r = addItem(inv, makeWeapon('sniper', 4));
  assert.equal(r.taken, true);
  assert.equal(r.dropped.type, 'ar');
  assert.equal(inv.slots[2].type, 'sniper');
  const inv2 = createInventory();
  addItem(inv2, { kind: 'item', type: 'bandage', count: 8 });
  const r2 = addItem(inv2, { kind: 'item', type: 'bandage', count: 5 });
  assert.equal(inv2.slots[0].count, 10);
  assert.equal(inv2.slots[1].count, 3);
  assert.equal(r2.leftover, null);
  const r3 = addItem(inv2, { kind: 'ammo', type: 'shells', count: 500 });
  assert.equal(inv2.ammo.shells, 60);
  assert.equal(r3.leftover.count, 440);
});

test('full match lifecycle: lobby -> ship -> glide -> combat -> victory -> rewards once -> lobby', () => {
  const { m, players, accounts } = setup({ humans: 2, bots: 2 });
  const [a, b] = players;
  startLive(m, a);
  const parts = [...m.players.values()].filter((p) => p.participant);
  assert.equal(parts.length, 4);
  assert.ok(parts.every((p) => p.st.m === MODE.SHIP));
  assert.equal(new Set(parts.map((p) => p.team)).size, 4);
  // Human A jumps; everyone else is auto-dropped at the end of the flight.
  m.queueInputs(a, [[1, IN.JUMP, 0, 0]]);
  m.tick(DT);
  assert.equal(a.st.m, MODE.GLIDE);
  for (let i = 0; i < 70 / DT && parts.some((p) => p.alive && p.st.m !== MODE.GROUND); i++) m.tick(DT);
  assert.ok(parts.every((p) => p.st.m === MODE.GROUND), 'everyone should have landed');
  assert.equal(m.ship, null);

  // Eliminate the bots and B, leaving A as the winner.
  for (const p of parts) if (p !== a) m.applyDamage(p, 500, a, 'ar', false);
  m.tick(DT); // victory is evaluated on the next server tick
  assert.equal(m.phase, 'ended');
  assert.equal(a.kills, 3);
  const endA = a.inbox.find((x) => x.t === 'end');
  assert.ok(endA, 'winner receives results');
  assert.equal(endA.you.placement, 1);
  assert.ok(endA.you.xp > 0);
  assert.equal(a.account.stats.wins, 1);
  assert.equal(a.account.stats.kills, 3);
  const endB = b.inbox.find((x) => x.t === 'end');
  assert.ok(endB.you.placement >= 2);
  // Rewards cannot be granted twice for the same match.
  assert.equal(accounts.recordResult(a.account, m.matchId, { placement: 1, kills: 99, damage: 0, outlasted: 3 }), null);
  assert.equal(a.account.stats.matches, 1);

  for (let i = 0; i < (MATCH.resultsDuration + 1) / DT; i++) m.tick(DT);
  assert.equal(m.phase, 'lobby');
  assert.equal([...m.players.values()].filter((p) => p.isBot).length, 0, 'bots removed');
  assert.ok(a.alive && b.alive);
});

test('server-validated shooting: hits, damage, fire-rate and aim validation', () => {
  const { m, players } = setup({ humans: 2 });
  const [a, b] = players;
  startLive(m, a);
  const spot = openSpot(m);
  place(m, a, spot.x, spot.z);
  place(m, b, spot.x, spot.z - 10);
  m.tick(DT);
  a.inv.slots[0] = makeWeapon('ar', 0);
  a.inv.active = 0;
  a.inv.ammo.medium = 0;
  a.bits = IN.AIM;
  const dir = aimAt(a, b);

  const before = b.hp;
  m.fire(a, { d: dir, rt: m.time });
  assert.ok(b.hp < before, 'target should take damage');
  const hit = a.inbox.find((x) => x.t === 'hit');
  assert.ok(hit && hit.id === b.id);
  assert.ok(b.inbox.some((x) => x.t === 'dmg'));
  assert.equal(a.inv.slots[0].mag, WEAPONS.ar.mag - 1);

  // Fire-rate limit: many shots in the same instant are mostly rejected.
  const magBefore = a.inv.slots[0].mag;
  for (let i = 0; i < 10; i++) m.fire(a, { d: dir, rt: m.time });
  assert.ok(magBefore - a.inv.slots[0].mag <= 1, 'rapid-fire exploit should be blocked');

  // Shooting in a direction far from where the player is looking is rejected.
  for (let i = 0; i < 30; i++) m.tick(DT);
  const mag2 = a.inv.slots[0].mag;
  m.fire(a, { d: [-dir[0], -dir[1], -dir[2]], rt: m.time });
  assert.equal(a.inv.slots[0].mag, mag2);
  // Malformed payloads are ignored.
  m.fire(a, { d: [NaN, 0, 1] });
  m.fire(a, { d: 'boom' });
  assert.equal(a.inv.slots[0].mag, mag2);
});

test('shields absorb damage first; teammates cannot damage each other', () => {
  const { m, players } = setup({ humans: 2, teamSize: 2 });
  const [a, b] = players;
  // Two players in duos would be a single team: the server must refuse to start.
  m.handleMessage(a, { t: 'start' });
  assert.equal(m.phase, 'lobby');
  assert.ok(a.inbox.some((x) => x.t === 'notice'));
  m.settings.bots = 2;
  startLive(m, a);
  for (const p of m.players.values()) if (p.isBot) p.team = 2;
  a.team = b.team = 1;
  b.sh = 50;
  assert.equal(m.applyDamage(b, 30, a, 'ar'), 0, 'friendly fire blocked');
  assert.equal(b.sh, 50);
  m.applyDamage(b, 30, null, 'fall');
  assert.equal(b.sh, 50, 'fall damage bypasses shields');
  assert.equal(b.hp, 70);
});

test('shield absorbs enemy damage before health', () => {
  const { m, players } = setup({ humans: 2 });
  const [a, b] = players;
  startLive(m, a);
  b.sh = 50;
  m.applyDamage(b, 70, a, 'ar');
  assert.equal(b.sh, 0);
  assert.equal(b.hp, 80);
});

test('pickup is validated by distance and is granted once', () => {
  const { m, players } = setup({ humans: 2 });
  const [a, b] = players;
  startLive(m, a);
  const spot = openSpot(m);
  place(m, a, spot.x, spot.z);
  place(m, b, spot.x + 1, spot.z);
  const id = 999999;
  m.loot.set(id, { id, x: spot.x + PICKUP_RANGE + 2, y: a.st.y, z: spot.z, item: makeWeapon('shotgun', 3) });
  m.pickup(a, id);
  assert.ok(m.loot.has(id), 'too far away');
  m.loot.get(id).x = spot.x + 1;
  m.pickup(a, id);
  m.pickup(b, id);
  assert.ok(!m.loot.has(id));
  assert.equal(a.inv.slots.filter((s) => s && s.type === 'shotgun').length, 1);
  assert.equal(b.inv.slots.filter((s) => s && s.type === 'shotgun').length, 0);
});

test('healing items take time and respect caps', () => {
  const { m, players } = setup({ humans: 2 });
  const [a] = players;
  startLive(m, a);
  for (let i = 0; i < 70 / DT && a.st.m !== MODE.GROUND; i++) m.tick(DT);
  a.hp = 40;
  a.inv.slots[1] = { kind: 'item', type: 'bandage', count: 2 };
  m.switchSlot(a, 1);
  m.useItem(a);
  assert.ok(a.use);
  m.tick(DT);
  assert.equal(a.hp, 40, 'not instant');
  for (let i = 0; i < 3.2 / DT; i++) m.tick(DT);
  assert.equal(Math.round(a.hp), 55);
  assert.equal(a.inv.slots[1].count, 1);
  a.hp = 75;
  m.useItem(a);
  assert.equal(a.use, null, 'bandages cannot heal above 75');
});

test('input budget prevents speed hacks', () => {
  const { m, players } = setup({ humans: 1 });
  const [a] = players;
  const x0 = a.st.x, z0 = a.st.z;
  // A cheater sends 2 seconds worth of forward inputs within a single tick.
  const flood = [];
  for (let i = 1; i <= 120; i++) flood.push([i, IN.FWD | IN.SPRINT, 0, 0]);
  for (let k = 0; k < 6; k++) m.queueInputs(a, flood.slice(k * 20, k * 20 + 20));
  m.tick(DT);
  const moved = Math.hypot(a.st.x - x0, a.st.z - z0);
  assert.ok(moved < 3, `moved ${moved.toFixed(2)}m in one tick`);
});

test('disconnect mid-match keeps the character for reconnection', () => {
  const { m, players } = setup({ humans: 2 });
  const [a, b] = players;
  startLive(m, a);
  m.disconnect(b);
  assert.ok(m.players.has(b.id));
  assert.equal(b.connected, false);
  const found = m.findDisconnected(b.account.id);
  assert.equal(found, b);
  const inbox = [];
  m.reconnect(b, (x) => inbox.push(x));
  assert.equal(b.connected, true);
  assert.ok(inbox.some((x) => x.t === 'state' && x.you === b.id && x.phase === 'live'));
});

test('a player who never reconnects is eliminated after the grace period', () => {
  const { m, players } = setup({ humans: 2, bots: 1 });
  const [a, b] = players;
  startLive(m, a);
  m.disconnect(b);
  for (let i = 0; i < (MATCH.reconnectGrace + 2) / DT && b.alive; i++) m.tick(DT);
  assert.equal(b.alive, false);
});

test('bots can play a whole match to completion on their own', () => {
  const { m, players } = setup({ humans: 1, bots: 6 });
  const [a] = players;
  startLive(m, a);
  a.alive = false; // human sits out; bots fight and the storm closes
  a.participant = false;
  let ticks = 0;
  while (m.phase === 'live' && ticks < 400 / DT) { m.tick(DT); ticks++; }
  assert.equal(m.phase, 'ended', `match still live after ${Math.round(ticks * DT)}s`);
  const res = m.lastResults;
  assert.equal(res.standings.filter((s) => s.placement === 1).length, 1);
});
