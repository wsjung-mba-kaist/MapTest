import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { withLamps } from '../../render/LocalLights';

/**
 * Kenney Car Kit (CC0) loader for instancing: each variant becomes ONE geometry (body + wheels + light discs) that
 * keeps the kit's palette texture (windows, bumpers, grilles, lights, tyres) and marks only the *paint* vertices.
 * The palette is an 8 x 4 grid of gradient swatches; the paint swatch is the one covering the largest triangle area of
 * the body mesh. `aBody` holds 0 for non-paint vertices and the swatch shade ratio (~0.7..1.3) for paint vertices, so
 * an instance colour replaces the paint while the swatch's gradient shading survives. `aEmit`: 1 headlight, 2 tail.
 * Models are normalised to face -z at yaw 0, wheels on y = 0, centred in x/z.
 */
export interface CarModel { geometry: THREE.BufferGeometry; length: number; width: number; height: number }

export const CAR_VARIANTS = ['sedan', 'hatchback-sports', 'suv', 'van', 'taxi', 'sedan-sports', 'police', 'delivery'] as const;

/** Paris street mix: mostly white / grey / black, a few blues, reds and beiges (sRGB). */
const PAINT: { hex: number; w: number }[] = [
  { hex: 0xf1f1ee, w: 22 }, { hex: 0xc9ccd1, w: 14 }, { hex: 0x8d9298, w: 12 }, { hex: 0x5b5f66, w: 8 }, { hex: 0x1e1f22, w: 16 },
  { hex: 0x24427a, w: 6 }, { hex: 0x4a78b5, w: 3 }, { hex: 0x9b2a2e, w: 5 }, { hex: 0xc9b99a, w: 4 }, { hex: 0x3f5a48, w: 3 },
  { hex: 0x7a3b1e, w: 2 }, { hex: 0xd08a2e, w: 1 }, { hex: 0x2a6f6a, w: 2 }, { hex: 0x6e2f5c, w: 2 },
];
const PAINT_TOTAL = PAINT.reduce((s, p) => s + p.w, 0);

export function carColor(seed: number, variant: number): number {
  if (variant === 4) return 0xf4f2ea;   // Paris taxis are mostly white
  if (variant === 6) return 0xf6f6f6;   // police white
  let r = (seed - Math.floor(seed)) * PAINT_TOTAL;
  for (const p of PAINT) { if (r < p.w) return p.hex; r -= p.w; }
  return PAINT[0].hex;
}

function tagged(g: THREE.BufferGeometry, body: Float32Array | number, emit: number, axle: [number, number, number] | null = null): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.attributes.position);
  out.setAttribute('normal', g.attributes.normal ?? g.attributes.position);
  out.setAttribute('uv', g.attributes.uv ?? new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  const n = g.attributes.position.count;
  out.setAttribute('aBody', new THREE.BufferAttribute(typeof body === 'number' ? new Float32Array(n).fill(body) : body, 1));
  out.setAttribute('aEmit', new THREE.BufferAttribute(new Float32Array(n).fill(emit), 1));
  // wheels: axle centre (y, z) and radius so the vertex shader can spin them about x
  const ax = new Float32Array(n * 3); if (axle) for (let i = 0; i < n; i++) { ax[i * 3] = axle[0]; ax[i * 3 + 1] = axle[1]; ax[i * 3 + 2] = axle[2]; }
  out.setAttribute('aAxle', new THREE.BufferAttribute(ax, 3));
  if (g.index) out.setIndex(g.index);
  if (!g.attributes.normal) out.computeVertexNormals();
  return out;
}

let texture: THREE.Texture | null = null;
let palette: { data: Uint8ClampedArray; w: number; h: number } | null = null;
const SWATCH_COLS = 8, SWATCH_ROWS = 4;

