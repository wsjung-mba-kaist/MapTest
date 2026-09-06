import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import type { BakeContext } from '../bake.ts';
import { MODELS_DIR } from '../config.ts';
import { log } from './log.ts';

/**
 * Tower access metadata from the baked eiffel.glb: the three visitor floors (height and square extents, found as
 * peaks of up-facing triangle area in the expected height bands) and the four pillar footprints. The runtime turns
 * these into walkable decks, guard rails and lift hotspots (src/world/TowerAccess.ts), so a different tower model
 * only needs `npm run bake:towerwalk` again.
 */

export interface TowerFloor { y: number; rOut: number; rIn: number }
export interface TowerWalk { floors: TowerFloor[]; pillars: [number, number][]; centre: [number, number]; top: number }

const BANDS: [number, number][] = [[40, 72], [98, 132], [255, 305]];
const BIN = 0.5;

/** Analyse a triangle soup (world metres, y up). */
export function analyseTower(pos: Float32Array, idx: ArrayLike<number> | null): TowerWalk {
  const n = idx ? idx.length / 3 : pos.length / 9;
  const hist = new Map<number, number>();
  const ups: { x: number; y: number; z: number; a: number }[] = [];
  const legs: { x: number; z: number; a: number }[] = [];
  let top = 0;
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (let t = 0; t < n; t++) {
    const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
    const bx = pos[i1 * 3], by = pos[i1 * 3 + 1], bz = pos[i1 * 3 + 2];
    const cx = pos[i2 * 3], cy = pos[i2 * 3 + 1], cz = pos[i2 * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    const area = len / 2;
    const y = (ay + by + cy) / 3, x = (ax + bx + cx) / 3, z = (az + bz + cz) / 3;
    top = Math.max(top, ay, by, cy);
    if (y < 40) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    if (ny / len > 0.85) {
      const bin = Math.floor(y / BIN);
      hist.set(bin, (hist.get(bin) ?? 0) + area);
      if (BANDS.some(([lo, hi]) => y >= lo && y <= hi)) ups.push({ x, y, z, a: area });
    }
    if (y > 1.5 && y < 8) legs.push({ x, z, a: area });
  }
  const centre: [number, number] = [(bx0 + bx1) / 2, (bz0 + bz1) / 2];
  const floors: TowerFloor[] = [];
  for (const [lo, hi] of BANDS) {
    let best = -1, bestA = 0;
    for (let b = Math.floor(lo / BIN); b <= Math.floor(hi / BIN); b++) { const a = hist.get(b) ?? 0; if (a > bestA) { bestA = a; best = b; } }
    if (best < 0 || bestA < 4) { log.warn(`towerwalk: no deck found in ${lo}-${hi} m`); continue; }
    const y = (best + 1) * BIN;   // top of the bin
    const rs = ups.filter(u => Math.abs(u.y - y) <= 1.5).map(u => Math.max(Math.abs(u.x - centre[0]), Math.abs(u.z - centre[1]))).sort((a, b) => a - b);
    if (rs.length < 8) { log.warn(`towerwalk: deck at ${y} m has too few faces`); continue; }
    const p = (q: number) => rs[Math.min(rs.length - 1, Math.floor(q * rs.length))];
    const rOut = p(0.97), rIn = p(0.03);
    floors.push({ y: +y.toFixed(2), rOut: +rOut.toFixed(1), rIn: rIn > 4 ? +rIn.toFixed(1) : 0 });
  }
  // pillars: area-weighted centroid of the low structure per quadrant
  const quad: { x: number; z: number; a: number }[] = [{ x: 0, z: 0, a: 0 }, { x: 0, z: 0, a: 0 }, { x: 0, z: 0, a: 0 }, { x: 0, z: 0, a: 0 }];
  for (const l of legs) {
    const q = (l.x >= centre[0] ? 1 : 0) + (l.z >= centre[1] ? 2 : 0);
    quad[q].x += l.x * l.a; quad[q].z += l.z * l.a; quad[q].a += l.a;
  }
  const pillars = quad.filter(q => q.a > 0).map(q => [+(q.x / q.a).toFixed(1), +(q.z / q.a).toFixed(1)] as [number, number]);
  return { floors, pillars, centre: [+centre[0].toFixed(1), +centre[1].toFixed(1)], top: +top.toFixed(1) };
}

export async function run(_ctx: BakeContext) {
  const file = path.join(MODELS_DIR, 'eiffel.glb');
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(file);
  const chunks: Float32Array[] = [];
  const idxChunks: (Uint32Array | null)[] = [];
  let total = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const M = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION'); if (!acc) continue;
      // positions are quantised (normalised int16 + the dequantisation in the node matrix): read through getElement
      const count = acc.getCount();
      const out = new Float32Array(count * 3);
      const el = [0, 0, 0];
      for (let v = 0; v < count; v++) {
        acc.getElement(v, el);
        const x = el[0], y = el[1], z = el[2];
        out[v * 3] = M[0] * x + M[4] * y + M[8] * z + M[12];
        out[v * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
        out[v * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
      }
      const ind = prim.getIndices()?.getArray();
      chunks.push(out); idxChunks.push(ind ? Uint32Array.from(ind as ArrayLike<number>) : null);
      total += ind ? ind.length / 3 : out.length / 9;
    }
  }
  // merge into one soup (indices offset per primitive)
  const verts = chunks.reduce((s, c) => s + c.length, 0);
  const pos = new Float32Array(verts);
  const idx: number[] = [];
  let off = 0;
  chunks.forEach((c, k) => {
    pos.set(c, off * 3);
    const ind = idxChunks[k];
    if (ind) for (let i = 0; i < ind.length; i++) idx.push(ind[i] + off); else for (let i = 0; i < c.length / 3; i++) idx.push(off + i);
    off += c.length / 3;
  });
  const res = analyseTower(pos, idx);
  log.info(`towerwalk: ${total} triangles; floors ${JSON.stringify(res.floors)}; pillars ${JSON.stringify(res.pillars)}; centre ${res.centre}; top ${res.top}`);
  await fs.writeFile(path.join(MODELS_DIR, 'eiffel_walk.json'), JSON.stringify(res));
}
