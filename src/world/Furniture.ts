import * as THREE from 'three';
import { CAR_VARIANTS, carColor, loadCarKit, makeCarMaterial } from './life/CarKit';
import { makePeopleMaterial, walkerGeometry } from './life/PersonMesh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FURNITURE_STRIDE, FurnitureKind } from '../../shared/layout';
import type { SurfaceGrid } from '../../shared/surfacegrid';
import { DATA_URL, fetchBuffer } from './DataLoader';
import { withLamps } from '../render/LocalLights';
import { REFLECT_LAYER } from '../render/WaterReflection';

/**
 * Street furniture and street life as instanced meshes: lamp posts with lanterns that glow after dusk
 * (plus a cheap additive light pool), benches, bollards, Morris columns, parked cars (Kenney CC0 kit,
 * recoloured per instance) and simple pedestrians.
 */
export class Furniture {
  readonly group = new THREE.Group();
  count = 0;
  private readonly uniforms = { uNight: { value: 0 } };
  private lanternMat!: THREE.MeshStandardMaterial;
  private poolMat!: THREE.ShaderMaterial;
  /** xyz per street lamp at lantern height (for LocalLights). */
  lampPositions = new Float32Array(0);
  private glare: THREE.Points | null = null;
  private peopleMat?: THREE.MeshStandardMaterial;
  private readonly peopleUniforms = { uTime: { value: 0 } };

  constructor() { this.group.name = 'furniture'; }

  private surface: SurfaceGrid | null = null;

