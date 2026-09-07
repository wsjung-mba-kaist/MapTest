import * as THREE from 'three';

/** What the browser handed us: the unmasked adapter name and whether it is a software / integrated device. */
export interface GpuInfo { name: string; raw: string; vendor: string; software: boolean; integrated: boolean; caveat: boolean }
let info: GpuInfo = { name: 'unknown', raw: '', vendor: 'unknown', software: false, integrated: false, caveat: false };
export function gpuInfo(): GpuInfo { return info; }

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|mesa offscreen|warp/i;
// integrated parts: Intel UHD/Iris/Arc Graphics, AMD "Radeon(TM) Graphics" / Vega / 6x0M-8x0M APU GPUs (discrete AMD mobile parts carry "RX")
const INTEGRATED_RE = /intel\(r\) (u?hd|iris|arc\(tm\) graphics)|radeon(\(tm\))? (\d{3}m\b|vega|graphics)|apple (m\d|gpu)|adreno|mali|powervr/i;

/** "ANGLE (AMD, AMD Radeon(TM) 610M (0x0000164E) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.21039.3004)" -> "AMD Radeon(TM) 610M" */
function shortName(raw: string): string {
  const inner = raw.replace(/^ANGLE \((.*)\)$/, '$1');
  const parts = inner.split(', ');
  const dev = (parts.length >= 2 ? parts[1] : inner).replace(/\s*\(0x[0-9A-Fa-f]+\)/g, '').replace(/\s+(Direct3D\d+|OpenGL|Vulkan|Metal)\b.*$/, '').trim();
  return dev || inner;
}

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
  const raw = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const name = shortName(raw);
  info = { name, raw, vendor: caveat ? 'software' : vendorOf(raw), software: caveat || SOFTWARE_RE.test(raw), integrated: !caveat && INTEGRATED_RE.test(raw), caveat };
  console.info(`[gpu] ${raw}${info.software ? '  (software rendering)' : info.integrated ? '  (integrated GPU - assign the browser to the high-performance GPU in Windows graphics settings)' : ''}`);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

/** Coarse vendor key from a renderer / adapter string. */
export function vendorOf(name: string): string {
  const s = name.toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|basic render|warp/.test(s)) return 'software';
  if (/nvidia|geforce|quadro/.test(s)) return 'nvidia';
  if (/\bamd\b|radeon/.test(s)) return 'amd';
  if (/intel|iris\b|arc\(tm\)/.test(s)) return 'intel';
  if (/apple/.test(s)) return 'apple';
  if (/qualcomm|adreno/.test(s)) return 'qualcomm';
  if (/\barm\b|mali/.test(s)) return 'arm';
  return 'unknown';
}

export interface HpAdapter { vendor: string; architecture: string; description: string }
let hp: HpAdapter | null | undefined;   // undefined = not probed yet

/** Result of the last probe (undefined before it ran). */
export function hpAdapter(): HpAdapter | null | undefined { return hp; }

/**
 * WebGPU enumerates every adapter on Windows even though WebGL is pinned to the browser's GPU process: asking it for the
 * high-performance adapter tells us whether a stronger GPU exists that the WebGL context is not using.
 */
export async function probeHighPerfAdapter(): Promise<HpAdapter | null> {
  if (hp !== undefined) return hp;
  hp = null;
  try {
    type Info = { vendor?: string; architecture?: string; description?: string; device?: string };
    type Adapter = { info?: Info; requestAdapterInfo?: () => Promise<Info> };
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: { powerPreference?: string }): Promise<Adapter | null> } }).gpu;
    if (!gpu) return hp;
    const a = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return hp;
    const i = a.info ?? (a.requestAdapterInfo ? await a.requestAdapterInfo() : undefined);
    if (i) {
      const desc = i.description || i.device || '';
      const vendor = (i.vendor && i.vendor !== 'unknown') ? vendorOf(i.vendor) === 'unknown' ? i.vendor : vendorOf(i.vendor) : vendorOf(desc);
      hp = { vendor, architecture: i.architecture ?? '', description: desc };
      console.info(`[gpu] WebGPU high-performance adapter: ${vendor}${i.architecture ? ` (${i.architecture})` : ''}${desc ? ` ${desc}` : ''}`);
    }
  } catch (e) { console.info('[gpu] WebGPU adapter probe unavailable', e); }
  return hp;
}
