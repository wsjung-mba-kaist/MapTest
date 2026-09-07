import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PathGraph } from './PathGraph';
import type { SimClock } from './SimClock';
import type { SurfaceGrid } from '../../../shared/surfacegrid';
import { EdgeFlag } from '../../../shared/paths';
import { hash32 } from '../../../shared/hash';
import { CLOTH_PALETTE, makePeopleMaterial, walkerGeometry } from './PersonMesh';

const CAP = 48;
const SPEED_MIN = 4.2, SPEED_MAX = 6.5;
const PEDESTRIAN_CLASSES = new Set([8, 9, 10, 12]);   // pedestrian, footway, path, cycleway (ROAD_CLASSES order)

/**
 * Cyclists on the wide car-free ways: park alleys, the Berges de Seine quays, the Champ-de-Mars paths (the driveable
 * graph is left to the cars, whose lane logic does not see bikes). A rider (the walker mesh, idle pose, standing on the
 * pedals) sits on a procedural bicycle; one InstancedMesh with the crowd's material. Deterministic per edge and time.
 */
export class Cyclists {
  readonly group = new THREE.Group();
  count = 0;
  private readonly mesh: THREE.InstancedMesh;
  private readonly anim: THREE.InstancedBufferAttribute;
  private readonly look: THREE.InstancedBufferAttribute;
  private readonly uniforms = { uTime: { value: 0 } };
  private readonly edge = new Int32Array(CAP); private readonly dir = new Int8Array(CAP); private readonly seg = new Int32Array(CAP);
  private readonly s = new Float32Array(CAP); private readonly v = new Float32Array(CAP); private readonly lat = new Float32Array(CAP);
  private readonly hx = new Float32Array(CAP); private readonly hz = new Float32Array(CAP); private readonly seed = new Uint32Array(CAP); private readonly hop = new Uint16Array(CAP);
  readonly px = new Float32Array(CAP); readonly pz = new Float32Array(CAP);
  private readonly ident = new Array<string>(CAP);
  private readonly alive = new Set<string>();
  private readonly seeded = new Set<number>();
  private readonly tmp = { x: 0, y: 0, z: 0, ux: 0, uz: -1, seg: 0 };
  private readonly M = new THREE.Matrix4(); private readonly color = new THREE.Color();
  private camX = 0; private camZ = 0;

