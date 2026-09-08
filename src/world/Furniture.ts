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
  /** Wallace / drinking fountains (x, y, z) for the soundscape */
  fountainPositions = new Float32Array(0);
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
      // faint up close (the real lamp light does the work there); stronger with distance so streets read as chains
      // of orange pools from the tower, as in aerial night photos
      vertexShader: 'varying vec2 vUv; varying float vD; void main(){ vUv = uv; vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform float uNight; varying vec2 vUv; varying float vD; void main(){ float d = length(vUv - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 2.2) * 0.10 * uNight * mix(1.0, 3.2, smoothstep(120.0, 500.0, vD)); gl_FragColor = vec4(vec3(1.0, 0.82, 0.55) * a, a); }',
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
    // ---- OSM street objects (points theme): Wallace fountains, métro entrances, bus shelters, bike racks, bins, flagpoles
    const parisGreen = withLamps(new THREE.MeshStandardMaterial({ color: 0x1f4a2a, roughness: 0.6, metalness: 0.3 }));
    const fountains = byKind.get(FurnitureKind.Fountain) ?? [];
    if (fountains.length) {
      place(wallace(), parisGreen, fountains);
      this.fountainPositions = new Float32Array(fountains.length * 3);
      fountains.forEach((k, n) => { const b = k * FURNITURE_STRIDE; this.fountainPositions.set([data[b], data[b + 1] + 1.2, data[b + 2]], n * 3); });
    }
    const entrances = byKind.get(FurnitureKind.SubwayEntrance) ?? [];
    if (entrances.length) place(metroEntrance(), withLamps(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 })), entrances);
    const stops = byKind.get(FurnitureKind.BusStop) ?? [];
    if (stops.length) place(busShelter(), withLamps(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.5 })), stops);
    const racks = byKind.get(FurnitureKind.BikeRack) ?? [];
    if (racks.length) place(bikeRack(), metal, racks);
    const bins = byKind.get(FurnitureKind.WasteBasket) ?? [];
    if (bins.length) place(wasteBasket(), withLamps(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 })), bins);
    const statues = byKind.get(FurnitureKind.Statue) ?? [];
    if (statues.length) place(statue(), withLamps(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 })), statues).layers.enable(REFLECT_LAYER);
    const flames = byKind.get(FurnitureKind.Flame) ?? [];
    if (flames.length) place(libertyFlame(), withLamps(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.55 })), flames).layers.enable(REFLECT_LAYER);
    const poles = byKind.get(FurnitureKind.Flagpole) ?? [];
    if (poles.length) place(flagpole(), withLamps(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide })), poles, { shadow: false });

    // ---- people: one instanced mesh with the same limb-tagged geometry/material as the walking crowd (idle sway only)
    const peopleIdx: number[] = [];
    for (let v = 0; v < 4; v++) peopleIdx.push(...(byKind.get(FurnitureKind.Person + v) ?? []));
    if (peopleIdx.length) {
      const geom = walkerGeometry();
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(peopleIdx.length * 4), 4);
      peopleIdx.forEach((k, n) => anim.setXYZW(n, 0, 0, (k * 0.618) % 1, 0));
      geom.setAttribute('aAnim', anim);
      const look = new THREE.InstancedBufferAttribute(new Float32Array(peopleIdx.length * 4), 4);
      const fr = (v: number) => v - Math.floor(v);
      peopleIdx.forEach((k, n) => look.setXYZW(n, fr(k * 0.7548), fr(k * 0.5698), fr(k * 0.3247), 0));
      geom.setAttribute('aLook', look);
      this.peopleMat = makePeopleMaterial(this.peopleUniforms);
      place(geom, this.peopleMat, peopleIdx, { colors: k => clothColor(k), scale: () => 1 });
    }

    // ---- parked cars: Kenney CC0 kit merged per variant (body tinted per instance, wheels untouched, lights off)
    const kit = await loadCarKit(CAR_VARIANTS);
    const carMat = makeCarMaterial({ uLights: { value: 0 }, uTime: { value: 0 } });
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

