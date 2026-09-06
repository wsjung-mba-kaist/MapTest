import * as THREE from 'three';
import { shopOpen } from '../../shared/nightlife';

/**
 * Local lighting injected into every lit material as a small uniform array evaluated with three's own BRDF
 * (RE_Direct). Cheaper and more scalable than PointLights: a fixed array size means no shader recompiles, the loop
 * skips empty slots, and one CPU update feeds all materials. No shadows.
 *
 * Slots 0..STATIC_N-1 hold the nearest static lights (street lamps, shop fronts, the tower's base projectors) picked
 * from a coarse grid; slots STATIC_N.. hold dynamic lights rewritten every frame (car headlights and tail lights,
 * the bateaux-mouches' floodlights). Lights may be spots: uLampDir.w is the cosine of the half-angle (-2 = point).
 */
export const STATIC_N = 32;
export const DYN_N = 16;
export const LAMP_N = STATIC_N + DYN_N;

export const lampUniforms = {
  uLampPos: { value: new Float32Array(LAMP_N * 4) },   // xyz world, w = cut-off radius (0 = empty slot)
  uLampCol: { value: new Float32Array(LAMP_N * 4) },   // rgb linear radiance scale, w unused
  uLampDir: { value: new Float32Array(LAMP_N * 4).fill(-2) },   // spot direction (world) + cos half-angle; w = -2 for point lights
  uLampNight: { value: 0 },
};

export type LightKind = 'lamp' | 'shop' | 'restaurant' | 'tower' | 'dynamic';
export interface LocalLight {
  x: number; y: number; z: number;
  radius: number;
  r: number; g: number; b: number;
  intensity: number;
  kind?: LightKind;
  /** spot light: unit direction and half-angle (radians) */
  dx?: number; dy?: number; dz?: number; cone?: number;
}

export const LAMP_COLOR = new THREE.Color(1.0, 0.74, 0.46);   // ~3000 K street LED / warm sodium mix
export const LAMP_INTENSITY = 52;
export const LAMP_RADIUS = 30;

const FRAG_DECL = /* glsl */`
#define LAMP_N ${LAMP_N}
uniform vec4 uLampPos[LAMP_N];
uniform vec4 uLampCol[LAMP_N];
uniform vec4 uLampDir[LAMP_N];
uniform float uLampNight;
varying vec3 vWorldPosL;
`;
const FRAG_LOOP = /* glsl */`
#if defined( RE_Direct )
if (uLampNight > 0.001) {
  for (int i = 0; i < LAMP_N; i++) {
    vec4 lp = uLampPos[i];
    if (lp.w <= 0.0) continue;
    vec3 Lw = lp.xyz - vWorldPosL;
    float d2 = dot(Lw, Lw);
    if (d2 > lp.w * lp.w) continue;
    float d = sqrt(d2);
    float xr = d / lp.w; float win = 1.0 - xr * xr * xr * xr; win *= win;   // Frostbite window
    // the source is a lantern / headlamp, not a point: clamp the inverse-square at ~2.5 m so surfaces right under
    // a lamp do not burn to white under AgX
    float att = win / max(d2, 6.0);
    vec4 ld = uLampDir[i];
    if (ld.w > -1.5) {   // spot: smooth cone edge
      float c = dot(-Lw / d, ld.xyz);
      att *= smoothstep(ld.w, ld.w + 0.12, c);
      if (att <= 0.0) continue;
    }
    IncidentLight lampLight;
    lampLight.direction = normalize((viewMatrix * vec4(Lw / d, 0.0)).xyz);
    lampLight.color = uLampCol[i].rgb * (att * uLampNight);
    lampLight.visible = true;
    RE_Direct(lampLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  }
}
#endif
`;
const VERT_DECL = 'varying vec3 vWorldPosL;';
const VERT_BODY = /* glsl */`
{
  vec4 wpL = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wpL = instanceMatrix * wpL;
  #endif
  vWorldPosL = (modelMatrix * wpL).xyz;
}`;

