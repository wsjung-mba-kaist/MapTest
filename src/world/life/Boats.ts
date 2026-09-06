import * as THREE from 'three';
import type { LocalLight } from '../../render/LocalLights';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { withLamps } from '../../render/LocalLights';
import type { PathGraph } from './PathGraph';
import type { SimClock } from './SimClock';

/**
 * Bateaux-mouches and a barge cruising the closed river loops baked into paths.bin (they thread between the
 * bridge piers). Procedural hulls; cabin windows glow after dusk. Boats face -z at yaw 0.
 */
interface Loop { pts: Float32Array; cum: Float32Array; length: number }
interface Boat { hx?: number; hz?: number; mesh: THREE.Group; loop: number; s0: number; speed: number; glass: THREE.MeshStandardMaterial; seed: number }

export class Boats {
  readonly group = new THREE.Group();
  count = 0;
  private loops: Loop[] = [];
  private boats: Boat[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(readonly graph: PathGraph, readonly clock: SimClock) {
    this.group.name = 'boats';
    const r = graph.river;
    for (const lm of graph.meta.riverLoops ?? []) {
      const n = lm.count;
      const pts = new Float32Array(n * 3);
      pts.set(r.subarray(lm.start * 3, (lm.start + n) * 3));
      const cum = new Float32Array(n + 1);
      for (let i = 1; i <= n; i++) {
        const a = (i - 1) % n, b = i % n;
        cum[i] = cum[i - 1] + Math.hypot(pts[b * 3] - pts[a * 3], pts[b * 3 + 2] - pts[a * 3 + 2]);
      }
      const loop: Loop = { pts, cum, length: cum[n] };
      const li = this.loops.push(loop) - 1;
      for (let k = 0; k < lm.boats; k++) {
        const { mesh, glass } = lm.kind === 'barge' ? barge() : mouche(k);
        this.group.add(mesh);
        this.boats.push({ mesh, loop: li, s0: (k + 0.37) * loop.length / lm.boats, speed: lm.kind === 'barge' ? 2.2 : 3.0, glass, seed: k * 7 + li * 13 });
      }
    }
    this.count = this.boats.length;
  }

  private pointAt(loop: Loop, s: number, out: THREE.Vector3) {
    const n = loop.pts.length / 3;
    const ss = ((s % loop.length) + loop.length) % loop.length;
    // binary search the segment
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (loop.cum[mid] <= ss) lo = mid; else hi = mid; }
    const a = lo % n, b = (lo + 1) % n;
    const t = (ss - loop.cum[lo]) / Math.max(1e-6, loop.cum[lo + 1] - loop.cum[lo]);
    out.set(loop.pts[a * 3] + (loop.pts[b * 3] - loop.pts[a * 3]) * t, loop.pts[a * 3 + 1], loop.pts[a * 3 + 2] + (loop.pts[b * 3 + 2] - loop.pts[a * 3 + 2]) * t);
    return out;
  }

  /** Debug readout: position of the first boat. */
  get stats(): string { const b = this.boats[0]; return b ? `@${b.mesh.position.x.toFixed(0)},${b.mesh.position.z.toFixed(0)}` : ''; }

  /** Bow floodlights of the nearest boats (2 spots each): the bateaux-mouches sweep the quays and bridge arches. */
  dynamicLights(out: LocalLight[], camX: number, camZ: number, maxBoats: number) {
    const order = this.boats.map(b => ({ b, d2: (b.mesh.position.x - camX) ** 2 + (b.mesh.position.z - camZ) ** 2 })).sort((p, q) => p.d2 - q.d2);
    for (const { b } of order.slice(0, maxBoats)) {
      const hx = b.hx ?? 0, hz = b.hz ?? -1, rx = -hz, rz = hx;   // heading and its right normal
      const p = b.mesh.position;
      for (const side of [-1, 1]) {
        // on the roof at the bow tip, so the cone never touches the boat's own hull
        out.push({ x: p.x + hx * 17.2 + rx * 2.6 * side, y: p.y + 3.6, z: p.z + hz * 17.2 + rz * 2.6 * side, radius: 60, r: 1.0, g: 0.97, b: 0.9, intensity: 80, kind: 'dynamic', dx: hx * 0.985 + rx * 0.17 * side, dy: -0.09, dz: hz * 0.985 + rz * 0.17 * side, cone: 24 * Math.PI / 180 });
      }
    }
  }

