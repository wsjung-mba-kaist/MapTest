import * as THREE from 'three';
import type { PathGraph, EdgePoint } from './PathGraph';
import type { SimClock } from './SimClock';
import { EdgeFlag, NodeFlag } from '../../../shared/paths';
import { hash32 } from '../../../shared/hash';
import { armPhase, signalState, SIGNAL_GREEN, SIGNAL_AMBER } from '../../../shared/signals';
import { carColor, loadCarKit, makeCarMaterial, type CarModel } from './CarKit';
import type { LocalLight } from '../../render/LocalLights';

const CAP = 384;
const VARIANTS = ['sedan', 'hatchback-sports', 'suv', 'van', 'taxi'] as const;
const VARIANT_W = [0.32, 0.2, 0.2, 0.13, 0.15];
const GAP_MIN = 7.5;          // bumper-to-bumper target gap at standstill (m)
const JUNCTION_RUN_IN = 8;    // metres of the next edge consumed by the junction curve
const NO_SPAWN_NEAR = 12;
const NO_SPAWN_VIEW = 120;
const STOP_BACK = 5;          // stop line: metres before the junction node

/**
 * Moving cars on the drivable graph: right-hand lanes, leader following, hash-chosen turns, quadratic junction
 * curves, tunnel/boundary sinks and night lights. Deterministic conveyor spawning like the crowd.
 */
