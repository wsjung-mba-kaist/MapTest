import * as THREE from 'three';
import type { PathGraph, EdgePoint } from './PathGraph';
import type { SimClock } from './SimClock';
import { buildingUniforms } from '../../materials/FacadeMaterial';
import { hash32 } from '../../../shared/hash';

const N = 3200;
const LIFT = 0.7;   // lamp height above the road surface (m)

/**
 * Distant traffic as moving light points. The simulated cars only exist within ~350 m of the viewer, so from the
 * tower or the Trocadéro the boulevards would be dead at night. Each point drives along a drivable edge in its kerb
 * lane and respawns on a length-weighted random edge when it runs out; the shader colours it warm white when it comes
 * toward the viewer and red when it goes away, and only fades it in beyond the radius where the real cars stop.
 * Night only, one draw call, ~3k points advanced on the CPU each frame.
 */
export class FarTraffic {
  readonly group = new THREE.Group();
  readonly count = N;
  private readonly edges: number[] = [];
  private readonly cum: number[] = [];
  private total = 0;
  private readonly edge = new Int32Array(N);
  private readonly dir = new Int8Array(N);
  private readonly s = new Float32Array(N);
  private readonly v = new Float32Array(N);
  private readonly seg = new Int32Array(N);
  private readonly gen = new Uint16Array(N);
  private readonly pos = new Float32Array(N * 3);
  private readonly hdg = new Float32Array(N * 2);
  private readonly posAttr: THREE.BufferAttribute;
  private readonly hdgAttr: THREE.BufferAttribute;
  private readonly tmp: EdgePoint = { x: 0, y: 0, z: 0, ux: 0, uz: -1, seg: 0 };
  private readonly uniforms = { uNight: buildingUniforms.uNight, uNear: { value: 260 }, uFar: { value: 420 } };

  constructor(readonly graph: PathGraph, readonly clock: SimClock) {
    this.group.name = 'fartraffic';
    for (let e = 0; e < graph.eLen.length; e++) {
      if (!graph.drivable(e) || graph.eLen[e] < 20) continue;
      this.edges.push(e); this.total += graph.eLen[e]; this.cum.push(this.total);
    }
    for (let i = 0; i < N; i++) this.spawn(i, true);
    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.hdgAttr = new THREE.BufferAttribute(this.hdg, 2).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('aDir', this.hdgAttr);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      vertexShader: /* glsl */`
        attribute vec2 aDir; uniform float uNight; uniform float uNear; uniform float uFar; varying vec3 vCol; varying float vA;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec3 toCam = cameraPosition - wp.xyz; float d = length(toCam);
          float facing = dot(normalize(toCam.xz + vec2(1e-4, 0.0)), aDir);
          vCol = facing > 0.0 ? vec3(1.0, 0.93, 0.78) : vec3(1.0, 0.10, 0.04);
          vA = uNight * smoothstep(uNear, uFar, d) * (facing > 0.0 ? 1.0 : 0.6) * (1.0 - smoothstep(2500.0, 4000.0, d));
          gl_PointSize = clamp(1400.0 / d, 2.0, 5.0);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol; varying float vA;
        void main() { if (vA <= 0.002) discard; float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; float a = pow(1.0 - r, 1.5) * vA; gl_FragColor = vec4(vCol * a * 2.2, 1.0); }`,
    });
    const pts = new THREE.Points(geom, mat);
    pts.frustumCulled = false;
    pts.name = 'far_traffic';
    this.group.add(pts);
    if (!this.edges.length) this.group.visible = false;
    this.write();
  }

  /** Put light i on a length-weighted random edge, anywhere along it (first fill) or at its start (respawn). */
  private spawn(i: number, anywhere: boolean) {
    if (!this.edges.length) return;
    const g = this.graph, gen = this.gen[i]++;
    const t = hash32(i, gen, 3) * this.total;
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] < t) lo = mid + 1; else hi = mid; }
    const e = this.edges[lo];
    const dir: 1 | -1 = g.isOneway(e) ? 1 : (hash32(i, gen, 5) < 0.5 ? 1 : -1);
    const L = g.eLen[e];
    const frac = anywhere ? hash32(i, gen, 7) : 0.002;
    this.edge[i] = e; this.dir[i] = dir; this.s[i] = dir > 0 ? frac * L : L - frac * L;
    this.v[i] = 7 + 6 * hash32(i, gen, 11);
    this.seg[i] = 0;
  }

  update(dt: number) {
    if (!this.edges.length) return;
    if (dt > 0) {
      for (let i = 0; i < N; i++) {
        this.s[i] += this.dir[i] * this.v[i] * dt;
        if (this.s[i] < 0 || this.s[i] > this.graph.eLen[this.edge[i]]) this.spawn(i, false);
      }
    }
    this.write();
  }

  private write() {
    const g = this.graph;
    for (let i = 0; i < N; i++) {
      const e = this.edge[i], dir = this.dir[i] as 1 | -1;
      const p = g.edgePoint(e, this.s[i], g.laneLat(e, 0, dir), this.seg[i], this.tmp);
      this.seg[i] = p.seg;
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y + LIFT; this.pos[i * 3 + 2] = p.z;
      this.hdg[i * 2] = dir * p.ux; this.hdg[i * 2 + 1] = dir * p.uz;
    }
    this.posAttr.needsUpdate = true; this.hdgAttr.needsUpdate = true;
  }
}
