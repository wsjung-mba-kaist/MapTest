import * as THREE from 'three';
import { REFLECT_LAYER } from '../render/WaterReflection';
import { DATA_URL, loadBinMesh } from './DataLoader';
import { buildingUniforms } from '../materials/FacadeMaterial';

/**
 * Distant skyline: one flat-shaded mesh of simplified BD TOPO buildings beyond the detailed square, plus a sparse
 * additive point cloud of lit windows scattered over its walls at night (a per-fragment hash would shimmer at 2 km).
 */
export class FarRing {
  readonly group = new THREE.Group();
  readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.9, metalness: 0 });
  count = 0;
  windows = 0;

  constructor() { this.group.name = 'far'; }

  async load() {
    const bm = await loadBinMesh(`${DATA_URL}/far.bin`);
    this.count = (bm.header.meta?.count as number) ?? 0;
    const s = bm.sections.get('far');
    if (!s) return;
    const mesh = new THREE.Mesh(s.geometry, this.material);
    mesh.name = 'far_ring';
    mesh.layers.enable(REFLECT_LAYER);
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    const pts = windowPoints(s.geometry, 120000);
    if (pts) { this.windows = pts.geometry.attributes.position.count; pts.layers.enable(REFLECT_LAYER); this.group.add(pts); }
    // ground skirt: a flat ring from the baked square out to the horizon so the far buildings do not stand on the void
    const farHalf = (bm.header.meta?.farHalf as number) ?? 3400;
    const skirt = new THREE.Mesh(ringGeometry(1536, farHalf + 1500, -1.5), new THREE.MeshStandardMaterial({ color: 0x5a5852, roughness: 1, metalness: 0 }));
    skirt.name = 'far_skirt'; skirt.receiveShadow = false; skirt.castShadow = false; skirt.matrixAutoUpdate = false;
    skirt.layers.enable(REFLECT_LAYER);
    this.group.add(skirt);
  }
}

/** Square ring (outer square minus inner square) at height y, 8 triangles. */
function ringGeometry(inner: number, outer: number, y: number): THREE.BufferGeometry {
  const o = outer, i = inner;
  const P = [[-o, -o], [o, -o], [o, o], [-o, o], [-i, -i], [i, -i], [i, i], [-i, i]];
  const pos = new Float32Array(P.length * 3);
  P.forEach(([x, z], k) => { pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z; });
  // outer k, inner k+4; each side is a quad (k, k+1, k+5, k+4) wound to face +y
  const idx: number[] = [];
  for (let k = 0; k < 4; k++) { const a = k, b = (k + 1) % 4, c = 4 + (k + 1) % 4, d = 4 + k; idx.push(a, c, b, a, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // flip if the normals came out downward
  const n = g.attributes.normal as THREE.BufferAttribute; if (n.getY(0) < 0) { const ix = g.index!; for (let t = 0; t < ix.count; t += 3) { const tmp = ix.getX(t + 1); ix.setX(t + 1, ix.getX(t + 2)); ix.setX(t + 2, tmp); } g.computeVertexNormals(); }
  return g;
}

/** Candidate windows on the wall triangles (one per ~22 m2 of facade), lit per the hour's fraction in the shader. */
function windowPoints(geom: THREE.BufferGeometry, cap: number): THREE.Points | null {
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const idx = geom.index;
  const tris = idx ? idx.count / 3 : pos.count / 3;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
  const walls: { a: number; b: number; c: number; area: number }[] = [];
  let total = 0;
  for (let t = 0; t < tris; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    A.fromBufferAttribute(pos, a); B.fromBufferAttribute(pos, b); C.fromBufferAttribute(pos, c);
    N.copy(B).sub(A).cross(C.clone().sub(A));
    const area = N.length() * 0.5;
    if (area < 4 || Math.abs(N.y / (area * 2)) > 0.3) continue;   // walls only
    walls.push({ a, b, c, area }); total += area;
  }
  if (!total) return null;
  const density = Math.min(1 / 22, cap / total);
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const out: number[] = [], seeds: number[] = [];
  for (const w of walls) {
    const expected = w.area * density;
    const n = Math.floor(expected) + (rnd() < expected - Math.floor(expected) ? 1 : 0);
    A.fromBufferAttribute(pos, w.a); B.fromBufferAttribute(pos, w.b); C.fromBufferAttribute(pos, w.c);
    for (let k = 0; k < n; k++) {
      let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const x = A.x + (B.x - A.x) * u + (C.x - A.x) * v, y = A.y + (B.y - A.y) * u + (C.y - A.y) * v, z = A.z + (B.z - A.z) * u + (C.z - A.z) * v;
      if (y < 3) continue;                                          // not at street level
      out.push(x, y, z); seeds.push(rnd());
    }
  }
  if (!out.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNight: buildingUniforms.uNight, uHour: buildingUniforms.uHour },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aSeed; uniform float uNight; uniform float uHour; varying vec3 vCol; varying float vA;
      float litP(float h) {
        h = mod(h, 24.0);
        float hs[17] = float[17](0.,1.,2.,3.,4.,5.,6.,7.,8.,17.,18.,19.,20.,21.,22.,23.,24.);
        float ps[17] = float[17](0.20,0.15,0.10,0.07,0.06,0.08,0.12,0.10,0.05,0.05,0.09,0.15,0.28,0.40,0.40,0.35,0.20);
        for (int i = 0; i < 16; i++) if (h >= hs[i] && h <= hs[i + 1]) return mix(ps[i], ps[i + 1], (h - hs[i]) / (hs[i + 1] - hs[i]));
        return 0.2;
      }
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(1.0, -mv.z);
        // the points stand for the 40 % of windows lit at the evening peak; fewer of them stay on as the night goes
        float on = aSeed * 0.4 < litP(uHour) ? 1.0 : 0.0;
        float warm = fract(aSeed * 17.3);
        vCol = warm < 0.7 ? vec3(1.0, 0.68, 0.38) : (warm < 0.88 ? vec3(1.0, 0.85, 0.62) : vec3(0.78, 0.86, 1.0));
        vA = on * uNight * (0.35 + 0.65 * fract(aSeed * 9.1)) * smoothstep(300.0, 900.0, d);
        gl_PointSize = clamp(1400.0 / d, 1.2, 3.2);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying float vA;
      void main() { if (vA <= 0.001) discard; float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; gl_FragColor = vec4(vCol * vA * 0.9, vA * 0.9); }`,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  p.matrixAutoUpdate = false;
  p.name = 'far_windows';
  return p;
}