  async load(surface: SurfaceGrid | null = null) {
    this.surface = surface;
    const data = new Float32Array(await fetchBuffer(`${DATA_URL}/furniture.bin`));
    this.count = data.length / FURNITURE_STRIDE;
    const byKind = new Map<number, number[]>();
    for (let k = 0; k < this.count; k++) { const kind = data[k * FURNITURE_STRIDE + 4]; const arr = byKind.get(kind); if (arr) arr.push(k); else byKind.set(kind, [k]); }

    const metal = withLamps(new THREE.MeshStandardMaterial({ color: 0x2a3330, roughness: 0.6, metalness: 0.6 }));
    this.lanternMat = withLamps(new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.4 }));
    this.poolMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uNight; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 2.2) * 0.10 * uNight; gl_FragColor = vec4(vec3(1.0, 0.82, 0.55) * a, a); }',
    });

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const place = (geom: THREE.BufferGeometry, mat: THREE.Material, idx: number[], opts: { yOff?: number; flat?: boolean; shadow?: boolean; colors?: (k: number, n: number) => THREE.Color | null; scale?: (k: number) => number; yawOff?: number; lift?: boolean } = {}) => {
      const mesh = new THREE.InstancedMesh(geom, mat, idx.length);
      const col = new THREE.Color();
      idx.forEach((k, n) => {
        const b = k * FURNITURE_STRIDE;
        // things standing on a sidewalk slab ride up the kerb (cars stay on the road)
        const lift = opts.lift === false ? 0 : (this.surface?.lift(data[b], data[b + 2]) ?? 0);
        p.set(data[b], data[b + 1] + (opts.yOff ?? 0) + lift, data[b + 2]);
        q.setFromAxisAngle(UP, opts.flat ? 0 : data[b + 3] + (opts.yawOff ?? 0));
        const sc = (data[b + 5] || 1) * (opts.scale ? opts.scale(k) : 1);
        s.set(sc, sc, sc);
        m.compose(p, q, s); mesh.setMatrixAt(n, m);
        const c = opts.colors?.(k, n); if (c) mesh.setColorAt(n, col.copy(c));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = opts.shadow ?? true; mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };

    const lamps = byKind.get(FurnitureKind.StreetLamp) ?? [];
    // Lantern positions for the local-light system (lantern body sits ~5 m up the post, scaled per row).
    this.lampPositions = new Float32Array(lamps.length * 3);
    lamps.forEach((k, n) => { const b = k * FURNITURE_STRIDE; this.lampPositions.set([data[b], data[b + 1] + 5.0 * (data[b + 5] || 1), data[b + 2]], n * 3); });
    if (lamps.length) {
      place(lampPost(), metal, lamps).layers.enable(REFLECT_LAYER);
      place(lantern(), this.lanternMat, lamps, { shadow: false }).layers.enable(REFLECT_LAYER);
      const pool = new THREE.PlaneGeometry(16, 16); pool.rotateX(-Math.PI / 2);
      place(pool, this.poolMat, lamps, { yOff: 0.06, flat: true, shadow: false });
      this.glare = lanternGlare(this.lampPositions);
      this.glare.layers.enable(REFLECT_LAYER);
      this.group.add(this.glare);
    }
    const benches = byKind.get(FurnitureKind.Bench) ?? [];
    if (benches.length) place(bench(), withLamps(new THREE.MeshStandardMaterial({ color: 0x2f5a3a, roughness: 0.7 })), benches);
    const bollards = byKind.get(FurnitureKind.Bollard) ?? [];
    if (bollards.length) place(new THREE.CylinderGeometry(0.09, 0.11, 1.0, 8).translate(0, 0.5, 0), metal, bollards);
    const columns = byKind.get(FurnitureKind.MorrisColumn) ?? [];
    if (columns.length) place(morris(), withLamps(new THREE.MeshStandardMaterial({ color: 0x22402e, roughness: 0.7 })), columns);

    // ---- people: one instanced mesh with the same limb-tagged geometry/material as the walking crowd (idle sway only)
    const peopleIdx: number[] = [];
    for (let v = 0; v < 4; v++) peopleIdx.push(...(byKind.get(FurnitureKind.Person + v) ?? []));
    if (peopleIdx.length) {
      const geom = walkerGeometry();
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(peopleIdx.length * 4), 4);
      peopleIdx.forEach((k, n) => anim.setXYZW(n, 0, 0, (k * 0.618) % 1, 0));
      geom.setAttribute('aAnim', anim);
      this.peopleMat = makePeopleMaterial(this.peopleUniforms);
      place(geom, this.peopleMat, peopleIdx, { colors: k => clothColor(k), scale: () => 1 });
    }

    // ---- parked cars: Kenney CC0 kit merged per variant (body tinted per instance, wheels untouched, lights off)
    const kit = await loadCarKit(CAR_VARIANTS);
    const carMat = makeCarMaterial({ uLights: { value: 0 } });
    CAR_VARIANTS.forEach((name, v) => {
      const idx = byKind.get(FurnitureKind.Car + v) ?? [];
      if (!idx.length) return;
      const model = kit.get(name);
      const colors = (k: number) => new THREE.Color(carColor(((k * 7 + v) % 97) / 97, v));
      if (model) place(model.geometry, carMat, idx, { lift: false, colors });
      else place(fallbackCar(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.3 }), idx, { lift: false, colors });
    });
  }

  update(night: number, time = 0) {
    this.peopleUniforms.uTime.value = time;
    this.uniforms.uNight.value = night;
    if (this.lanternMat) this.lanternMat.emissiveIntensity = 5.0 * night;
    if (this.glare) (this.glare.material as THREE.ShaderMaterial).uniforms.uNight.value = night;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

const CLOTH = [0x2b2f3a, 0x8c2f2f, 0x2f5a3a, 0xe0d8c8, 0x3a3a3a, 0x5a6a9a, 0xa07040, 0x1f1f24, 0xc8c0b8, 0x704060];
function clothColor(k: number): THREE.Color { return new THREE.Color(CLOTH[(k * 13) % CLOTH.length]); }


function lampPost(): THREE.BufferGeometry {
  const base = new THREE.CylinderGeometry(0.16, 0.2, 0.9, 10).translate(0, 0.45, 0);
  const pole = new THREE.CylinderGeometry(0.06, 0.09, 3.6, 8).translate(0, 0.9 + 1.8, 0);
  const collar = new THREE.CylinderGeometry(0.11, 0.08, 0.25, 8).translate(0, 4.5, 0);
  return mergeGeometries([base, pole, collar])!;
}
function lantern(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.16, 0.24, 0.55, 6).translate(0, 4.9, 0);
  const cap = new THREE.ConeGeometry(0.3, 0.3, 6).translate(0, 5.32, 0);
  return mergeGeometries([body, cap])!;
}
function bench(): THREE.BufferGeometry {
  const seat = new THREE.BoxGeometry(1.8, 0.06, 0.45).translate(0, 0.45, 0);
  const back = new THREE.BoxGeometry(1.8, 0.4, 0.05).translate(0, 0.72, -0.2);
  const legL = new THREE.BoxGeometry(0.06, 0.45, 0.4).translate(-0.8, 0.22, 0);
  const legR = new THREE.BoxGeometry(0.06, 0.45, 0.4).translate(0.8, 0.22, 0);
  return mergeGeometries([seat, back, legL, legR])!;
}
function morris(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.7, 0.7, 2.8, 12).translate(0, 1.4, 0);
  const dome = new THREE.SphereGeometry(0.75, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 2.8, 0);
  return mergeGeometries([body, dome])!;
}
function fallbackCar(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1.8, 0.55, 4.3).translate(0, 0.55, 0);
  const cabin = new THREE.BoxGeometry(1.6, 0.5, 2.0).translate(0, 1.05, -0.2);
  const g = mergeGeometries([body, cabin])!;
  const n = g.attributes.position.count; const col = new Float32Array(n * 3).fill(1);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** One additive point per lantern: the soft glare a bright lamp leaves on the eye / camera at night. */
function lanternGlare(xyz: Float32Array): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNight: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      uniform float uNight; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(1.0, -mv.z);
        gl_PointSize = clamp(520.0 / d, 6.0, 90.0);
        vA = uNight * clamp(1.4 - d / 220.0, 0.25, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main() { float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; float a = pow(1.0 - r, 2.6) * 0.5 * vA; gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * a, a); }`,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  p.renderOrder = 4;
  return p;
}
