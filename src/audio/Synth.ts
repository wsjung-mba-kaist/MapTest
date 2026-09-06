/**
 * Procedural sound sources (no assets needed): coloured noise loops with filters for wind / traffic / water,
 * short FM chirps for birds, and band-limited noise bursts for footsteps.
 */

export type NoiseKind = 'white' | 'pink' | 'brown';

const buffers = new WeakMap<AudioContext, Map<NoiseKind, AudioBuffer>>();

/** A few seconds of looping coloured noise (Paul Kellet's pink filter, leaky integrator for brown). */
export function noiseBuffer(ctx: AudioContext, kind: NoiseKind, seconds = 4): AudioBuffer {
  let m = buffers.get(ctx); if (!m) { m = new Map(); buffers.set(ctx, m); }
  const cached = m.get(kind); if (cached) return cached;
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w * 0.5;
    else if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
  }
  // seamless loop: crossfade the last 0.2 s into the first
  const f = Math.floor(ctx.sampleRate * 0.2);
  for (let i = 0; i < f; i++) { const t = i / f; d[n - f + i] = d[n - f + i] * (1 - t) + d[i] * t; }
  m.set(kind, buf);
  return buf;
}

/** Looping noise through a filter and a gain (the ambience voices). */
export class NoiseVoice {
  readonly src: AudioBufferSourceNode;
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  constructor(ctx: AudioContext, kind: NoiseKind, type: BiquadFilterType, freq: number, q: number, out: AudioNode) {
    this.src = ctx.createBufferSource(); this.src.buffer = noiseBuffer(ctx, kind); this.src.loop = true;
    this.src.playbackRate.value = 0.9 + Math.random() * 0.2;
    this.filter = ctx.createBiquadFilter(); this.filter.type = type; this.filter.frequency.value = freq; this.filter.Q.value = q;
    this.gain = ctx.createGain(); this.gain.gain.value = 0;
    this.src.connect(this.filter).connect(this.gain).connect(out);
    this.src.start();
  }
  /** smooth level change (seconds time constant) */
  level(v: number, tau = 1.2) { this.gain.gain.setTargetAtTime(v, this.gain.context.currentTime, tau); }
  dispose() { try { this.src.stop(); } catch { /* already stopped */ } this.src.disconnect(); this.filter.disconnect(); this.gain.disconnect(); }
}

export type StepKind = 'concrete' | 'grass' | 'gravel' | 'wood';

/** One footstep: a filtered noise burst (gravel gets a second crunch, wood a resonant thud). */
export function footstep(ctx: AudioContext, out: AudioNode, kind: StepKind, strength: number, when = ctx.currentTime) {
  const burst = (t0: number, freq: number, type: BiquadFilterType, q: number, dur: number, vol: number) => {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, 'white'); src.loop = true;
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq * (0.92 + Math.random() * 0.16); f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.004); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t0, Math.random() * 3); src.stop(t0 + dur + 0.02);
  };
  const v = 0.25 + 0.55 * strength;
  switch (kind) {
    case 'grass': burst(when, 650, 'lowpass', 0.6, 0.11, v * 0.45); break;
    case 'gravel': burst(when, 2400, 'bandpass', 0.6, 0.09, v * 0.5); burst(when + 0.035, 3200, 'bandpass', 0.8, 0.07, v * 0.35); break;
    case 'wood': burst(when, 320, 'bandpass', 2.2, 0.13, v * 0.7); burst(when, 1400, 'bandpass', 1.0, 0.05, v * 0.25); break;
    default: burst(when, 1300, 'bandpass', 1.1, 0.075, v * 0.55); burst(when + 0.012, 4200, 'highpass', 0.7, 0.04, v * 0.18);
  }
}

/** A short bird phrase: 2-4 FM chirps with a rising pitch envelope. */
export function birdPhrase(ctx: AudioContext, out: AudioNode, gain: number, when = ctx.currentTime) {
  const n = 2 + Math.floor(Math.random() * 3);
  const base = 2200 + Math.random() * 1800;
  for (let i = 0; i < n; i++) {
    const t0 = when + i * (0.14 + Math.random() * 0.08);
    const osc = ctx.createOscillator(); osc.type = 'sine';
    const f1 = base * (0.9 + Math.random() * 0.3);
    osc.frequency.setValueAtTime(f1, t0); osc.frequency.exponentialRampToValueAtTime(f1 * 1.6, t0 + 0.05); osc.frequency.exponentialRampToValueAtTime(f1 * 1.1, t0 + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.11);
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8;
    osc.connect(g).connect(pan).connect(out);
    osc.start(t0); osc.stop(t0 + 0.13);
  }
}
