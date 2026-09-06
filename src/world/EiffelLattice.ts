import * as THREE from 'three';

/**
 * Procedural lattice Eiffel Tower built from the documented geometry:
 *  - four pillars on a 125 m square (corners toward N/E/S/W), centres following an exponential curve,
 *  - each pillar = four box-truss chords with X-braced faces,
 *  - the four decorative arches under the first floor,
 *  - first (57.6 m), second (115.7 m) and third (276 m) floor girders with slabs and railings,
 *  - the tapering upper shaft, campanile and antenna mast to 330 m.
 * Everything is one InstancedMesh of unit boxes (~20k instances), coloured in the three "Eiffel brown" tones.
 */

export interface LatticeResult { mesh: THREE.InstancedMesh; panels: THREE.InstancedMesh; material: THREE.MeshStandardMaterial; samples: THREE.Vector3[]; instances: number; top: number }

const H1 = 57.6, H2 = 115.7, H3 = 276.1, HTOP = 300.6, HANT = 330;
const D1 = new THREE.Vector3(Math.SQRT1_2, 0, Math.SQRT1_2);   // square side direction (SE)
const D2 = new THREE.Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);  // square side direction (NE)
const CARDINAL = [new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)]; // N E S W

/** Radius from the axis to a pillar/chord centre at height h (metres). */
function radiusAt(h: number): number {
  if (h <= H2) return 70 * Math.exp(-0.00972 * h);
  if (h <= H3) return THREE.MathUtils.lerp(22.9, 12.0, (h - H2) / (H3 - H2));
  if (h <= HTOP) return THREE.MathUtils.lerp(6.0, 4.2, (h - H3) / (HTOP - H3));
  return 1.2;
}
/** Side of a pillar's square cross-section at height h. */
function pillarSide(h: number): number { return Math.max(4.6, 25 * Math.exp(-0.01425 * Math.min(h, H2))); }
/** Size of a chord's own box-truss cross-section. */
function chordSize(h: number): number { return h <= H2 ? THREE.MathUtils.lerp(2.4, 1.3, h / H2) : THREE.MathUtils.lerp(1.3, 0.8, Math.min(1, (h - H2) / (H3 - H2))); }

class Beams {
  readonly mats: THREE.Matrix4[] = [];
  readonly cols: THREE.Color[] = [];
  readonly samples: THREE.Vector3[] = [];
  readonly panels: { m: THREE.Matrix4; w: number; h: number }[] = [];
  private readonly m = new THREE.Matrix4(); private readonly q = new THREE.Quaternion(); private readonly s = new THREE.Vector3(); private readonly p = new THREE.Vector3();
  private readonly dir = new THREE.Vector3(); private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly tmpQ = new THREE.Quaternion();

  /** Box beam from a to b with cross-section w (across `roll` direction) x t. */
  beam(a: THREE.Vector3, b: THREE.Vector3, w: number, t = w, tone?: THREE.Color, roll?: THREE.Vector3) {
    this.dir.subVectors(b, a);
    const len = this.dir.length();
    if (len < 0.01) return;
    this.dir.divideScalar(len);
    this.q.setFromUnitVectors(this.up, this.dir);
    if (roll) {
      // Rotate about the beam axis so the local +x points along `roll` (keeps flat plates facing outward).
      const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(this.q);
      const target = roll.clone().sub(this.dir.clone().multiplyScalar(roll.dot(this.dir)));
      if (target.lengthSq() > 1e-6) {
        target.normalize();
        const ang = Math.atan2(new THREE.Vector3().crossVectors(lx, target).dot(this.dir), lx.dot(target));
        this.q.multiply(this.tmpQ.setFromAxisAngle(this.up, ang));
      }
    }
    this.p.addVectors(a, b).multiplyScalar(0.5);
    this.s.set(w, len, t);
    this.mats.push(this.m.compose(this.p, this.q, this.s).clone());
    this.cols.push(tone ?? toneAt(this.p.y));
    if (this.mats.length % 3 === 0) this.samples.push(this.p.clone());
  }

  /** Flat lattice sheet spanning the quad a0-b0 (bottom) to a1-b1 (top). */
  panel(a0: THREE.Vector3, b0: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3) {
    const u = new THREE.Vector3().subVectors(b0, a0), v = new THREE.Vector3().subVectors(a1, a0);
    const w = u.length(), h = v.length(); if (w < 0.3 || h < 0.3) return;
    u.divideScalar(w); v.divideScalar(h);
    const n = new THREE.Vector3().crossVectors(u, v).normalize();
    v.crossVectors(n, u).normalize();
    const c = new THREE.Vector3().add(a0).add(b0).add(a1).add(b1).multiplyScalar(0.25);
    const m = new THREE.Matrix4().makeBasis(u.multiplyScalar(w), v.multiplyScalar(h), n).setPosition(c);
    this.panels.push({ m, w, h });
  }

