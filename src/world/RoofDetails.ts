import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DETAIL_STRIDE, RoofDetailKind } from '../../shared/layout';
import { buildingUniforms } from '../materials/FacadeMaterial';
import { withLamps } from '../render/LocalLights';
import { hash32 } from '../../shared/hash';

/**
 * Chimney stacks and dormer boxes baked per chunk (details/{i}_{j}.bin). Instanced per kind; dormer windows glow
 * at night for a third of them. Geometries are authored at their typical size and scaled per instance.
 */
export interface RoofDetailMeshes { meshes: THREE.InstancedMesh[]; count: number }

const CHIMNEY_COLORS = [0x9a7a5c, 0x7d5a45, 0x8f8a80, 0xa38a6a];
const geoms = new Map<number, THREE.BufferGeometry>();
let stackMat: THREE.MeshStandardMaterial | null = null, dormerMat: THREE.MeshStandardMaterial | null = null;

function paint(g: THREE.BufferGeometry, c: THREE.Color | null, glass = 0): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), gl = new Float32Array(n);
  for (let i = 0; i < n; i++) { col[i * 3] = c ? c.r : 1; col[i * 3 + 1] = c ? c.g : 1; col[i * 3 + 2] = c ? c.b : 1; gl[i] = glass; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aGlass', new THREE.BufferAttribute(gl, 1));
  g.deleteAttribute('uv');
  return g;
}

/** Chimney stack authored at 1.15 x 2.0 x 0.6 m with `pots` clay pots on top; origin at the base centre. */
function chimneyGeometry(pots: number): THREE.BufferGeometry {
  const body = paint(new THREE.BoxGeometry(1.15, 2.0, 0.6).translate(0, 1.0, 0), null);
  const cap = paint(new THREE.BoxGeometry(1.25, 0.12, 0.7).translate(0, 2.0, 0), new THREE.Color(0x6e6a64));
  const parts = [body, cap];
  const pot = new THREE.Color(0xb0663f);
  for (let k = 0; k < pots; k++) {
    const x = (k - (pots - 1) / 2) * (0.95 / Math.max(1, pots - 1 || 1));
    parts.push(paint(new THREE.CylinderGeometry(0.1, 0.12, 0.45, 8).translate(pots === 1 ? 0 : x, 2.28, 0), pot));
  }
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  return g;
}

/** Dormer authored at 1.35 x 1.75 x 1.05 m: zinc box, white frame, dark glass on the front (-z? no: +x is along the edge, front = outward = +... ) */
function dormerGeometry(): THREE.BufferGeometry {
  // local frame: +z along the roof edge, +x outward (away from the building), y up; origin at the box centre bottom
  const zinc = new THREE.Color(0x8f949a), frame = new THREE.Color(0xf0eee8), glass = new THREE.Color(0x101418);
  const body = paint(new THREE.BoxGeometry(1.05, 1.75, 1.35).translate(0, 0.875, 0), zinc);
  const roof = paint(new THREE.BoxGeometry(1.15, 0.12, 1.45).translate(0, 1.78, 0), zinc);
  const fr = paint(new THREE.BoxGeometry(0.06, 1.35, 1.05).translate(0.53, 0.85, 0), frame);
  const gl = paint(new THREE.BoxGeometry(0.04, 1.15, 0.85).translate(0.55, 0.85, 0), glass, 1);
  const mullion = paint(new THREE.BoxGeometry(0.05, 1.15, 0.06).translate(0.57, 0.85, 0), frame);
  const g = mergeGeometries([body, roof, fr, gl, mullion], false)!;
  g.computeBoundingSphere();
  return g;
}