  constructor(private readonly graph: PathGraph, private readonly clock: SimClock, private readonly surface: SurfaceGrid | null) {
    this.group.name = 'cyclists';
    const geom = riderGeometry();
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4); this.anim.setUsage(THREE.DynamicDrawUsage);
    this.look = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4); this.look.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aAnim', this.anim); geom.setAttribute('aLook', this.look);
    this.mesh = new THREE.InstancedMesh(geom, makePeopleMaterial(this.uniforms), CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.castShadow = true;
    this.mesh.setColorAt(0, this.color.setHex(0xffffff));
    this.group.add(this.mesh);
  }

  private rideable(e: number): boolean {
    const g = this.graph, f = g.eFlags[e];
    if (!(f & EdgeFlag.WALK) || (f & EdgeFlag.STEPS) || (f & EdgeFlag.CROSSING)) return false;
    return (f & EdgeFlag.PARK) !== 0 ? g.eWidth[e] >= 2.5 : PEDESTRIAN_CLASSES.has(g.eCls[e]) && g.eWidth[e] >= 3.5;
  }
  private readonly allowed = (e: number, _dir: 1 | -1) => this.rideable(e);

  setActive(edges: number[], x: number, z: number, radius: number) {
    this.camX = x; this.camZ = z;
    const next = new Set(edges.filter(e => this.rideable(e)));
    const far2 = (radius + 60) ** 2;
    for (let i = this.count - 1; i >= 0; i--) { const dx = this.px[i] - x, dz = this.pz[i] - z; if (dx * dx + dz * dz > far2) this.remove(i); }
    for (const e of this.seeded) if (!next.has(e)) this.seeded.delete(e);
    for (const e of next) if (!this.seeded.has(e)) { this.seedEdge(e); this.seeded.add(e); }
    this.mesh.count = this.count;
  }

  /** Deterministic: ~one rider per 90 m of rideable way, at a conveyor position for the current time. */
  private seedEdge(e: number) {
    const g = this.graph, L = g.eLen[e];
    if (L < 20) return;
    const slots = Math.ceil(L / 90);
    for (let k = 0; k < slots; k++) {
      if (hash32(e, k, 61) > 0.45) continue;
      const dir: 1 | -1 = hash32(e, k, 62) < 0.5 ? 1 : -1;
      const speed = SPEED_MIN + hash32(e, k, 63) * (SPEED_MAX - SPEED_MIN);
      const u = k * 90 + speed * this.clock.time + hash32(e, k, 64) * 90, lap = Math.floor(u / L);
      const id = `b${e}:${k}:${lap}`;
      if (this.alive.has(id) || this.count >= CAP) continue;
      const sPos = dir > 0 ? u - lap * L : L - (u - lap * L);
      const seed = (hash32(e, k, lap, 65) * 4294967295) >>> 0;
      const i = this.count++;
      this.edge[i] = e; this.dir[i] = dir; this.s[i] = sPos; this.v[i] = speed; this.seg[i] = 0; this.seed[i] = seed; this.hop[i] = 0;
      this.lat[i] = (hash32(seed, 66) - 0.5) * Math.min(2.0, g.eWidth[e] * 0.4);
      this.ident[i] = id; this.alive.add(id);
      this.color.setHex(CLOTH_PALETTE[Math.floor(hash32(seed, 67) * CLOTH_PALETTE.length)]);
      this.mesh.setColorAt(i, this.color);
      this.anim.setXYZW(i, 0, 0, hash32(seed, 68), 0);
      this.look.setXYZW(i, hash32(seed, 40), hash32(seed, 41), hash32(seed, 42), 0);
      const p = g.edgePoint(e, sPos, this.lat[i], 0, this.tmp);
      this.px[i] = p.x; this.pz[i] = p.z; this.hx[i] = dir * p.ux; this.hz[i] = dir * p.uz;
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.anim.needsUpdate = true; this.look.needsUpdate = true;
  }

  private remove(i: number) {
    const last = this.count - 1;
    this.alive.delete(this.ident[i]);
    if (i !== last) {
      for (const a of [this.edge, this.seg] as Int32Array[]) a[i] = a[last];
      this.dir[i] = this.dir[last];
      for (const a of [this.s, this.v, this.lat, this.hx, this.hz, this.px, this.pz] as Float32Array[]) a[i] = a[last];
      this.seed[i] = this.seed[last]; this.hop[i] = this.hop[last]; this.ident[i] = this.ident[last];
      this.mesh.getMatrixAt(last, this.M); this.mesh.setMatrixAt(i, this.M);
      if (this.mesh.instanceColor) { this.mesh.getColorAt(last, this.color); this.mesh.setColorAt(i, this.color); }
      this.anim.setXYZW(i, this.anim.getX(last), this.anim.getY(last), this.anim.getZ(last), this.anim.getW(last));
      this.look.setXYZW(i, this.look.getX(last), this.look.getY(last), this.look.getZ(last), this.look.getW(last));
    }
    this.count = last; this.mesh.count = last;
  }

  /** Nearest rider to (x, z) for the debug readout. */
  nearest(x: number, z: number): { d: number; x: number; z: number } | null {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.count; i++) { const d = Math.hypot(this.px[i] - x, this.pz[i] - z); if (d < bd) { bd = d; best = i; } }
    return best < 0 ? null : { d: bd, x: this.px[best], z: this.pz[best] };
  }

  /** Push a circle out of the riders (player collision). */
  pushOut(x: number, z: number, r: number, out: { dx: number; dz: number }) {
    const cr = r + 0.45;
    for (let i = 0; i < this.count; i++) { const dx = x - this.px[i], dz = z - this.pz[i], d = Math.hypot(dx, dz); if (d < cr && d > 1e-4) { const push = cr - d; out.dx += dx / d * push; out.dz += dz / d * push; } }
  }

  update(dt: number) {
    this.uniforms.uTime.value = this.clock.time;
    const g = this.graph, a = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      this.s[i] += this.dir[i] * this.v[i] * dt;
      const L = g.eLen[this.edge[i]];
      if (this.s[i] < 0 || this.s[i] > L) {
        const e = this.edge[i], dir = this.dir[i] as 1 | -1, node = g.nodeOf(e, dir, true);
        const over = dir > 0 ? this.s[i] - L : -this.s[i];
        const next = g.pickNext(node, e, this.hx[i], this.hz[i], this.allowed, hash32(this.seed[i], this.hop[i]++, 69), 0.8);
        if (!next) { this.dir[i] = -dir as 1 | -1; this.s[i] = dir > 0 ? L - over : over; }
        else { this.edge[i] = next.e; this.dir[i] = next.dir; const nl = g.eLen[next.e]; this.s[i] = next.dir > 0 ? Math.min(nl, over) : Math.max(0, nl - over); this.seg[i] = next.dir > 0 ? 0 : Math.max(0, g.eNv[next.e] - 2); this.lat[i] = (hash32(this.seed[i], 66) - 0.5) * Math.min(2.0, g.eWidth[next.e] * 0.4); }
      }
      const p = g.edgePoint(this.edge[i], this.s[i], this.lat[i], this.seg[i], this.tmp);
      this.seg[i] = p.seg;
      const tx = this.dir[i] * p.ux, tz = this.dir[i] * p.uz, k = 1 - Math.exp(-dt / 0.3);
      this.hx[i] += (tx - this.hx[i]) * k; this.hz[i] += (tz - this.hz[i]) * k;
      this.px[i] = p.x; this.pz[i] = p.z;
      const hl = Math.hypot(this.hx[i], this.hz[i]) || 1, c = -this.hz[i] / hl, sn = -this.hx[i] / hl;
      const y = p.y + (this.surface?.lift(p.x, p.z) ?? 0);
      // a gentle lean into the direction change would need the curvature; keep upright, faces -z at yaw 0
      const o = i * 16;
      a[o] = c; a[o + 1] = 0; a[o + 2] = -sn; a[o + 3] = 0; a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0;
      a[o + 8] = sn; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0; a[o + 12] = p.x; a[o + 13] = y; a[o + 14] = p.z; a[o + 15] = 1;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = this.count;
    void this.camX; void this.camZ;
  }
}

