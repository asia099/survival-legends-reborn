// End-to-end: real server, real WebSocket clients (Node's built-in WebSocket client).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { PROTOCOL_VERSION, IN, MATCH } from '../shared/config.js';
import { MODE, supportHeight } from '../shared/physics.js';
import { makeWeapon } from '../server/loot.js';

class TestClient {
  constructor(port) {
    this.msgs = [];
    this.waiters = [];
    this.closed = null;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.opened = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
    };
    this.ws.onclose = (ev) => { this.closed = ev.code; for (const w of this.waiters) w.onClose?.(ev.code); };
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(pred, timeout = 5000, label = 'message') {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeout);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  waitClose(timeout = 5000) {
    if (this.closed !== null) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for close')), timeout);
      this.waiters.push({ pred: () => false, onClose: (c) => { clearTimeout(t); resolve(c); } });
    });
  }
  clear() { this.msgs.length = 0; }
  close() { this.ws.close(); }
}

async function join(port, name, token) {
  const c = new TestClient(port);
  await c.opened;
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name, token });
  const welcome = await c.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  const state = await c.waitFor((m) => m.t === 'state', 5000, 'state');
  c.token = welcome.token;
  c.id = state.you;
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('end-to-end multiplayer session over WebSockets', { timeout: 60000 }, async () => {
  const srv = await startServer({ port: 0, quick: true, seed: 7, dataFile: null, log: () => {} });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    // --- static files and path traversal protection
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/vendor/three.module.js`)).status, 200);
    assert.equal((await fetch(`${base}/shared/config.js`)).status, 200);
    assert.equal((await fetch(`${base}/%2e%2e/server/accounts.js`)).status, 404);
    assert.equal((await fetch(`${base}/shared/%2e%2e%2fserver%2faccounts.js`)).status, 404);

    // --- join two players, both see each other in snapshots
    const a = await join(srv.port, 'Alpha');
    const b = await join(srv.port, 'Bravo');
    assert.notEqual(a.id, b.id);
    assert.equal(a.token.length, 64);
    const snapA = await a.waitFor((m) => m.t === 's' && m.p.some((e) => e[0] === b.id), 3000, 'snapshot containing B');
    assert.ok(snapA.me, 'own state included for prediction');

    // --- movement is simulated by the server and replicated to the other client
    await b.waitFor((m) => m.t === 's' && m.p.some((e) => e[0] === a.id), 3000, 'snapshot containing A');
    const bView0 = b.msgs.filter((m) => m.t === 's').at(-1).p.find((e) => e[0] === a.id);
    for (let i = 1; i <= 60; i++) a.send({ t: 'in', i: [[i, IN.FWD, 0, 0]] });
    await sleep(1500);
    const sa = a.msgs.filter((m) => m.t === 's').at(-1);
    assert.equal(sa.a, 60, 'server acknowledged every input');
    const bView1 = b.msgs.filter((m) => m.t === 's').at(-1).p.find((e) => e[0] === a.id);
    const moved = Math.hypot(bView1[1] - bView0[1], bView1[3] - bView0[3]);
    assert.ok(moved > 2 && moved < 9, `A moved ${moved.toFixed(2)}m as seen by B`);

    // --- host starts the match (no bots), countdown, then everyone boards the ship
    a.send({ t: 'settings', bots: 0, teamSize: 1 });
    a.send({ t: 'start' });
    await a.waitFor((m) => m.t === 'phase' && m.phase === 'countdown', 3000, 'countdown');
    const live = await b.waitFor((m) => m.t === 'state' && m.phase === 'live', (MATCH.countdown + 3) * 1000, 'live state');
    assert.ok(live.loot.length > 50, `loot spawned: ${live.loot.length}`);
    assert.ok(live.storm.active);
    await b.waitFor((m) => m.t === 'inv' && m.slots[0]?.type === 'pistol', 3000, 'starting pistol');

    // --- server-validated combat over the network
    const m = srv.match;
    const pa = m.players.get(a.id), pb = m.players.get(b.id);
    const w = m.world;
    let spot = null;
    for (let x = -200; x < 200 && !spot; x += 7) for (let z = -200; z < 200 && !spot; z += 7) {
      const y0 = w.heightAt(x, z);
      if (y0 < 0 || Math.abs(y0 - w.heightAt(x, z - 10)) > 0.3) continue;
      if (w.queryBoxes(x - 3, z - 13, x + 3, z + 3, []).length) continue;
      if (w.raycast(x, y0 + 1.5, z, 0, 0, -1, 10).t >= 10) spot = { x, z };
    }
    const put = (p, x, z) => {
      Object.assign(p.st, { x, z, y: supportHeight(w, x, z, w.heightAt(x, z) + 0.6), vx: 0, vy: 0, vz: 0, g: true, c: false, m: MODE.GROUND });
      p.history.length = 0;
    };
    put(pa, spot.x, spot.z);
    put(pb, spot.x, spot.z - 10);
    pa.inv.slots[1] = makeWeapon('ar', 2);
    pa.inv.active = 1;
    const dy = pb.st.y + 1.1 - (pa.st.y + 1.6);
    const pitch = Math.atan2(dy, 10);
    a.send({ t: 'in', i: [[1000, IN.AIM, 0, pitch]] });
    await sleep(150);
    const d = [0, Math.sin(pitch), -Math.cos(pitch)];
    a.clear(); b.clear();
    a.send({ t: 'f', d, rt: m.time });
    const hit = await a.waitFor((x) => x.t === 'hit', 3000, 'hit confirmation');
    assert.equal(hit.id, b.id);
    const dmg = await b.waitFor((x) => x.t === 'dmg', 3000, 'damage notification');
    assert.ok(dmg.d > 0);
    assert.ok(pb.hp < 100);
    // A forged "fire" with an impossible direction does nothing.
    const hpBefore = pb.hp;
    await sleep(300);
    a.send({ t: 'f', d: [0, 0, 1], rt: m.time });
    await sleep(200);
    assert.equal(pb.hp, hpBefore);

    // --- reconnection keeps the same character
    b.close();
    await sleep(300);
    assert.equal(pb.connected, false);
    const b2 = await join(srv.port, 'Bravo', b.token);
    assert.equal(b2.id, b.id, 'reconnected to the same player');
    const st = b2.msgs.find((x) => x.t === 'state');
    assert.equal(st.phase, 'live');

    // --- match completion: B is eliminated, A wins, results are delivered once
    m.applyDamage(pb, 1000, pa, 'ar', true);
    const endA = await a.waitFor((x) => x.t === 'end', 3000, 'end for A');
    const endB = await b2.waitFor((x) => x.t === 'end', 3000, 'end for B');
    assert.equal(endA.you.placement, 1);
    assert.equal(endB.you.placement, 2);
    assert.deepEqual(endA.winners, ['Alpha']);
    assert.equal(pa.account.stats.wins, 1);
    assert.equal(pb.account.stats.matches, 1);

    // --- protocol abuse: version mismatch and message floods are rejected
    const bad = new TestClient(srv.port);
    await bad.opened;
    bad.send({ t: 'hello', v: 999, name: 'Old' });
    assert.equal(await bad.waitClose(), 4001);
    const flood = await join(srv.port, 'Flooder');
    for (let i = 0; i < 600; i++) flood.send({ t: 'ping', c: i });
    assert.equal(await flood.waitClose(), 4008);

    a.close(); b2.close();
  } finally {
    await srv.close();
  }
});