/** Read the palette pixels once so vertices can be classified by the swatch they sample. */
function paletteOf(tex: THREE.Texture) {
  if (palette) return palette;
  const img = tex.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  palette = { data: id.data, w: c.width, h: c.height };
  return palette;
}
const frac = (v: number) => v - Math.floor(v);
function texelRGB(p: { data: Uint8ClampedArray; w: number; h: number }, u: number, v: number, flipY: boolean): [number, number, number] {
  const x = Math.min(p.w - 1, Math.floor(frac(u) * p.w));
  const y = Math.min(p.h - 1, Math.floor((flipY ? 1 - frac(v) : frac(v)) * p.h));
  const o = (y * p.w + x) * 4;
  return [p.data[o], p.data[o + 1], p.data[o + 2]];
}
/** perceived luminance (sRGB bytes -> 0..1) of the texel at uv */
function texelLum(p: { data: Uint8ClampedArray; w: number; h: number }, u: number, v: number, flipY: boolean) {
  const [r, g, b] = texelRGB(p, u, v, flipY);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
const swatchOf = (u: number, v: number, flipY: boolean) => Math.floor(frac(u) * SWATCH_COLS) + SWATCH_COLS * Math.floor((flipY ? 1 - frac(v) : frac(v)) * SWATCH_ROWS);

/** aBody per vertex: swatch shade ratio where the vertex samples the model's dominant (paint) swatch, else 0. */
function paintMask(g: THREE.BufferGeometry, tex: THREE.Texture): Float32Array {
  const n = g.attributes.position.count;
  const out = new Float32Array(n);
  const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv) return out.fill(1);
  const pal = paletteOf(tex);
  const cell = new Int32Array(n);
  for (let i = 0; i < n; i++) cell[i] = swatchOf(uv.getX(i), uv.getY(i), tex.flipY);
  // area-weighted histogram over triangles
  const pos = g.attributes.position as THREE.BufferAttribute;
  const idx = g.index;
  const tris = idx ? idx.count / 3 : n / 3;
  const hist = new Map<number, number>();
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    A.fromBufferAttribute(pos, a); B.fromBufferAttribute(pos, b); C.fromBufferAttribute(pos, c);
    const area = B.sub(A).cross(C.sub(A)).length() * 0.5;
    hist.set(cell[a], (hist.get(cell[a]) ?? 0) + area);
  }
  // paint = largest swatch that is neither dark trim / tyres nor the kit's grey-blue glass swatch (unless glass is
  // all there is, as on the plain sedan whose body uses that very swatch)
  const meanOf = (c: number) => {
    let r = 0, g = 0, b = 0, m = 0;
    for (let i = 0; i < n; i++) if (cell[i] === c) { const [tr, tg, tb] = texelRGB(pal, uv.getX(i), uv.getY(i), tex.flipY); r += tr; g += tg; b += tb; m++; }
    return m ? [r / m, g / m, b / m] : [0, 0, 0];
  };
  const ranked = [...hist.entries()].sort((p, q) => q[1] - p[1]).map(([c, a]) => ({ c, a, rgb: meanOf(c) }));
  const isDark = (rgb: number[]) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.3;
  const isGlass = (rgb: number[]) => Math.abs(rgb[0] - 107) < 22 && Math.abs(rgb[1] - 109) < 22 && Math.abs(rgb[2] - 130) < 25;
  const candidates = ranked.filter(s => !isDark(s.rgb));
  const nonGlass = candidates.filter(s => !isGlass(s.rgb) && s.a > candidates[0].a * 0.08);
  const paint = (nonGlass[0] ?? candidates[0] ?? ranked[0])?.c ?? -1;
  // shade ratio relative to the swatch's mean luminance
  let sum = 0, cnt = 0;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) if (cell[i] === paint) { lum[i] = texelLum(pal, uv.getX(i), uv.getY(i), tex.flipY); sum += lum[i]; cnt++; }
  const mean = cnt ? sum / cnt : 1;
  for (let i = 0; i < n; i++) out[i] = cell[i] === paint ? Math.max(0.55, Math.min(1.35, lum[i] / Math.max(0.05, mean))) : 0;
  return out;
}

