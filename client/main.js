// Client entry point: networking, prediction/reconciliation, interpolation, camera, input and UI flow.
// The client never decides outcomes - it sends inputs and requests, and renders what the server reports.

import * as THREE from 'three';
import {
  PROTOCOL_VERSION, INPUT_DT, INTERP_DELAY, IN, WEAPONS, CONSUMABLES, RARITIES, PICKUP_RANGE,
  INVENTORY_SLOTS, SHIP, PLAYER,
} from '/shared/config.js';
import { createWorld } from '/shared/world.js';
import { createMoveState, stepMove, eyeHeight, MODE } from '/shared/physics.js';
import { Renderer, Avatar } from './render.js';
import { Hud, fmtTime } from './hud.js';
import { Audio } from './audio.js';

const WEAPON_TYPES = Object.keys(WEAPONS);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r4 = (v) => Math.round(v * 10000) / 10000;
const RECOIL = { pistol: 0.012, smg: 0.007, ar: 0.011, shotgun: 0.045, sniper: 0.06 };

// ------------------------------------------------------------------ persistence (per-browser conveniences)

const store = {
  get(k, d = null) { try { const v = localStorage.getItem('slr.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('slr.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const SETTINGS_SCHEMA = [
  { key: 'sens', label: 'Mouse sensitivity', min: 0.1, max: 4, step: 0.05, def: 1 },
  { key: 'adsSens', label: 'Aim sensitivity multiplier', min: 0.2, max: 1.5, step: 0.05, def: 0.75 },
  { key: 'fov', label: 'Field of view', min: 60, max: 100, step: 1, def: 80 },
  { key: 'volume', label: 'Master volume', min: 0, max: 1, step: 0.05, def: 0.7 },
  { key: 'renderScale', label: 'Render scale', min: 0.5, max: 1, step: 0.05, def: 1 },
  { key: 'shadows', label: 'Shadows', check: true, def: true },
  { key: 'invertY', label: 'Invert mouse Y', check: true, def: false },
  { key: 'showFps', label: 'Show FPS', check: true, def: false },
];

function loadSettings() {
  const s = {};
  for (const f of SETTINGS_SCHEMA) s[f.key] = f.def;
  return { ...s, ...(store.get('settings', {}) ?? {}) };
}

// ------------------------------------------------------------------ game

class Game {
  constructor() {
    this.settings = loadSettings();
    this.audio = new Audio();
    this.audio.setVolume(this.settings.volume);
    this.ws = null;
    this.connected = false;
    this.wantConnected = false;
    this.reconnectTries = 0;
    this.token = store.get('token');
    this.myId = 0;
    this.myTeam = 0;
    this.seed = null;
    this.world = null;
    this.renderer = null;
    this.hud = null;

    this.phase = 'menu';
    this.phaseEnd = 0;
    this.host = 0;
    this.spectator = false;
    this.alive = false;
    this.hp = 100; this.sh = 0; this.kills = 0; this.aliveCount = 0;
    this.inv = null; this.reload = null; this.use = null;
    this.roster = new Map();
    this.storm = null;
    this.ship = null;
    this.loot = new Map();
    this.remotes = new Map();
    this.settingsLobby = { bots: 7, teamSize: 1 };

    this.pred = createMoveState();
    this.havePred = false;
    this.pending = [];
    this.outBuf = [];
    this.seq = 0;
    this.inputAcc = 0;
    this.lastSend = 0;
    this.smooth = new THREE.Vector3();

    this.clientTime = 0;
    this.offset = 0; this.offsetInit = false;
    this.rtt = 0.05;
    this.lastSnapAt = 0;
    this.lastPing = 0;

    this.yaw = 0; this.pitch = 0;
    this.keys = new Set();
    this.jumpLatch = false;
    this.firing = false; this.trigger = false; this.aiming = false;
    this.nextFire = 0;
    this.locked = false;
    this.chatOpen = false;
    this.mapOpen = false;
    this.specTarget = 0;
    this.camPos = new THREE.Vector3();
    this.fov = 80;
    this.selfAvatar = null;
    this.stepTimer = 0;
    this.lastStormStage = null;
    this.fpsAcc = 0; this.fpsFrames = 0;

    this.bindUi();
    this.bindInput();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    window.__slr = this; // exposed for automated smoke tests
  }

  serverNow() { return this.clientTime + this.offset; }

  // ---------------------------------------------------------------- UI wiring

  bindUi() {
    $('name-input').value = store.get('name', '') ?? '';
    const prof = store.get('profile');
    if (prof) this.showProfile(prof);
    $('play-btn').onclick = () => { this.audio.unlock(); this.connect(); };
    $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('play-btn').click(); });
    $('menu-settings-btn').onclick = () => this.openSettings();
    $('menu-controls-btn').onclick = () => $('controls').classList.remove('hidden');
    $('pause-settings-btn').onclick = () => this.openSettings();
    $('pause-controls-btn').onclick = () => $('controls').classList.remove('hidden');
    $('controls-close').onclick = () => $('controls').classList.add('hidden');
    $('settings-close').onclick = () => { $('settings').classList.add('hidden'); };
    $('resume-btn').onclick = () => { $('pause').classList.add('hidden'); this.lock(); };
    $('leave-btn').onclick = () => this.leave();
    $('ready-btn').onclick = () => this.send({ t: 'ready', v: !this.roster.get(this.myId)?.ready });
    $('start-btn').onclick = () => this.send({ t: 'start' });
    $('lobby-play-btn').onclick = () => this.lock();
    $('bots-range').oninput = (e) => { $('bots-value').textContent = e.target.value; };
    $('bots-range').onchange = (e) => this.send({ t: 'settings', bots: Number(e.target.value) });
    $('team-select').onchange = (e) => this.send({ t: 'settings', teamSize: Number(e.target.value) });
    this.buildSettingsForm();
    window.addEventListener('error', (e) => this.showError(`Error: ${e.message}`));
    const params = new URLSearchParams(location.search);
    if (params.get('name')) $('name-input').value = params.get('name');
    if (params.get('autoplay')) setTimeout(() => this.connect(), 50);
  }

  buildSettingsForm() {
    const form = $('settings-form');
    form.innerHTML = '';
    for (const f of SETTINGS_SCHEMA) {
      const row = document.createElement('div');
      row.className = 'settings-row';
      if (f.check) {
        row.innerHTML = `<span>${f.label}</span><input type="checkbox" ${this.settings[f.key] ? 'checked' : ''}><output></output>`;
        row.querySelector('input').onchange = (e) => this.setSetting(f.key, e.target.checked);
      } else {
        row.innerHTML = `<span>${f.label}</span><input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${this.settings[f.key]}"><output>${this.settings[f.key]}</output>`;
        row.querySelector('input').oninput = (e) => { row.querySelector('output').textContent = e.target.value; this.setSetting(f.key, Number(e.target.value)); };
      }
      form.appendChild(row);
    }
  }

  setSetting(k, v) {
    this.settings[k] = v;
    store.set('settings', this.settings);
    if (k === 'volume') this.audio.setVolume(v);
    if (this.renderer && (k === 'shadows' || k === 'renderScale' || k === 'fov')) this.renderer.applySettings(this.settings);
    $('fps').classList.toggle('hidden', !this.settings.showFps);
  }

  openSettings() { $('settings').classList.remove('hidden'); }

  showProfile(p) {
    const s = p.stats;
    $('profile').innerHTML = `Level <b>${p.level}</b> · ${s.matches} matches · ${s.wins} wins · ${s.kills} eliminations`;
  }

  showError(text, dur = 6000) {
    const e = $('error');
    e.textContent = text;
    e.classList.remove('hidden');
    clearTimeout(this.errTimer);
    if (dur) this.errTimer = setTimeout(() => e.classList.add('hidden'), dur);
  }

  leave() {
    this.wantConnected = false;
    this.ws?.close();
    location.href = location.pathname;
  }

  // ---------------------------------------------------------------- networking

  connect() {
    const name = $('name-input').value.trim();
    store.set('name', name);
    this.wantConnected = true;
    $('menu-status').textContent = 'Connecting…';
    $('play-btn').disabled = true;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.reconnectTries = 0;
      this.seq = 0; this.pending = []; this.outBuf = []; this.havePred = false;
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, token: this.token }));
      $('error').classList.add('hidden');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      this.connected = false;
      $('play-btn').disabled = false;
      if (ev.code === 4002) { this.wantConnected = false; this.showError('You logged in from another tab or device.', 0); return; }
      if (ev.code === 4001) { this.wantConnected = false; return; }
      if (!this.wantConnected) return;
      if (this.phase === 'menu') { $('menu-status').textContent = 'Could not reach the server. Is it running?'; this.wantConnected = false; return; }
      if (this.reconnectTries++ < 20) {
        this.showError('Connection lost - reconnecting…', 0);
        setTimeout(() => { if (this.wantConnected) this.connect(); }, 1500);
      } else this.showError('Disconnected from server.', 0);
    };
  }

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  onMessage(m) {
    switch (m.t) {
      case 'welcome':
        this.token = m.token;
        store.set('token', m.token);
        store.set('profile', m.profile);
        this.profile = m.profile;
        this.showProfile(m.profile);
        break;
      case 'state': this.onState(m); break;
      case 's': this.onSnapshot(m); break;
      case 'inv': this.onInv(m); break;
      case 'roster': this.onRoster(m); break;
      case 'phase':
        this.phase = m.phase; this.phaseEnd = m.end;
        this.updateLobbyPanel();
        break;
      case 'settings': this.settingsLobby = m.s; this.updateLobbyPanel(); break;
      case 'storm': this.onStorm(m.s); break;
      case 'loot+': for (const l of m.l) this.addLoot(l); break;
      case 'loot-': for (const id of m.ids) this.removeLoot(id); break;
      case 'shot': this.onShot(m); break;
      case 'hit': this.onHit(m); break;
      case 'dmg': this.onDamaged(m); break;
      case 'kill': this.onKill(m); break;
      case 'dead': this.onDead(m); break;
      case 'end': this.onEnd(m); break;
      case 'chat': this.hud?.chat(m.n, m.m, m.id === 0); break;
      case 'notice': this.hud?.notice(m.m); break;
      case 'pong': {
        const rtt = this.clientTime - m.c;
        this.rtt = this.rtt * 0.7 + rtt * 0.3;
        const sample = m.s + rtt / 2 - this.clientTime;
        if (!this.offsetInit) { this.offset = sample; this.offsetInit = true; } else this.offset += (sample - this.offset) * 0.2;
        break;
      }
      case 'error': this.showError(m.m, 0); break;
      default: break;
    }
  }

  ensureWorld(seed) {
    if (this.world && this.seed === seed) return;
    if (this.renderer) { location.reload(); return; } // different map: simplest correct path is a fresh page
    this.seed = seed;
    this.world = createWorld(seed);
    this.renderer = new Renderer($('game'), this.world, this.settings);
    this.hud = new Hud(this.world);
    this.selfAvatar = new Avatar(0, '', { self: true });
    this.renderer.scene.add(this.selfAvatar.group);
    this.renderer.renderer.domElement.addEventListener('click', () => {
      this.audio.unlock();
      if (!this.locked && !this.anyScreenOpen()) this.lock();
      else if (this.locked && !this.alive && this.phase === 'live') this.cycleSpectate();
    });
    $('fps').classList.toggle('hidden', !this.settings.showFps);
  }

  onState(m) {
    this.ensureWorld(m.seed);
    this.myId = m.you;
    this.myTeam = m.team;
    this.phase = m.phase;
    this.phaseEnd = m.phaseEnd;
    this.host = m.host;
    this.settingsLobby = m.settings;
    this.spectator = m.spectator;
    this.alive = m.alive;
    if (!this.offsetInit) { this.offset = m.time - this.clientTime; this.offsetInit = true; }
    this.ship = m.ship;
    this.onStorm(m.storm, true);
    this.renderer.clearLoot();
    this.loot.clear();
    for (const l of m.loot) this.addLoot(l);
    for (const r of this.remotes.values()) { this.renderer.scene.remove(r.avatar.group); r.avatar.dispose(); }
    this.remotes.clear();
    this.havePred = false;
    this.pending = [];
    this.kills = 0;
    $('menu').classList.add('hidden');
    $('death').classList.add('hidden');
    if (m.phase !== 'ended') $('results').classList.add('hidden');
    this.hud.show(true);
    if (m.phase === 'ended' && m.results) this.showResults({ winners: m.results.winners, standings: m.results.standings, you: null, next: m.phaseEnd });
    if (this.spectator) this.hud.notice('Match in progress - spectating until the next round', 4);
    this.updateLobbyPanel();
    if (m.phase === 'live' && !this.spectator) this.hud.notice('Press SPACE to jump from the airship', 4);
  }

  onSnapshot(m) {
    this.lastSnapAt = this.clientTime;
    const sample = m.tm + this.rtt / 2 - this.clientTime;
    if (!this.offsetInit) { this.offset = sample; this.offsetInit = true; }
    else this.offset += (sample - this.offset) * 0.02;

    this.hp = m.hp; this.sh = m.sh; this.kills = m.k; this.aliveCount = m.n;
    if (m.me) {
      const [x, y, z, vx, vy, vz, g, c, mode] = m.me;
      const bx = this.pred.x, by = this.pred.y, bz = this.pred.z;
      Object.assign(this.pred, { x, y, z, vx, vy, vz, g: !!g, c: !!c, m: mode });
      this.pending = this.pending.filter((p) => p[0] > m.a);
      if (mode !== MODE.SHIP) for (const p of this.pending) stepMove(this.pred, p[1], p[2], INPUT_DT, this.world);
      if (this.havePred) {
        const ex = bx - this.pred.x, ey = by - this.pred.y, ez = bz - this.pred.z;
        if (ex * ex + ey * ey + ez * ez < 9 && mode !== MODE.SHIP) this.smooth.x += ex, this.smooth.y += ey, this.smooth.z += ez;
        else this.smooth.set(0, 0, 0);
      }
      this.havePred = true;
      this.alive = true;
    }
    const seen = new Set();
    for (const e of m.p) {
      const [id, x, y, z, yaw, pitch, flags, w, team] = e;
      if (id === this.myId) continue;
      seen.add(id);
      let r = this.remotes.get(id);
      if (!r) {
        const info = this.roster.get(id);
        const teammate = this.phase === 'live' && this.myTeam !== 0 && team === this.myTeam;
        r = { id, buf: [], avatar: new Avatar(id, info?.name ?? `Player ${id}`, { teammate }), missing: 0, step: 0 };
        this.renderer.scene.add(r.avatar.group);
        this.remotes.set(id, r);
      }
      r.missing = 0;
      r.buf.push({ t: m.tm, x, y, z, yaw, pitch, flags, w });
      if (r.buf.length > 30) r.buf.shift();
    }
    for (const [id, r] of this.remotes) {
      if (seen.has(id)) continue;
      if (++r.missing > 3) { this.renderer.scene.remove(r.avatar.group); r.avatar.dispose(); this.remotes.delete(id); }
    }
    if (m.tmt) this.teammates = m.tmt;
  }

  onInv(m) {
    this.inv = { slots: m.slots, active: m.active, ammo: m.ammo };
    const wasReloading = !!this.reload;
    this.reload = m.reload;
    this.use = m.use;
    if (this.reload && !wasReloading) this.audio.reload();
    this.hud?.setInventory(this.inv);
  }

  onRoster(m) {
    this.host = m.host;
    this.roster = new Map(m.players.map((p) => [p.id, p]));
    const me = this.roster.get(this.myId);
    if (me) this.myTeam = me.team;
    this.updateLobbyPanel();
    if (!$('scoreboard').classList.contains('hidden')) this.renderScoreboard();
  }

  onStorm(s, silent = false) {
    this.storm = s && s.active ? {
      stage: s.stage, phase: s.phase, phases: s.phases,
      from: { x: s.from[0], z: s.from[1], r: s.from[2] }, to: { x: s.to[0], z: s.to[1], r: s.to[2] },
      start: s.start, end: s.end, dps: s.dps,
    } : null;
    if (!silent && this.storm && this.storm.stage !== this.lastStormStage) {
      if (this.storm.stage === 'shrink') { this.hud.notice('The storm is closing in!'); this.audio.stormWarning(); }
      else if (this.storm.stage === 'wait') this.hud.notice(`Storm phase ${this.storm.phase + 1}: new safe zone marked on the map`);
    }
    this.lastStormStage = this.storm?.stage ?? null;
  }

  stormCircle(t) {
    const s = this.storm;
    if (!s) return null;
    if (s.stage !== 'shrink') return s.from;
    const k = Math.min(1, Math.max(0, (t - s.start) / (s.end - s.start)));
    return { x: s.from.x + (s.to.x - s.from.x) * k, z: s.from.z + (s.to.z - s.from.z) * k, r: s.from.r + (s.to.r - s.from.r) * k };
  }

  shipPos(t) {
    const s = this.ship;
    if (!s) return null;
    const d = (t - s.start) * s.speed;
    if (d > s.len + 30) return null;
    return { x: s.sx + s.dx * Math.min(d, s.len), z: s.sz + s.dz * Math.min(d, s.len) };
  }

  addLoot(w) {
    const [id, x, y, z, item] = w;
    const l = { id, x, y, z, item };
    this.loot.set(id, l);
    this.renderer.addLoot(l);
  }

  removeLoot(id) { this.loot.delete(id); this.renderer?.removeLoot(id); }

  // ---------------------------------------------------------------- combat feedback

  onShot(m) {
    const r = this.remotes.get(m.id);
    const from = new THREE.Vector3();
    if (r) r.avatar.muzzleWorld(from); else from.set(...m.o);
    this.renderer.flash(from);
    for (const e of m.e) {
      const to = new THREE.Vector3(e[0], e[1], e[2]);
      this.renderer.tracer(from, to);
      if (!e[3]) this.renderer.puff(to);
    }
    this.audio.shot(m.w, m.o);
  }

  onHit(m) {
    this.hud.hitmarker(m.k ? 'kill' : m.hs ? 'head' : m.sh ? 'shield' : 'body');
    this.hud.floater(String(m.d), m.hs ? '#ffcf3f' : m.sh ? '#7fd4ff' : '#ffffff', m.at[0], m.at[1] + 0.4, m.at[2]);
    this.audio.hit(m.hs, m.sh);
    if (m.k) this.audio.kill();
  }

  onDamaged(m) {
    this.audio.hurt();
    if (m.from) {
      const dx = m.from[0] - this.pred.x, dz = m.from[1] - this.pred.z;
      const ang = Math.atan2(-dx, -dz); // world yaw toward the source
      this.hud.damageFrom(-(ang - this.yaw));
    } else if (m.cause === 'fall') this.hud.notice(`Fall damage -${m.d}`, 1.2);
  }

  onKill(m) {
    this.hud.killfeed(m, this.myId);
    if (m.kid === this.myId && m.vid !== this.myId) this.hud.notice(`ELIMINATED ${m.v}`, 2);
  }

  onDead(m) {
    this.alive = false;
    this.havePred = false;
    const how = m.by ? `Eliminated by <b>${esc(m.by)}</b>` : m.cause === 'storm' ? 'Consumed by the storm' : m.cause === 'fall' ? 'Fell to your death' : 'Eliminated';
    $('death-detail').innerHTML = how;
    $('death-place').textContent = m.placement ? `#${m.placement}` : '';
    $('death').classList.remove('hidden');
    this.specTarget = m.byId && this.remotes.has(m.byId) ? m.byId : 0;
    this.audio.defeat();
  }

  onEnd(m) {
    $('death').classList.add('hidden');
    this.showResults(m);
    if (m.you && m.you.placement === 1) this.audio.victory();
    if (document.pointerLockElement) document.exitPointerLock();
    if (m.you?.stats) {
      const prof = { ...(this.profile ?? {}), level: m.you.level, stats: m.you.stats };
      store.set('profile', prof);
      this.showProfile(prof);
    }
  }

  showResults(m) {
    this.phase = 'ended';
    this.phaseEnd = m.next;
    const you = m.you;
    const win = you && you.placement === 1;
    $('results-title').textContent = win ? 'LAST LEGEND STANDING' : you ? `#${you.placement} PLACE` : 'MATCH OVER';
    $('results-title').className = win ? 'win' : '';
    $('results-sub').textContent = `Winner${m.winners.length > 1 ? 's' : ''}: ${m.winners.join(', ')}`;
    $('results-stats').innerHTML = you ? [
      ['PLACEMENT', `#${you.placement}`], ['ELIMINATIONS', you.kills], ['DAMAGE', you.damage], ['SURVIVED', fmtTime(you.survived)],
      ...(you.xp != null ? [['XP EARNED', `+${you.xp}`], ['LEVEL', you.level]] : []),
    ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('') : '';
    $('results-table').innerHTML = '<tr><th>#</th><th>PLAYER</th><th>ELIMS</th><th>DAMAGE</th><th>SURVIVED</th></tr>'
      + m.standings.map((s) => `<tr class="${s.id === this.myId ? 'me' : ''}"><td>${s.placement}</td><td>${esc(s.name)}</td><td>${s.kills}</td><td>${s.damage}</td><td>${fmtTime(s.survived)}</td></tr>`).join('');
    $('results').classList.remove('hidden');
  }

  // ---------------------------------------------------------------- lobby / scoreboard

  updateLobbyPanel() {
    const inLobby = this.phase === 'lobby' || this.phase === 'countdown';
    $('lobby').classList.toggle('hidden', !inLobby || this.locked);
    $('topright').style.visibility = inLobby && !this.locked ? 'hidden' : '';
    if (!inLobby) return;
    $('lobby-phase').textContent = this.phase === 'countdown' ? 'starting…' : `${this.roster.size} connected`;
    const rows = [...this.roster.values()].filter((p) => !p.bot).map((p) => `<div class="roster-row"><span>${esc(p.name)}${p.level ? ` <span class="hint">Lv ${p.level}</span>` : ''}${p.id === this.myId ? ' <span class="hint">(you)</span>' : ''}</span>
      <span>${p.host ? '<span class="tag host">LEADER</span> ' : ''}<span class="tag ${p.ready ? 'ready' : ''}">${p.ready ? 'READY' : 'NOT READY'}</span></span></div>`);
    if (this.settingsLobby.bots) rows.push(`<div class="roster-row"><span class="hint">+ up to ${this.settingsLobby.bots} bots</span><span class="tag">BOTS</span></div>`);
    $('lobby-roster').innerHTML = rows.join('');
    const isHost = this.host === this.myId;
    $('lobby-host').classList.toggle('hidden', !isHost || this.phase !== 'lobby');
    $('lobby-guest').classList.toggle('hidden', isHost);
    $('bots-range').value = this.settingsLobby.bots;
    $('bots-value').textContent = this.settingsLobby.bots;
    $('team-select').value = String(this.settingsLobby.teamSize);
    const ready = this.roster.get(this.myId)?.ready;
    $('ready-btn').textContent = ready ? 'READY ✓' : 'READY';
    $('ready-btn').classList.toggle('on', !!ready);
  }

  renderScoreboard() {
    const rows = [...this.roster.values()].filter((p) => this.phase !== 'live' || p.participant)
      .sort((a, b) => (b.alive - a.alive) || a.team - b.team);
    $('scoreboard-table').innerHTML = '<tr><th>PLAYER</th><th>TEAM</th><th>STATUS</th></tr>' + rows.map((p) =>
      `<tr class="${p.id === this.myId ? 'me' : ''}"><td>${esc(p.name)}</td><td>${p.team || '–'}</td><td>${p.alive ? 'Alive' : 'Eliminated'}${p.conn ? '' : ' (offline)'}</td></tr>`).join('');
  }

  anyScreenOpen() {
    return ['menu', 'pause', 'settings', 'controls', 'results'].some((id) => !$(id).classList.contains('hidden'));
  }

  // ---------------------------------------------------------------- input

  lock() {
    const el = this.renderer?.renderer.domElement;
    if (!el) return;
    try {
      const p = el.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch { /* pointer lock not available */ }
  }

  bindInput() {
    document.addEventListener('pointerlockchange', () => {
      this.locked = !!document.pointerLockElement;
      if (!this.locked) { this.firing = false; this.aiming = false; this.keys.clear(); }
      if (!this.locked && this.phase === 'live' && !this.anyScreenOpen() && !this.chatOpen) $('pause').classList.remove('hidden');
      if (this.locked) $('pause').classList.add('hidden');
      this.updateLobbyPanel();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      let k = 0.0022 * this.settings.sens;
      if (this.aiming) k *= this.settings.adsSens * (this.fov / this.settings.fov);
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k * (this.settings.invertY ? -1 : 1);
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.firing = true; this.trigger = true; }
      if (e.button === 2) this.aiming = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
      if (e.button === 2) this.aiming = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => {
      if (!this.locked || !this.inv) return;
      const dir = Math.sign(e.deltaY);
      this.selectSlot((this.inv.active + dir + INVENTORY_SLOTS) % INVENTORY_SLOTS);
    });
    window.addEventListener('keydown', (e) => {
      if (this.chatOpen) {
        if (e.key === 'Enter') { const v = $('chat-input').value.trim(); if (v) this.send({ t: 'c', m: v }); this.closeChat(); }
        else if (e.key === 'Escape') this.closeChat();
        return;
      }
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (e.code === 'Tab') { e.preventDefault(); if (this.hud) { this.renderScoreboard(); $('scoreboard').classList.remove('hidden'); } return; }
      if (!this.hud) return;
      if (e.code === 'Enter') { this.openChat(); e.preventDefault(); return; }
      if (e.code === 'KeyM') { this.mapOpen = !this.mapOpen; $('bigmap').classList.toggle('hidden', !this.mapOpen); return; }
      if (!this.locked) return;
      this.keys.add(e.code);
      if (e.code === 'Space') { this.jumpLatch = true; e.preventDefault(); }
      if (e.code === 'KeyR') this.send({ t: 'r' });
      if (e.code === 'KeyE') this.tryPickup();
      if (e.code === 'KeyG' && this.inv) this.send({ t: 'dr', i: this.inv.active });
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5)) - 1;
        if (n >= 0 && n < INVENTORY_SLOTS) this.selectSlot(n);
      }
      if (e.ctrlKey && e.code !== 'ControlLeft') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab') $('scoreboard').classList.add('hidden');
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.firing = false; });
  }

  selectSlot(i) {
    if (!this.inv || this.inv.active === i) return;
    this.inv.active = i; // optimistic; the server confirms with an inventory update
    this.reload = null; this.use = null;
    this.hud.setInventory(this.inv);
    this.audio.click();
    this.send({ t: 'sl', i });
  }

  openChat() {
    this.chatOpen = true;
    this.keys.clear(); this.firing = false;
    const input = $('chat-input');
    input.classList.remove('hidden');
    input.value = '';
    if (document.pointerLockElement) document.exitPointerLock();
    setTimeout(() => input.focus(), 0);
  }

  closeChat() {
    this.chatOpen = false;
    const input = $('chat-input');
    input.blur();
    input.classList.add('hidden');
    $('pause').classList.add('hidden');
    this.lock();
  }

  sampleBits() {
    if (!this.locked) return this.jumpLatch ? IN.JUMP : 0;
    const k = this.keys;
    let b = 0;
    if (k.has('KeyW')) b |= IN.FWD;
    if (k.has('KeyS')) b |= IN.BACK;
    if (k.has('KeyA')) b |= IN.LEFT;
    if (k.has('KeyD')) b |= IN.RIGHT;
    if (k.has('Space') || this.jumpLatch) b |= IN.JUMP;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) b |= IN.SPRINT;
    if (k.has('KeyC') || k.has('ControlLeft')) b |= IN.CROUCH;
    if (this.aiming) b |= IN.AIM;
    return b;
  }

  nearestLoot() {
    if (!this.alive || this.pred.m !== MODE.GROUND) return null;
    let best = null, bd = PICKUP_RANGE;
    for (const l of this.loot.values()) {
      const d = Math.hypot(l.x - this.pred.x, l.z - this.pred.z);
      if (d < bd && Math.abs(l.y - this.pred.y) < 2.5) { bd = d; best = l; }
    }
    return best;
  }

  tryPickup() {
    const l = this.nearestLoot();
    if (l) { this.send({ t: 'p', id: l.id }); this.audio.pickup(); }
  }

  // Camera-ray aim point, including other players so close targets are not shot "past".
  aimPoint() {
    const cam = this.renderer.camera;
    const o = cam.position;
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    let t = this.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 600).t;
    const box = new THREE.Box3(), ray = new THREE.Ray(o.clone(), d.clone()), hit = new THREE.Vector3();
    for (const r of this.remotes.values()) {
      const p = r.avatar.group.position;
      box.min.set(p.x - 0.45, p.y, p.z - 0.45);
      box.max.set(p.x + 0.45, p.y + 1.85, p.z + 0.45);
      if (ray.intersectBox(box, hit)) { const tt = hit.distanceTo(o); if (tt < t) t = tt; }
    }
    return { point: o.clone().addScaledVector(d, t), camDir: d };
  }

  tryFire() {
    this.trigger = this.trigger && this.firing;
    if (!this.alive || this.phase !== 'live' || this.pred.m !== MODE.GROUND || !this.locked || !this.inv) { this.trigger = false; return; }
    const slot = this.inv.slots[this.inv.active];
    if (!slot) { this.trigger = false; return; }
    if (slot.kind === 'item') {
      if (this.trigger && !this.use) this.send({ t: 'u' });
      this.trigger = false;
      return;
    }
    const W = WEAPONS[slot.type];
    if (!W.auto && !this.trigger) return;
    if (this.clientTime < this.nextFire) return;
    this.trigger = false;
    if (slot.mag <= 0) {
      this.audio.empty();
      if (!this.reload) this.send({ t: 'r' });
      this.nextFire = this.clientTime + 0.35;
      return;
    }
    this.nextFire = this.clientTime + 60 / W.rpm;
    const { point, camDir } = this.aimPoint();
    const eye = new THREE.Vector3(this.pred.x, this.pred.y + eyeHeight(this.pred), this.pred.z);
    const dir = point.clone().sub(eye);
    if (dir.length() < 1.5) dir.copy(camDir); else dir.normalize();
    if (dir.dot(camDir) < 0.7) dir.copy(camDir);
    this.send({ t: 'f', d: [r4(dir.x), r4(dir.y), r4(dir.z)], rt: Math.round((this.serverNow() - INTERP_DELAY) * 1000) / 1000 });
    slot.mag--;
    this.reload = null; this.use = null;
    this.hud.setInventory(this.inv);
    // Local cosmetic feedback (the server decides hits)
    const muzzle = this.selfAvatar.muzzleWorld(new THREE.Vector3());
    this.renderer.flash(muzzle);
    const spread = this.aiming ? W.aimSpread : W.spread;
    for (let i = 0; i < Math.min(W.pellets, 6); i++) {
      const p = point.clone();
      if (W.pellets > 1) { const dist = p.distanceTo(muzzle); p.x += (Math.random() - 0.5) * spread * dist * 2; p.y += (Math.random() - 0.5) * spread * dist * 2; p.z += (Math.random() - 0.5) * spread * dist * 2; }
      this.renderer.tracer(muzzle, p);
    }
    this.audio.shot(slot.type, null);
    const kick = RECOIL[slot.type] * (this.aiming ? 0.6 : 1);
    this.pitch = Math.min(1.45, this.pitch + kick);
    this.yaw += (Math.random() - 0.5) * kick * 0.6;
  }

  cycleSpectate() {
    const ids = [...this.remotes.keys()];
    if (!ids.length) return;
    const i = ids.indexOf(this.specTarget);
    this.specTarget = ids[(i + 1) % ids.length];
  }

  // ---------------------------------------------------------------- frame

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clientTime += dt;
    if (!this.renderer) return;
    try { this.update(dt); } catch (e) { console.error(e); this.showError(`Frame error: ${e.message}`); }
  }

  update(dt) {
    const sNow = this.serverNow();
    // Fixed-step input sampling + local prediction
    const controlling = this.connected && this.alive && this.havePred && this.phase !== 'ended';
    if (controlling) {
      this.inputAcc += dt;
      while (this.inputAcc >= INPUT_DT) {
        this.inputAcc -= INPUT_DT;
        const bits = this.sampleBits();
        const cmd = [++this.seq, bits, r4(this.yaw), r4(this.pitch)];
        this.pending.push(cmd);
        this.outBuf.push(cmd);
        if (this.pred.m !== MODE.SHIP) stepMove(this.pred, bits, cmd[2], INPUT_DT, this.world);
        this.jumpLatch = false;
      }
      if (this.pending.length > 120) this.pending.splice(0, this.pending.length - 120);
    } else this.inputAcc = 0;
    if (this.outBuf.length && (this.clientTime - this.lastSend > 1 / 30 || this.outBuf.length >= 8)) {
      while (this.outBuf.length) this.send({ t: 'in', i: this.outBuf.splice(0, 16) });
      this.lastSend = this.clientTime;
    }
    if (this.connected && this.clientTime - this.lastPing > 2) { this.lastPing = this.clientTime; this.send({ t: 'ping', c: this.clientTime }); }

    if (this.firing || this.trigger) this.tryFire();

    // Smoothly decay prediction corrections
    this.smooth.multiplyScalar(Math.max(0, 1 - dt * 12));

    // Remote players (interpolated in the past)
    const rt = sNow - INTERP_DELAY;
    for (const r of this.remotes.values()) {
      const b = r.buf;
      if (!b.length) continue;
      let a = b[0], c = b[b.length - 1], k = 0;
      if (rt <= a.t) c = a;
      else if (rt >= c.t) a = c;
      else for (let i = b.length - 1; i > 0; i--) if (b[i - 1].t <= rt) { a = b[i - 1]; c = b[i]; k = (rt - a.t) / (c.t - a.t || 1); break; }
      let dyaw = c.yaw - a.yaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      const x = a.x + (c.x - a.x) * k, y = a.y + (c.y - a.y) * k, z = a.z + (c.z - a.z) * k;
      r.avatar.setWeapon(c.w, WEAPON_TYPES);
      r.avatar.update(dt, x, y, z, a.yaw + dyaw * k, a.pitch + (c.pitch - a.pitch) * k, c.flags);
      if ((c.flags & 2) && r.avatar.speed > 2) {
        r.step -= dt * (r.avatar.speed / 5);
        if (r.step <= 0) { r.step = 0.38; this.audio.footstep([x, y, z], (c.flags & 1) ? 0.4 : 1); }
      }
    }

    // Self avatar
    const p = this.pred;
    const vis = { x: p.x + this.smooth.x, y: p.y + this.smooth.y, z: p.z + this.smooth.z };
    const showSelf = this.alive && this.havePred && p.m !== MODE.SHIP;
    this.selfAvatar.group.visible = showSelf;
    const slot = this.inv?.slots[this.inv.active];
    if (showSelf) {
      this.selfAvatar.setWeapon(slot && slot.kind === 'weapon' ? WEAPON_TYPES.indexOf(slot.type) * 8 + slot.rarity : -1, WEAPON_TYPES);
      this.selfAvatar.update(dt, vis.x, vis.y, vis.z, this.yaw, this.pitch, (p.c ? 1 : 0) | (p.g ? 2 : 0) | (p.m === MODE.GLIDE ? 32 : 0));
      if (p.g && Math.hypot(p.vx, p.vz) > 2) {
        this.stepTimer -= dt * Math.hypot(p.vx, p.vz) / 5;
        if (this.stepTimer <= 0) { this.stepTimer = 0.38; this.audio.footstep(null, p.c ? 0.3 : 0.6); }
      }
    }

    // Camera
    const shipPos = this.shipPos(sNow);
    this.renderer.setShip(this.phase === 'live' ? shipPos : null, this.ship ? { x: this.ship.dx, z: this.ship.dz } : null);
    const W = slot && slot.kind === 'weapon' ? WEAPONS[slot.type] : null;
    const canAim = this.aiming && showSelf && p.m === MODE.GROUND && W;
    const scoped = canAim && W.scope;
    let focus, dist = 3.4, shoulder = 0.65, headY;
    if (showSelf) {
      focus = vis;
      headY = eyeHeight(p) + 0.15;
      if (p.m === MODE.GLIDE) dist = 7;
      if (canAim) { dist = 1.5; shoulder = 0.55; }
    } else if (this.alive && p.m === MODE.SHIP && shipPos) {
      focus = { x: shipPos.x, y: SHIP.altitude, z: shipPos.z };
      headY = 2; dist = 30; shoulder = 0;
    } else {
      let target = this.remotes.get(this.specTarget);
      if (!target && this.remotes.size) { this.specTarget = this.remotes.keys().next().value; target = this.remotes.get(this.specTarget); }
      focus = target ? target.avatar.group.position : (this.havePred ? vis : { x: -70, y: 10, z: -45 });
      headY = 1.8; dist = 5; shoulder = 0;
    }
    const targetFov = canAim ? W.aimFov : this.settings.fov;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 14);
    const cam = this.renderer.camera;
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    const cp = Math.cos(this.pitch);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const head = new THREE.Vector3(focus.x, focus.y + headY, focus.z);
    let camPos;
    if (scoped) {
      camPos = head.clone();
      this.selfAvatar.group.visible = false;
    } else {
      const pivot = head.clone().addScaledVector(right, shoulder);
      const want = pivot.clone().addScaledVector(fwd, -dist);
      const seg = want.clone().sub(head);
      const len = seg.length();
      seg.normalize();
      const hit = this.world.raycast(head.x, head.y, head.z, seg.x, seg.y, seg.z, len + 0.3);
      camPos = hit.t < len + 0.3 ? head.clone().addScaledVector(seg, Math.max(0.2, hit.t - 0.3)) : want;
    }
    cam.position.copy(camPos);
    cam.rotation.set(this.pitch, this.yaw, 0);
    this.audio.listener = { x: camPos.x, y: camPos.y, z: camPos.z, yaw: this.yaw };

    const circle = this.phase === 'live' ? this.stormCircle(sNow) : null;
    this.renderer.setStorm(circle, this.clientTime);
    this.renderer.render(dt, this.clientTime, focus);
    this.updateHud(dt, sNow, circle, shipPos, vis, scoped);
  }

  updateHud(dt, sNow, circle, shipPos, vis, scoped) {
    const hud = this.hud;
    const p = this.pred;
    hud.setVitals(this.alive ? this.hp : 0, this.alive ? this.sh : 0);
    hud.setCounters(this.aliveCount, this.kills);
    hud.setCompass(this.yaw);
    $('scope').classList.toggle('hidden', !scoped);
    $('crosshair').style.opacity = scoped || !this.alive ? '0' : '1';
    const slot = this.inv?.slots[this.inv.active];
    if (slot && slot.kind === 'weapon') {
      const W = WEAPONS[slot.type];
      const gap = 4 + (this.aiming ? W.aimSpread : W.spread) * 260 + (Math.hypot(p.vx, p.vz) > 1 && !this.aiming ? 6 : 0);
      const c = $('crosshair').children;
      c[0].style.top = `${-gap - 8}px`; c[1].style.top = `${gap}px`; c[2].style.left = `${-gap - 8}px`; c[3].style.left = `${gap}px`;
    }

    // Banner + phase info
    let banner = '';
    if (this.phase === 'lobby') {
      const humans = [...this.roster.values()].filter((r) => !r.bot);
      banner = `WARM-UP LOBBY · ${humans.filter((h) => h.ready).length}/${humans.length} ready${this.locked ? ' · Esc for lobby menu' : ''}`;
    } else if (this.phase === 'countdown') {
      const left = Math.ceil(this.phaseEnd - sNow);
      banner = `MATCH STARTS IN ${Math.max(0, left)}`;
      if (left !== this.lastBeep && left <= 5 && left >= 0) { this.lastBeep = left; this.audio.beep(left === 0); }
    } else if (this.phase === 'live') {
      if (this.spectator) banner = 'SPECTATING · you will join the next match';
      else if (this.alive && p.m === MODE.SHIP) {
        const s = this.ship;
        const left = s ? (s.len - (sNow - s.start) * s.speed) / s.speed : 0;
        banner = `Press <b>SPACE</b> to jump · auto-drop in ${fmtTime(left)}`;
      } else if (this.alive && p.m === MODE.GLIDE) banner = 'GLIDING · steer with WASD · hold C to dive';
      else if (!this.alive) {
        const t = this.remotes.get(this.specTarget);
        banner = t ? `SPECTATING ${esc(this.roster.get(this.specTarget)?.name ?? '')}` : 'ELIMINATED';
      }
    }
    if (!this.locked && this.phase !== 'ended' && !this.anyScreenOpen() && this.phase !== 'lobby' && this.phase !== 'countdown') banner = 'Click to play';
    if (!this.locked && (this.phase === 'lobby' || this.phase === 'countdown')) banner += ' · <b>click the world</b> to move around';
    hud.setBanner(banner);

    // Storm
    let stormHtml = '';
    const outside = circle && this.alive && Math.hypot(vis.x - circle.x, vis.z - circle.z) > circle.r && p.m !== MODE.SHIP;
    if (this.storm && this.phase === 'live') {
      const s = this.storm;
      if (s.stage === 'wait') stormHtml = `<span class="storm">STORM ${s.phase + 1}/${s.phases}</span> · shrinks in ${fmtTime(s.end - sNow)}`;
      else if (s.stage === 'shrink') stormHtml = `<span class="storm">STORM CLOSING</span> · ${fmtTime(s.end - sNow)}`;
      else stormHtml = '<span class="storm">FINAL ZONE</span>';
      if (outside) stormHtml += `<br><span style="color:#ff9ad6">IN THE STORM · -${s.dps}/s</span>`;
    }
    hud.setStormInfo(stormHtml);
    $('stormtint').style.opacity = outside ? '1' : '0';

    const stale = this.connected && this.clientTime - this.lastSnapAt > 1.5 && this.lastSnapAt > 0;
    hud.setNet(this.rtt * 1000, stale || !this.connected);

    // Interaction prompt + progress
    const l = this.nearestLoot();
    hud.setPrompt(l && this.phase === 'live' ? `Pick up ${lootLabel(l.item)}` : null);
    if (this.reload) hud.setProgress('Reloading', (sNow - this.reload[0]) / (this.reload[1] - this.reload[0]));
    else if (this.use) hud.setProgress(`Using ${CONSUMABLES[this.use[2]].name}`, (sNow - this.use[0]) / (this.use[1] - this.use[0]));
    else hud.setProgress(null);

    // Teammates
    hud.setTeammates(this.phase === 'live' ? this.teammates : null, new Map([...this.roster.values()].map((r) => [r.id, r.name])));

    // Maps
    const teammates = [];
    for (const r of this.remotes.values()) {
      if (this.myTeam && this.roster.get(r.id)?.team === this.myTeam && this.phase === 'live') teammates.push(r.avatar.group.position);
    }
    const mapView = {
      x: vis.x, z: vis.z, yaw: this.yaw, self: this.alive,
      storm: circle ? { cur: circle, next: this.storm?.stage !== 'done' ? this.storm.to : null } : null,
      ship: this.phase === 'live' && shipPos ? this.ship : null, shipPos, teammates,
    };
    if (!this.alive && this.remotes.get(this.specTarget)) { const sp = this.remotes.get(this.specTarget).avatar.group.position; mapView.x = sp.x; mapView.z = sp.z; }
    if (p.m === MODE.SHIP && shipPos && this.alive) { mapView.x = shipPos.x; mapView.z = shipPos.z; }
    hud.drawMinimap(mapView);
    if (this.mapOpen) hud.drawBigMap(mapView);

    hud.update(dt, (x, y, z) => this.renderer.project(x, y, z));

    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      $('fps').textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} FPS · ${this.renderer.renderer.info.render.calls} draws`;
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
  }
}

function lootLabel(item) {
  if (item.kind === 'weapon') return `${RARITIES[item.rarity].name} ${WEAPONS[item.type].name}`;
  if (item.kind === 'item') return `${CONSUMABLES[item.type].name} ×${item.count}`;
  return `${item.type[0].toUpperCase()}${item.type.slice(1)} ammo ×${item.count}`;
}

new Game();
