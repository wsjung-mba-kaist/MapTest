import * as THREE from 'three';
import { buildingUniforms } from '../materials/FacadeMaterial';
import type { Season } from '../../shared/season';
import { withLamps } from '../render/LocalLights';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CHUNK_SIZE, GRID_N, KERB_H, SurfaceClass, TREE_STRIDE, chunkIndexOf, chunkKey, chunkOrigin } from '../../shared/layout';
import { DATA_URL, fetchBuffer, loadTexture } from './DataLoader';
import type { SurfaceGrid } from '../../shared/surfacegrid';

/**
 * Trees from the Paris inventory as instanced leaf-card trees: a tapered trunk, a few branches and a cloud
 * of alpha-tested leaf-cluster cards on a species-shaped canopy. Two LODs per species, grouped per chunk.
 */
export class Trees {
  readonly group = new THREE.Group();
  count = 0;
  lodDistance = 240;
  private cells = new Map<string, { lod0: THREE.Group; lod1: THREE.Group; cx: number; cz: number }>();
  private readonly uniforms = { uTime: { value: 0 }, uWind: { value: 0.7 }, uNight: buildingUniforms.uNight, uCoverage: { value: 1 }, uAutumn: { value: 0 }, uFresh: { value: 0 } };
  /** Foliage by date (shared/season.ts): coverage drops cards, autumn/fresh retint the rest. */
  setSeason(s: Season) { this.uniforms.uCoverage.value = s.coverage; this.uniforms.uAutumn.value = s.autumn; this.uniforms.uFresh.value = s.fresh; }
  setWind(v: number) { this.uniforms.uWind.value = v; }
  private leafMats: THREE.MeshStandardMaterial[] = [];
  private trunkMat!: THREE.MeshStandardMaterial;

  constructor() { this.group.name = 'trees'; }

