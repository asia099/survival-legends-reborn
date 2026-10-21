// Server-controlled shrinking storm. The server decides every circle; clients receive
// the current stage (from/to circle + start/end times) and interpolate visually.

import { MAP_SIZE } from '../shared/config.js';

export class Storm {
  constructor(phases, rng) {
    this.phases = phases;
    this.rng = rng;
    this.active = false;
    this.version = 0;
  }

  start(time) {
    this.active = true;
    this.phaseIdx = 0;
    this.stage = 'wait';
    const cx = (this.rng() - 0.5) * 80, cz = (this.rng() - 0.5) * 80;
    this.from = { x: cx, z: cz, r: MAP_SIZE * 0.75 };
    this.to = this.pickNext(this.from, this.phases[0].radius);
    this.stageStart = time;
    this.stageEnd = time + this.phases[0].wait;
    this.version++;
  }

  pickNext(cur, radius) {
    // New circle lies entirely inside the current one and inside the playable map.
    const maxOff = Math.max(0, cur.r - radius);
    const lim = MAP_SIZE / 2 - Math.min(radius, MAP_SIZE / 2 - 20) - 10;
    for (let i = 0; i < 20; i++) {
      const a = this.rng() * Math.PI * 2, d = Math.sqrt(this.rng()) * maxOff;
      const x = cur.x + Math.cos(a) * d, z = cur.z + Math.sin(a) * d;
      if (Math.abs(x) <= lim && Math.abs(z) <= lim) return { x, z, r: radius };
    }
    return { x: Math.max(-lim, Math.min(lim, cur.x)), z: Math.max(-lim, Math.min(lim, cur.z)), r: radius };
  }

  // Current safe circle at `time`.
  circle(time) {
    if (!this.active) return { x: 0, z: 0, r: MAP_SIZE };
    if (this.stage !== 'shrink') return { ...this.from };
    const k = Math.min(1, Math.max(0, (time - this.stageStart) / (this.stageEnd - this.stageStart)));
    return {
      x: this.from.x + (this.to.x - this.from.x) * k,
      z: this.from.z + (this.to.z - this.from.z) * k,
      r: this.from.r + (this.to.r - this.from.r) * k,
    };
  }

  get dps() {
    if (!this.active) return 0;
    return this.phases[Math.min(this.phaseIdx, this.phases.length - 1)].dps;
  }

  isOutside(x, z, time) {
    const c = this.circle(time);
    return Math.hypot(x - c.x, z - c.z) > c.r;
  }

  // Advances stages. Returns true when the stage changed (so the server re-broadcasts).
  update(time) {
    if (!this.active || this.stage === 'done' || time < this.stageEnd) return false;
    const ph = this.phases[this.phaseIdx];
    if (this.stage === 'wait') {
      this.stage = 'shrink';
      this.stageStart = this.stageEnd;
      this.stageEnd = this.stageStart + ph.shrink;
    } else {
      this.from = { ...this.to };
      this.phaseIdx++;
      if (this.phaseIdx >= this.phases.length) {
        this.stage = 'done';
        this.phaseIdx = this.phases.length - 1;
        this.stageStart = this.stageEnd = time;
      } else {
        const next = this.phases[this.phaseIdx];
        this.to = this.pickNext(this.from, next.radius);
        this.stage = 'wait';
        this.stageStart = this.stageEnd;
        this.stageEnd = this.stageStart + next.wait;
      }
    }
    this.version++;
    return true;
  }

  serialize() {
    if (!this.active) return { active: false };
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      active: true, stage: this.stage, phase: this.phaseIdx, phases: this.phases.length,
      from: [r2(this.from.x), r2(this.from.z), r2(this.from.r)],
      to: [r2(this.to.x), r2(this.to.z), r2(this.to.r)],
      start: r2(this.stageStart), end: r2(this.stageEnd), dps: this.dps,
    };
  }
}
