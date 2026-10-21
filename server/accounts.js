// Guest accounts with persistent stats. A random secret token is issued on first join and
// kept by the client; the server stores only its SHA-256 hash. This is a prototype identity
// system, not production authentication (no passwords, email, or OAuth).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { XP } from '../shared/config.js';

const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

export function sanitizeName(name) {
  const clean = String(name ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 16);
  return clean.length >= 2 ? clean : `Legend${Math.floor(1000 + Math.random() * 9000)}`;
}

export function levelForXp(xp) {
  return Math.floor(xp / XP.perLevel) + 1;
}

export class AccountStore {
  constructor(file) {
    this.file = file;            // null => in-memory only (tests)
    this.byHash = new Map();
    this.saveTimer = null;
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        for (const a of data.accounts ?? []) this.byHash.set(a.tokenHash, a);
      } catch (e) {
        console.error('[accounts] could not read', file, e.message);
      }
    }
  }

  // Returns { account, token, created }.
  login(token, name) {
    if (typeof token === 'string' && token.length >= 32 && token.length <= 128) {
      const acc = this.byHash.get(hashToken(token));
      if (acc) {
        if (name) acc.name = sanitizeName(name);
        this.scheduleSave();
        return { account: acc, token, created: false };
      }
    }
    const newToken = randomBytes(32).toString('hex');
    const acc = {
      id: randomUUID(),
      tokenHash: hashToken(newToken),
      name: sanitizeName(name),
      created: new Date().toISOString(),
      stats: { matches: 0, wins: 0, kills: 0, deaths: 0, damage: 0, bestPlacement: 0, xp: 0 },
      rewardedMatches: [],
    };
    this.byHash.set(acc.tokenHash, acc);
    this.scheduleSave();
    return { account: acc, token: newToken, created: true };
  }

  // Grants match rewards exactly once per (account, match). Returns xp gained or null if already granted.
  recordResult(acc, matchId, r) {
    if (acc.rewardedMatches.includes(matchId)) return null;
    acc.rewardedMatches.push(matchId);
    if (acc.rewardedMatches.length > 100) acc.rewardedMatches.shift();
    const s = acc.stats;
    s.matches++;
    if (r.placement === 1) s.wins++;
    else s.deaths++;
    s.kills += r.kills;
    s.damage += Math.round(r.damage);
    if (!s.bestPlacement || r.placement < s.bestPlacement) s.bestPlacement = r.placement;
    const xp = XP.participation + r.kills * XP.perKill + (r.placement === 1 ? XP.win : 0)
      + Math.max(0, r.outlasted) * XP.perPlacementAbove;
    s.xp += xp;
    this.scheduleSave();
    return xp;
  }

  publicProfile(acc) {
    return { id: acc.id, name: acc.name, level: levelForXp(acc.stats.xp), stats: { ...acc.stats } };
  }

  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1000);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify({ version: 1, accounts: [...this.byHash.values()] }, null, 1));
      renameSync(tmp, this.file);
    } catch (e) {
      console.error('[accounts] save failed', e.message);
    }
  }
}
