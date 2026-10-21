// Authoritative match simulation. Owns every piece of gameplay state: positions, health,
// inventories, loot, the storm, eliminations and results. Transport-agnostic: each player
// has a `send(obj)` function, so tests can drive a Match without sockets.

import { randomUUID } from 'node:crypto';
import {
  TICK_RATE, INPUT_DT, MAX_REWIND, MAP_SIZE, PLAYER, SHIP, IN, WEAPONS, CONSUMABLES, AMMO,
  RARITIES, STORM_PHASES, QUICK_STORM_PHASES, MATCH, PICKUP_RANGE, INVENTORY_SLOTS,
} from '../shared/config.js';
import { createWorld, mulberry32 } from '../shared/world.js';
import { createMoveState, stepMove, supportHeight, eyeHeight, MODE } from '../shared/physics.js';
import { Storm } from './storm.js';
import { spawnWorldLoot, createInventory, addItem, serializeInventory, makeWeapon } from './loot.js';
import {
  rayPlayer, recordHistory, positionAt, damageFor, applySpread, viewDir,
} from './combat.js';
import { updateBot, createBrain, BOT_NAMES } from './bots.js';
import { levelForXp } from './accounts.js';

export const WEAPON_TYPES = Object.keys(WEAPONS);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const noop = () => {};
const LOBBY_SPAWN = { x: -70, z: -45, r: 18 };

export class Match {
  constructor({ seed = 1, accounts = null, quick = false, rng = Math.random, log = console.log } = {}) {
    this.seed = seed;
    this.world = createWorld(seed);
    this.accounts = accounts;
    this.stormPhases = quick ? QUICK_STORM_PHASES : STORM_PHASES;
    this.rng = rng;
    this.log = log;
    this.time = 0;
    this.players = new Map();
    this.nextPlayerId = 1;
    this.nextLootId = 1;
    this.joinCounter = 0;
    this.loot = new Map();
    this.phase = 'lobby';
    this.phaseEnd = 0;
    this.settings = { bots: 7, teamSize: 1 };
    this.storm = new Storm(this.stormPhases, this.rng);
    this.ship = null;
    this.matchId = null;
    this.startTime = 0;
    this.teamCount = 0;
    this.lastResults = null;
    this.stats = { shotsRejected: 0, inputsDropped: 0 };
  }

  // ------------------------------------------------------------------ players

  addPlayer({ name, account = null, send = noop, isBot = false }) {
    const p = {
      id: this.nextPlayerId++, name, account, isBot, send, connected: true,
      joinOrder: this.joinCounter++, team: 0, st: createMoveState(), yaw: 0, pitch: 0, bits: 0,
      alive: false, participant: false, hp: PLAYER.maxHealth, sh: 0, inv: createInventory(),
      reload: null, use: null, fireTokens: 1, lastFireT: 0,
      inputQueue: [], lastQueuedSeq: 0, lastSeq: 0, inputBudget: 0, lastInputAt: 0,
      kills: 0, damage: 0, placement: 0, deathTime: 0, history: [], ready: false,
      disconnectedAt: 0, stormAcc: 0, chatNext: 0, brain: isBot ? createBrain() : null,
    };
    this.players.set(p.id, p);
    if (this.phase === 'lobby' || this.phase === 'countdown') this.spawnInLobby(p);
    if (!isBot) {
      this.sendFullState(p);
      this.broadcastRoster();
      this.system(`${name} joined`);
    }
    return p;
  }

  findDisconnected(accountId) {
    for (const p of this.players.values()) {
      if (!p.isBot && !p.connected && p.account && p.account.id === accountId) return p;
    }
    return null;
  }

  findConnected(accountId) {
    for (const p of this.players.values()) {
      if (!p.isBot && p.connected && p.account && p.account.id === accountId) return p;
    }
    return null;
  }

  reconnect(p, send) {
    p.connected = true;
    p.send = send;
    p.inputQueue.length = 0;
    p.lastQueuedSeq = 0;
    p.lastSeq = 0;
    this.sendFullState(p);
    this.sendInv(p);
    this.broadcastRoster();
    this.system(`${p.name} reconnected`);
  }