  private surface: SurfaceGrid | null = null;
  private readonly pitGeom = new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2);
  private pitMat: THREE.MeshStandardMaterial | null = null;
  pitCount = 0;
  classHist = new Map<number, number>();
  get stats() { return `trees ${this.count} pits ${this.pitCount} cls ${[...this.classHist.entries()].map(([k, v]) => `${k}:${v}`).join(',')}`; }

  private groundY: ((x: number, z: number) => number) | null = null;
  async load(surface: SurfaceGrid | null = null, groundY: ((x: number, z: number) => number) | null = null) {
    this.surface = surface; this.groundY = groundY;
    const [buf, bark] = await Promise.all([
      fetchBuffer(`${DATA_URL}/trees.bin`),
      loadTexture('/textures/pbr/Bark014_color.jpg').catch(() => null),
    ]);
    const data = new Float32Array(buf);
    this.count = data.length / TREE_STRIDE;
    this.trunkMat = withLamps(new THREE.MeshStandardMaterial({ color: bark ? 0xb9b0a6 : 0x5a4a3c, map: bark ?? undefined, roughness: 0.95 }));
    if (bark) { bark.wrapS = bark.wrapT = THREE.RepeatWrapping; bark.repeat.set(1, 2); }
    const leafTextures = [leafTexture(0), leafTexture(1), leafTexture(2)];
    this.leafMats = leafTextures.map(t => this.makeLeafMaterial(t));

    // Reference geometries per species x LOD (unit height = 1).
    const refs: { canopy: THREE.BufferGeometry; trunk: THREE.BufferGeometry }[][] = [];
    for (let sp = 0; sp < 7; sp++) refs.push([treeGeometry(sp, 0), treeGeometry(sp, 1)]);

    // Bucket by chunk and species.
    const buckets = new Map<string, number[]>();
    for (let k = 0; k < this.count; k++) {
      const x = data[k * TREE_STRIDE], z = data[k * TREE_STRIDE + 2], sp = data[k * TREE_STRIDE + 5];
      const { i, j } = chunkIndexOf(x, z);
      const key = `${chunkKey(Math.max(0, Math.min(GRID_N - 1, i)), Math.max(0, Math.min(GRID_N - 1, j)))}|${sp}`;
      const arr = buckets.get(key); if (arr) arr.push(k); else buckets.set(key, [k]);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    for (const [key, idx] of buckets) {
      const [ck, spS] = key.split('|');
      const sp = Number(spS);
      const [i, j] = ck.split('_').map(Number);
      let cell = this.cells.get(ck);
      if (!cell) {
        const o = chunkOrigin(i, j);
        cell = { lod0: new THREE.Group(), lod1: new THREE.Group(), cx: o.x + CHUNK_SIZE / 2, cz: o.z + CHUNK_SIZE / 2 };
        cell.lod1.visible = false;
        this.group.add(cell.lod0, cell.lod1);
        this.cells.set(ck, cell);
      }
      const spec = SPECIES[sp] ?? SPECIES[6];
      // cast-iron grate around every trunk that stands on a sidewalk slab (park trees stand in earth)
      {
        const pits: number[] = [];
        for (const k of idx) {
          const b = k * TREE_STRIDE, cls = this.surface?.classAt(data[b], data[b + 2]) ?? SurfaceClass.None;
          this.classHist.set(cls, (this.classHist.get(cls) ?? 0) + 1);
          // street trees (anything but lawn, gravel alley or water) get a grate, laid on the rendered ground + kerb
          if (cls !== SurfaceClass.None && cls !== SurfaceClass.Grass && cls !== SurfaceClass.Gravel && cls !== SurfaceClass.Water) {
            const x = data[b], z = data[b + 2];
            // kerb-line trees sit on the 2 m grid's road/paved cell next to the slab: look 1.2 m around for the sidewalk
            const sw = this.surface && (cls === SurfaceClass.Sidewalk || [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]].some(([dx, dz]) => this.surface!.classAt(x + dx, z + dz) === SurfaceClass.Sidewalk));
            if (cls === SurfaceClass.Road && !sw) continue;   // a tree in the carriageway grid with no slab around: median, no grate
            const gy = this.groundY ? this.groundY(x, z) : data[b + 1];
            pits.push(x, gy + (sw ? KERB_H : 0) + 0.03, z, data[b + 6]);
          }
        }
        if (pits.length) {
          this.pitMat ??= withLamps(new THREE.MeshStandardMaterial({ map: grateTexture(), alphaTest: 0.5, color: 0x9a9a9c, roughness: 0.75, metalness: 0.35, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
          const mesh = new THREE.InstancedMesh(this.pitGeom, this.pitMat, pits.length / 4);
          for (let n = 0; n < pits.length / 4; n++) { p.set(pits[n * 4], pits[n * 4 + 1], pits[n * 4 + 2]); q.setFromAxisAngle(UP, frac(pits[n * 4 + 3] * 0.13) * Math.PI); s.set(1, 1, 1); m.compose(p, q, s); mesh.setMatrixAt(n, m); }
          mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.name = 'tree_pits';
          this.pitCount += pits.length / 4;
          cell.lod0.add(mesh);
        }
      }
      for (let lod = 0; lod < 2; lod++) {
        const ref = refs[sp][lod];
        const canopy = new THREE.InstancedMesh(ref.canopy, this.leafMats[spec.tex], idx.length);
        const trunk = new THREE.InstancedMesh(ref.trunk, this.trunkMat, idx.length);
        idx.forEach((k, n) => {
          const b = k * TREE_STRIDE;
          const x = data[b], y = data[b + 1] + (this.surface?.lift(data[b], data[b + 2]) ?? 0), z = data[b + 2], h = data[b + 3], seed = data[b + 6];
          p.set(x, y - 0.2, z);
          q.setFromAxisAngle(UP, seed * 0.0245 * 7);
          const sc = Math.max(3, h);
          s.set(sc * (0.92 + 0.16 * frac(seed * 0.37)), sc, sc * (0.92 + 0.16 * frac(seed * 0.71)));
          m.compose(p, q, s);
          canopy.setMatrixAt(n, m); trunk.setMatrixAt(n, m);
          const v = 0.85 + 0.3 * frac(seed * 0.618);
          col.setRGB(spec.tint[0] * v, spec.tint[1] * v, spec.tint[2] * v);
          canopy.setColorAt(n, col);
        });
        canopy.instanceMatrix.needsUpdate = true; trunk.instanceMatrix.needsUpdate = true;
        if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
        canopy.castShadow = true; canopy.receiveShadow = true; trunk.castShadow = true;   // LOD1 too: no shadow pop line at 240 m
        canopy.frustumCulled = false; trunk.frustumCulled = false;
        (lod === 0 ? cell.lod0 : cell.lod1).add(canopy, trunk);
      }
    }
  }

  private makeLeafMaterial(tex: THREE.Texture): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8, metalness: 0, vertexColors: false });
    mat.customProgramCacheKey = () => 'leaf-cards';
    mat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float sway;\nuniform float uTime; uniform float uWind; uniform float uCoverage; varying float vKey;')
        .replace('#include <begin_vertex>', /* glsl */`
          vec3 transformed = position;
          #ifdef USE_INSTANCING
            float phase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
          #else
            float phase = 0.0;
          #endif
          float g = sin(uTime * 1.2 + phase) * 0.5 + sin(uTime * 2.7 + phase * 1.7 + position.y * 3.0) * 0.5;
          transformed.xz += g * 0.025 * uWind * sway * position.y;
          // seasonal leaf drop: each card has a stable key; cards above the coverage collapse to nothing
          float dropKey = fract(sway * 53.17 + phase * 0.379);
          vKey = dropKey;
          if (dropKey > uCoverage) transformed = vec3(0.0);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight; uniform float uAutumn; uniform float uFresh; varying float vKey;')
        // leaves are thin and translucent by day; under the lamps at night the canopy should glow, not shine
        .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
          if (!gl_FrontFacing) diffuseColor.rgb *= 0.82;
          {
            // autumn: gold to rust built from the green channel, cards turning at different times; spring: pale fresh green
            float g = diffuseColor.g;
            vec3 aut = mix(vec3(1.9, 1.15, 0.30), vec3(1.5, 0.75, 0.30), fract(vKey * 7.31)) * g;
            float turn = clamp(uAutumn * 1.35 - fract(vKey * 3.7) * 0.35, 0.0, 1.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, aut, turn);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.05, 1.12, 0.72) + vec3(0.05, 0.08, 0.0), uFresh * 0.8);
          }
          diffuseColor.rgb *= 1.0 - 0.35 * uNight;`);
    };
    withLamps(mat);
    return mat;
  }

  update(x: number, z: number, time: number) {
    this.uniforms.uTime.value = time;
    const d2 = this.lodDistance ** 2;
    for (const c of this.cells.values()) {
      const near = (c.cx - x) ** 2 + (c.cz - z) ** 2 < d2 * 1.6;
      if (c.lod0.visible !== near) { c.lod0.visible = near; c.lod1.visible = !near; }
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const frac = (v: number) => v - Math.floor(v);
const rand = (seed: number) => { const s = Math.sin(seed * 12.9898) * 43758.5453; return s - Math.floor(s); };

/** Canopy shape per species: radius/height as a fraction of tree height, centre height, texture, tint. */
const SPECIES: { rx: number; ry: number; cy: number; tex: number; tint: [number, number, number]; cards: [number, number]; trunkR: number }[] = [
  { rx: 0.30, ry: 0.36, cy: 0.62, tex: 0, tint: [0.62, 0.75, 0.45], cards: [16, 6], trunkR: 0.035 }, // Platanus: broad, tall
  { rx: 0.27, ry: 0.38, cy: 0.58, tex: 1, tint: [0.55, 0.72, 0.38], cards: [16, 6], trunkR: 0.03 },  // Tilia: oval, dense
  { rx: 0.29, ry: 0.42, cy: 0.56, tex: 0, tint: [0.42, 0.60, 0.32], cards: [18, 6], trunkR: 0.034 }, // Aesculus: conical, dark
  { rx: 0.32, ry: 0.28, cy: 0.66, tex: 2, tint: [0.66, 0.78, 0.50], cards: [12, 5], trunkR: 0.028 }, // Sophora: airy, light
  { rx: 0.27, ry: 0.32, cy: 0.60, tex: 2, tint: [0.62, 0.70, 0.40], cards: [14, 6], trunkR: 0.03 },  // Acer
  { rx: 0.29, ry: 0.33, cy: 0.60, tex: 1, tint: [0.56, 0.70, 0.42], cards: [14, 6], trunkR: 0.03 },  // Celtis
  { rx: 0.28, ry: 0.33, cy: 0.60, tex: 1, tint: [0.58, 0.72, 0.42], cards: [14, 6], trunkR: 0.03 },  // Other
];

/** 1.5 m square cast-iron tree grate: rings of slots around a hole for the trunk (alpha-tested). */
function grateTexture(): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3a3a3c'; ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(S / 2, S / 2, 30, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 7; ctx.strokeStyle = '#000';
  for (let r = 46; r <= 118; r += 16) for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(S / 2, S / 2, r, k * Math.PI / 2 + 0.12, (k + 1) * Math.PI / 2 - 0.12); ctx.stroke(); }
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#4a4a4c';
  for (let k = 0; k < 4; k++) { ctx.save(); ctx.translate(S / 2, S / 2); ctx.rotate(k * Math.PI / 2 + Math.PI / 4); ctx.fillRect(-3, 30, 6, 96); ctx.restore(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** Unit-height tree: trunk + branches (returned separately) and a cloud of leaf cards (with `sway`). */
function treeGeometry(sp: number, lod: number): { canopy: THREE.BufferGeometry; trunk: THREE.BufferGeometry } {
  const S = SPECIES[sp] ?? SPECIES[6];
  const seedBase = sp * 17 + lod * 5;
  // Trunk up to the canopy centre, tapered; a few branches into the canopy.
  const trunkH = S.cy + S.ry * 0.25;
  const trunk = new THREE.CylinderGeometry(S.trunkR * 0.6, S.trunkR, trunkH, lod ? 5 : 8, 1, true).translate(0, trunkH / 2, 0);
  const parts: THREE.BufferGeometry[] = [trunk];
  if (!lod) for (let b = 0; b < 4; b++) {
    const a = (b / 4) * Math.PI * 2 + rand(seedBase + b) * 0.8;
    const len = S.ry * 0.9;
    const br = new THREE.CylinderGeometry(S.trunkR * 0.25, S.trunkR * 0.5, len, 5, 1, true).translate(0, len / 2, 0);
    br.rotateZ(0.55 + rand(seedBase + 9 + b) * 0.35).rotateY(a).translate(0, S.cy - S.ry * 0.35, 0);
    parts.push(br);
  }
  const trunkGeom = mergeGeometries(parts, false)!;
  const n = trunkGeom.attributes.position.count;
  trunkGeom.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(n).fill(0), 1));

  // Leaf cards on the canopy ellipsoid shell (a little inward jitter), random facing.
  const cards: THREE.BufferGeometry[] = [];
  const count = S.cards[lod];
  const size = lod ? S.ry * 1.9 : S.ry * 1.25;
  for (let i = 0; i < count; i++) {
    const u = rand(seedBase + i * 3.1) * Math.PI * 2, v = Math.acos(1 - 2 * rand(seedBase + i * 5.3));
    const r = 0.55 + 0.45 * rand(seedBase + i * 7.7);
    const cx = Math.sin(v) * Math.cos(u) * S.rx * r, cy = S.cy + Math.cos(v) * S.ry * r * 0.9, cz = Math.sin(v) * Math.sin(u) * S.rx * r;
    const card = new THREE.PlaneGeometry(size * (0.8 + 0.4 * rand(i + 1.3)), size * (0.8 + 0.4 * rand(i + 2.9)));
    // Face roughly outward from the canopy centre with random roll, so cards read from every direction.
    const look = new THREE.Vector3(cx, cy - S.cy, cz).normalize();
    const qOut = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), look.lengthSq() > 0.01 ? look : new THREE.Vector3(0, 0, 1));
    const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rand(i + 4.1) * Math.PI);
    card.applyQuaternion(qOut.multiply(roll)).translate(cx, cy, cz);
    // Randomise which quarter of the atlas each card uses (4 cluster variants).
    const uv = card.attributes.uv as THREE.BufferAttribute;
    const ox = Math.floor(rand(i + 6.7) * 2) * 0.5, oy = Math.floor(rand(i + 8.3) * 2) * 0.5;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, ox + uv.getX(k) * 0.5, oy + uv.getY(k) * 0.5);
    const cn = card.attributes.position.count;
    card.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(cn).fill(0.6 + 0.4 * rand(i + 9.9)), 1));
    cards.push(card);
  }
  const canopy = mergeGeometries(cards, false)!;
  return { canopy, trunk: trunkGeom };
}

