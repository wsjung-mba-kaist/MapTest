import fs from 'node:fs/promises';
import path from 'node:path';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { BBOX_FAR_TALL, FAR_TALL_HALF_M, FAR_TALL_MIN_H, OUT_DIR } from '../config.ts';
import { exists, fmtBytes } from './http.ts';
import { fetchLayer } from './bdtopo.ts';
import { frame, worldBoxToLonLatBox, DATUM_ALT } from '../../shared/geo.ts';
import { WORLD_HALF } from '../../shared/layout.ts';
import { area, centroid, cleanRing, orient, type Ring } from './polygons.ts';
import { encodeBinMesh, type SectionInput } from './binmesh.ts';

/**
 * Far skyline ring: flat-roofed BD TOPO buildings between the baked square and FAR_HALF as one cheap mesh, plus only
 * the tall ones (>= FAR_TALL_MIN_H) out to FAR_TALL_HALF_M so the horizon from the tower keeps La Défense, Montparnasse,
 * Sacré-Cœur and the Invalides/Notre-Dame silhouettes instead of stopping at 3.4 km.
 */
const FAR_HALF = 3400;
const MIN_AREA = 140;
const MAX_VERTS = 8;

function simplify(r: Ring, maxVerts: number, minEdge = 2.0): Ring {
  let out = cleanRing(r, minEdge);
  while (out.length > maxVerts) {
    // Drop the vertex whose removal changes the area least.
    let best = -1, bestCost = Infinity;
    for (let i = 0; i < out.length; i++) {
      const p = out[(i + out.length - 1) % out.length], c = out[i], q = out[(i + 1) % out.length];
      const cost = Math.abs((c[0] - p[0]) * (q[1] - p[1]) - (c[1] - p[1]) * (q[0] - p[0]));
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    out.splice(best, 1);
  }
  return out;
}

export async function run(ctx: BakeContext) {
  const out = path.join(OUT_DIR, 'far.bin');
  if (!ctx.force && await exists(out)) { log.info('far: cached'); return; }
  const bbox = worldBoxToLonLatBox(frame, 0, 0, FAR_HALF);
  const fc = await fetchLayer('BDTOPO_V3:batiment', bbox, 'batiment_far', false);
  log.info(`far: ${fc.features.length} BD TOPO buildings within ±${FAR_HALF} m`);
  let tall: typeof fc.features = [];
  try {
    const tf = await fetchLayer('BDTOPO_V3:batiment', BBOX_FAR_TALL, 'batiment_tall', false, `hauteur>=${FAR_TALL_MIN_H}`);
    tall = tf.features;
    log.info(`far: ${tall.length} tall buildings (>= ${FAR_TALL_MIN_H} m) within ±${FAR_TALL_HALF_M} m`);
  } catch (e) { log.warn(`far: tall-building fetch failed, outer ring skipped: ${(e as Error).message.slice(0, 100)}`); }
  const inner = WORLD_HALF + 120;
  // Compact vertex format: position (f32x3) + colour (u8x4) only.
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const vtx = (x: number, y: number, z: number, c: [number, number, number, number]) => { pos.push(x, y, z); col.push(c[0], c[1], c[2], c[3]); return pos.length / 3 - 1; };
  let kept = 0;
  const outerFeatures = tall.map(f => ({ f, outer: true }));
  for (const { f, outer } of [...fc.features.map(f => ({ f, outer: false })), ...outerFeatures]) {
    const p = f.properties;
    const h = p.hauteur ?? 0;
    if (h < 3) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const coords of polys) {
      const ring = orient(cleanRing(coords[0].map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z] as [number, number]; })), false);
      if (ring.length < 3) continue;
      const c = centroid(ring);
      if (Math.abs(c[0]) < inner && Math.abs(c[1]) < inner) continue;
      const lim = outer ? FAR_TALL_HALF_M : FAR_HALF;
      if (outer && Math.abs(c[0]) <= FAR_HALF && Math.abs(c[1]) <= FAR_HALF) continue;   // already in the inner ring
      if (Math.abs(c[0]) > lim || Math.abs(c[1]) > lim) continue;
      const a = area(ring);
      if (a < MIN_AREA) continue;
      const r = simplify(ring, MAX_VERTS);
      if (r.length < 3) continue;
      const groundY = (p.altitude_minimale_sol ?? 33) - DATUM_ALT;
      const top = groundY + h + (h > 9 ? 3.5 : 0.5);
      const seed = (kept * 37) % 21;
      const tint: [number, number, number, number] = [218 + seed - 10, 208 + seed - 10, 184 + Math.round((seed - 10) * 0.5), 0];
      const roof: [number, number, number, number] = [126, 130, 136, 2];
      const n = r.length;
      for (let i = 0; i < n; i++) {
        const A = r[i], B = r[(i + 1) % n];
        const i0 = vtx(A[0], groundY - 2, A[1], tint), i1 = vtx(B[0], groundY - 2, B[1], tint);
        const i2 = vtx(B[0], top, B[1], tint), i3 = vtx(A[0], top, A[1], tint);
        idx.push(i0, i1, i2, i0, i2, i3);
      }
      const base = pos.length / 3;
      for (const q of r) vtx(q[0], top, q[1], roof);
      for (let i = 1; i + 1 < n; i++) idx.push(base, base + i + 1, base + i);
      kept++;
    }
  }
  const section: SectionInput = { name: 'far', vertexCount: pos.length / 3, indices: idx, attrs: [
    { spec: { name: 'position', size: 3, type: 'f32' }, data: new Float32Array(pos) },
    { spec: { name: 'color', size: 4, type: 'u8', normalized: true }, data: new Uint8Array(col) },
  ] };
  const buf = encodeBinMesh({ x: 0, z: 0 }, [section], { count: kept, farHalf: FAR_TALL_HALF_M });
  await fs.writeFile(out, buf);
  log.info(`far: ${kept} buildings, ${fmtBytes(buf.length)}, ${(idx.length / 3 / 1e6).toFixed(2)} M tris`);
}