  box(centre: THREE.Vector3, sx: number, sy: number, sz: number, tone: THREE.Color, yaw = 0) {
    this.q.setFromAxisAngle(this.up, yaw);
    this.s.set(sx, sy, sz);
    this.mats.push(this.m.compose(centre, this.q, this.s).clone());
    this.cols.push(tone);
  }
}

const TONES = [new THREE.Color(0x3d2d21), new THREE.Color(0x54402f), new THREE.Color(0x6b5541)];
const STONE = new THREE.Color(0xb6ad9f);
const SLAB = new THREE.Color(0x2e2a26);
const RAIL = new THREE.Color(0x3a3230);
function toneAt(y: number): THREE.Color {
  const t = THREE.MathUtils.clamp(y / HTOP, 0, 1);
  return t < 0.33 ? TONES[0] : t < 0.66 ? TONES[1] : TONES[2];
}

/** Box truss along the polyline pts with cross-section `size(h)`, sub-chords + ties + X bracing. */
function boxTruss(B: Beams, pts: THREE.Vector3[], size: (h: number) => number, sub = 0.2, brace = 0.11, frame: [THREE.Vector3, THREE.Vector3] = [D1, D2]) {
  const corners = (p: THREE.Vector3, s: number) => [
    p.clone().addScaledVector(frame[0], s / 2).addScaledVector(frame[1], s / 2), p.clone().addScaledVector(frame[0], s / 2).addScaledVector(frame[1], -s / 2),
    p.clone().addScaledVector(frame[0], -s / 2).addScaledVector(frame[1], -s / 2), p.clone().addScaledVector(frame[0], -s / 2).addScaledVector(frame[1], s / 2),
  ];
  let prev = corners(pts[0], size(pts[0].y));
  for (let i = 1; i < pts.length; i++) {
    const cur = corners(pts[i], size(pts[i].y));
    for (let k = 0; k < 4; k++) {
      B.beam(prev[k], cur[k], sub);                                   // sub-chord
      B.beam(cur[k], cur[(k + 1) % 4], brace);                        // tie at the top of the panel
      B.beam(prev[k], cur[(k + 1) % 4], brace * 0.9);                 // X bracing
      B.beam(prev[(k + 1) % 4], cur[k], brace * 0.9);
    }
    prev = cur;
  }
}

function pillarChordPath(pillar: number, cornerSign: [number, number], h0: number, h1: number, step: number): THREE.Vector3[] {
  const d = CARDINAL[pillar];
  const pts: THREE.Vector3[] = [];
  for (let h = h0; h < h1 + 1e-6; h += step) {
    const hh = Math.min(h, h1);
    const r = radiusAt(hh), w = pillarSide(hh);
    pts.push(new THREE.Vector3(0, hh, 0).addScaledVector(d, r).addScaledVector(D1, cornerSign[0] * w / 2).addScaledVector(D2, cornerSign[1] * w / 2));
    if (hh === h1) break;
  }
  return pts;
}

/** Square ring girder at height hTop with depth `depth`, corner radius `rc` (corners toward N/E/S/W). */
function floorGirder(B: Beams, hTop: number, depth: number, rc: number, chord: number, railH = 1.1) {
  const corner = (k: number, h: number) => new THREE.Vector3(0, h, 0).addScaledVector(CARDINAL[k], rc);
  const hBot = hTop - depth;
  for (let k = 0; k < 4; k++) {
    const a0 = corner(k, hBot), b0 = corner((k + 1) % 4, hBot), a1 = corner(k, hTop), b1 = corner((k + 1) % 4, hTop);
    const side = new THREE.Vector3().subVectors(b0, a0); const L = side.length(); side.divideScalar(L);
    const outward = new THREE.Vector3(side.z, 0, -side.x); if (outward.dot(a0) < 0) outward.negate();
    // Outer face and inner face of the girder (two parallel trusses 2 m apart).
    for (const off of [0, -2.2]) {
      const oa0 = a0.clone().addScaledVector(outward, off), ob0 = b0.clone().addScaledVector(outward, off);
      const oa1 = a1.clone().addScaledVector(outward, off), ob1 = b1.clone().addScaledVector(outward, off);
      B.beam(oa0, ob0, chord, chord * 0.7, undefined, outward); B.beam(oa1, ob1, chord, chord * 0.7, undefined, outward);
      const n = Math.max(2, Math.round(L / 4.2));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const pb = oa0.clone().lerp(ob0, t), pt = oa1.clone().lerp(ob1, t);
        B.beam(pb, pt, chord * 0.5, chord * 0.4, undefined, outward);
        if (i < n) {
          const nb = oa0.clone().lerp(ob0, (i + 1) / n), nt = oa1.clone().lerp(ob1, (i + 1) / n);
          B.beam(pb, nt, chord * 0.32, chord * 0.2, undefined, outward); B.beam(pt, nb, chord * 0.32, chord * 0.2, undefined, outward);
        }
      }
    }
    // Floor slab strip along this side (between outer and inner face) and railing on the outer edge.
    const mid = a1.clone().lerp(b1, 0.5).addScaledVector(outward, -1.1).setY(hTop + 0.12);
    const yaw = Math.atan2(side.x, side.z);
    B.box(mid, 2.4, 0.25, L, SLAB, yaw);
    const posts = Math.round(L / 1.6);
    for (let i = 0; i <= posts; i++) {
      const p = a1.clone().lerp(b1, i / posts).addScaledVector(outward, 0.15);
      B.beam(p.clone().setY(hTop + 0.2), p.clone().setY(hTop + railH), 0.07, 0.07, RAIL);
    }
    B.beam(a1.clone().addScaledVector(outward, 0.15).setY(hTop + railH), b1.clone().addScaledVector(outward, 0.15).setY(hTop + railH), 0.08, 0.08, RAIL);
    B.beam(a1.clone().addScaledVector(outward, 0.15).setY(hTop + railH * 0.55), b1.clone().addScaledVector(outward, 0.15).setY(hTop + railH * 0.55), 0.05, 0.05, RAIL);
  }
}

