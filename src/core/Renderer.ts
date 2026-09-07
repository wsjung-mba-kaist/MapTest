import * as THREE from 'three';

/** What the browser handed us: the unmasked adapter name and whether it is a software / integrated device. */
export interface GpuInfo { name: string; software: boolean; integrated: boolean; caveat: boolean }
let info: GpuInfo = { name: 'unknown', software: false, integrated: false, caveat: false };
export function gpuInfo(): GpuInfo { return info; }

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|mesa offscreen|warp/i;
const INTEGRATED_RE = /intel\(r\) (u?hd|iris|arc\(tm\) graphics)|radeon\(tm\) (vega|graphics)|amd radeon graphics|apple (m\d|gpu)|adreno|mali|powervr/i;

const ATTRS = { antialias: false, stencil: false, depth: true, powerPreference: 'high-performance' as const, alpha: false };

/**
 * Hardware first: `failIfMajorPerformanceCaveat` makes the browser refuse a software (SwiftShader / WARP) context
 * instead of silently handing one out, and `powerPreference: 'high-performance'` asks for the discrete GPU where the
 * browser can choose one (macOS; on Windows the GPU is the one the OS assigns to the browser process). Only if that
 * fails do we accept whatever is available, on a fresh canvas, and flag it so the HUD can tell the user.
 */
export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  let renderer: THREE.WebGLRenderer;
  let caveat = false;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, ...ATTRS, failIfMajorPerformanceCaveat: true });
  } catch (e) {
    console.warn('[gpu] no hardware-accelerated WebGL2 context, falling back to software rendering', e);
    // a failed creation attempt can leave the canvas without a usable context mode: retry on a fresh element
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    renderer = new THREE.WebGLRenderer({ canvas: fresh, ...ATTRS });
    caveat = true;
  }
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).replace(/^ANGLE \((.*)\)$/, '$1');
  info = { name, software: caveat || SOFTWARE_RE.test(name), integrated: !caveat && INTEGRATED_RE.test(name), caveat };
  console.info(`[gpu] ${name}${info.software ? '  (software rendering)' : info.integrated ? '  (integrated GPU)' : ''}`);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}
