// DOM-based HUD: vitals, hotbar, minimap, compass, killfeed, prompts and feedback.

import { MAP_SIZE, WATER_LEVEL, WEAPONS, CONSUMABLES, AMMO, RARITIES, INVENTORY_SLOTS } from '/shared/config.js';
import { BIOMES, POIS } from '/shared/world.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SHORT = { pistol: 'P9', smg: 'SMG', ar: 'AR', shotgun: 'SG', sniper: 'DMR' };

export function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Hud {
  constructor(world) {
    this.world = world;
    this.mapImage = this.renderMapImage();
    this.floaters = [];
    this.noticeTimer = 0;
    this.hitTimer = 0;
    this.chatLines = [];
    this.buildCompass();
    this.buildHotbar();
  }

  show(v) { $('hud').classList.toggle('hidden', !v); }

  renderMapImage() {
    const N = MAP_SIZE;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    const half = N / 2;
    for (let pz = 0; pz < N; pz++) for (let px = 0; px < N; px++) {
      const x = px - half + 0.5, z = pz - half + 0.5;
      const h = this.world.heightAt(x, z);
      const b = BIOMES[this.world.biomeAt(x, z)];
      let [r, gg, bb] = b.ground;
      const shade = 0.75 + Math.max(-0.25, Math.min(0.35, (h - this.world.heightAt(x + 1, z - 1)) * 0.6));
      r *= shade; gg *= shade; bb *= shade;
      if (h < WATER_LEVEL) { r = 0.16; gg = 0.42; bb = 0.62; }
      const i = (pz * N + px) * 4;
      img.data[i] = r * 255; img.data[i + 1] = gg * 255; img.data[i + 2] = bb * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    g.fillStyle = 'rgba(40,40,50,0.85)';
    for (const b of this.world.boxes) {
      if (b.k !== 'roof' && b.k !== 'container' && b.k !== 'ruin') continue;
      g.fillRect(b.minX + half, b.minZ + half, b.maxX - b.minX, b.maxZ - b.minZ);
    }
    return c;
  }

  buildCompass() {
    const strip = $('compass-strip');
    const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let rep = 0; rep < 3; rep++) for (let d = 0; d < 360; d += 15) {
      const l = labels[d];
      html += l ? `<span class="card">${l}</span>` : `<span>${d % 45 === 0 ? d : '·'}</span>`;
    }
    strip.innerHTML = html;
  }

  setCompass(yaw) {
    // yaw 0 faces -Z (north on our map). Heading increases clockwise.
    let heading = (-yaw * 180) / Math.PI;
    heading = ((heading % 360) + 360) % 360;
    const px = (heading / 15) * 30 + 360 / 15 * 30; // middle repetition
    const w = $('compass').clientWidth;
    $('compass-strip').style.transform = `translateX(${w / 2 - px - 15}px)`;
  }

  buildHotbar() {
    const hb = $('hotbar');
    hb.innerHTML = '';
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const d = document.createElement('div');
      d.className = 'slot';
      d.innerHTML = `<span class="key">${i + 1}</span><span class="count"></span><span class="icon"></span><span class="label"></span><span class="rar"></span>`;
      hb.appendChild(d);
    }
  }

  setInventory(inv, reload, use, now) {
    const slots = $('hotbar').children;
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const s = inv?.slots[i];
      const el = slots[i];
      el.classList.toggle('active', inv?.active === i);
      const icon = el.querySelector('.icon'), label = el.querySelector('.label'), count = el.querySelector('.count'), rar = el.querySelector('.rar');
      if (!s) { icon.textContent = ''; label.textContent = ''; count.textContent = ''; rar.style.background = 'transparent'; el.style.borderColor = ''; continue; }
      if (s.kind === 'weapon') {
        icon.textContent = SHORT[s.type];
        label.textContent = WEAPONS[s.type].name.split(' ')[0];
        count.textContent = s.mag;
        rar.style.background = RARITIES[s.rarity].color;
      } else {
        const c = CONSUMABLES[s.type];
        icon.textContent = c.heal ? '✚' : '◆';
        icon.style.color = c.color;
        label.textContent = c.name;
        count.textContent = s.count;
        rar.style.background = c.color;
      }
    }
    const cur = inv?.slots[inv.active];
    if (cur && cur.kind === 'weapon') {
      const W = WEAPONS[cur.type];
      $('ammo-mag').textContent = cur.mag;
      $('ammo-mag').style.color = cur.mag === 0 ? 'var(--danger)' : '';
      $('ammo-reserve').textContent = `${inv.ammo[W.ammo]} ${AMMO[W.ammo].name}`;
      $('weapon-name').textContent = `${RARITIES[cur.rarity].name} ${W.name}`;
      $('weapon-name').style.color = RARITIES[cur.rarity].color;
    } else if (cur) {
      $('ammo-mag').textContent = cur.count;
      $('ammo-mag').style.color = '';
      $('ammo-reserve').textContent = 'Left click to use';
      $('weapon-name').textContent = CONSUMABLES[cur.type].name;
      $('weapon-name').style.color = CONSUMABLES[cur.type].color;
    } else {
      $('ammo-mag').textContent = '–';
      $('ammo-reserve').textContent = '';
      $('weapon-name').textContent = '';
    }
  }

  setProgress(label, frac) {
    const el = $('progress');
    if (label == null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    $('progress-label').textContent = label;
    $('progress-bar').firstElementChild.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
  }

  setVitals(hp, sh) {
    $('health-fill').style.width = `${hp}%`;
    $('health-text').textContent = hp;
    $('shield-fill').style.width = `${sh}%`;
    $('shield-text').textContent = sh;
    $('vignette').style.opacity = hp > 0 && hp < 30 ? String(0.6 * (1 - hp / 30) + 0.2) : '0';
  }

  setCounters(alive, kills) {
    $('alive-count').textContent = alive;
    $('kill-count').textContent = kills;
  }

  setBanner(html) { const b = $('banner'); if (b.innerHTML !== html) b.innerHTML = html; }
  setStormInfo(html) { const s = $('storm-info'); if (s.innerHTML !== html) s.innerHTML = html; }

  setNet(ping, bad) {
    const n = $('net-info');
    n.textContent = bad ? 'CONNECTION PROBLEM' : `${Math.round(ping)} ms`;
    n.classList.toggle('bad', !!bad);
  }

  setPrompt(text) {
    const p = $('prompt');
    if (!text) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden');
    if (p.dataset.t !== text) { p.dataset.t = text; p.innerHTML = `<kbd>E</kbd>${esc(text)}`; }
  }

  notice(text, dur = 2.2) {
    const n = $('notice');
    n.textContent = text;
    n.style.opacity = '1';
    this.noticeTimer = dur;
  }

  hitmarker(kind) {
    const h = $('hitmarker');
    h.style.color = kind === 'kill' ? '#ff4d5e' : kind === 'head' ? '#ffcf3f' : kind === 'shield' ? '#7fd4ff' : '#ffffff';
    h.style.opacity = '1';
    h.style.transform = kind === 'kill' ? 'scale(1.5)' : 'scale(1)';
    this.hitTimer = 0.2;
  }

  damageFrom(angle) {
    const d = document.createElement('div');
    d.className = 'dmgdir';
    d.style.transform = `rotate(${angle}rad)`;
    $('dmgdirs').appendChild(d);
    setTimeout(() => d.remove(), 1200);
  }

  floater(text, color, x, y, z) {
    const el = document.createElement('div');
    el.className = 'floater';
    el.textContent = text;
    el.style.color = color;
    $('floaters').appendChild(el);
    this.floaters.push({ el, x, y, z, life: 0.9, vy: 1.6 });
  }

  killfeed(msg, myId) {
    const d = document.createElement('div');
    d.className = 'kf';
    const killer = msg.k ? `<b class="${msg.kid === myId ? 'me' : ''}">${esc(msg.k)}</b>` : '';
    const how = {
      storm: 'was consumed by the storm', fall: 'fell to their doom', left: 'left the match',
    }[msg.w];
    const victim = `<span class="v ${msg.vid === myId ? 'me' : ''}">${esc(msg.v)}</span>`;
    if (msg.k && msg.kid !== msg.vid) {
      const wname = WEAPONS[msg.w]?.name ?? msg.w;
      d.innerHTML = `${killer} eliminated ${victim} <span class="hint">${esc(wname)}${msg.hs ? ' · headshot' : ''}</span>`;
    } else d.innerHTML = `${victim} ${how ?? 'was eliminated'}`;
    const feed = $('killfeed');
    feed.appendChild(d);
    while (feed.children.length > 6) feed.firstChild.remove();
    setTimeout(() => d.remove(), 7200);
  }

  chat(name, text, system) {
    const log = $('chat-log');
    const d = document.createElement('div');
    if (system) { d.className = 'sys'; d.textContent = text; }
    else d.innerHTML = `<b>${esc(name)}:</b> ${esc(text)}`;
    log.appendChild(d);
    while (log.children.length > 8) log.firstChild.remove();
    setTimeout(() => d.classList.add('old'), 12000);
  }

  setTeammates(list, names) {
    const el = $('teammates');
    if (!list || !list.length) { el.innerHTML = ''; return; }
    el.innerHTML = list.map(([id, hp, sh, alive]) => `<div class="tm ${alive ? '' : 'dead'}">${esc(names.get(id) ?? 'Teammate')}
      <div class="bars"><i style="width:${sh * 0.8}px;background:var(--shield)"></i><i style="width:${hp * 0.8}px;background:var(--health)"></i></div></div>`).join('');
  }

  update(dt, project) {
    if (this.noticeTimer > 0) { this.noticeTimer -= dt; if (this.noticeTimer <= 0) $('notice').style.opacity = '0'; }
    if (this.hitTimer > 0) { this.hitTimer -= dt; if (this.hitTimer <= 0) $('hitmarker').style.opacity = '0'; }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      f.y += f.vy * dt;
      if (f.life <= 0) { f.el.remove(); this.floaters.splice(i, 1); continue; }
      const p = project(f.x, f.y, f.z);
      f.el.style.display = p.visible ? '' : 'none';
      f.el.style.left = `${p.x}px`;
      f.el.style.top = `${p.y}px`;
      f.el.style.opacity = String(Math.min(1, f.life * 2));
    }
  }

  // ---------------------------------------------------------------- maps

  drawMinimap(view) {
    const cv = $('minimap');
    const g = cv.getContext('2d');
    const W = cv.width, span = 170; // meters across
    const scale = W / span;
    const half = MAP_SIZE / 2;
    g.fillStyle = '#16304a';
    g.fillRect(0, 0, W, W);
    const cx = view.x, cz = view.z;
    g.save();
    g.translate(W / 2, W / 2);
    g.scale(scale, scale);
    g.translate(-cx, -cz);
    g.drawImage(this.mapImage, -half, -half);
    this.drawOverlays(g, view, 1 / scale);
    g.restore();
    // Self arrow in the center
    g.save();
    g.translate(W / 2, W / 2);
    g.rotate(-view.yaw);
    g.fillStyle = '#ffcf3f';
    g.strokeStyle = '#000';
    g.beginPath(); g.moveTo(0, -8); g.lineTo(6, 6); g.lineTo(0, 3); g.lineTo(-6, 6); g.closePath();
    g.fill(); g.stroke();
    g.restore();
  }

  drawBigMap(view) {
    const cv = $('bigmap-canvas');
    const g = cv.getContext('2d');
    const W = cv.width;
    const scale = W / MAP_SIZE;
    const half = MAP_SIZE / 2;
    g.clearRect(0, 0, W, W);
    g.save();
    g.scale(scale, scale);
    g.translate(half, half);
    g.drawImage(this.mapImage, -half, -half);
    this.drawOverlays(g, view, 1 / scale);
    g.font = `bold ${13 / scale}px Segoe UI, sans-serif`;
    g.textAlign = 'center';
    for (const p of POIS) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillText(p.name.toUpperCase(), p.x + 0.8 / scale, p.z + 0.8 / scale);
      g.fillStyle = '#fff';
      g.fillText(p.name.toUpperCase(), p.x, p.z);
    }
    if (view.self) {
      g.save();
      g.translate(view.x, view.z);
      g.rotate(-view.yaw);
      g.fillStyle = '#ffcf3f'; g.strokeStyle = '#000'; g.lineWidth = 1 / scale;
      const s = 1 / scale;
      g.beginPath(); g.moveTo(0, -10 * s); g.lineTo(7 * s, 7 * s); g.lineTo(0, 3 * s); g.lineTo(-7 * s, 7 * s); g.closePath();
      g.fill(); g.stroke();
      g.restore();
    }
    g.restore();
  }

  drawOverlays(g, view, px) {
    const half = MAP_SIZE / 2;
    if (view.ship) {
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.setLineDash([6 * px, 6 * px]);
      g.lineWidth = 2 * px;
      g.beginPath();
      g.moveTo(view.ship.sx, view.ship.sz);
      g.lineTo(view.ship.sx + view.ship.dx * view.ship.len, view.ship.sz + view.ship.dz * view.ship.len);
      g.stroke();
      g.setLineDash([]);
      if (view.shipPos) { g.fillStyle = '#ffcf3f'; g.beginPath(); g.arc(view.shipPos.x, view.shipPos.z, 5 * px, 0, Math.PI * 2); g.fill(); }
    }
    if (view.storm) {
      const c = view.storm.cur, n = view.storm.next;
      g.fillStyle = 'rgba(120,40,220,0.45)';
      g.beginPath();
      g.rect(-half - 400, -half - 400, MAP_SIZE + 800, MAP_SIZE + 800);
      g.arc(c.x, c.z, Math.max(0.1, c.r), 0, Math.PI * 2, true);
      g.fill('evenodd');
      g.strokeStyle = '#c58bff'; g.lineWidth = 2 * px;
      g.beginPath(); g.arc(c.x, c.z, Math.max(0.1, c.r), 0, Math.PI * 2); g.stroke();
      if (n) {
        g.strokeStyle = '#ffffff'; g.lineWidth = 2 * px;
        g.beginPath(); g.arc(n.x, n.z, Math.max(0.1, n.r), 0, Math.PI * 2); g.stroke();
      }
    }
    for (const t of view.teammates ?? []) {
      g.fillStyle = '#7dff9a'; g.strokeStyle = '#000'; g.lineWidth = px;
      g.beginPath(); g.arc(t.x, t.z, 4 * px, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
}