/** Decorative arch under the first floor between two adjacent pillars (in the vertical plane of the square side). */
function arch(B: Beams, k: number) {
  const a = CARDINAL[k], b = CARDINAL[(k + 1) % 4];
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5); // direction to the side's midpoint (length 1/sqrt2)
  const side = new THREE.Vector3().subVectors(b, a).normalize();
  const r0 = radiusAt(0);
  // Arch plane passes through the pillars' inner chords at ground: offset from the axis along `mid`.
  const centreDist = r0 * mid.length() - pillarSide(0) * 0.18;
  const centre = mid.clone().normalize().multiplyScalar(centreDist);
  const R = 37.0, rInner = R - 3.2, hc = 39.0 - R;
  const segs = 44;
  const pt = (rad: number, ang: number) => centre.clone().addScaledVector(side, Math.cos(ang) * rad).setY(hc + Math.sin(ang) * rad);
  let prevO = pt(R, 0), prevI = pt(rInner, 0);
  const outward = mid.clone().normalize();
  for (let i = 1; i <= segs; i++) {
    const ang = (i / segs) * Math.PI;
    const o = pt(R, ang), inn = pt(rInner, ang);
    if (o.y > -1) {
      B.beam(prevO, o, 0.7, 0.45, undefined, outward); B.beam(prevI, inn, 0.55, 0.4, undefined, outward);
      B.beam(inn, o, 0.3, 0.25, undefined, outward);
      if (i % 2 === 0) B.beam(prevI, o, 0.22, 0.18, undefined, outward); else B.beam(prevO, inn, 0.22, 0.18, undefined, outward);
    }
    prevO = o; prevI = inn;
  }
}

