import type * as THREE from 'three';
import type { Post } from '../render/Post';
import type { WaterReflection } from '../render/WaterReflection';
import type { World } from '../world/World';
import type { Hud } from '../ui/Hud';
import type { Prefs } from '../../shared/prefs';
import { pickQuality, type QualityLevel } from '../../shared/quality';
import { S, fmt } from '../ui/strings';

export interface QualityContext {
  renderer: THREE.WebGLRenderer;
  post: Post;
  world: World;
  hud: Hud;
  /** the planar reflection pre-pass, once the water layer exists */
  reflection: () => WaterReflection | undefined;
  /** touch preset: pixel ratio capped at 1 */
  touch: () => boolean;
  /** movement input is live (the auto decision only samples frames the player actually sees) */
  inputActive: () => boolean;
  /** re-applies the canvas size after a pixel-ratio change */
  resize: () => void;
}

/**
 * Everything that trades image quality for frame time: the quality / AO / shadow / reflection / pixel-ratio
 * preferences, the `?quality=` style URL overrides and the automatic step-down (shared/quality.ts decides, this
 * samples). Was spread over App.boot, applyPrefs, applyUrlParams and a loop tick; one place means one answer to
 * "why is AO off".
 */
export class QualityController {
  private readonly frameSamples: number[] = [];
  private autoAt = 0;
  private autoDone = false;
  private autoLevel: QualityLevel = 'high';

  constructor(private readonly c: QualityContext) {}

  /** The preference keys this controller owns (App routes them here from applyPrefs). */
  static readonly KEYS: readonly (keyof Prefs)[] = ['quality', 'ao', 'shadows', 'reflection', 'pixelRatio'];

  apply(p: Prefs, k: keyof Prefs) {
    const { renderer, post, world } = this.c;
    if (k === 'quality') { if (p.quality !== 'auto') post.setQuality(p.quality); else if (this.autoDone) this.resetAuto(); }
    else if (k === 'ao') post.setAo(p.ao);
    else if (k === 'shadows') { renderer.shadowMap.enabled = p.shadows; renderer.shadowMap.needsUpdate = true; }
    else if (k === 'reflection') {
      const r = this.c.reflection();
      if (r) { r.enabled = p.reflection; post.reflection = p.reflection ? r : undefined; if (p.reflection) world.water?.setReflection(r.target.texture, r.textureMatrix); else world.water?.setReflection(null, null, 0); }
    }
    else if (k === 'pixelRatio') { renderer.setPixelRatio(p.pixelRatio === 'auto' ? Math.min(window.devicePixelRatio || 1, this.c.touch() ? 1 : 2) : p.pixelRatio); this.c.resize(); }
  }

  /** A changed `quality: auto` preference restarts the measurement. */
  resetAuto() { this.autoDone = false; this.autoAt = 0; this.frameSamples.length = 0; }

  /**
   * Per frame while the preference is `auto`: wait for the streaming to settle (or 25 s), sample a few seconds of
   * frame times, then step the preset down once per session when the median says the machine is too slow.
   */
  tick(dt: number, t: number, auto: boolean) {
    if (this.autoDone || !auto || !this.c.post.enabled || !this.c.inputActive()) return;
    if (!this.autoAt) { this.autoAt = t; return; }
    const settled = this.c.world.pending === 0 || t - this.autoAt > 25;
    if (!settled || t - this.autoAt < 3) return;
    this.frameSamples.push(dt * 1000);
    if (this.frameSamples.length < 30 || t - this.autoAt < 8) return;
    const d = pickQuality(this.frameSamples, this.autoLevel, { minSamples: 30 });
    this.autoDone = true;
    if (!d.changed) return;
    this.autoLevel = d.quality;
    this.c.post.setQuality(d.quality);
    if (d.pixelRatio) { this.c.renderer.setPixelRatio(this.c.renderer.getPixelRatio() * d.pixelRatio); this.c.resize(); }
    this.c.hud.toast(fmt(S.app.qualityLowered, { quality: S.settings.quality[d.quality], ratio: d.pixelRatio ? S.app.qualityRatio : '' }), 5000);
  }
}
