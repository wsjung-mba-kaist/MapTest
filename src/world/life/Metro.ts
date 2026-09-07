import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SimClock } from './SimClock';
import { DATA_URL } from '../DataLoader';
import { withLamps } from '../../render/LocalLights';

interface RailLine { name: string; pts: [number, number, number][] }
const CAR_LEN = 15.1, CAR_GAP = 0.6, CARS = 5, CRUISE = 11.5, ACCEL = 0.9, DWELL = 28;

/**
 * Métro line 6 on its viaduct: one five-car train per elevated polyline (rail.json), shuttling end to end on the
 * simulation clock (accelerate, cruise, brake, dwell, reverse) so it is deterministic for a given `simt`. Cars are
 * instanced boxes in the MP 73 livery (blue below, white above, dark window band); headlights glow after dusk.
 */
export class Metro {
  readonly group = new THREE.Group();
  count = 0;
  private trains: { pts: [number, number, number][]; cum: number[]; len: number; mesh: THREE.InstancedMesh; offset: number }[] = [];
  private readonly M = new THREE.Matrix4(); private readonly P = new THREE.Vector3(); private readonly Q = new THREE.Quaternion(); private readonly S = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private mat: THREE.MeshStandardMaterial | null = null;
  /** head positions for the soundscape */
  readonly heads: { x: number; y: number; z: number; v: number }[] = [];

  constructor(private readonly clock: SimClock) { this.group.name = 'metro'; }

  async load() {
    const res = await fetch(`${DATA_URL}/rail.json`);
    if (!res.ok) throw new Error(`rail.json ${res.status}`);
    const data = await res.json() as { lines: RailLine[] };
    const geom = carGeometry();
    this.mat = withLamps(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 }));
    for (const line of data.lines) {
      if (line.pts.length < 2) continue;
      const cum = [0];
      for (let i = 1; i < line.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(line.pts[i][0] - line.pts[i - 1][0], line.pts[i][2] - line.pts[i - 1][2]));
      const len = cum[cum.length - 1];
      if (len < CARS * (CAR_LEN + CAR_GAP) + 40) continue;
      const mesh = new THREE.InstancedMesh(geom, this.mat, CARS);
      mesh.castShadow = true; mesh.receiveShadow = false; mesh.frustumCulled = false; mesh.name = `metro_${line.name || this.trains.length}`;
      this.group.add(mesh);
      this.trains.push({ pts: line.pts, cum, len, mesh, offset: this.trains.length * 37 });
      this.heads.push({ x: 0, y: 0, z: 0, v: 0 });
    }
    this.count = this.trains.length;
  }

  /** Position of the train head along the line at simulation time (metres from the start) and its speed. */
  private headAt(len: number, time: number): { s: number; v: number } {
    const run = len - CARS * (CAR_LEN + CAR_GAP);                 // the head travels from the train length to the end
    const tAcc = CRUISE / ACCEL, dAcc = 0.5 * ACCEL * tAcc * tAcc;
    const tCruise = Math.max(0, (run - 2 * dAcc) / CRUISE);
    const tTrip = 2 * tAcc + tCruise, tLeg = tTrip + DWELL;
    const u = time % (2 * tLeg), fwd = u < tLeg, t = fwd ? u : u - tLeg;
    let d = 0, v = 0;
    if (t < tAcc) { d = 0.5 * ACCEL * t * t; v = ACCEL * t; }
    else if (t < tAcc + tCruise) { d = dAcc + CRUISE * (t - tAcc); v = CRUISE; }
    else if (t < tTrip) { const r = tTrip - t; d = run - 0.5 * ACCEL * r * r; v = ACCEL * r; }
    else { d = run; v = 0; }
    const base = CARS * (CAR_LEN + CAR_GAP);
    return fwd ? { s: base + d, v } : { s: len - d, v: -v };
  }

  private at(tr: { pts: [number, number, number][]; cum: number[] }, s: number, out: THREE.Vector3, dir: THREE.Vector3) {
    const cum = tr.cum; let i = 0; while (i + 2 < cum.length && cum[i + 1] < s) i++;
    const a = tr.pts[i], b = tr.pts[i + 1], seg = cum[i + 1] - cum[i] || 1, t = Math.max(0, Math.min(1, (s - cum[i]) / seg));
    out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    dir.set(b[0] - a[0], 0, b[2] - a[2]).normalize();
  }

  update(night: number) {
    if (this.mat) this.mat.emissiveIntensity = night;
    const time = this.clock.time;
    const dir = new THREE.Vector3(), pos = new THREE.Vector3();
    this.trains.forEach((tr, k) => {
      const { s, v } = this.headAt(tr.len, time + tr.offset);
      const sign = v >= 0 ? 1 : -1;
      for (let c = 0; c < CARS; c++) {
        const sc = s - sign * c * (CAR_LEN + CAR_GAP) * (v >= 0 ? 1 : -1) * 1;   // cars trail the head
        this.at(tr, Math.max(0, Math.min(tr.len, v >= 0 ? s - c * (CAR_LEN + CAR_GAP) : s + c * (CAR_LEN + CAR_GAP))), pos, dir);
        void sc;
        // the car faces -z at yaw 0: yaw = atan2(-hx, -hz); when running backwards flip the heading so headlights lead
        const hx = dir.x * sign, hz = dir.z * sign;
        this.Q.setFromAxisAngle(this.up, Math.atan2(-hx, -hz));
        this.P.copy(pos).setY(pos.y + 0.05);
        tr.mesh.setMatrixAt(c, this.M.compose(this.P, this.Q, this.S));
      }
      tr.mesh.instanceMatrix.needsUpdate = true;
      const h = this.heads[k]; h.x = pos.x; h.y = pos.y; h.z = pos.z; h.v = Math.abs(v);
    });
  }
}

/** One MP 73 car: blue body, white upper band, dark window strip, grey roof and bogies; emissive headlight discs at -z. */
function carGeometry(): THREE.BufferGeometry {
  const tint = (g: THREE.BufferGeometry, hex: number, em = 0): THREE.BufferGeometry => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r * (1 + em); col[i * 3 + 1] = c.g * (1 + em); col[i * 3 + 2] = c.b * (1 + em); }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    return g;
  };
  const parts = [
    tint(new THREE.BoxGeometry(2.45, 1.5, CAR_LEN).translate(0, 1.15, 0), 0x1d4f9c),                    // lower body, RATP blue
    tint(new THREE.BoxGeometry(2.45, 1.2, CAR_LEN).translate(0, 2.5, 0), 0xe9e9e6),                     // upper body, white
    tint(new THREE.BoxGeometry(2.5, 0.75, CAR_LEN - 1.2).translate(0, 2.45, 0), 0x1a1c22),              // window band
    tint(new THREE.BoxGeometry(2.3, 0.35, CAR_LEN - 0.4).translate(0, 3.27, 0), 0x8a8e93),              // roof
    tint(new THREE.BoxGeometry(2.2, 0.4, 2.4).translate(0, 0.2, 4.5), 0x2a2c30), tint(new THREE.BoxGeometry(2.2, 0.4, 2.4).translate(0, 0.2, -4.5), 0x2a2c30),   // bogies
  ];
  for (const sx of [-0.8, 0.8]) parts.push(tint(new THREE.CircleGeometry(0.16, 10).rotateY(Math.PI).translate(sx, 1.4, -CAR_LEN / 2 - 0.01), 0xfff4d6, 2.5));
  return mergeGeometries(parts, false)!;
}