/** Add the lamp array to a shader (call from onBeforeCompile). */
export function injectLampLights(shader: THREE.WebGLProgramParametersWithUniforms) {
  Object.assign(shader.uniforms, lampUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${VERT_BODY}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FRAG_LOOP}`);
}

/** Wrap a lit material so its (possibly already patched) shader also receives the lamp array. Idempotent. */
export function withLamps<T extends THREE.Material>(mat: T): T {
  if (mat.userData.lamps) return mat;
  mat.userData.lamps = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    injectLampLights(shader);
  };
  const prevKey = mat.customProgramCacheKey;
  const isDefault = prevKey === THREE.Material.prototype.customProgramCacheKey;
  mat.customProgramCacheKey = () => `${isDefault ? mat.type : prevKey.call(mat)}:lamps2`;
  return mat;
}

/** Street lamp light record from a lantern position. */
export const lampLight = (x: number, y: number, z: number): LocalLight => ({ x, y, z, radius: LAMP_RADIUS, r: LAMP_COLOR.r, g: LAMP_COLOR.g, b: LAMP_COLOR.b, intensity: LAMP_INTENSITY, kind: 'lamp' });

/** Nearest-light selection on a coarse grid (static lights) plus per-frame dynamic lights. */
export class LocalLights {
  enabled = true;
  debug = false;
  private cell = 64;
  private readonly groups = new Map<string, LocalLight[]>();
  private all: LocalLight[] = [];
  private grid = new Map<number, number[]>();
  private dynamic: LocalLight[] = [];
  private lastX = NaN; private lastZ = NaN; private lastT = 0;
  /** brightness multipliers applied per kind at selection time (hour-dependent) */
  hour = 12;
  towerScale = 1;

  /** Register / replace a named group of static lights (lamps, one group per building chunk for shop fronts...). */
  addLights(key: string, list: LocalLight[]) { this.groups.set(key, list); this.rebuild(); }
  removeLights(key: string) { if (this.groups.delete(key)) this.rebuild(); }
  /** Legacy helper: lamp positions as a flat xyz array (already at lantern height). */
  setLamps(xyz: Float32Array) {
    const list: LocalLight[] = [];
    for (let i = 0; i < xyz.length / 3; i++) list.push(lampLight(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]));
    this.addLights('lamps', list);
  }
  /** Lights rewritten every frame (headlights, boats); at most DYN_N are used. */
  setDynamic(list: LocalLight[]) { this.dynamic = list; }

  private rebuild() {
    this.all = [];
    for (const g of this.groups.values()) for (const l of g) this.all.push(l);
    this.grid.clear();
    this.all.forEach((l, i) => {
      const k = this.key(Math.floor(l.x / this.cell), Math.floor(l.z / this.cell));
      const arr = this.grid.get(k); if (arr) arr.push(i); else this.grid.set(k, [i]);
    });
    this.lastX = NaN;
  }
  private key(i: number, j: number) { return (i + 2048) * 4096 + (j + 2048); }

  private scaleOf(l: LocalLight): number {
    switch (l.kind) {
      case 'shop': return shopOpen(this.hour, false);
      case 'restaurant': return shopOpen(this.hour, true);
      case 'tower': return this.towerScale;
      default: return 1;
    }
  }

  private write(slot: number, l: LocalLight, fade: number) {
    const P = lampUniforms.uLampPos.value, C = lampUniforms.uLampCol.value, D = lampUniforms.uLampDir.value;
    const k = this.scaleOf(l) * fade * (this.debug ? 1 : 1);
    P[slot * 4] = l.x; P[slot * 4 + 1] = l.y; P[slot * 4 + 2] = l.z; P[slot * 4 + 3] = k > 0.001 ? l.radius : 0;
    const col = this.debug ? [1, 0, 1] : [l.r, l.g, l.b];
    C[slot * 4] = col[0] * l.intensity * k; C[slot * 4 + 1] = col[1] * l.intensity * k; C[slot * 4 + 2] = col[2] * l.intensity * k; C[slot * 4 + 3] = 0;
    if (l.cone !== undefined && l.dx !== undefined) { D[slot * 4] = l.dx; D[slot * 4 + 1] = l.dy ?? 0; D[slot * 4 + 2] = l.dz ?? 0; D[slot * 4 + 3] = Math.cos(l.cone); }
    else { D[slot * 4] = 0; D[slot * 4 + 1] = -1; D[slot * 4 + 2] = 0; D[slot * 4 + 3] = -2; }
  }

  update(x: number, z: number, night: number, now = performance.now()) {
    lampUniforms.uLampNight.value = this.enabled ? night : 0;
    // dynamic slots every call (cheap)
    const P = lampUniforms.uLampPos.value;
    let dn = 0;
    for (const l of this.dynamic) { if (dn >= DYN_N) break; this.write(STATIC_N + dn, l, 1); dn++; }
    for (let k = dn; k < DYN_N; k++) P[(STATIC_N + k) * 4 + 3] = 0;
    // static selection: throttled
    if (Number.isFinite(this.lastX) && Math.hypot(x - this.lastX, z - this.lastZ) < 1.5 && now - this.lastT < 250) return;
    this.lastX = x; this.lastZ = z; this.lastT = now;
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    const cand: { d2: number; i: number }[] = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const i of this.grid.get(this.key(ci + di, cj + dj)) ?? []) {
        const l = this.all[i];
        const dx = l.x - x, dz = l.z - z;
        cand.push({ d2: dx * dx + dz * dz, i });
      }
    }
    cand.sort((a, b) => a.d2 - b.d2);
    let n = 0, shops = 0;
    for (let k = 0; k < cand.length && n < STATIC_N; k++) {
      const l = this.all[cand[k].i];
      if (l.kind === 'shop' || l.kind === 'restaurant') { if (shops >= 10) continue; shops++; }   // lamps keep priority
      const fade = 1 - THREE.MathUtils.smoothstep(n, STATIC_N - 8, STATIC_N);   // the last slots fade so rank changes never pop
      this.write(n, l, fade);
      n++;
    }
    for (let k = n; k < STATIC_N; k++) P[k * 4 + 3] = 0;
  }
}

export const localLights = new LocalLights();
