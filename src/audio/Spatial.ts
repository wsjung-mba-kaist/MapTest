import { noiseBuffer } from './Synth';

/**
 * Positional sound: a small pool of HRTF panners fed by synthesised voices, plus one-shot events that also sit in
 * space (horns, sirens sweeping past, the hour bell from a distance, the tower lift). The listener follows the
 * camera, so turning the head finally moves the traffic hiss, the boat engine and the café murmur around you.
 */
export type SpatialKind = 'car' | 'boat' | 'terrace' | 'fountain' | 'train';
export interface SpatialSource { kind: SpatialKind; x: number; y: number; z: number; level: number; speed?: number }

const POOL: Record<SpatialKind, number> = { car: 4, boat: 2, terrace: 4, fountain: 2, train: 1 };

function panner(ctx: AudioContext, ref = 3, max = 150, rolloff = 1.1): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = ref; p.maxDistance = max; p.rolloffFactor = rolloff;
  p.coneInnerAngle = 360; p.coneOuterAngle = 360;
  return p;
}

function place(p: PannerNode, x: number, y: number, z: number, t: number, tau = 0.08) {
  if (p.positionX) { p.positionX.setTargetAtTime(x, t, tau); p.positionY.setTargetAtTime(y, t, tau); p.positionZ.setTargetAtTime(z, t, tau); }
  else p.setPosition(x, y, z);
}

class Voice {
  readonly panner: PannerNode;
  readonly gain: GainNode;
  private readonly parts: { src: AudioBufferSourceNode; filter: BiquadFilterNode; g: GainNode }[] = [];
  private lfo: OscillatorNode | null = null;
  private grainClock = 0;
  active = false;

  constructor(private readonly ctx: AudioContext, readonly kind: SpatialKind, out: AudioNode) {
    this.panner = panner(ctx, kind === 'boat' || kind === 'train' ? 6 : kind === 'car' ? 3 : 2, kind === 'boat' ? 220 : kind === 'train' ? 320 : 120);
    this.gain = ctx.createGain(); this.gain.gain.value = 0;
    this.gain.connect(this.panner).connect(out);
    const part = (kind: 'brown' | 'pink' | 'white', type: BiquadFilterType, freq: number, q: number, level: number) => {
      const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, kind); src.loop = true; src.playbackRate.value = 0.85 + Math.random() * 0.3;
      const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
      const g = ctx.createGain(); g.gain.value = level;
      src.connect(filter).connect(g).connect(this.gain); src.start(0, Math.random() * 3);
      this.parts.push({ src, filter, g });
    };
    switch (kind) {
      case 'car': part('brown', 'lowpass', 160, 0.7, 0.5); part('pink', 'bandpass', 900, 0.8, 0.25); break;
      case 'boat': {
        part('brown', 'lowpass', 110, 0.9, 0.7);
        // slow engine throb
        const lfo = ctx.createOscillator(); lfo.frequency.value = 1.3; const lg = ctx.createGain(); lg.gain.value = 0.25;
        lfo.connect(lg).connect(this.parts[0].g.gain); lfo.start(); this.lfo = lfo;
        break;
      }
      case 'terrace': part('pink', 'bandpass', 700, 0.5, 0.3); break;
      case 'train': {
        // rubber-tyred métro on the viaduct: deep rumble plus a 4.5 Hz clatter
        part('brown', 'lowpass', 130, 0.8, 0.7); part('pink', 'bandpass', 380, 1.2, 0.2);
        const lfo = ctx.createOscillator(); lfo.frequency.value = 4.5; const lg = ctx.createGain(); lg.gain.value = 0.15;
        lfo.connect(lg).connect(this.parts[1].g.gain); lfo.start(); this.lfo = lfo;
        break;
      }
      case 'fountain': part('pink', 'highpass', 1400, 0.7, 0.6); break;
    }
  }

  set(s: SpatialSource, dt: number) {
    const t = this.ctx.currentTime;
    place(this.panner, s.x, s.y, s.z, t);
    this.gain.gain.setTargetAtTime(s.level, t, 0.15);
    if (this.kind === 'car') {
      const v = s.speed ?? 8;
      this.parts[1].filter.frequency.setTargetAtTime(500 + 70 * v, t, 0.3);
      this.parts[1].g.gain.setTargetAtTime(0.08 + 0.35 * Math.min(1, v / 12), t, 0.3);
      this.parts[0].g.gain.setTargetAtTime(0.3 + 0.25 * Math.min(1, v / 12), t, 0.3);
    }
    if (this.kind === 'terrace') {
      // cutlery and voices: short bright grains at a random rate
      this.grainClock -= dt;
      if (this.grainClock <= 0) {
        this.grainClock = 0.12 + Math.random() * 0.5;
        const src = this.ctx.createBufferSource(); src.buffer = noiseBuffer(this.ctx, 'white'); src.loop = true;
        const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200 + Math.random() * 2400; f.Q.value = 2.5;
        const g = this.ctx.createGain(); const d = 0.03 + Math.random() * 0.05;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.35 * s.level, t + 0.005); g.gain.exponentialRampToValueAtTime(0.001, t + d);
        src.connect(f).connect(g).connect(this.panner); src.start(t, Math.random() * 3); src.stop(t + d + 0.02);
      }
    }
    this.active = true;
  }

  release() { if (this.active) { this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25); this.active = false; } }
  dispose() { for (const p of this.parts) { try { p.src.stop(); } catch { /* stopped */ } } this.lfo?.stop(); this.panner.disconnect(); }
}