export class Traffic {
  readonly group = new THREE.Group();
  count = 0;
  private models: CarModel[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  private readonly uniforms = { uLights: { value: 0 } };
  // agent state
  private readonly edge = new Int32Array(CAP);
  private readonly dir = new Int8Array(CAP);
  private readonly lane = new Uint8Array(CAP);
  private readonly seg = new Int32Array(CAP);
  private readonly s = new Float32Array(CAP);         // arc length from a (regardless of dir)
  private readonly v = new Float32Array(CAP);
  private readonly vCruise = new Float32Array(CAP);
  private readonly variant = new Uint8Array(CAP);
  private readonly seed = new Uint32Array(CAP);
  private readonly hop = new Uint16Array(CAP);
  private readonly nextE = new Int32Array(CAP);
  private readonly nextDir = new Int8Array(CAP);
  private readonly px = new Float32Array(CAP);
  private readonly py = new Float32Array(CAP);
  private readonly pz = new Float32Array(CAP);
  private readonly hx = new Float32Array(CAP);
  private readonly hz = new Float32Array(CAP);
  // junction curve state: jt < 0 = none; else progress (m) along the curve
  private readonly jt = new Float32Array(CAP).fill(-1);
  private readonly jLen = new Float32Array(CAP);
  private readonly j0 = new Float32Array(CAP * 3);
  private readonly jc = new Float32Array(CAP * 3);
  private readonly j1 = new Float32Array(CAP * 3);
  private readonly ident = new Array<string>(CAP);
  private readonly alive = new Set<string>();
  private readonly seeded = new Set<number>();
  private readonly tmp: EdgePoint = { x: 0, y: 0, z: 0, ux: 0, uz: -1, seg: 0 };
  private readonly color = new THREE.Color();
  private readonly camDir = new THREE.Vector3(0, 0, -1);
  private laneLists = new Map<number, number[]>();
  /** signal phase per (edge, end): index e*2 + (arriving at b ? 1 : 0); -1 = no signal */
  private readonly sigPhase: Float32Array;
  /** time-of-day volume factor (shared/nightlife activity) */
  activity = 1;
  /** Returns true when the change is big enough that the caller should re-seed the active edges. */
  setActivity(a: number): boolean {
    const prev = this.activity;
    if (Math.abs(a - prev) < 0.06) return false;
    this.activity = a;
    if (a < prev) { const keep = a / prev; for (let i = this.count - 1; i >= 0; i--) if (hash32(this.seed[i], 29) > keep) this.remove(i); return false; }
    this.seeded.clear();
    return true;
  }

  constructor(readonly graph: PathGraph, readonly clock: SimClock) { this.group.name = 'traffic'; this.sigPhase = buildSignalTable(graph); }

  async load() {
    const kit = await loadCarKit(VARIANTS);
    const mat = makeCarMaterial(this.uniforms);
    VARIANTS.forEach(name => {
      const m = kit.get(name);
      if (!m) return;
      this.models.push(m);
      const mesh = new THREE.InstancedMesh(m.geometry, mat, CAP);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = false;
      // instanceColor buffer exists once setColorAt is called; do it now so the shader path is stable
      mesh.setColorAt(0, this.color.setHex(0xffffff));
      this.meshes.push(mesh);
      this.group.add(mesh);
    });
  }

  private laneKey(e: number, dir: number, lane: number) { return e * 8 + (dir > 0 ? 0 : 4) + Math.min(3, lane); }
  private progress(i: number) { return this.dir[i] > 0 ? this.s[i] : this.graph.eLen[this.edge[i]] - this.s[i]; }

  setActive(edges: number[], x: number, z: number, radius: number) {
    const next = new Set<number>();
    for (const e of edges) if (this.graph.drivable(e)) next.add(e);
    const far2 = (radius + 60) * (radius + 60);
    for (let i = this.count - 1; i >= 0; i--) { const dx = this.px[i] - x, dz = this.pz[i] - z; if (dx * dx + dz * dz > far2) this.remove(i); }
    for (const e of this.seeded) if (!next.has(e)) this.seeded.delete(e);
    this.rebuildLanes();
    for (const e of next) if (!this.seeded.has(e)) { this.seedEdge(e, x, z); this.seeded.add(e); }
  }

  private density(e: number): number {
    const cls = this.graph.eCls[e];
    return [0.34, 0.34, 0.3, 0.22, 0.18, 0.18, 0.08, 0.06][cls] ?? 0.05;
  }

  private seedEdge(e: number, camX: number, camZ: number) {
    if (!this.models.length) return;
    const g = this.graph;
    const L = g.eLen[e];
    if (L < 10) return;
    const T = this.clock.time;
    const vC = g.speed(e);
    const D = Math.max(16, 2.4 * vC + 6);
    const slots = Math.ceil(L / D);
    const dirs: (1 | -1)[] = g.isOneway(e) ? [1] : [1, -1];
    for (const dir of dirs) {
      const nl = Math.max(1, g.lanes(e, dir));
      for (let lane = 0; lane < nl; lane++) {
        const dens = this.density(e) * this.activity * (lane === 0 ? 1 : 0.7);
        for (let k = 0; k < slots; k++) {
          const h0 = hash32(e, dir + 2 + lane * 4, k, 21);
          if (h0 > dens) continue;
          const speed = vC * (0.88 + hash32(e, dir + 2 + lane * 4, k, 22) * 0.24);
          const phi = hash32(e, dir + 2 + lane * 4, k, 23) * D;
          const u = k * D + speed * T + phi;
          const lap = Math.floor(u / L);
          const prog = u - lap * L;
          const id = `c${e}:${dir}:${lane}:${k}:${lap}`;
          if (this.alive.has(id)) continue;
          if (this.count >= CAP) return;
          const sPos = dir > 0 ? prog : L - prog;
          const lat = g.laneLat(e, lane, dir);
          g.edgePoint(e, sPos, lat, 0, this.tmp);
          const dx = this.tmp.x - camX, dz = this.tmp.z - camZ, d2 = dx * dx + dz * dz;
          if (d2 < NO_SPAWN_NEAR * NO_SPAWN_NEAR) continue;
          if (d2 < NO_SPAWN_VIEW * NO_SPAWN_VIEW) { const d = Math.sqrt(d2); if ((dx / d) * this.camDir.x + (dz / d) * this.camDir.z > 0.55) continue; }
          // keep a gap from cars already on this lane
          const key = this.laneKey(e, dir, lane);
          let blocked = false;
          for (const j of this.laneLists.get(key) ?? []) if (Math.abs(this.progress(j) - prog) < GAP_MIN + 4.5) { blocked = true; break; }
          if (blocked) continue;
          const seed = (hash32(e, k, lap, 24) * 4294967295) >>> 0;
          const i = this.count++;
          this.edge[i] = e; this.dir[i] = dir; this.lane[i] = lane; this.seg[i] = this.tmp.seg; this.s[i] = sPos;
          this.v[i] = speed; this.vCruise[i] = speed; this.variant[i] = pickVariant(hash32(seed, 25)); this.seed[i] = seed; this.hop[i] = 0;
          this.px[i] = this.tmp.x; this.pz[i] = this.tmp.z; this.hx[i] = dir * this.tmp.ux; this.hz[i] = dir * this.tmp.uz;
          this.jt[i] = -1; this.ident[i] = id; this.alive.add(id);
          this.chooseNext(i);
          (this.laneLists.get(key) ?? this.laneLists.set(key, []).get(key)!).push(i);
        }
      }
    }
  }

  private remove(i: number) {
    const last = this.count - 1;
    this.alive.delete(this.ident[i]);
    if (i !== last) {
      for (const a of [this.edge, this.seg, this.nextE] as Int32Array[]) a[i] = a[last];
      for (const a of [this.dir, this.nextDir] as Int8Array[]) a[i] = a[last];
      for (const a of [this.lane, this.variant] as Uint8Array[]) a[i] = a[last];
      for (const a of [this.s, this.v, this.vCruise, this.px, this.py, this.pz, this.hx, this.hz, this.jt, this.jLen] as Float32Array[]) a[i] = a[last];
      for (const a of [this.j0, this.jc, this.j1]) { a[i * 3] = a[last * 3]; a[i * 3 + 1] = a[last * 3 + 1]; a[i * 3 + 2] = a[last * 3 + 2]; }
      this.seed[i] = this.seed[last]; this.hop[i] = this.hop[last]; this.ident[i] = this.ident[last];
    }
    this.count = last;
  }

  /** Decide the edge after the current one (needed early for gap checks across the junction). */
  private chooseNext(i: number) {
    const g = this.graph;
    const e = this.edge[i], dir = this.dir[i] as 1 | -1;
    const node = g.nodeOf(e, dir, true);
    // heading at the end of the edge
    const v0 = g.eV0[e], nv = g.eNv[e];
    const a = dir > 0 ? v0 + nv - 2 : v0 + 1, b = dir > 0 ? v0 + nv - 1 : v0;
    const dx = g.vPos[b * 3] - g.vPos[a * 3], dz = g.vPos[b * 3 + 2] - g.vPos[a * 3 + 2], l = Math.hypot(dx, dz) || 1;
    const rnd = hash32(this.seed[i], this.hop[i], 26);
    const next = g.nodeFlag(node, NodeFlag.CAR_SINK) ? null : g.pickNext(node, e, dx / l, dz / l, g.driveAllowed, rnd, 0.7);
    this.nextE[i] = next ? next.e : -1; this.nextDir[i] = next ? next.dir : 0;
  }

  private rebuildLanes() {
    this.laneLists.clear();
    for (let i = 0; i < this.count; i++) {
      const key = this.laneKey(this.edge[i], this.dir[i], this.lane[i]);
      const arr = this.laneLists.get(key); if (arr) arr.push(i); else this.laneLists.set(key, [i]);
    }
  }

  update(dt: number, camX: number, camZ: number, camDir: THREE.Vector3, night: number) {
    this.camDir.copy(camDir);
    this.uniforms.uLights.value = night > 0.3 ? 1 : 0;
    const g = this.graph;
    if (dt > 0) {
      this.rebuildLanes();
      for (let i = 0; i < this.count; i++) {
        // ---- gap to the leader (same lane, ahead; or first car on the next edge/lane)
        const L = g.eLen[this.edge[i]];
        const prog = this.progress(i);
        let gap = Infinity;
        for (const j of this.laneLists.get(this.laneKey(this.edge[i], this.dir[i], this.lane[i])) ?? []) {
          if (j === i) continue;
          const d = this.progress(j) - prog;
          if (d > 0 && d < gap) gap = d;
        }
        if (gap === Infinity && this.nextE[i] >= 0 && L - prog < 40) {
          const nl = Math.max(1, g.lanes(this.nextE[i], this.nextDir[i] as 1 | -1));
          const lane = Math.min(this.lane[i], nl - 1);
          for (const j of this.laneLists.get(this.laneKey(this.nextE[i], this.nextDir[i], lane)) ?? []) {
            const d = L - prog + this.progress(j);
            if (d < gap) gap = d;
          }
        }
        const carLen = this.models[this.variant[i]]?.length ?? 4.4;
        // ---- speed control: leader following, stop at dead ends / sinks
        let vT = this.vCruise[i];
        if (gap < Infinity) vT = Math.min(vT, Math.max(0, 0.8 * (gap - carLen - GAP_MIN)));
        if (this.nextE[i] < 0) { const rem = L - prog; vT = Math.min(vT, Math.max(0, 0.6 * (rem - 2))); }
        // ---- traffic signals: brake to the stop line on red; on amber only cars still more than 8 m out stop
        const ph = this.sigPhase[this.edge[i] * 2 + (this.dir[i] > 0 ? 1 : 0)];
        if (ph >= 0 && this.jt[i] < 0) {
          const st = signalState(this.clock.time, ph);
          const rem = L - prog - STOP_BACK;
          if (st !== SIGNAL_GREEN && rem > -1.5 && !(st === SIGNAL_AMBER && rem < 8)) vT = Math.min(vT, Math.max(0, 0.7 * (rem - 0.5)));
        }
        const dv = vT - this.v[i];
        this.v[i] += Math.max(-6 * dt, Math.min(2.5 * dt, dv));
        if (this.v[i] < 0.02 && vT < 0.02) this.v[i] = 0;
        // ---- advance
        const step = this.v[i] * dt;
        if (this.jt[i] >= 0) {
          this.jt[i] += step;
          if (this.jt[i] >= this.jLen[i]) { this.jt[i] = -1; }
        } else {
          this.s[i] += this.dir[i] * step;
          if (this.s[i] < 0 || this.s[i] > L) this.arrive(i);
        }
      }
    }
    // ---- write instances per variant
    const counts = new Array<number>(this.meshes.length).fill(0);
    for (let i = 0; i < this.count; i++) {
      const vi = this.variant[i]; const mesh = this.meshes[vi]; if (!mesh) continue;
      let x: number, y: number, z: number, hx: number, hz: number;
      if (this.jt[i] >= 0) {
        const u = Math.min(1, this.jt[i] / Math.max(0.01, this.jLen[i])), w = 1 - u;
        const o = i * 3;
        x = w * w * this.j0[o] + 2 * w * u * this.jc[o] + u * u * this.j1[o];
        y = w * w * this.j0[o + 1] + 2 * w * u * this.jc[o + 1] + u * u * this.j1[o + 1];
        z = w * w * this.j0[o + 2] + 2 * w * u * this.jc[o + 2] + u * u * this.j1[o + 2];
        hx = 2 * w * (this.jc[o] - this.j0[o]) + 2 * u * (this.j1[o] - this.jc[o]);
        hz = 2 * w * (this.jc[o + 2] - this.j0[o + 2]) + 2 * u * (this.j1[o + 2] - this.jc[o + 2]);
      } else {
        const p = g.edgePoint(this.edge[i], this.s[i], g.laneLat(this.edge[i], this.lane[i], this.dir[i] as 1 | -1), this.seg[i], this.tmp);
        this.seg[i] = p.seg; x = p.x; y = p.y; z = p.z; hx = this.dir[i] * p.ux; hz = this.dir[i] * p.uz;
      }
      const hl = Math.hypot(hx, hz) || 1;
      this.hx[i] = hx / hl; this.hz[i] = hz / hl; this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      // model faces -z at yaw 0; a Y rotation r turns that to (-sin r, -cos r), so sin r = -hx, cos r = -hz
      const c = -this.hz[i], sn = -this.hx[i];
      const slot = counts[vi]++;
      const a = mesh.instanceMatrix.array as Float32Array, o = slot * 16;
      a[o] = c; a[o + 1] = 0; a[o + 2] = -sn; a[o + 3] = 0; a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0;
      a[o + 8] = sn; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0; a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
      mesh.setColorAt(slot, this.color.setHex(carColor(hash32(this.seed[i], 27), vi)));
    }
    this.meshes.forEach((m, k) => { m.count = counts[k]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  }

  /**
   * Headlight / tail-light spots of the nearest moving cars for the local-light array (2 slots per car): the headlamp
   * pair merged into one 35-degree spot tilted 8 degrees down, and a short red glow behind the car.
   */
  dynamicLights(out: LocalLight[], camX: number, camZ: number, maxCars: number) {
    const order: { d2: number; i: number }[] = [];
    for (let i = 0; i < this.count; i++) { const dx = this.px[i] - camX, dz = this.pz[i] - camZ; order.push({ d2: dx * dx + dz * dz, i }); }
    order.sort((a, b) => a.d2 - b.d2);
    const tilt = Math.sin(8 * Math.PI / 180), ct = Math.cos(8 * Math.PI / 180);
    for (let k = 0; k < Math.min(maxCars, order.length); k++) {
      const i = order[k].i;
      const hx = this.hx[i], hz = this.hz[i], len = this.models[this.variant[i]]?.length ?? 4.4;
      out.push({ x: this.px[i] + hx * len * 0.45, y: this.py[i] + 0.7, z: this.pz[i] + hz * len * 0.45, radius: 28, r: 1.0, g: 0.95, b: 0.85, intensity: 45, kind: 'dynamic', dx: hx * ct, dy: -tilt, dz: hz * ct, cone: 35 * Math.PI / 180 });
      out.push({ x: this.px[i] - hx * len * 0.5, y: this.py[i] + 0.8, z: this.pz[i] - hz * len * 0.5, radius: 5, r: 1.0, g: 0.08, b: 0.03, intensity: 6, kind: 'dynamic', dx: -hx, dy: -0.2, dz: -hz, cone: 60 * Math.PI / 180 });
    }
  }

  /** End of edge: sink, dead end (U-turn on two-way streets) or the pre-chosen next edge via a junction curve. */
  private arrive(i: number) {
    const g = this.graph;
    const e = this.edge[i], dir = this.dir[i] as 1 | -1;
    const L = g.eLen[e];
    const node = g.nodeOf(e, dir, true);
    if (g.nodeFlag(node, NodeFlag.CAR_SINK) && this.nextE[i] < 0) { this.remove(i); return; }
    if (this.nextE[i] < 0) {
      if (g.isOneway(e)) { this.remove(i); return; }
      // U-turn: same edge, opposite direction, kerb-most lane
      this.dir[i] = -dir as 1 | -1; this.s[i] = dir > 0 ? L - 0.01 : 0.01; this.lane[i] = 0; this.hop[i]++;
      this.v[i] = Math.min(this.v[i], 2);
      this.chooseNext(i);
      return;
    }
    // junction curve from the current lane end to a point JUNCTION_RUN_IN into the next edge's lane
    const ne = this.nextE[i], nd = this.nextDir[i] as 1 | -1;
    const nl = Math.max(1, g.lanes(ne, nd));
    const lane = Math.min(this.lane[i], nl - 1);
    const p0 = g.edgePoint(e, dir > 0 ? L : 0, g.laneLat(e, this.lane[i], dir), this.seg[i], this.tmp);
    const o = i * 3;
    this.j0[o] = p0.x; this.j0[o + 1] = p0.y; this.j0[o + 2] = p0.z;
    const nL = g.eLen[ne];
    const run = Math.min(JUNCTION_RUN_IN, nL * 0.5);
    const s1 = nd > 0 ? run : nL - run;
    const p1 = g.edgePoint(ne, s1, g.laneLat(ne, lane, nd), nd > 0 ? 0 : Math.max(0, g.eNv[ne] - 2), this.tmp);
    this.j1[o] = p1.x; this.j1[o + 1] = p1.y; this.j1[o + 2] = p1.z;
    // control point: intersection-ish = node position pulled toward the lane lines (average of the two lane ends + node)
    this.jc[o] = (g.nodeX(node) + (p0.x + p1.x) * 0.5) * 0.5; this.jc[o + 1] = (p0.y + p1.y) * 0.5; this.jc[o + 2] = (g.nodeZ(node) + (p0.z + p1.z) * 0.5) * 0.5;
    const chord = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const dev = Math.hypot(this.jc[o] - (p0.x + p1.x) * 0.5, this.jc[o + 2] - (p0.z + p1.z) * 0.5);
    this.jLen[i] = Math.max(0.5, chord + 0.3 * dev);
    this.jt[i] = 0;
    this.edge[i] = ne; this.dir[i] = nd; this.lane[i] = lane; this.s[i] = s1; this.seg[i] = p1.seg; this.hop[i]++;
    this.chooseNext(i);
  }
}

/** Phase of the signal facing each drivable arm, indexed e*2 + (arriving at b ? 1 : 0); -1 where there is none. */
function buildSignalTable(g: PathGraph): Float32Array {
  const t = new Float32Array(g.eLen.length * 2).fill(-1);
  const inc: number[] = [];
  for (let n = 0; n < g.nodeCount; n++) {
    if (!g.nodeFlag(n, NodeFlag.SIGNAL)) continue;
    for (const e of g.incident(n, inc)) {
      if (!g.drivable(e)) continue;
      const v0 = g.eV0[e], nv = g.eNv[e]; if (nv < 2) continue;
      const atEnd = g.eB[e] === n;
      if (g.isOneway(e) && !atEnd) continue;
      const i = atEnd ? v0 + nv - 2 : v0 + 1, j = atEnd ? v0 + nv - 1 : v0;
      const dx = g.vPos[j * 3] - g.vPos[i * 3], dz = g.vPos[j * 3 + 2] - g.vPos[i * 3 + 2], l = Math.hypot(dx, dz) || 1;
      t[e * 2 + (atEnd ? 1 : 0)] = armPhase(n, dx / l, dz / l);
    }
  }
  return t;
}

function pickVariant(r: number): number {
  let acc = 0;
  for (let i = 0; i < VARIANT_W.length; i++) { acc += VARIANT_W[i]; if (r < acc) return i; }
  return 0;
}

void EdgeFlag;