  disconnect(p) {
    if (!this.players.has(p.id)) return;
    if (this.phase === 'live' && p.participant && p.alive) {
      p.connected = false;
      p.send = noop;
      p.disconnectedAt = this.time;
      this.system(`${p.name} lost connection`);
    } else {
      this.players.delete(p.id);
      this.system(`${p.name} left`);
    }
    this.broadcastRoster();
  }

  spawnInLobby(p) {
    const a = this.rng() * Math.PI * 2, d = this.rng() * LOBBY_SPAWN.r;
    const x = LOBBY_SPAWN.x + Math.cos(a) * d, z = LOBBY_SPAWN.z + Math.sin(a) * d;
    p.st = createMoveState(x, supportHeight(this.world, x, z, this.world.heightAt(x, z) + 0.6), z);
    p.alive = true;
    p.hp = PLAYER.maxHealth; p.sh = 0;
    p.inv = createInventory();
    p.reload = null; p.use = null;
    p.history.length = 0;
  }

  get hostId() {
    let best = null;
    for (const p of this.players.values()) {
      if (p.isBot || !p.connected) continue;
      if (!best || p.joinOrder < best.joinOrder) best = p;
    }
    return best ? best.id : 0;
  }

  humans() { return [...this.players.values()].filter((p) => !p.isBot); }

  // ------------------------------------------------------------------ messages