export class Spatial {
  private readonly voices = new Map<SpatialKind, Voice[]>();
  private readonly fwd = { x: 0, y: 0, z: -1 };

  constructor(private readonly ctx: AudioContext, private readonly out: AudioNode) {}

  /** Listener pose from the camera (world metres; the graph uses the same axes as the scene). */
  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number) {
    const l = this.ctx.listener, t = this.ctx.currentTime;
    this.fwd.x = fx; this.fwd.y = fy; this.fwd.z = fz;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, 0.03); l.positionY.setTargetAtTime(y, t, 0.03); l.positionZ.setTargetAtTime(z, t, 0.03);
      l.forwardX.setTargetAtTime(fx, t, 0.03); l.forwardY.setTargetAtTime(fy, t, 0.03); l.forwardZ.setTargetAtTime(fz, t, 0.03);
      l.upX.setTargetAtTime(0, t, 0.03); l.upY.setTargetAtTime(1, t, 0.03); l.upZ.setTargetAtTime(0, t, 0.03);
    } else { l.setPosition(x, y, z); l.setOrientation(fx, fy, fz, 0, 1, 0); }
  }

  /** Assign this frame's sources (nearest first per kind) to the pool; the rest fade out. */
  update(sources: SpatialSource[], dt: number) {
    const used = new Map<SpatialKind, number>();
    for (const s of sources) {
      const n = used.get(s.kind) ?? 0;
      if (n >= POOL[s.kind]) continue;
      let pool = this.voices.get(s.kind);
      if (!pool) { pool = []; this.voices.set(s.kind, pool); }
      if (!pool[n]) pool[n] = new Voice(this.ctx, s.kind, this.out);
      pool[n].set(s, dt);
      used.set(s.kind, n + 1);
    }
    for (const [kind, pool] of this.voices) { const n = used.get(kind) ?? 0; for (let i = n; i < pool.length; i++) pool[i].release(); }
  }

  get activeCount() { let n = 0; for (const pool of this.voices.values()) for (const v of pool) if (v.active) n++; return n; }

  // ---------------------------------------------------------------- one-shots

  /** Short double-tone horn from a point (a nearby car). */
  horn(x: number, y: number, z: number, gain = 0.3) {
    const ctx = this.ctx, t0 = ctx.currentTime, p = panner(ctx, 4, 200); p.connect(this.out); place(p, x, y, z, t0, 0.001);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400; f.connect(p);
    const g = ctx.createGain(); g.connect(f);
    const d = 0.25 + Math.random() * 0.5;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.02); g.gain.setValueAtTime(gain, t0 + d - 0.05); g.gain.linearRampToValueAtTime(0, t0 + d);
    for (const hz of [415 * (0.97 + Math.random() * 0.06), 520 * (0.97 + Math.random() * 0.06)]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = hz; o.connect(g); o.start(t0); o.stop(t0 + d + 0.05); }
  }

  /** Two-tone siren passing on a line 40 m to one side of the listener, from 180 m ahead to 180 m behind. */
  siren(lx: number, ly: number, lz: number, gain = 0.22) {
    const ctx = this.ctx, t0 = ctx.currentTime, dur = 9;
    const p = panner(ctx, 8, 400, 1.0); p.connect(this.out);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2200; f.connect(p);
    const g = ctx.createGain(); g.connect(f);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.connect(g);
    // French two-tone: 435 / 580 Hz, 0.85 s each
    for (let k = 0; k * 0.85 < dur; k++) o.frequency.setValueAtTime(k % 2 ? 580 : 435, t0 + k * 0.85);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.4); g.gain.setValueAtTime(gain, t0 + dur - 0.6); g.gain.linearRampToValueAtTime(0, t0 + dur);
    const side = Math.random() < 0.5 ? -1 : 1, right = { x: -this.fwd.z, z: this.fwd.x };
    const ox = lx + right.x * 40 * side, oz = lz + right.z * 40 * side;
    const ax = this.fwd.x, az = this.fwd.z;
    for (let k = 0; k <= 30; k++) { const u = k / 30, s = 180 - 360 * u, tt = t0 + u * dur; if (p.positionX) { p.positionX.linearRampToValueAtTime(ox + ax * s, tt); p.positionY.linearRampToValueAtTime(ly, tt); p.positionZ.linearRampToValueAtTime(oz + az * s, tt); } }
    if (!p.positionX) p.setPosition(ox, ly, oz);
    o.start(t0); o.stop(t0 + dur + 0.1);
  }

  /** The hour struck by a church some 400 m away (north-east), muffled by distance. */
  bell(strikes: number, lx: number, ly: number, lz: number) {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const p = panner(ctx, 80, 1200, 0.6); p.connect(this.out); place(p, lx + 280, ly + 30, lz - 280, t0, 0.001);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1600; f.connect(p);
    for (let i = 0; i < strikes; i++) {
      const t = t0 + i * 1.45;
      for (const [hz, amp] of [[392, 1.0], [784, 0.35], [1175, 0.18]] as [number, number][]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = hz * (1 + (Math.random() - 0.5) * 0.004);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16 * amp, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0005, t + 2.6);
        o.connect(g).connect(f); o.start(t); o.stop(t + 2.7);
      }
    }
  }

  /** Tower lift: motor hum for `seconds`, a soft bell on arrival (non-positional: you are inside it). */
  lift(seconds: number) {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 52;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 220; f.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.12, t0 + 1.2); g.gain.setValueAtTime(0.12, t0 + seconds - 1.5); g.gain.linearRampToValueAtTime(0, t0 + seconds);
    o.connect(f).connect(g).connect(this.out); o.start(t0); o.stop(t0 + seconds + 0.1);
    const d = ctx.createOscillator(); d.type = 'sine'; d.frequency.value = 1318;
    const dg = ctx.createGain(); const td = t0 + seconds - 0.3;
    dg.gain.setValueAtTime(0, td); dg.gain.linearRampToValueAtTime(0.08, td + 0.01); dg.gain.exponentialRampToValueAtTime(0.0005, td + 0.9);
    d.connect(dg).connect(this.out); d.start(td); d.stop(td + 1);
  }
}