export async function loadCarModel(name: string, targetLength: number): Promise<CarModel> {
  const gltf = await new GLTFLoader().loadAsync(`/models/cars/${name}.glb`);
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const scale = targetLength / Math.max(size.x, size.z);
  const fix = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
  fix.premultiply(new THREE.Matrix4().makeRotationY(Math.PI)); // Kenney cars point +z; ours face -z
  const parts: THREE.BufferGeometry[] = [];
  gltf.scene.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = mesh.material as THREE.MeshStandardMaterial;
    if (!texture && m.map) { texture = m.map; texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; }
    const g = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(fix, mesh.matrixWorld));
    const nm = (mesh.name || '').toLowerCase();
    const isWheel = /wheel|tire/.test(nm);
    let axle: [number, number, number] | null = null;
    if (isWheel) { g.computeBoundingBox(); const bb = g.boundingBox!; axle = [(bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2, Math.max(0.15, (bb.max.y - bb.min.y) / 2)]; }
    parts.push(tagged(g, isWheel || !texture ? 0 : paintMask(g, texture), 0, axle));
  });
  const merged0 = mergeGeometries(parts, false)!;
  merged0.computeBoundingBox();
  const b = merged0.boundingBox!;
  const w = b.max.x - b.min.x, h = b.max.y - b.min.y;
  // Light discs: headlights at the front (-z), tail lights at the rear (+z).
  // CircleGeometry faces +z, so headlights are turned round before being placed on the front (-z) face.
  const lights: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    lights.push(tagged(new THREE.CircleGeometry(0.13, 10).rotateY(Math.PI).translate(sx * w * 0.33, h * 0.42, b.min.z - 0.02), 0, 1));
    lights.push(tagged(new THREE.CircleGeometry(0.1, 8).translate(sx * w * 0.36, h * 0.4, b.max.z + 0.02), 0, 2));
  }
  const geometry = mergeGeometries([merged0, ...lights], false)!;
  geometry.computeBoundingSphere();
  return { geometry, length: b.max.z - b.min.z, width: w, height: h };
}

export async function loadCarKit(names: readonly string[]): Promise<Map<string, CarModel>> {
  const out = new Map<string, CarModel>();
  for (const n of names) {
    try { out.set(n, await loadCarModel(n, n === 'van' || n === 'delivery' ? 5.2 : 4.4)); } catch (e) { console.warn(`car model ${n} missing`, e); }
  }
  return out;
}

export function carTexture() { return texture; }

/**
 * Car material: the kit's palette texture everywhere, the instance colour replacing the paint swatch (glossier,
 * slightly metallic), head / tail lights emissive at night. three's own instance-colour multiply (`vColor`) is
 * bypassed: `color_fragment` is replaced, not appended, so the texture keeps its colours outside the paint.
 */
type CarUniforms = { uLights: { value: number }; uTime: { value: number } };

/** Vertex side shared by cars and buses: paint / light tags, wheel spin about the axle, per-instance state to the fragment. */
function carVertexPatch(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aBody; attribute float aEmit; attribute vec3 aAxle; attribute vec3 aState; varying float vEmit; varying float vBody; varying vec3 vPaint; varying vec3 vState; varying float vSide;')
    // wheels spin about their axle by odometer / radius (aState.z); the car faces -z, so forward is a negative angle
    .replace('#include <beginnormal_vertex>', /* glsl */`#include <beginnormal_vertex>
      if (aAxle.z > 0.0) { float ang = -aState.z / aAxle.z; float c = cos(ang), s = sin(ang); objectNormal.yz = vec2(c * objectNormal.y - s * objectNormal.z, s * objectNormal.y + c * objectNormal.z); }`)
    .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
      if (aAxle.z > 0.0) { float ang = -aState.z / aAxle.z; float c = cos(ang), s = sin(ang); vec2 d = transformed.yz - aAxle.xy; transformed.yz = aAxle.xy + vec2(c * d.x - s * d.y, s * d.x + c * d.y); }`)
    .replace('#include <color_vertex>', /* glsl */`#include <color_vertex>
      vEmit = aEmit; vBody = aBody; vState = aState; vSide = position.x;
      vPaint = vec3(0.85);
      #ifdef USE_INSTANCING_COLOR
        vPaint = instanceColor.xyz;
      #endif`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uLights; uniform float uTime; varying float vEmit; varying float vBody; varying vec3 vPaint; varying vec3 vState; varying float vSide;');
}

