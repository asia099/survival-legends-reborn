// Procedural sound effects with Web Audio. No asset files: every sound is synthesized.
// Positional sounds are panned and attenuated relative to the camera.

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  // Returns a gain+panner chain for a world position (or centered when pos is null).
  out(pos, base = 1, range = 25) {
    const c = this.ctx;
    const g = c.createGain();
    let gain = base, pan = 0;
    if (pos) {
      const L = this.listener;
      const dx = pos[0] - L.x, dz = pos[2] - L.z, dy = (pos[1] ?? L.y) - L.y;
      const d = Math.hypot(dx, dy, dz);
      gain = base / (1 + d / range);
      if (d > range * 14) return null;
      const rx = Math.cos(L.yaw), rz = -Math.sin(L.yaw);
      pan = d > 0.5 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) : 0;
    }
    g.gain.value = gain;
    if (c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.master);
    } else g.connect(this.master);
    return g;
  }

  noiseBurst(dest, dur, freq, q = 1, type = 'lowpass', t0 = 0) {
    const c = this.ctx, t = c.currentTime + t0;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  tone(dest, freq, dur, type = 'sine', vol = 0.5, t0 = 0, endFreq = null) {
    const c = this.ctx, t = c.currentTime + t0;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  shot(weapon, pos) {
    if (!this.ctx) return;
    const profile = {
      pistol: [0.12, 2600, 160, 0.7], smg: [0.08, 3200, 190, 0.55], ar: [0.14, 2200, 120, 0.8],
      shotgun: [0.32, 1400, 80, 1.1], sniper: [0.5, 1800, 60, 1.2],
    }[weapon] ?? [0.12, 2400, 140, 0.7];
    const dest = this.out(pos, profile[3], pos ? 40 : 25);
    if (!dest) return;
    this.noiseBurst(dest, profile[0], profile[1], 0.8);
    this.tone(dest, profile[2], profile[0] * 0.9, 'triangle', 0.6, 0, profile[2] * 0.4);
  }

  impact(pos) {
    if (!this.ctx) return;
    const dest = this.out(pos, 0.25, 10);
    if (dest) this.noiseBurst(dest, 0.05, 3000, 2, 'bandpass');
  }

  hit(head, shield) {
    if (!this.ctx) return;
    const dest = this.out(null, 0.35);
    if (head) this.tone(dest, 1800, 0.18, 'sine', 0.5, 0, 2400);
    else this.tone(dest, shield ? 900 : 1200, 0.07, 'square', 0.25);
  }

  kill() {
    if (!this.ctx) return;
    const dest = this.out(null, 0.4);
    this.tone(dest, 660, 0.12, 'triangle', 0.5);
    this.tone(dest, 990, 0.25, 'triangle', 0.5, 0.08);
  }

  hurt() {
    if (!this.ctx) return;
    const dest = this.out(null, 0.5);
    this.noiseBurst(dest, 0.15, 500, 1);
    this.tone(dest, 120, 0.15, 'sine', 0.5, 0, 70);
  }

  click() { if (this.ctx) this.tone(this.out(null, 0.2), 900, 0.04, 'square', 0.3); }
  pickup() { if (this.ctx) { const d = this.out(null, 0.3); this.tone(d, 520, 0.08, 'sine', 0.4); this.tone(d, 780, 0.1, 'sine', 0.4, 0.06); } }
  reload() { if (this.ctx) { const d = this.out(null, 0.3); this.noiseBurst(d, 0.05, 2000, 3, 'bandpass'); this.noiseBurst(d, 0.06, 1500, 3, 'bandpass', 0.25); } }
  empty() { if (this.ctx) this.tone(this.out(null, 0.25), 1400, 0.03, 'square', 0.2); }
  beep(high) { if (this.ctx) this.tone(this.out(null, 0.35), high ? 1320 : 880, 0.15, 'sine', 0.5); }

  footstep(pos, loud = 1) {
    if (!this.ctx) return;
    const dest = this.out(pos, 0.18 * loud, 8);
    if (dest) this.noiseBurst(dest, 0.06, 700 + Math.random() * 300, 1.5, 'bandpass');
  }

  stormWarning() {
    if (!this.ctx) return;
    const d = this.out(null, 0.4);
    this.tone(d, 220, 0.6, 'sawtooth', 0.25, 0, 180);
    this.tone(d, 165, 0.8, 'sawtooth', 0.2, 0.3, 110);
  }

  victory() {
    if (!this.ctx) return;
    const d = this.out(null, 0.45);
    [523, 659, 784, 1047].forEach((f, i) => this.tone(d, f, 0.5, 'triangle', 0.4, i * 0.14));
  }

  defeat() {
    if (!this.ctx) return;
    const d = this.out(null, 0.45);
    [392, 330, 262].forEach((f, i) => this.tone(d, f, 0.5, 'triangle', 0.4, i * 0.2));
  }
}