/** Paint a whole geometry one colour (vertex colours, so several parts can share a material). */
function tint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex), n = g.attributes.position.count, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Wallace fountain, 2.7 m: octagonal base, pedestal, four caryatid columns, dome and finial (dark green cast iron). */
function wallace(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(0.62, 0.7, 0.18, 8).translate(0, 0.09, 0),
    new THREE.CylinderGeometry(0.34, 0.42, 0.85, 8).translate(0, 0.6, 0),
    new THREE.CylinderGeometry(0.5, 0.36, 0.14, 8).translate(0, 1.1, 0),
  ];
  for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + Math.PI / 4; parts.push(new THREE.CapsuleGeometry(0.075, 0.75, 3, 8).translate(Math.cos(a) * 0.24, 1.6, Math.sin(a) * 0.24)); }
  parts.push(new THREE.SphereGeometry(0.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 2.05, 0));
  parts.push(new THREE.ConeGeometry(0.1, 0.3, 8).translate(0, 2.55, 0));
  return mergeGeometries(parts, false)!;
}

/** Métro entrance in the Guimard spirit: two flared green posts, a red "MÉTROPOLITAIN" plate, railings round the stair. */
function metroEntrance(): THREE.BufferGeometry {
  const green = 0x2f5a3a, red = 0x8a1a1a, cream = 0xe8dcb0;
  const parts: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    parts.push(tint(new THREE.CylinderGeometry(0.05, 0.09, 2.9, 8).translate(sx * 1.05, 1.45, 0), green));
    parts.push(tint(new THREE.SphereGeometry(0.16, 8, 6).translate(sx * 1.05, 2.95, 0), cream));   // the lamps
    parts.push(tint(new THREE.BoxGeometry(0.06, 0.9, 5.5).translate(sx * 1.1, 0.45, 2.9), green));   // stair railings
  }
  parts.push(tint(new THREE.BoxGeometry(2.4, 0.5, 0.06).translate(0, 2.45, 0), red));
  parts.push(tint(new THREE.BoxGeometry(2.2, 0.3, 0.02).translate(0, 2.45, 0.04), cream));
  return mergeGeometries(parts, false)!;
}

/** Bus shelter: four posts, a shallow roof, a glass back panel with an advertising board. */
function busShelter(): THREE.BufferGeometry {
  const grey = 0x555a5e, glass = 0x9fb4c4, ad = 0xd9d0c0;
  const parts: THREE.BufferGeometry[] = [];
  for (const sx of [-1.8, 1.8]) for (const sz of [-0.7, 0.7]) parts.push(tint(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8).translate(sx, 1.3, sz), grey));
  parts.push(tint(new THREE.BoxGeometry(4.0, 0.12, 1.7).translate(0, 2.62, 0), grey));
  parts.push(tint(new THREE.BoxGeometry(3.6, 2.2, 0.03).translate(0, 1.35, 0.7), glass));
  parts.push(tint(new THREE.BoxGeometry(1.2, 1.7, 0.06).translate(1.15, 1.3, 0.72), ad));
  parts.push(tint(new THREE.BoxGeometry(1.4, 0.05, 0.4).translate(-0.9, 0.5, 0.45), grey));   // bench
  return mergeGeometries(parts, false)!;
}

/** Three Sheffield hoops (arceaux) in a row. */
function bikeRack(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = -1; k <= 1; k++) {
    const x = k * 1.0;
    parts.push(new THREE.CylinderGeometry(0.025, 0.025, 0.8, 6).translate(x, 0.4, -0.35), new THREE.CylinderGeometry(0.025, 0.025, 0.8, 6).translate(x, 0.4, 0.35));
    parts.push(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6).rotateX(Math.PI / 2).translate(x, 0.8, 0));
  }
  return mergeGeometries(parts, false)!;
}

/** Paris litter bin: a post with a green hoop holding a translucent bag (drawn as a grey cylinder). */
function wasteBasket(): THREE.BufferGeometry {
  return mergeGeometries([
    tint(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 6).translate(0.25, 0.55, 0), 0x2f5a3a),
    tint(new THREE.TorusGeometry(0.22, 0.02, 6, 16).rotateX(Math.PI / 2).translate(0, 1.0, 0), 0x2f5a3a),
    tint(new THREE.CylinderGeometry(0.2, 0.14, 0.75, 10).translate(0, 0.62, 0), 0x8f9296),
  ], false)!;
}