  update(_dt: number, night: number) {
    const t = this.clock.time;
    const ahead = new THREE.Vector3();
    for (const b of this.boats) {
      const loop = this.loops[b.loop];
      const s = b.s0 + b.speed * t;
      const p = this.pointAt(loop, s, this.tmp);
      this.pointAt(loop, s + 12, ahead);
      const dx = ahead.x - p.x, dz = ahead.z - p.z;
      const hl = Math.hypot(dx, dz) || 1; b.hx = dx / hl; b.hz = dz / hl;
      const yaw = Math.atan2(-dx, -dz);   // hull faces -z at yaw 0: rotation r maps it to (-sin r, -cos r)
      b.mesh.position.set(p.x, p.y + 0.04 * Math.sin(t * 0.7 + b.seed), p.z);
      b.mesh.rotation.set(0.006 * Math.sin(t * 0.45 + b.seed), yaw, 0.012 * Math.sin(t * 0.5 + b.seed * 1.3), 'YXZ');
      b.glass.emissiveIntensity = 0.5 * night;   // cabin glow; the floods do the bright work
    }
  }
}

function mouche(k: number): { mesh: THREE.Group; glass: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: k % 2 ? 0xe9e6dc : 0xf1efe8, roughness: 0.55, metalness: 0.1 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x1f3550, roughness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2530, roughness: 0.12, metalness: 0.5, emissive: 0xffd9a0, emissiveIntensity: 0 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x9c9d95, roughness: 0.8 });
  // hull: box + rounded bow (half cylinder) — length 34 m, beam 7.5 m, freeboard 1.0 m above the water line
  const hullBox = new THREE.BoxGeometry(7.5, 1.7, 30).translate(0, 0.25, 2);
  const bow = new THREE.CylinderGeometry(3.75, 3.75, 1.7, 14, 1, false, 0, Math.PI).rotateY(-Math.PI / 2).translate(0, 0.25, -13);
  const stern = new THREE.BoxGeometry(7.5, 1.7, 2).translate(0, 0.25, 17.5);
  const hull = new THREE.Mesh(mergeGeometries([hullBox, bow, stern])!, hullMat);
  const trim = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.18, 30.5).translate(0, 1.05, 2), trimMat);
  // low glass cabin (keeps under the bridge decks) and a light roof deck with seat rows
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(6.4, 2.1, 24).translate(0, 2.15, 1), glass);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.16, 25).translate(0, 3.28, 1), deckMat);
  const seats: THREE.BufferGeometry[] = [];
  for (let r = 0; r < 6; r++) seats.push(new THREE.BoxGeometry(5.6, 0.45, 0.6).translate(0, 3.6, -8 + r * 3.4));
  const seatMesh = new THREE.Mesh(mergeGeometries(seats)!, trimMat);
  const bridgeHouse = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 2.4).translate(0, 4.0, -9.5), glass);
  g.add(hull, trim, cabin, roof, seatMesh, bridgeHouse);
  g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = false; withLamps(m.material as THREE.Material); } });
  return { mesh: g, glass };
}

function barge(): { mesh: THREE.Group; glass: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x2f3236, roughness: 0.75, metalness: 0.25 });
  const cargoMat = new THREE.MeshStandardMaterial({ color: 0x6e5a3a, roughness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2530, roughness: 0.15, metalness: 0.4, emissive: 0xffe0b0, emissiveIntensity: 0 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(5.2, 2.0, 38).translate(0, 0.2, 0), hullMat);
  const cargo = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.9, 26).translate(0, 1.5, -3), cargoMat);
  const house = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.3, 4.2).translate(0, 2.3, 15), hullMat);
  const win = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.7, 4.3).translate(0, 2.7, 15), glass);
  g.add(hull, cargo, house, win);
  g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = false; withLamps(m.material as THREE.Material); } });
  return { mesh: g, glass };
}
