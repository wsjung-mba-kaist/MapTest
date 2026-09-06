declare module 'n8ao' {
  import type { Camera, Color, Scene } from 'three';
  import { Pass } from 'postprocessing';
  export interface N8AOConfig {
    aoRadius: number; distanceFalloff: number; intensity: number; color: Color;
    aoSamples: number; denoiseSamples: number; denoiseRadius: number; halfRes: boolean;
    screenSpaceRadius: boolean; depthAwareUpsampling: boolean; gammaCorrection: boolean;
    renderMode: number; biasOffset: number; biasMultiplier: number; transparencyAware: boolean; accumulate: boolean;
  }
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfig;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
    setSize(width: number, height: number): void;
    enabled: boolean;
  }
  export class N8AOPass extends N8AOPostPass {}
}