/** 9 m flagpole with a tricolore (blue at the hoist). */
/**
 * A statue on its plinth: a stepped stone base carrying a standing bronze figure. Scale 1 is a ~4.5 m figure on a
 * 2.6 m plinth, the size of a park bronze.
 *
 * This stands in for every artwork and memorial OSM marks with a node, so it must stay ANONYMOUS. It carried a
 * raised torch and a spiked crown once, which made every park bronze in the city read as the Statue of Liberty —
 * including the one standing where the Wall for Peace should be. A named monument gets a real model instead
 * (see scripts/landmarks_models.ts).
 */
function statue(): THREE.BufferGeometry {
  const STONE = 0xb9b2a4, BRONZE = 0x5d6b52;
  const parts: THREE.BufferGeometry[] = [
    // stepped plinth
    tint(new THREE.BoxGeometry(2.6, 0.35, 2.6).translate(0, 0.175, 0), STONE),
    tint(new THREE.BoxGeometry(2.1, 0.3, 2.1).translate(0, 0.5, 0), STONE),
    tint(new THREE.BoxGeometry(1.6, 1.6, 1.6).translate(0, 1.45, 0), STONE),
    tint(new THREE.BoxGeometry(1.9, 0.22, 1.9).translate(0, 2.36, 0), STONE),
    // robed body: a tapered skirt up to the shoulders
    tint(new THREE.CylinderGeometry(0.42, 0.75, 3.0, 12).translate(0, 3.97, 0), BRONZE),
    tint(new THREE.SphereGeometry(0.44, 12, 8).translate(0, 5.5, 0), BRONZE),
    // head
    tint(new THREE.SphereGeometry(0.26, 10, 8).translate(0, 6.05, 0), BRONZE),
    // arms held close: one across the body, one down at the side
    tint(new THREE.CylinderGeometry(0.1, 0.12, 1.15, 8).rotateZ(0.42).translate(-0.46, 4.85, 0.06), BRONZE),
    tint(new THREE.CylinderGeometry(0.1, 0.12, 1.25, 8).rotateZ(-0.2).translate(0.44, 4.75, 0.1), BRONZE),
  ];
  return mergeGeometries(parts, false)!;
}

/**
 * Flamme de la Liberté: a full-size gilded replica of the torch flame the Statue of Liberty holds, standing on a
 * square stone plinth over the Alma tunnel entrance. Modelled at 3.5 m overall — the flame itself is about 2 m.
 */
function libertyFlame(): THREE.BufferGeometry {
  const STONE = 0xbdb6a6, GOLD = 0xd8ab3c;
  const parts: THREE.BufferGeometry[] = [
    tint(new THREE.BoxGeometry(2.3, 0.28, 2.3).translate(0, 0.14, 0), STONE),
    tint(new THREE.BoxGeometry(1.9, 1.15, 1.9).translate(0, 0.85, 0), STONE),
    tint(new THREE.BoxGeometry(2.1, 0.16, 2.1).translate(0, 1.5, 0), STONE),
    // the torch handle rising out of the plinth
    tint(new THREE.CylinderGeometry(0.17, 0.21, 0.55, 12).translate(0, 1.85, 0), GOLD),
    tint(new THREE.CylinderGeometry(0.30, 0.17, 0.18, 12).translate(0, 2.2, 0), GOLD),
  ];
  // The flame: tapering leaves twisted around the axis, the shape that reads from the roundabout.
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const lean = 0.22 + 0.1 * ((k % 3) / 2);
    const g = new THREE.ConeGeometry(0.16, 1.25 - 0.12 * (k % 3), 5);
    g.translate(0, 0.62, 0);
    g.rotateX(lean);
    g.rotateY(a);
    g.translate(Math.sin(a) * 0.17, 2.3, Math.cos(a) * 0.17);
    parts.push(tint(g, GOLD));
  }
  parts.push(tint(new THREE.ConeGeometry(0.13, 1.5, 6).translate(0, 2.95, 0), GOLD));
  return mergeGeometries(parts, false)!;
}

function flagpole(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [tint(new THREE.CylinderGeometry(0.04, 0.07, 9, 8).translate(0, 4.5, 0), 0xe8e8e8), tint(new THREE.SphereGeometry(0.08, 8, 6).translate(0, 9.05, 0), 0xd4b25a)];
  const cols = [0x1f3a8a, 0xf2f2f2, 0xc8102e];
  for (let k = 0; k < 3; k++) parts.push(tint(new THREE.PlaneGeometry(0.6, 1.2).translate(0.3 + k * 0.6, 8.2, 0), cols[k]));
  return mergeGeometries(parts, false)!;
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