export function buildLattice(): LatticeResult {
  const B = new Beams();

  // ---- pillars: four legs, each with four box-truss corner chords and X-braced faces
  const cornerSigns: [number, number][] = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  for (let p = 0; p < 4; p++) {
    const paths = cornerSigns.map(cs => pillarChordPath(p, cs, -1.5, H2, 3.4));
    for (const path of paths) boxTruss(B, path, chordSize, 0.34, 0.16);
    // Face bracing between adjacent chords: big X per panel, panel height growing with height.
    const n = paths[0].length;
    for (let f = 0; f < 4; f++) {
      const A = paths[f], C = paths[(f + 1) % 4];
      let i = 0;
      while (i < n - 1) {
        const span = Math.max(2, Math.round(3 - A[i].y / 60)); // 3 segments (~10 m) low, 2 (~7 m) high
        const j = Math.min(n - 1, i + span);
        const out = new THREE.Vector3().addVectors(A[i], C[i]).multiplyScalar(0.5).setY(0).normalize();
        B.beam(A[i], C[j], 0.9, 0.3, undefined, out); B.beam(C[i], A[j], 0.9, 0.3, undefined, out);
        B.beam(A[j], C[j], 0.8, 0.3, undefined, out);
        for (let q = i; q < j; q++) B.panel(A[q], C[q], A[q + 1], C[q + 1]);
        i = j;
      }
    }
  }

  // ---- arches, floors
  for (let k = 0; k < 4; k++) arch(B, k);
  floorGirder(B, H1, 7.2, 48, 0.8);
  floorGirder(B, H2, 5.0, 30, 0.6);
  floorGirder(B, H3, 4.0, 13.5, 0.45, 1.3);
  floorGirder(B, HTOP, 2.2, 6.0, 0.3, 1.2);

  // ---- upper shaft: four corner chords + ties + bracing, then the campanile
  const shaftPaths = CARDINAL.map(d => { const pts: THREE.Vector3[] = []; for (let h = H2; h <= HTOP + 1e-6; h += 3.6) pts.push(new THREE.Vector3(0, Math.min(h, HTOP), 0).addScaledVector(d, radiusAt(Math.min(h, HTOP)))); return pts; });
  for (const path of shaftPaths) boxTruss(B, path, h => chordSize(h) * 1.35, 0.3, 0.13, [D1, D2]);
  const ns = shaftPaths[0].length;
  for (let f = 0; f < 4; f++) {
    const A = shaftPaths[f], C = shaftPaths[(f + 1) % 4];
    for (let i = 0; i + 2 < ns; i += 2) {
      const out = new THREE.Vector3().addVectors(A[i], C[i]).multiplyScalar(0.5).setY(0).normalize();
      B.beam(A[i], C[i], 0.6, 0.25, undefined, out);
      B.beam(A[i], C[i + 2], 0.55, 0.2, undefined, out); B.beam(C[i], A[i + 2], 0.55, 0.2, undefined, out);
      B.panel(A[i], C[i], A[i + 2], C[i + 2]);
    }
  }

  // ---- antenna mast and dishes
  B.beam(new THREE.Vector3(0, HTOP, 0), new THREE.Vector3(0, HANT, 0), 1.2, 1.2, TONES[2]);
  B.beam(new THREE.Vector3(0, HTOP, 0), new THREE.Vector3(0, HTOP + 12, 0), 2.6, 2.6, TONES[2]);
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; B.box(new THREE.Vector3(Math.cos(a) * 2.2, HTOP + 8 + i * 2.5, Math.sin(a) * 2.2), 1.6, 1.6, 0.4, TONES[2], -a); }

  // ---- masonry plinths under the pillars
  for (let p = 0; p < 4; p++) B.box(new THREE.Vector3(0, 0.3, 0).addScaledVector(CARDINAL[p], radiusAt(0)), 27, 1.6, 27, STONE, Math.PI / 4);

  // ---- assemble
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.18, vertexColors: false });
  const mesh = new THREE.InstancedMesh(geom, material, B.mats.length);
  for (let i = 0; i < B.mats.length; i++) { mesh.setMatrixAt(i, B.mats[i]); mesh.setColorAt(i, B.cols[i]); }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const panels = buildPanels(B.panels, material.color);
  return { mesh, material, panels, samples: B.samples, instances: B.mats.length + B.panels.length, top: HANT };
}

/** Alpha-tested lattice sheets: a canvas texture of fine X bracing, tiled at ~1.3 m cells per panel. */
function latticeTexture(): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = '#ffffff'; ctx.lineCap = 'square';
  ctx.lineWidth = 13;
  for (let k = -S; k <= 2 * S; k += S / 2) { ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k + S, S); ctx.stroke(); ctx.beginPath(); ctx.moveTo(k + S, 0); ctx.lineTo(k, S); ctx.stroke(); }
  ctx.lineWidth = 10;
  for (const y of [0, S / 2, S]) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
  for (const x of [0, S / 2, S]) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, S); ctx.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function buildPanels(panels: { m: THREE.Matrix4; w: number; h: number }[], _tint: THREE.Color): THREE.InstancedMesh {
  const geom = new THREE.PlaneGeometry(1, 1);
  const scale = new Float32Array(panels.length * 2);
  panels.forEach((p, i) => { scale[i * 2] = Math.max(1, Math.round(p.w / 2.6)); scale[i * 2 + 1] = Math.max(1, Math.round(p.h / 2.6)); });
  geom.setAttribute('panelScale', new THREE.InstancedBufferAttribute(scale, 2));
  const tex = latticeTexture();
  const mat = new THREE.MeshStandardMaterial({ color: TONES[1], alphaMap: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.18 });
  mat.customProgramCacheKey = () => 'eiffel-panel';
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 panelScale;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_ALPHAMAP\nvAlphaMapUv = uv * panelScale;\n#endif');
    // Far away the fine bracing averages out in the mips; lower the alpha cut-off with distance so the sheets
    // read as the dense steel the real tower shows from the Trocadéro.
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>',
      'float latticeCut = mix(0.5, 0.27, smoothstep(120.0, 650.0, length(vViewPosition))); if (diffuseColor.a < latticeCut) discard;');
  };
  const mesh = new THREE.InstancedMesh(geom, mat, panels.length);
  panels.forEach((p, i) => mesh.setMatrixAt(i, p.m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
  return mesh;
}
