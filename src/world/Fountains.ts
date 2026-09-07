import * as THREE from 'three';
import { DATA_URL } from './DataLoader';
import { buildingUniforms } from '../materials/FacadeMaterial';

interface Jet { x: number; y: number; z: number; vx: number; vy: number; vz: number; n: number; w: number }
export interface FountainSite { name: string; x: number; y: number; z: number; jets: number }

/**
 * Fountain jets as parabolic particle streams (one Points draw call): each droplet is launched from its nozzle with a
 * small spread, follows gravity for its flight time and respawns in phase. Bigger toward the top of the arc where the
 * water breaks up; floodlit-bright at night like the Trocadéro fountains.
 */
export class Fountains {
  readonly group = new THREE.Group();
  sites: FountainSite[] = [];
  count = 0;

  constructor() { this.group.name = 'fountains'; }

  async load() {
    const res = await fetch(`${DATA_URL}/fountains.json`);
    if (!res.ok) throw new Error(`fountains.json ${res.status}`);
    const data = await res.json() as { jets: Jet[]; sites: FountainSite[] };
    this.sites = data.sites;
    const total = data.jets.reduce((s, j) => s + j.n, 0);
    this.count = data.jets.length;
    if (!total) return;
    const origin = new Float32Array(total * 3), vel = new Float32Array(total * 3), ph = new Float32Array(total * 2);
    let seed = 24680;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let k = 0;
    for (const j of data.jets) {
      const speed = Math.hypot(j.vx, j.vy, j.vz);
      for (let i = 0; i < j.n; i++) {
        // nozzle spread: jitter the direction by up to ~2.5 degrees and the speed by +-6 %
        const sp = speed * (0.94 + rnd() * 0.12), a = rnd() * Math.PI * 2, r = rnd() * 0.045;
        const jx = Math.cos(a) * r, jz = Math.sin(a) * r;
        const dx = j.vx / speed + jx, dy = j.vy / speed, dz = j.vz / speed + jz, dl = Math.hypot(dx, dy, dz);
        origin[k * 3] = j.x + (rnd() - 0.5) * j.w; origin[k * 3 + 1] = j.y; origin[k * 3 + 2] = j.z + (rnd() - 0.5) * j.w;
        vel[k * 3] = dx / dl * sp; vel[k * 3 + 1] = dy / dl * sp; vel[k * 3 + 2] = dz / dl * sp;
        ph[k * 2] = rnd(); ph[k * 2 + 1] = 2 * (dy / dl * sp) / 9.81;   // phase, flight time back to the launch height
        k++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(origin, 3));
    g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    g.setAttribute('aPh', new THREE.BufferAttribute(ph, 2));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: buildingUniforms.uTime, uNight: buildingUniforms.uNight },
      transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        attribute vec3 aVel; attribute vec2 aPh; uniform float uTime; uniform float uNight; varying float vA; varying float vT;
        void main() {
          float T = max(0.2, aPh.y);
          float t = fract(uTime / T + aPh.x) * T;
          vec3 p = position + aVel * t + vec3(0.0, -4.905 * t * t, 0.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = max(1.0, -mv.z);
          vT = t / T;
          gl_PointSize = clamp(220.0 / d, 1.5, 9.0) * (0.6 + 0.9 * vT);
          vA = (0.55 - 0.3 * vT) * (1.0 - smoothstep(250.0, 600.0, d));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uNight; varying float vA; varying float vT;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0 || vA <= 0.002) discard;
          float a = vA * (1.0 - r * r);
          // white water, a touch of sky blue in the column, floodlit at night
          vec3 col = mix(vec3(0.78, 0.88, 1.0), vec3(1.0), vT) * (1.0 + 0.6 * uNight);
          gl_FragColor = vec4(col, a);
        }`,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    pts.name = 'fountain_jets';
    this.group.add(pts);
  }
}