function materials() {
  if (!stackMat) stackMat = withLamps(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }));
  if (!dormerMat) {
    dormerMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25 });
    dormerMat.customProgramCacheKey = () => 'dormer';
    dormerMat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, buildingUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlass; attribute float aLit; varying float vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlass * max(aLit, 0.001);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uNight; uniform float uHour; varying float vGlow;
          // same table as shared/nightlife.ts LIT_ANCHORS; attic rooms light up at about half the rate of the floors below
          float dormerLitP(float h) {
            h = mod(h, 24.0);
            float hs[17] = float[17](0.,1.,2.,3.,4.,5.,6.,7.,8.,17.,18.,19.,20.,21.,22.,23.,24.);
            float ps[17] = float[17](0.20,0.15,0.10,0.07,0.06,0.08,0.12,0.10,0.05,0.05,0.09,0.15,0.28,0.40,0.40,0.35,0.20);
            for (int i = 0; i < 16; i++) if (h >= hs[i] && h <= hs[i + 1]) return 0.6 * mix(ps[i], ps[i + 1], (h - hs[i]) / (hs[i + 1] - hs[i]));
            return 0.1;
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            // vGlow = aGlass * hash: glass texel of a dormer whose draw falls under tonight's lit fraction
            float on = (vGlow > 0.0 && vGlow < dormerLitP(uHour)) ? 1.0 : 0.0;
            float warm = fract(vGlow * 13.7);
            vec3 col = warm < 0.7 ? vec3(1.0, 0.62, 0.32) : vec3(1.0, 0.80, 0.58);
            totalEmissiveRadiance += col * on * uNight * (0.45 + 0.5 * fract(vGlow * 7.3));
          }`);
    };
    withLamps(dormerMat);
  }
  return { stackMat, dormerMat };
}

export function buildRoofDetails(rows: Float32Array, chunkOrigin: THREE.Vector3): RoofDetailMeshes | null {
  const n = Math.floor(rows.length / DETAIL_STRIDE);
  if (!n) return null;
  const byKind = new Map<number, number[]>();
  for (let r = 0; r < n; r++) { const k = rows[r * DETAIL_STRIDE + 4]; const arr = byKind.get(k); if (arr) arr.push(r); else byKind.set(k, [r]); }
  const { stackMat, dormerMat } = materials();
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  const meshes: THREE.InstancedMesh[] = [];
  for (const [kind, idx] of byKind) {
    let g = geoms.get(kind);
    if (!g) { g = kind === RoofDetailKind.Dormer ? dormerGeometry() : chimneyGeometry(kind === RoofDetailKind.Chimney2 ? 2 : kind === RoofDetailKind.Chimney3 ? 3 : 4); geoms.set(kind, g); }
    const geom = kind === RoofDetailKind.Dormer ? g.clone() : g; // dormers carry a per-chunk aLit attribute
    const mesh = new THREE.InstancedMesh(geom, kind === RoofDetailKind.Dormer ? dormerMat : stackMat, idx.length);
    const lit = kind === RoofDetailKind.Dormer ? new Float32Array(idx.length) : null;
    idx.forEach((r, k) => {
      const b = r * DETAIL_STRIDE;
      P.set(rows[b] - chunkOrigin.x, rows[b + 1], rows[b + 2] - chunkOrigin.z);
      Q.setFromAxisAngle(up, rows[b + 3]);
      const sx = rows[b + 5], sy = rows[b + 6], sz = rows[b + 7];
      if (kind === RoofDetailKind.Dormer) S.set(sz / 1.05, sy / 1.75, sx / 1.35); else S.set(sx / 1.15, sy / 2.0, sz / 0.6);
      mesh.setMatrixAt(k, M.compose(P, Q, S));
      const seed = rows[b + 8];
      if (kind !== RoofDetailKind.Dormer) mesh.setColorAt(k, color.setHex(CHIMNEY_COLORS[Math.floor(hash32(seed, 31) * CHIMNEY_COLORS.length)]));
      if (lit) lit[k] = hash32(seed, 32);   // stable per-dormer draw, compared with the hour's lit fraction in the shader
    });
    if (lit) geom.setAttribute('aLit', new THREE.InstancedBufferAttribute(lit, 1));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = `roofdetail_${kind}`;
    meshes.push(mesh);
  }
  return { meshes, count: n };
}

export function disposeRoofDetails(d: RoofDetailMeshes) { for (const m of d.meshes) { if (m.geometry.attributes.aLit) m.geometry.dispose(); m.dispose(); } }