  handleMessage(p, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'in': return this.queueInputs(p, msg.i);
      case 'f': return this.fire(p, msg);
      case 'r': return this.startReload(p);
      case 'sl': return this.switchSlot(p, msg.i);
      case 'p': return this.pickup(p, msg.id);
      case 'dr': return this.drop(p, msg.i);
      case 'u': return this.useItem(p);
      case 'ready': return this.setReady(p, !!msg.v);
      case 'start': return this.hostStart(p);
      case 'settings': return this.updateSettings(p, msg);
      case 'c': return this.chat(p, msg.m);
      case 'ping': return p.send({ t: 'pong', c: msg.c, s: r3(this.time) });
      default: return undefined;
    }
  }

  queueInputs(p, list) {
    if (!Array.isArray(list)) return;
    p.lastInputAt = this.time;
    for (let i = 0; i < list.length && i < 20; i++) {
      const e = list[i];
      if (!Array.isArray(e) || e.length < 4) continue;
      const [seq, bits, yaw, pitch] = e;
      if (!Number.isInteger(seq) || seq <= p.lastQueuedSeq) continue;
      if (!Number.isInteger(bits) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) continue;
      p.lastQueuedSeq = seq;
      p.inputQueue.push([seq, bits & 0xff, yaw, Math.max(-1.5, Math.min(1.5, pitch))]);
    }
    while (p.inputQueue.length > 40) { p.inputQueue.shift(); this.stats.inputsDropped++; }
  }

  setReady(p, v) {
    if (this.phase !== 'lobby' && this.phase !== 'countdown') return;
    p.ready = v;
    this.broadcastRoster();
  }

  // A match needs at least two teams, otherwise it would be won instantly.
  canStart() {
    const humans = this.humans().filter((h) => h.connected).length;
    const total = Math.min(MATCH.maxPlayers, humans + this.settings.bots);
    return humans > 0 && Math.ceil(total / this.settings.teamSize) >= 2;
  }

  hostStart(p) {
    if (p.id !== this.hostId || this.phase !== 'lobby') return;
    if (!this.canStart()) { p.send({ t: 'notice', m: 'Need at least 2 teams - add bots or invite friends.' }); return; }
    this.beginCountdown();
  }

  updateSettings(p, msg) {
    if (p.id !== this.hostId || this.phase !== 'lobby') return;
    if (Number.isInteger(msg.bots)) this.settings.bots = Math.max(0, Math.min(MATCH.maxPlayers - 1, msg.bots));
    if (msg.teamSize === 1 || msg.teamSize === 2 || msg.teamSize === 4) this.settings.teamSize = msg.teamSize;
    this.broadcast({ t: 'settings', s: this.settings });
  }

  chat(p, text) {
    if (typeof text !== 'string' || this.time < p.chatNext) return;
    const clean = text.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 120);
    if (!clean) return;
    p.chatNext = this.time + 0.8;
    this.broadcast({ t: 'chat', id: p.id, n: p.name, m: clean });
  }

  system(m) { this.broadcast({ t: 'chat', id: 0, n: '', m }); }

  // ------------------------------------------------------------------ lifecycle

  beginCountdown() {
    this.phase = 'countdown';
    this.phaseEnd = this.time + MATCH.countdown;
    this.broadcast({ t: 'phase', phase: this.phase, end: r3(this.phaseEnd) });
  }

  beginMatch() {
    this.matchId = randomUUID();
    for (const p of [...this.players.values()]) if (p.isBot) this.players.delete(p.id);
    const humans = this.humans().filter((p) => p.connected);
    const botCount = Math.min(this.settings.bots, MATCH.maxPlayers - humans.length);
    const names = [...BOT_NAMES].sort(() => this.rng() - 0.5);
    for (let i = 0; i < botCount; i++) this.addPlayer({ name: names[i % names.length] + ' [BOT]', isBot: true });

    const participants = [...this.players.values()].filter((p) => p.isBot || p.connected);
    // Team assignment: shuffle, then fill teams in order.
    participants.sort(() => this.rng() - 0.5);
    const ts = this.settings.teamSize;
    participants.forEach((p, i) => { p.team = Math.floor(i / ts) + 1; });
    this.teamCount = Math.ceil(participants.length / ts);

    // Transport ship path across the map.
    const a = this.rng() * Math.PI * 2;
    const L = MAP_SIZE / 2 + 10;
    const off = (this.rng() - 0.5) * 160;
    const dx = Math.cos(a), dz = Math.sin(a);
    this.ship = {
      sx: -dx * L - dz * off, sz: -dz * L + dx * off, dx, dz, len: 2 * L, start: this.time, speed: SHIP.speed,
    };

    for (const p of participants) {
      p.participant = true;
      p.alive = true;
      p.hp = PLAYER.maxHealth; p.sh = 0;
      p.inv = createInventory();
      p.inv.slots[0] = makeWeapon('pistol', 0);
      p.inv.ammo.light = 24;
      p.kills = 0; p.damage = 0; p.placement = 0; p.deathTime = 0;
      p.reload = null; p.use = null; p.stormAcc = 0; p.ready = false;
      p.history.length = 0;
      const pos = this.shipPos();
      p.st = createMoveState(pos.x, SHIP.altitude, pos.z);
      p.st.m = MODE.SHIP;
      if (p.isBot) p.brain = createBrain(this, p);
    }
    this.loot = spawnWorldLoot(this.world, this.rng, () => this.nextLootId++);
    this.storm = new Storm(this.stormPhases, this.rng);
    this.storm.start(this.time);
    this.phase = 'live';
    this.startTime = this.time;
    this.log(`[match ${this.matchId.slice(0, 8)}] started: ${participants.length} players, ${this.teamCount} teams, ${this.loot.size} loot items`);
    for (const p of this.players.values()) if (!p.isBot) { this.sendFullState(p); this.sendInv(p); }
    this.broadcastRoster();
  }

  shipPos() {
    const s = this.ship;
    const d = Math.min(s.len, (this.time - s.start) * s.speed);
    return { x: s.sx + s.dx * d, z: s.sz + s.dz * d, done: d >= s.len };
  }

  eject(p) {
    const pos = this.shipPos();
    p.st.m = MODE.GLIDE;
    p.st.x = pos.x; p.st.z = pos.z; p.st.y = SHIP.altitude - 2;
    p.st.vx = this.ship.dx * 8; p.st.vz = this.ship.dz * 8; p.st.vy = 0;
    p.st.g = false;
  }

  endMatch() {
    const parts = [...this.players.values()].filter((p) => p.participant);
    let winTeam = null;
    const alive = parts.filter((p) => p.alive);
    if (alive.length) winTeam = alive[0].team;
    else if (parts.length) winTeam = parts.reduce((a, b) => (b.deathTime > a.deathTime ? b : a)).team;
    for (const p of parts) if (p.team === winTeam) p.placement = 1;

    const standings = parts.map((p) => ({
      id: p.id, name: p.name, team: p.team, placement: p.placement || 1, kills: p.kills,
      damage: Math.round(p.damage), survived: Math.round((p.alive ? this.time : p.deathTime) - this.startTime),
    })).sort((a, b) => a.placement - b.placement || b.kills - a.kills);
    const winners = parts.filter((p) => p.team === winTeam).map((p) => p.name);

    this.phase = 'ended';
    this.phaseEnd = this.time + MATCH.resultsDuration;
    this.ship = null;
    this.lastResults = { matchId: this.matchId, winners, standings };
    this.log(`[match ${this.matchId.slice(0, 8)}] ended. Winner(s): ${winners.join(', ')}`);

    for (const p of parts) {
      let xp = null, profile = null;
      if (!p.isBot && p.account && this.accounts) {
        const s = standings.find((x) => x.id === p.id);
        xp = this.accounts.recordResult(p.account, this.matchId, {
          placement: s.placement, kills: s.kills, damage: s.damage, outlasted: this.teamCount - s.placement,
        });
        profile = this.accounts.publicProfile(p.account);
      }
      if (!p.isBot) {
        const s = standings.find((x) => x.id === p.id);
        p.send({ t: 'end', winners, standings, you: { ...s, xp, level: profile?.level ?? null, stats: profile?.stats ?? null }, next: r3(this.phaseEnd) });
      }
    }
    for (const p of this.players.values()) {
      if (!p.isBot && !p.participant) p.send({ t: 'end', winners, standings, you: null, next: r3(this.phaseEnd) });
    }
  }

  resetToLobby() {
    for (const p of [...this.players.values()]) {
      if (p.isBot || !p.connected) this.players.delete(p.id);
    }
    this.loot.clear();
    this.storm = new Storm(this.stormPhases, this.rng);
    this.ship = null;
    this.phase = 'lobby';
    this.matchId = null;
    for (const p of this.players.values()) {
      p.participant = false; p.ready = false; p.team = 0;
      this.spawnInLobby(p);
      this.sendFullState(p);
      this.sendInv(p);
    }
    this.broadcastRoster();
  }

  // ------------------------------------------------------------------ tick

  tick(dt = 1 / TICK_RATE) {
    this.time += dt;

    if (this.phase === 'lobby') {
      const humans = this.humans().filter((p) => p.connected);
      if (humans.length >= MATCH.minPlayersToAutoStart && humans.every((p) => p.ready) && this.canStart()) this.beginCountdown();
    } else if (this.phase === 'countdown') {
      if (!this.humans().some((p) => p.connected)) { this.phase = 'lobby'; this.broadcast({ t: 'phase', phase: 'lobby', end: 0 }); }
      else if (this.time >= this.phaseEnd) this.beginMatch();
    } else if (this.phase === 'ended') {
      if (this.time >= this.phaseEnd) this.resetToLobby();
    }

    const live = this.phase === 'live';
    if (live) {
      if (this.storm.update(this.time)) this.broadcast({ t: 'storm', s: this.storm.serialize() });
      if (this.ship) {
        const pos = this.shipPos();
        for (const p of this.players.values()) {
          if (p.alive && p.st.m === MODE.SHIP) {
            if (pos.done) this.eject(p);
            else { p.st.x = pos.x; p.st.z = pos.z; p.st.y = SHIP.altitude; }
          }
        }
        if (pos.done) this.ship = null;
      }
    }

    for (const p of this.players.values()) {
      if (p.isBot) { if (live) updateBot(this, p, dt); }
      else this.processInputs(p, dt);
      if (!p.alive) continue;
      this.updateTimers(p);
      if (live) {
        if (this.storm.isOutside(p.st.x, p.st.z, this.time)) {
          p.stormAcc += dt;
          if (p.stormAcc >= 1) { p.stormAcc -= 1; this.applyDamage(p, this.storm.dps, null, 'storm'); }
        } else p.stormAcc = 0;
        if (!p.connected && !p.isBot && this.time - p.disconnectedAt > MATCH.reconnectGrace) {
          this.eliminate(p, null, 'left', false);
        }
      }
      if (p.alive) recordHistory(p, this.time);
    }

    if (live) this.checkWin();
    this.sendSnapshots();
  }

  processInputs(p, dt) {
    p.inputBudget = Math.min(p.inputBudget + dt, 0.25);
    let processed = 0;
    while (p.inputQueue.length && p.inputBudget >= INPUT_DT - 1e-6) {
      const [seq, bits, yaw, pitch] = p.inputQueue.shift();
      p.inputBudget -= INPUT_DT;
      p.lastSeq = seq;
      p.yaw = yaw; p.pitch = pitch; p.bits = bits;
      this.applyInput(p, bits, yaw);
      processed++;
    }
    // Keep physics running (gravity, gliding) for idle or disconnected players.
    if (!processed && this.time - p.lastInputAt > 0.25) {
      const steps = Math.round(dt / INPUT_DT);
      for (let i = 0; i < steps; i++) this.applyInput(p, 0, p.yaw);
    }
  }

  applyInput(p, bits, yaw) {
    if (!p.alive) return;
    if (p.st.m === MODE.SHIP) {
      if ((bits & IN.JUMP) && this.ship) this.eject(p);
      return;
    }
    const fall = stepMove(p.st, bits, yaw, INPUT_DT, this.world);
    if (fall > 0 && this.phase === 'live') this.applyDamage(p, fall, null, 'fall');
  }

  updateTimers(p) {
    if (p.reload && this.time >= p.reload.end) {
      const slot = p.inv.slots[p.reload.slot];
      p.reload = null;
      if (slot && slot.kind === 'weapon') {
        const W = WEAPONS[slot.type];
        const n = Math.min(W.mag - slot.mag, p.inv.ammo[W.ammo]);
        slot.mag += n; p.inv.ammo[W.ammo] -= n;
      }
      this.sendInv(p);
    }
    if (p.use && this.time >= p.use.end) {
      const slotIdx = p.use.slot;
      const slot = p.inv.slots[slotIdx];
      const type = p.use.type;
      p.use = null;
      if (slot && slot.kind === 'item' && slot.type === type) {
        const c = CONSUMABLES[type];
        if (c.heal && p.hp < c.healCap) p.hp = Math.min(c.healCap, p.hp + c.heal);
        if (c.shield && p.sh < c.shieldCap) p.sh = Math.min(c.shieldCap, p.sh + c.shield);
        slot.count--;
        if (slot.count <= 0) p.inv.slots[slotIdx] = null;
      }
      this.sendInv(p);
    }
  }

  checkWin() {
    const teams = new Set();
    let any = false;
    for (const p of this.players.values()) if (p.participant) { any = true; if (p.alive) teams.add(p.team); }
    if (any && teams.size <= 1) this.endMatch();
  }

  // ------------------------------------------------------------------ combat

  fire(p, msg) {
    if (this.phase !== 'live' || !p.alive || p.st.m !== MODE.GROUND) return;
    const slot = p.inv.slots[p.inv.active];
    if (!slot || slot.kind !== 'weapon') return;
    const W = WEAPONS[slot.type];
    if (p.use) { p.use = null; this.sendInv(p); }
    if (p.reload) {
      if (slot.mag <= 0) return;
      p.reload = null;
    }
    if (slot.mag <= 0) { this.startReload(p); return; }

    const interval = 60 / W.rpm;
    p.fireTokens = Math.min(1.5, p.fireTokens + (this.time - p.lastFireT) / interval);
    p.lastFireT = this.time;
    if (p.fireTokens < 0.8) { this.stats.shotsRejected++; return; }
    p.fireTokens -= 1;

    // Validate aim direction: finite, normalized, roughly where the player is looking.
    const d = Array.isArray(msg.d) ? msg.d.map(Number) : null;
    if (!d || d.length !== 3 || !d.every(Number.isFinite)) return;
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-6) return;
    const dir = [d[0] / len, d[1] / len, d[2] / len];
    const v = viewDir(p.yaw, p.pitch);
    if (dir[0] * v[0] + dir[1] * v[1] + dir[2] * v[2] < 0.6) { this.stats.shotsRejected++; return; }

    slot.mag--;
    const o = [p.st.x, p.st.y + eyeHeight(p.st), p.st.z];
    const aiming = (p.bits & IN.AIM) !== 0;
    let spread = aiming ? W.aimSpread : W.spread;
    const hs = Math.hypot(p.st.vx, p.st.vz);
    if (hs > 1 && !aiming) spread *= 1.4;
    if (!p.st.g) spread *= 1.8;
    if (p.st.c) spread *= 0.8;

    const rt = Math.max(this.time - MAX_REWIND, Math.min(this.time, Number(msg.rt) || this.time));
    const targets = [];
    for (const q of this.players.values()) {
      if (q === p || !q.alive || q.st.m === MODE.SHIP) continue;
      targets.push({ q, pos: positionAt(q, rt) });
    }
    const ends = [];
    const hits = new Map();
    for (let i = 0; i < W.pellets; i++) {
      const pd = applySpread(dir, spread, this.rng);
      const w = this.world.raycast(o[0], o[1], o[2], pd[0], pd[1], pd[2], W.range);
      let tMax = w.t, hitQ = null, head = false;
      for (const tg of targets) {
        const r = rayPlayer(o, pd, tg.pos, tg.pos.c, tMax);
        if (r) { tMax = r.t; hitQ = tg.q; head = r.head; }
      }
      ends.push([r2(o[0] + pd[0] * tMax), r2(o[1] + pd[1] * tMax), r2(o[2] + pd[2] * tMax), hitQ ? 1 : 0]);
      if (hitQ) {
        const h = hits.get(hitQ) ?? { dmg: 0, head: false, at: null };
        h.dmg += damageFor(W, slot.rarity, tMax, head);
        h.head = h.head || head;
        h.at = ends[ends.length - 1];
        hits.set(hitQ, h);
      }
    }
    const shot = { t: 'shot', id: p.id, w: slot.type, o: o.map(r2), e: ends };
    for (const q of this.players.values()) {
      if (q === p || q.isBot) continue;
      if (Math.hypot(q.st.x - p.st.x, q.st.z - p.st.z) < 300 || !q.alive) q.send(shot);
    }
    for (const [q, h] of hits) this.applyDamage(q, h.dmg, p, slot.type, h.head, h.at);
    if (slot.mag === 0 && p.inv.ammo[W.ammo] > 0) this.startReload(p);
    else this.sendInv(p);
  }

  applyDamage(t, amount, src, cause, head = false, at = null) {
    if (!t.alive || this.phase !== 'live' || amount <= 0) return 0;
    if (src && src !== t && src.team === t.team) return 0;
    let dmg = amount, shieldDmg = 0;
    if (cause !== 'storm' && cause !== 'fall' && t.sh > 0) {
      shieldDmg = Math.min(t.sh, dmg);
      t.sh -= shieldDmg; dmg -= shieldDmg;
    }
    t.hp -= dmg;
    const total = shieldDmg + dmg;
    const lethal = t.hp <= 0.0001;
    if (src && src !== t) {
      src.damage += total;
      src.send({ t: 'hit', id: t.id, d: Math.round(total), hs: head, sh: shieldDmg > 0, k: lethal,
        at: at ?? [r2(t.st.x), r2(t.st.y + 1.2), r2(t.st.z)] });
    }
    t.send({ t: 'dmg', d: Math.round(total), from: src ? [r2(src.st.x), r2(src.st.z)] : null, cause });
    if (lethal) { t.hp = 0; this.eliminate(t, src, cause, head); }
    return total;
  }

  eliminate(t, killer, cause, head) {
    if (!t.alive) return;
    t.alive = false;
    t.deathTime = this.time;
    t.reload = null; t.use = null;
    // Drop inventory as loot.
    const drops = [];
    const add = (item) => {
      const a = this.rng() * Math.PI * 2, d = 0.6 + this.rng() * 1.4;
      const x = t.st.x + Math.cos(a) * d, z = t.st.z + Math.sin(a) * d;
      const id = this.nextLootId++;
      const y = supportHeight(this.world, x, z, t.st.y + 0.6);
      const l = { id, x, y, z, item };
      this.loot.set(id, l); drops.push(l);
    };
    for (const s of t.inv.slots) if (s) add({ ...s });
    for (const [k, n] of Object.entries(t.inv.ammo)) if (n > 0) add({ kind: 'ammo', type: k, count: n });
    t.inv = createInventory();
    if (drops.length) this.broadcast({ t: 'loot+', l: drops.map(lootWire) });

    if (killer && killer !== t) killer.kills++;
    this.broadcast({ t: 'kill', k: killer && killer !== t ? killer.name : null, kid: killer?.id ?? 0, v: t.name, vid: t.id, w: cause, hs: !!head });

    const parts = [...this.players.values()].filter((p) => p.participant);
    if (!parts.some((p) => p.team === t.team && p.alive)) {
      const aliveTeams = new Set(parts.filter((p) => p.alive).map((p) => p.team)).size;
      for (const p of parts) if (p.team === t.team) p.placement = aliveTeams + 1;
    }
    t.send({ t: 'dead', by: killer && killer !== t ? killer.name : null, byId: killer?.id ?? 0, cause, placement: t.placement || null });
    this.broadcastRoster();
  }

  // ------------------------------------------------------------------ inventory

  startReload(p) {
    if (!p.alive || p.reload) return;
    const slot = p.inv.slots[p.inv.active];
    if (!slot || slot.kind !== 'weapon') return;
    const W = WEAPONS[slot.type];
    if (slot.mag >= W.mag || p.inv.ammo[W.ammo] <= 0) return;
    p.use = null;
    p.reload = { start: this.time, end: this.time + W.reload * RARITIES[slot.rarity].reload, slot: p.inv.active };
    this.sendInv(p);
  }

  switchSlot(p, i) {
    if (!Number.isInteger(i) || i < 0 || i >= INVENTORY_SLOTS || !p.alive) return;
    p.inv.active = i;
    p.reload = null; p.use = null;
    this.sendInv(p);
  }

  pickup(p, id) {
    if (this.phase !== 'live' || !p.alive || p.st.m !== MODE.GROUND) return;
    const l = this.loot.get(id);
    if (!l) return;
    if (Math.hypot(l.x - p.st.x, l.z - p.st.z) > PICKUP_RANGE || Math.abs(l.y - p.st.y) > 2.5) return;
    const res = addItem(p.inv, l.item);
    if (!res.taken) { p.send({ t: 'notice', m: 'Inventory full' }); return; }
    this.loot.delete(id);
    const removed = [id], added = [];
    if (res.leftover) {
      const nl = { ...l, id: this.nextLootId++, item: res.leftover };
      this.loot.set(nl.id, nl); added.push(nl);
    }
    if (res.dropped) {
      const nl = { id: this.nextLootId++, x: p.st.x, y: p.st.y, z: p.st.z, item: res.dropped };
      this.loot.set(nl.id, nl); added.push(nl);
    }
    if (res.dropped) p.reload = null; // active weapon was swapped out
    this.broadcast({ t: 'loot-', ids: removed });
    if (added.length) this.broadcast({ t: 'loot+', l: added.map(lootWire) });
    this.sendInv(p);
  }

  drop(p, i) {
    if (this.phase !== 'live' || !p.alive || !Number.isInteger(i) || i < 0 || i >= INVENTORY_SLOTS) return;
    const item = p.inv.slots[i];
    if (!item) return;
    p.inv.slots[i] = null;
    if (p.reload?.slot === i) p.reload = null;
    if (p.use?.slot === i) p.use = null;
    const f = viewDir(p.yaw, 0);
    const x = p.st.x + f[0] * 1.2, z = p.st.z + f[2] * 1.2;
    const l = { id: this.nextLootId++, x, y: supportHeight(this.world, x, z, p.st.y + 0.6), z, item };
    this.loot.set(l.id, l);
    this.broadcast({ t: 'loot+', l: [lootWire(l)] });
    this.sendInv(p);
  }

  useItem(p) {
    if (this.phase !== 'live' || !p.alive || p.use || p.st.m !== MODE.GROUND) return;
    const slot = p.inv.slots[p.inv.active];
    if (!slot || slot.kind !== 'item') return;
    const c = CONSUMABLES[slot.type];
    if (c.heal && p.hp >= c.healCap) { p.send({ t: 'notice', m: `Health already at ${c.healCap}` }); return; }
    if (c.shield && p.sh >= c.shieldCap) { p.send({ t: 'notice', m: `Shield already at ${c.shieldCap}` }); return; }
    p.reload = null;
    p.use = { start: this.time, end: this.time + c.useTime, slot: p.inv.active, type: slot.type };
    this.sendInv(p);
  }

  // ------------------------------------------------------------------ networking out

  broadcast(msg) {
    for (const p of this.players.values()) if (!p.isBot && p.connected) p.send(msg);
  }

  broadcastRoster() {
    const host = this.hostId;
    const players = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, bot: p.isBot, ready: p.ready, alive: p.alive && (p.participant || this.phase !== 'live'),
      conn: p.connected, host: p.id === host, level: p.account ? levelForXp(p.account.stats.xp) : null,
      participant: p.participant,
    }));
    this.broadcast({ t: 'roster', host, players });
  }

  sendInv(p) {
    if (p.isBot) return;
    p.send({
      t: 'inv', ...serializeInventory(p.inv),
      reload: p.reload ? [r3(p.reload.start), r3(p.reload.end)] : null,
      use: p.use ? [r3(p.use.start), r3(p.use.end), p.use.type] : null,
    });
  }

  sendFullState(p) {
    p.send({
      t: 'state', you: p.id, seed: this.seed, phase: this.phase, phaseEnd: r3(this.phaseEnd), time: r3(this.time),
      settings: this.settings, host: this.hostId, matchId: this.matchId, team: p.team,
      spectator: this.phase === 'live' && !p.participant,
      alive: p.alive && (p.participant || this.phase !== 'live'),
      storm: this.storm.serialize(),
      ship: this.ship ? { ...this.ship } : null,
      loot: [...this.loot.values()].map(lootWire),
      results: this.phase === 'ended' ? this.lastResults : null,
    });
  }

  sendSnapshots() {
    const others = [];
    let aliveCount = 0;
    for (const q of this.players.values()) {
      if (!q.alive) continue;
      if (this.phase === 'live' && !q.participant) continue;
      aliveCount++;
      if (q.st.m === MODE.SHIP) continue;
      const slot = q.inv.slots[q.inv.active];
      const w = slot && slot.kind === 'weapon' ? WEAPON_TYPES.indexOf(slot.type) * 8 + slot.rarity : -1;
      const flags = (q.st.c ? 1 : 0) | (q.st.g ? 2 : 0) | ((q.bits & IN.AIM) ? 4 : 0) | (q.reload ? 8 : 0)
        | (q.use ? 16 : 0) | (q.st.m === MODE.GLIDE ? 32 : 0);
      others.push([q.id, r2(q.st.x), r2(q.st.y), r2(q.st.z), r3(q.yaw), r3(q.pitch), flags, w, q.team]);
    }
    const tm = r3(this.time);
    for (const p of this.players.values()) {
      if (p.isBot || !p.connected) continue;
      const s = p.st;
      const msg = {
        t: 's', tm, a: p.lastSeq, p: others, n: aliveCount,
        me: p.alive ? [r3(s.x), r3(s.y), r3(s.z), r3(s.vx), r3(s.vy), r3(s.vz), s.g ? 1 : 0, s.c ? 1 : 0, s.m] : null,
        hp: Math.ceil(p.hp), sh: Math.ceil(p.sh), k: p.kills,
      };
      if (this.phase === 'live' && p.team) {
        msg.tmt = [];
        for (const q of this.players.values()) {
          if (q !== p && q.team === p.team && q.participant) msg.tmt.push([q.id, Math.ceil(q.hp), Math.ceil(q.sh), q.alive ? 1 : 0]);
        }
      }
      p.send(msg);
    }
  }
}

export function lootWire(l) {
  return [l.id, r2(l.x), r2(l.y), r2(l.z), l.item];
}