/** 512² atlas of four leaf-cluster sprites (RGB colour + alpha coverage). kind: 0 broad, 1 small round, 2 fine. */
function leafTexture(kind: number): THREE.CanvasTexture {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, S, S);
  const leafW = kind === 0 ? 30 : kind === 1 ? 18 : 12, leafH = kind === 0 ? 20 : kind === 1 ? 15 : 7;
  const per = kind === 0 ? 70 : kind === 1 ? 130 : 220;
  let seed = kind * 101 + 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * (S / 2), oy = Math.floor(q / 2) * (S / 2), R = S / 4 - 14;
    for (let i = 0; i < per; i++) {
      // Gaussian-ish cluster: denser at the centre, ragged edge.
      const ang = rnd() * Math.PI * 2, rad = Math.sqrt(rnd()) * R;
      const x = ox + S / 4 + Math.cos(ang) * rad, y = oy + S / 4 + Math.sin(ang) * rad;
      const shade = 0.55 + rnd() * 0.6;
      const g = Math.round(120 * shade + 40), r = Math.round(70 * shade + 30), b = Math.round(40 * shade + 20);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.save(); ctx.translate(x, y); ctx.rotate(rnd() * Math.PI);
      ctx.beginPath(); ctx.ellipse(0, 0, leafW * (0.7 + rnd() * 0.6) / 2, leafH * (0.7 + rnd() * 0.6) / 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
