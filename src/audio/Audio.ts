import { SurfaceClass } from '../../shared/layout';
import type { SurfaceGrid } from '../../shared/surfacegrid';
import { NoiseVoice, birdPhrase, footstep, type StepKind } from './Synth';

/**
 * Soundscape: traffic hum near roads, birds in the parks (dawn to dusk), river noise by the water, wind up high,
 * and footsteps that follow the surface under the player. Everything is synthesised (see Synth.ts), so it works
 * offline and needs no licensed assets; the context starts on the first user gesture, `V` mutes.
 *   ?audio=0      off entirely
 *   ?audio=debug  status line in the HUD (context state, bus levels, surface)
 */
const MUTE_KEY = 'paris.audio.muted';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private busAmb!: GainNode;
  private busSteps!: GainNode;
  private traffic!: NoiseVoice; private trafficHigh!: NoiseVoice; private wind!: NoiseVoice; private water!: NoiseVoice;
  private birdLevel = 0; private birdClock = 0;
  private t = 0;
  private levels = { traffic: 0, birds: 0, water: 0, wind: 0 };
  private lastKind: StepKind = 'concrete';
  private lastStep = 0;
  muted = false;
  readonly enabled: boolean;
  readonly debug: boolean;

  constructor(mode: string | null) {
    this.enabled = mode !== '0';
    this.debug = mode === 'debug';
    try { this.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* no storage */ }
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend(); else if (!this.muted) void this.ctx.resume();
    });
  }

  /** Create / resume the context (call from a user gesture; idempotent). */
  ensure() {
    if (!this.enabled) return;
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 1;
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3; comp.knee.value = 12;
      this.master.connect(comp).connect(ctx.destination);
      this.busAmb = ctx.createGain(); this.busAmb.gain.value = 0.9; this.busAmb.connect(this.master);
      this.busSteps = ctx.createGain(); this.busSteps.gain.value = 0.8; this.busSteps.connect(this.master);
      this.traffic = new NoiseVoice(ctx, 'brown', 'lowpass', 190, 0.7, this.busAmb);
      this.trafficHigh = new NoiseVoice(ctx, 'pink', 'bandpass', 520, 0.9, this.busAmb);
      this.wind = new NoiseVoice(ctx, 'brown', 'lowpass', 420, 0.5, this.busAmb);
      this.water = new NoiseVoice(ctx, 'pink', 'bandpass', 1300, 0.6, this.busAmb);
    }
    if (this.ctx.state === 'suspended' && !this.muted) void this.ctx.resume();
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* no storage */ }
    if (this.ctx) { this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05); if (!m) void this.ctx.resume(); }
  }
  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  /** Surface under the feet -> footstep kind (decks and floors above the terrain sound like wood). */
  static kindAt(surface: SurfaceGrid | null, x: number, z: number, aboveTerrain: number): StepKind {
    if (aboveTerrain > 0.5) return 'wood';
    switch (surface?.classAt(x, z)) {
      case SurfaceClass.Grass: return 'grass';
      case SurfaceClass.Gravel: return 'gravel';
      default: return 'concrete';
    }
  }

  step(kind: StepKind, strength: number) {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now - this.lastStep < 0.16) return;
    this.lastStep = now;
    this.lastKind = kind;
    footstep(this.ctx, this.busSteps, kind, strength, now);
  }

  /**
   * Ambience targets from the surroundings; call every frame.
   * hour: local hour; aboveGround: metres between the ear and the terrain (wind on the tower decks).
   */
  update(dt: number, x: number, z: number, hour: number, aboveGround: number, surface: SurfaceGrid | null) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.t += dt;
    const day = smooth(5.5, 8, hour) * (1 - smooth(19, 22.5, hour));          // 0 at night, 1 by day
    const road = surface ? surface.fractionNear(x, z, 40, SurfaceClass.Road) : 0.3;
    const park = surface ? surface.fractionNear(x, z, 30, [SurfaceClass.Grass, SurfaceClass.Gravel]) : 0;
    const w60 = surface ? surface.fractionNear(x, z, 60, SurfaceClass.Water) : 0;
    const w140 = surface ? surface.fractionNear(x, z, 140, SurfaceClass.Water) : 0;
    const high = smooth(10, 80, aboveGround);
    const traffic = Math.min(1, road * 1.6) * (0.45 + 0.55 * day) * (1 - 0.6 * high);
    const birds = park * (0.35 + 0.65 * smooth(5.5, 7.5, hour) * (1 - smooth(17, 21, hour))) * (1 - high);
    const water = Math.max(w60 * 1.4, w140 * 0.7) * (1 - 0.7 * high);
    const wind = 0.06 + 0.7 * high + 0.05 * w140;
    this.levels = { traffic, birds, water, wind };
    // slow swells so the hum does not sound like a constant tone
    const swell = 0.75 + 0.25 * Math.sin(this.t * 0.31) * Math.sin(this.t * 0.11 + 1.3);
    this.traffic.level(traffic * 0.32 * swell);
    this.trafficHigh.level(traffic * 0.05 * (0.6 + 0.4 * Math.sin(this.t * 0.47)));
    this.wind.level(wind * 0.28);
    this.wind.filter.frequency.setTargetAtTime(280 + 260 * high + 120 * Math.sin(this.t * 0.37), this.ctx.currentTime, 0.5);
    this.water.level(water * 0.22);
    // birds: random phrases whose rate follows the level
    this.birdLevel += (birds - this.birdLevel) * Math.min(1, dt * 0.8);
    this.birdClock -= dt;
    if (this.birdLevel > 0.03 && this.birdClock <= 0) {
      birdPhrase(this.ctx, this.busAmb, 0.06 + 0.12 * this.birdLevel);
      this.birdClock = 1.5 + Math.random() * 6 / Math.max(0.05, this.birdLevel);
    }
  }

  status(): string {
    if (!this.enabled) return 'audio off';
    if (!this.ctx) return 'audio: waiting for a click';
    const l = this.levels;
    return `audio ${this.ctx.state}${this.muted ? ' muted' : ''} traffic ${l.traffic.toFixed(2)} birds ${l.birds.toFixed(2)} water ${l.water.toFixed(2)} wind ${l.wind.toFixed(2)} step ${this.lastKind}`;
  }
}

const smooth = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
