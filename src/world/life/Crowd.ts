import * as THREE from 'three';
import type { SurfaceGrid } from '../../../shared/surfacegrid';
import type { PathGraph, EdgePoint } from './PathGraph';
import type { SimClock } from './SimClock';
import { EdgeFlag } from '../../../shared/paths';
import { hash32 } from '../../../shared/hash';
import { CLOTH_PALETTE, makePeopleMaterial, walkerGeometry } from './PersonMesh';

const CAP = 768;
const SPACING = 7;            // conveyor slot spacing (m)
const STEP_LEN = 1.4;         // metres per full cycle (two steps)
const NO_SPAWN_NEAR = 6;      // never appear this close to the camera
const NO_SPAWN_VIEW = 120;    // ...or within view in front of the camera closer than this

/**
 * Walking pedestrians on footways and synthetic sidewalks around the viewer. Agents are spawned deterministically
 * from a "conveyor" defined by simulation time (same time -> same people), walk along the graph choosing turns
 * by hash, and are despawned beyond the activation radius. One InstancedMesh, one draw call.
 */
export class Crowd {
  readonly group = new THREE.Group();
  count = 0;
  private readonly mesh: THREE.InstancedMesh;
  private readonly anim: THREE.InstancedBufferAttribute;
  private readonly uniforms = { uTime: { value: 0 } };
  // agent state (SoA)
  private readonly edge = new Int32Array(CAP);
  private readonly dir = new Int8Array(CAP);
  private readonly seg = new Int32Array(CAP);
  private readonly s = new Float32Array(CAP);
  private readonly speed = new Float32Array(CAP);
  private readonly lat = new Float32Array(CAP);
  private readonly latTarget = new Float32Array(CAP);
  private readonly pref = new Int8Array(CAP);     // preferred travel side (+1 right of travel)
  private readonly phase = new Float32Array(CAP);
  private readonly walk = new Float32Array(CAP);  // 0 standing, 1 walking
  private readonly hx = new Float32Array(CAP);
  private readonly hz = new Float32Array(CAP);
  private readonly px = new Float32Array(CAP);
  private readonly pz = new Float32Array(CAP);
  private readonly seed = new Uint32Array(CAP);
  private readonly hop = new Uint16Array(CAP);
  private readonly ident = new Array<string>(CAP);
  private readonly alive = new Set<string>();
  private readonly seeded = new Set<number>();
  /** time-of-day volume factor (shared/nightlife activity) */
  activity = 1;
  setActivity(a: number): boolean {
    const prev = this.activity;
    if (Math.abs(a - prev) < 0.06) return false;
    this.activity = a;
    if (a < prev) { const keep = a / prev; for (let i = this.count - 1; i >= 0; i--) if (hash32(this.seed[i], 29) > keep) this.remove(i); this.mesh.count = this.count; return false; }
    this.seeded.clear();
    return true;
  }
  private activeSet = new Set<number>();
  private radius = 220;
  private readonly tmp: EdgePoint = { x: 0, y: 0, z: 0, ux: 0, uz: -1, seg: 0 };
  private readonly mat4 = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(readonly graph: PathGraph, readonly clock: SimClock, private readonly surface: SurfaceGrid | null = null) {
    this.group.name = 'crowd';
    const geom = walkerGeometry();
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aAnim', this.anim);
    this.mesh = new THREE.InstancedMesh(geom, makePeopleMaterial(this.uniforms), CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true; this.mesh.receiveShadow = false;
    this.group.add(this.mesh);
  }

  /** Called when the viewer moved: despawn far agents, seed newly active edges. */
  setActive(edges: number[], x: number, z: number, radius: number) {
    this.radius = radius;
    const next = new Set<number>();
    for (const e of edges) if (this.graph.walkable(e)) next.add(e);
    // despawn beyond radius + 60
    const far2 = (radius + 60) * (radius + 60);
    for (let i = this.count - 1; i >= 0; i--) {
      const dx = this.px[i] - x, dz = this.pz[i] - z;
      if (dx * dx + dz * dz > far2) this.remove(i);
    }
    for (const e of this.seeded) if (!next.has(e)) this.seeded.delete(e);
    for (const e of next) if (!this.seeded.has(e)) { this.seedEdge(e, x, z); this.seeded.add(e); }
    this.activeSet = next;
  }

  private camDir = new THREE.Vector3(0, 0, -1);
  private camX = 0; private camZ = 0;

  /** Deterministic population of one edge from the conveyor at the current simulation time. */
  private seedEdge(e: number, camX: number, camZ: number) {
    const g = this.graph;
    const L = g.eLen[e];
    if (L < 3) return;
    const f = g.eFlags[e];
    const tracks: { track: number; lat: number; density: number; jitter: number }[] = [];
    const park = (f & EdgeFlag.PARK) !== 0;
    if (f & EdgeFlag.WALK) tracks.push({ track: 0, lat: 0, density: park ? 0.32 : (f & EdgeFlag.CROSSING) ? 0.28 : (f & EdgeFlag.STEPS) ? 0.18 : 0.22, jitter: Math.min(0.9, g.eWidth[e] * 0.3) });
    if (f & EdgeFlag.SIDE_L) tracks.push({ track: -1, lat: g.sideLat(e, -1), density: 0.26, jitter: 0.7 });
    if (f & EdgeFlag.SIDE_R) tracks.push({ track: 1, lat: g.sideLat(e, 1), density: 0.26, jitter: 0.7 });
    const T = this.clock.time;
    const slots = Math.ceil(L / SPACING);
    for (const tr of tracks) {
      for (let k = 0; k < slots; k++) {
        const h0 = hash32(e, tr.track + 2, k, 1);
        if (h0 > tr.density * this.activity) continue;
        const dir: 1 | -1 = hash32(e, tr.track + 2, k, 2) < 0.5 ? 1 : -1;
        const speed = (f & EdgeFlag.STEPS) ? 0.55 : (park ? 0.95 : 1.15) + hash32(e, tr.track + 2, k, 3) * 0.5;
        const phi = hash32(e, tr.track + 2, k, 4) * SPACING;
        const u = k * SPACING + speed * T + phi;
        const lap = Math.floor(u / L);
        const sPos = dir > 0 ? u - lap * L : L - (u - lap * L);
        const id = `${e}:${tr.track}:${k}:${lap}`;
        if (this.alive.has(id)) continue;
        if (this.count >= CAP) return;
        const seed = (hash32(e, k, lap, 5) * 4294967295) >>> 0;
        const lat = tr.lat + (hash32(seed, 6) - 0.5) * 2 * tr.jitter;
        g.edgePoint(e, sPos, lat, 0, this.tmp);
        const dx = this.tmp.x - camX, dz = this.tmp.z - camZ, d2 = dx * dx + dz * dz;
        if (d2 < NO_SPAWN_NEAR * NO_SPAWN_NEAR) continue;
        if (d2 < NO_SPAWN_VIEW * NO_SPAWN_VIEW) {
          const d = Math.sqrt(d2);
          if ((dx / d) * this.camDir.x + (dz / d) * this.camDir.z > 0.55) continue; // in front of the viewer
        }
        const i = this.count++;
        this.edge[i] = e; this.dir[i] = dir; this.seg[i] = this.tmp.seg; this.s[i] = sPos; this.speed[i] = speed;
        this.lat[i] = lat; this.latTarget[i] = lat; this.pref[i] = tr.track === 0 ? (hash32(seed, 7) < 0.5 ? 1 : -1) : (tr.track * dir) as 1 | -1;
        this.phase[i] = hash32(seed, 8) * Math.PI * 2;
        this.walk[i] = hash32(seed, 9) < 0.06 ? 0 : 1;
        this.hx[i] = dir * this.tmp.ux; this.hz[i] = dir * this.tmp.uz;
        this.px[i] = this.tmp.x; this.pz[i] = this.tmp.z;
        this.seed[i] = seed; this.hop[i] = 0; this.ident[i] = id; this.alive.add(id);
        this.color.setHex(CLOTH_PALETTE[Math.floor(hash32(seed, 10) * CLOTH_PALETTE.length)]);
        this.mesh.setColorAt(i, this.color);
        this.anim.setXYZW(i, this.phase[i], this.walk[i], hash32(seed, 11), 0);
        this.writeMatrix(i, this.tmp.x, this.tmp.y + (this.surface?.lift(this.tmp.x, this.tmp.z) ?? 0), this.tmp.z, 0.92 + hash32(seed, 12) * 0.16);
      }
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.count = this.count;
  }

  private remove(i: number) {
    const last = this.count - 1;
    this.alive.delete(this.ident[i]);
    if (i !== last) {
      for (const a of [this.edge, this.seg] as Int32Array[]) a[i] = a[last];
      for (const a of [this.dir, this.pref] as Int8Array[]) a[i] = a[last];
      for (const a of [this.s, this.speed, this.lat, this.latTarget, this.phase, this.walk, this.hx, this.hz, this.px, this.pz] as Float32Array[]) a[i] = a[last];
      this.seed[i] = this.seed[last]; this.hop[i] = this.hop[last]; this.ident[i] = this.ident[last];
      this.mesh.getMatrixAt(last, this.mat4); this.mesh.setMatrixAt(i, this.mat4);
      if (this.mesh.instanceColor) { this.mesh.getColorAt(last, this.color); this.mesh.setColorAt(i, this.color); }
      this.anim.setXYZW(i, this.anim.getX(last), this.anim.getY(last), this.anim.getZ(last), this.anim.getW(last));
    }
    this.count = last;
    this.mesh.count = last;
  }

  private writeMatrix(i: number, x: number, y: number, z: number, sc: number) {
    const hx = this.hx[i], hz = this.hz[i];
    const l = Math.hypot(hx, hz) || 1;
    // local -z faces the heading: a Y rotation r maps -z to (-sin r, -cos r), so sin r = -hx, cos r = -hz
    const c = -hz / l, s = -hx / l; // cos(r), sin(r)
    const a = this.mesh.instanceMatrix.array as Float32Array;
    const o = i * 16;
    a[o] = c * sc; a[o + 1] = 0; a[o + 2] = -s * sc; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = sc; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = s * sc; a[o + 9] = 0; a[o + 10] = c * sc; a[o + 11] = 0;
    a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
  }

  update(dt: number, camX: number, camZ: number, camDir: THREE.Vector3, _night: number) {
    this.camDir.copy(camDir); this.camX = camX; this.camZ = camZ;
    this.uniforms.uTime.value = this.clock.time;
    const g = this.graph;
    const k = 1 - Math.exp(-dt / 0.25);
    for (let i = 0; i < this.count; i++) {
      if (this.walk[i] > 0) {
        this.s[i] += this.dir[i] * this.speed[i] * dt;
        const L = g.eLen[this.edge[i]];
        if (this.s[i] < 0 || this.s[i] > L) this.arrive(i);
        this.phase[i] += (Math.PI * 2 * this.speed[i] / STEP_LEN) * dt;
        this.lat[i] += (this.latTarget[i] - this.lat[i]) * Math.min(1, dt * this.speed[i] / 4);
      }
      const e = this.edge[i];
      const p = g.edgePoint(e, this.s[i], this.lat[i], this.seg[i], this.tmp);
      this.seg[i] = p.seg;
      if (this.walk[i] > 0) {
        const tx = this.dir[i] * p.ux, tz = this.dir[i] * p.uz;
        this.hx[i] += (tx - this.hx[i]) * k; this.hz[i] += (tz - this.hz[i]) * k;
      }
      this.px[i] = p.x; this.pz[i] = p.z;
      const sc = this.mesh.instanceMatrix.array[i * 16 + 5];
      this.writeMatrix(i, p.x, p.y + (this.surface?.lift(p.x, p.z) ?? 0), p.z, sc);
      this.anim.setX(i, this.phase[i]);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.anim.needsUpdate = true;
    this.mesh.count = this.count;
  }

  /** Reached the end of the edge: pick the next one (or turn round at a dead end) and keep the preferred side. */
  private arrive(i: number) {
    const g = this.graph;
    const e = this.edge[i], dir = this.dir[i] as 1 | -1;
    const node = g.nodeOf(e, dir, true);
    const overshoot = dir > 0 ? this.s[i] - g.eLen[e] : -this.s[i];
    const rnd = hash32(this.seed[i], this.hop[i]++, 13);
    const next = g.pickNext(node, e, this.hx[i], this.hz[i], g.walkAllowed, rnd, 0.6);
    if (!next) { // dead end: turn round, keep the same side of travel (which is the other lateral track)
      this.dir[i] = -dir as 1 | -1;
      this.s[i] = dir > 0 ? g.eLen[e] - overshoot : overshoot;
      this.latTarget[i] = this.trackFor(e, this.dir[i] as 1 | -1, i);
      return;
    }
    this.edge[i] = next.e; this.dir[i] = next.dir;
    const L = g.eLen[next.e];
    this.s[i] = next.dir > 0 ? Math.min(L, overshoot) : Math.max(0, L - overshoot);
    this.seg[i] = next.dir > 0 ? 0 : Math.max(0, g.eNv[next.e] - 2);
    this.latTarget[i] = this.trackFor(next.e, next.dir, i);
  }

  /** Lateral offset on edge e when travelling in dir for agent i's side preference. */
  private trackFor(e: number, dir: 1 | -1, i: number): number {
    const g = this.graph, f = g.eFlags[e];
    const side = (this.pref[i] * dir) as 1 | -1; // absolute side of the way
    const jitter = (hash32(this.seed[i], 14) - 0.5) * 1.4;
    const has = (s: 1 | -1) => (s < 0 ? (f & EdgeFlag.SIDE_L) : (f & EdgeFlag.SIDE_R)) !== 0;
    if (has(side)) return g.sideLat(e, side) + jitter;
    if (f & EdgeFlag.WALK) return jitter * Math.min(1, g.eWidth[e] * 0.35);
    if (has(-side as 1 | -1)) return g.sideLat(e, -side as 1 | -1) + jitter;
    return 0;
  }
}