/** Fragment side shared by cars and buses: light-disc albedo, night glow + brake + blinking indicator. */
const LIGHT_DISCS = /* glsl */`
  if (vEmit > 0.5) diffuseColor.rgb = vEmit > 1.5 ? vec3(0.5, 0.05, 0.03) : vec3(0.9, 0.9, 0.85);`;
const LIGHT_EMISSIVE = /* glsl */`#include <emissivemap_fragment>
  if (vEmit > 0.5) {
    float blink = step(0.5, fract(uTime * 1.25));
    float ind = (abs(vState.y) > 0.5 && vSide * vState.y > 0.0) ? blink : 0.0;
    vec3 amber = vec3(1.0, 0.45, 0.05);
    totalEmissiveRadiance += vEmit > 1.5 ? vec3(1.0, 0.08, 0.04) * (uLights * 3.5 + vState.x * 5.0) + amber * ind * 6.0 : vec3(1.0, 0.95, 0.8) * uLights * 9.0 + amber * ind * 4.0;
  }`;

export function makeCarMaterial(uniforms: CarUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.55, metalness: 0.12 });
  mat.customProgramCacheKey = () => 'carkit-v5';
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    carVertexPatch(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', /* glsl */`
        // paint swatch -> instance colour times the swatch's gradient shade; everything else keeps the palette texture
        if (vBody > 0.01) diffuseColor.rgb = vPaint * vBody;` + LIGHT_DISCS)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vBody > 0.01 ? 0.3 : roughness;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vBody > 0.01 ? 0.5 : metalness;')
      .replace('#include <emissivemap_fragment>', LIGHT_EMISSIVE);
  };
  withLamps(mat);
  return mat;
}

/** Bus material: vertex-coloured livery (no palette texture), same lights / wheels / state as the cars. */
export function makeBusMaterial(uniforms: CarUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15 });
  mat.customProgramCacheKey = () => 'bus-v1';
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    carVertexPatch(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>' + LIGHT_DISCS)
      .replace('#include <emissivemap_fragment>', LIGHT_EMISSIVE);
  };
  withLamps(mat);
  return mat;
}

/** RATP-style standard bus, 12 m: white body, jade band, dark window strip, four spinning wheels, light discs. */
export function busModel(): CarModel {
  const col = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  const L = 12, W = 2.55;
  const parts: THREE.BufferGeometry[] = [
    col(tagged(new THREE.BoxGeometry(W, 2.6, L).translate(0, 1.85, 0), 0, 0), 0xf2f2ee),
    col(tagged(new THREE.BoxGeometry(W + 0.03, 0.55, L + 0.02).translate(0, 0.95, 0), 0, 0), 0x2a8c74),
    col(tagged(new THREE.BoxGeometry(W + 0.05, 0.95, L - 1.0).translate(0, 2.45, 0), 0, 0), 0x14171c),
    col(tagged(new THREE.BoxGeometry(W - 0.3, 1.7, 0.06).translate(0, 2.15, -L / 2 - 0.01), 0, 0), 0x14171c),
    col(tagged(new THREE.BoxGeometry(1.6, 0.35, 3.0).translate(0, 3.3, 1.0), 0, 0), 0x9a9ea3),
  ];
  for (const sx of [-1.05, 1.05]) for (const sz of [-3.9, 3.9]) parts.push(col(tagged(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 14).rotateZ(Math.PI / 2).translate(sx, 0.5, sz), 0, 0, [0.5, sz, 0.5]), 0x17181a));
  for (const sx of [-0.9, 0.9]) {
    parts.push(col(tagged(new THREE.CircleGeometry(0.16, 10).rotateY(Math.PI).translate(sx, 1.0, -L / 2 - 0.03), 0, 1), 0xffffff));
    parts.push(col(tagged(new THREE.CircleGeometry(0.14, 8).translate(sx * 1.05, 1.35, L / 2 + 0.02), 0, 2), 0xffffff));
  }
  const geometry = mergeGeometries(parts, false)!;
  geometry.computeBoundingSphere();
  return { geometry, length: L, width: W, height: 3.5 };
}