/**
 * Rider posed on the saddle (legs forward to the pedals, torso leaning, arms to the bars) merged with a bicycle.
 * The pose is baked into the walker geometry; bike parts use the people material's dark shoe palette (aPart 4).
 */
function riderGeometry(): THREE.BufferGeometry {
  const rider = walkerGeometry();
  const pos = rider.attributes.position as THREE.BufferAttribute, nor = rider.attributes.normal as THREE.BufferAttribute, limb = rider.attributes.aLimb as THREE.BufferAttribute;
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  // rotate the current vertex (and its normal) about an x-parallel axis through (py, pz); +ang swings points below the pivot forward (-z)
  const rotAbout = (py: number, pz: number, ang: number) => {
    const c = Math.cos(ang), sn = Math.sin(ang), dy = v.y - py, dz = v.z - pz;
    v.y = py + dy * c - dz * sn; v.z = pz + dy * sn + dz * c;
    const ny = n.y * c - n.z * sn, nz = n.y * sn + n.z * c; n.y = ny; n.z = nz;
  };
  const HIP = 0.88, SHOULDER = 1.42, LEAN = -0.42, ARM = 1.25;
  const sy = HIP + (SHOULDER - HIP) * Math.cos(LEAN), sz = (SHOULDER - HIP) * Math.sin(LEAN);   // shoulder after the lean
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i); n.fromBufferAttribute(nor, i);
    const l = limb.getX(i);
    if (l === 1 || l === 2) rotAbout(HIP, 0, l === 1 ? 0.72 : 0.58);   // legs down-forward to the pedals, slightly apart in the stroke
    else { rotAbout(HIP, 0, LEAN); if (l === 3 || l === 4) rotAbout(sy, sz, ARM); }   // upper body leans, arms reach the bars
    pos.setXYZ(i, v.x, v.y + 0.02, v.z + 0.15); nor.setXYZ(i, n.x, n.y, n.z);          // hips on the saddle
  }
  const dark = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    const cnt = g.attributes.position.count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cnt * 3).fill(1), 3));
    g.setAttribute('aLimb', new THREE.BufferAttribute(new Float32Array(cnt), 1));
    g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(cnt).fill(4), 1));
    g.deleteAttribute('uv');
    return g;
  };
  const tube = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r = 0.03) => {
    const a = new THREE.Vector3(x0, y0, z0), d = new THREE.Vector3(x1, y1, z1).sub(a), len = d.length();
    const g = new THREE.CylinderGeometry(r, r, len, 6).translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())).translate(a.x, a.y, a.z);
    return dark(g);
  };
  const R = 0.34, HUB_F = -0.55, HUB_R = 0.55, BB = { y: 0.3, z: -0.2 }, HEAD = { y: 0.97, z: -0.5 }, SEAT = { y: 0.9, z: 0.15 };
  const wheel = (z: number) => [
    dark(new THREE.TorusGeometry(R, 0.035, 6, 20).translate(0, R, z)),                             // tyre
    dark(new THREE.CylinderGeometry(R - 0.04, R - 0.04, 0.012, 16).rotateZ(Math.PI / 2).translate(0, R, z)),   // disc (reads as spokes at distance)
  ];
  const parts = [
    ...wheel(HUB_F), ...wheel(HUB_R),
    tube(0, BB.y, BB.z, 0, SEAT.y, SEAT.z),                 // seat tube
    tube(0, BB.y, BB.z, 0, HEAD.y - 0.05, HEAD.z + 0.02),   // down tube
    tube(0, SEAT.y - 0.02, SEAT.z - 0.05, 0, HEAD.y, HEAD.z),   // top tube
    tube(0, HEAD.y + 0.03, HEAD.z, 0, R, HUB_F),            // fork
    tube(0, BB.y, BB.z, 0, R, HUB_R, 0.02),                 // chain stay
    tube(0, SEAT.y - 0.02, SEAT.z, 0, R, HUB_R, 0.02),      // seat stay
    tube(-0.24, HEAD.y + 0.03, HEAD.z, 0.24, HEAD.y + 0.03, HEAD.z, 0.018),   // handlebar
    dark(new THREE.BoxGeometry(0.16, 0.05, 0.26).translate(0, SEAT.y + 0.02, SEAT.z)),   // saddle
    dark(new THREE.BoxGeometry(0.1, 0.02, 0.07).translate(-0.1, BB.y - 0.12, BB.z - 0.1)),   // pedals
    dark(new THREE.BoxGeometry(0.1, 0.02, 0.07).translate(0.1, BB.y + 0.12, BB.z + 0.1)),
  ];
  const merged = mergeGeometries([rider, ...parts], false)!;
  merged.computeBoundingSphere();
  return merged;
}
