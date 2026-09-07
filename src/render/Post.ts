import * as THREE from 'three';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { WaterReflection } from './WaterReflection';

export type Quality = 'low' | 'medium' | 'high';

/** Render pipeline: scene -> N8AO -> bloom + vignette + AgX tone mapping -> SMAA. */
export class Post {
  readonly composer: EffectComposer;
  readonly n8ao: N8AOPostPass;
  readonly bloom: BloomEffect;
  readonly tone: ToneMappingEffect;
  private readonly vignette: VignetteEffect;
  private readonly smaaPass: EffectPass;
  private readonly aoPass: N8AOPostPass;
  enabled = true;
  reflection?: WaterReflection;

  constructor(readonly renderer: THREE.WebGLRenderer, readonly scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera) {
    renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in the composer
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.n8ao = new N8AOPostPass(scene, camera, size.x, size.y);
    this.aoPass = this.n8ao;
    const c = this.n8ao.configuration;
    c.aoRadius = 2.5; c.distanceFalloff = 1.2; c.intensity = 2.6; c.halfRes = true; c.gammaCorrection = false;
    c.aoSamples = 12; c.denoiseSamples = 6; c.denoiseRadius = 10; c.depthAwareUpsampling = true;
    c.color = new THREE.Color(0x0b0d12);
    this.composer.addPass(this.n8ao);

    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.92, luminanceSmoothing: 0.2, intensity: 0.32, radius: 0.7 });
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.vignette = new VignetteEffect({ darkness: 0.32, offset: 0.28 });
    this.composer.addPass(new EffectPass(camera, this.bloom, this.vignette, this.tone));
    this.smaaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }));
    this.composer.addPass(this.smaaPass);
  }

  setSize(w: number, h: number) { this.composer.setSize(w, h); this.reflection?.setSize(w, h); }

  /**
   * Night grading: a lower, softer bloom knee so lamps, headlights and the tower's sparkle glow while lit windows
   * (kept under ~0.9) stay crisp; a touch more vignette; and a higher exposure for the eye's dark adaptation
   * (three feeds `toneMappingExposure` to the composer's AgX pass as well).
   */
  /** Night grading, plus a daytime exposure that opens up as the sun gets low (a photographer's -1/3 EV at noon, +0 at golden hour). */
  setNight(n: number, sunElevDeg = 45) {
    const L = THREE.MathUtils.lerp;
    this.bloom.luminanceMaterial.threshold = L(0.92, 0.80, n);
    this.bloom.luminanceMaterial.smoothing = L(0.20, 0.35, n);
    this.bloom.intensity = L(0.32, 0.45, n);
    this.vignette.darkness = L(0.12, 0.22, n);
    const dayExposure = L(0.8, 0.95, THREE.MathUtils.smoothstep(30 - sunElevDeg, 0, 25));
    this.renderer.toneMappingExposure = L(dayExposure, 1.25, n);
  }

  setQuality(q: Quality) {
    const c = this.aoPass.configuration;
    if (q === 'low') { this.aoPass.enabled = false; this.smaaPass.enabled = true; }
    else if (q === 'medium') { this.aoPass.enabled = true; c.halfRes = true; c.aoSamples = 12; c.denoiseSamples = 6; }
    else { this.aoPass.enabled = true; c.halfRes = false; c.aoSamples = 16; c.denoiseSamples = 8; }
  }

  render(dt: number) {
    if (this.reflection?.enabled) this.reflection.render(this.scene, this.camera);
    if (this.enabled) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.reflection?.debugBlit();
  }
}
