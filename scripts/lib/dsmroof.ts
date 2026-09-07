import fs from 'node:fs/promises';
import path from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';
import { CACHE_DIR } from '../config.ts';
import { exists, readJson } from './http.ts';
import { DSM_INDEX, type DsmIndex, type DsmWindow } from './dsm.ts';
import { log } from './log.ts';
import type { GeomBuilder } from './binmesh.ts';
import type { BuildingSpec } from './buildings.ts';
import { clipToBox, distToRing, pointInPoly, signedArea, type Poly, type Pt, type Ring } from './polygons.ts';
import { triangulateCap } from './extrude.ts';
import { altToY, frame } from '../../shared/geo.ts';
import { SurfaceFlag } from '../../shared/layout.ts';
import { sampleBil, type BilGrid } from './wmsgrid.ts';

/**
 * Roof caps from the LiDAR HD surface model: the footprint is gridded (0.5-2 m), every grid vertex takes the
 * (median-filtered, clamped) DSM height, boundary cells are clipped to the footprint, the boundary vertices follow
 * the wall-top curve so wall and cap seal, and the mesh is simplified (border locked) so flat roofs collapse while
 * domes, cupolas and mansard breaks survive. uv = world (x, z) for the ortho projection, flag = RoofDsm.
 */

interface Window { win: DsmWindow; grids: BilGrid[] }

export class DsmProvider {
  private constructor(private readonly windows: Map<string, Window>) {}

  static async load(): Promise<DsmProvider | null> {
    if (process.env.DSM === '0' || !await exists(DSM_INDEX)) return null;
    const index = await readJson<DsmIndex>(DSM_INDEX);
    const windows = new Map<string, Window>();
    for (const win of index.windows) {
      const grids: BilGrid[] = [];
      let ok = true;
      for (const t of win.tiles) {
        try {
          const buf = await fs.readFile(path.join(CACHE_DIR, t.file));
          grids.push({ box: t.box, w: t.w, h: t.h, data: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) });
        } catch { ok = false; break; }
      }
      if (ok && win.nodata <= 0.25) windows.set(win.group, { win, grids });
      else log.warn(`dsm: window ${win.group} skipped (${ok ? `nodata ${(win.nodata * 100).toFixed(0)} %` : 'tile missing'})`);
    }
    log.info(`dsm: ${windows.size} windows loaded (layer ${index.layer})`);
    return new DsmProvider(windows);
  }

  has(group: string | undefined): boolean { return !!group && this.windows.has(group); }

  /** World y of the surface at (x, z) inside the group's window; NaN outside / nodata. */
  sampleY(group: string, x: number, z: number): number {
    const w = this.windows.get(group);
    if (!w) return NaN;
    const { lon, lat } = frame.fromWorld(x, z);
    for (const g of w.grids) { const a = sampleBil(g, lon, lat); if (Number.isFinite(a)) return altToY(a); }
    return NaN;
  }
}

export interface DsmCapResult { trisBefore: number; trisAfter: number; wallTop: (p: Pt) => number }

const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((p, q) => p - q); return s.length ? s[(s.length - 1) >> 1] : NaN; };

/** Inward unit normal at ring vertex i (outer rings are negatively oriented: the outward normal of a->b is (-dz, dx)). */
function inwardAt(ring: Ring, i: number, sign: number): Pt {
  const n = ring.length;
  const p = ring[(i + n - 1) % n], c = ring[i], q = ring[(i + 1) % n];
  const e1 = [c[0] - p[0], c[1] - p[1]], e2 = [q[0] - c[0], q[1] - c[1]];
  const l1 = Math.hypot(e1[0], e1[1]) || 1, l2 = Math.hypot(e2[0], e2[1]) || 1;
  let nx = (e1[1] / l1 + e2[1] / l2) * sign, nz = (-e1[0] / l1 - e2[0] / l2) * sign;
  const l = Math.hypot(nx, nz) || 1;
  nx /= l; nz /= l;
  return [nx, nz];
}

/**
 * Emit the DSM cap of `b` into `gb` (chunk-local coordinates). Returns null when the window does not cover the
 * footprint, so the caller falls back to the analytic roof.
 */
export function addDsmCap(gb: GeomBuilder, b: BuildingSpec, dsm: DsmProvider, ox: number, oz: number, meta: [number, number, number, number], tint: [number, number, number]): DsmCapResult | null {
  const group = b.group ?? b.id;
  const rings = b.rings;
  const outer = rings[0];
  const xs = outer.map(p => p[0]), zs = outer.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const g = b.area <= 2000 ? 0.5 : b.area <= 30000 ? 1 : 2;
  const gx0 = Math.floor(x0 / g) - 1, gz0 = Math.floor(z0 / g) - 1;
  const nx = Math.ceil((x1 - x0) / g) + 3, nz = Math.ceil((z1 - z0) / g) + 3;
  if (nx * nz > 4_000_000) return null;

  // ---- raw samples, median 3x3, plausibility clamp
  const base = b.groundY + (b.minH > 0 ? b.minH : 0);
  const lo = base + 1, hi = b.groundY + Math.max(b.ridge, b.eave) * 1.8 + 15;
  const raw = new Float64Array(nx * nz);
  let valid = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const y = dsm.sampleY(group, (gx0 + i) * g, (gz0 + j) * g);
    raw[j * nx + i] = y; if (Number.isFinite(y)) valid++;
  }
  if (valid < nx * nz * 0.5) return null;
  const smooth = new Float64Array(nx * nz);
  const win: number[] = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    win.length = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const v = raw[jj * nx + ii]; if (Number.isFinite(v)) win.push(v);
    }
    const m = median(win);
    smooth[j * nx + i] = Number.isFinite(m) ? Math.max(lo, Math.min(hi, m)) : NaN;
  }
  // unmapped courtyards read as pits: lift them to the local roof level (the outline's holes are already excluded)
  const roofFloor = b.groundY + Math.max(b.minH, b.eave * 0.6);
  const heights: number[] = [];
  for (let k = 0; k < smooth.length; k++) if (Number.isFinite(smooth[k]) && smooth[k] >= roofFloor) heights.push(smooth[k]);
  const roofMedian = median(heights);
  let pits = 0;
  if (Number.isFinite(roofMedian)) for (let k = 0; k < smooth.length; k++) if (Number.isFinite(smooth[k]) && smooth[k] < roofFloor) { smooth[k] = roofMedian; pits++; }
  const at = (i: number, j: number) => { const v = smooth[j * nx + i]; return Number.isFinite(v) ? v : (Number.isFinite(roofMedian) ? roofMedian : b.groundY + b.eave); };
  const sampleSmooth = (x: number, z: number) => {   // bilinear in the smoothed grid
    const u = x / g - gx0, v = z / g - gz0;
    const i = Math.max(0, Math.min(nx - 2, Math.floor(u))), j = Math.max(0, Math.min(nz - 2, Math.floor(v)));
    const fx = Math.max(0, Math.min(1, u - i)), fy = Math.max(0, Math.min(1, v - j));
    return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
  };

  // ---- wall tops: DSM just inside each ring vertex, running median along the ring, clamped around the analytic eave
  const topLo = b.groundY + Math.max(b.minH + 2, b.eave - 3), topHi = b.groundY + b.ridge + 3;
  const wallTops = new Map<string, number>();
  const key = (p: Pt) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const ringTops: { ring: Ring; tops: number[] }[] = [];
  for (const ring of rings) {
    const sign = signedArea(ring) < 0 ? 1 : -1;
    const probes = ring.map((p, i) => {
      const [nx_, nz_] = inwardAt(ring, i, sign);
      return median([sampleSmooth(p[0] + nx_ * 1.0, p[1] + nz_ * 1.0), sampleSmooth(p[0] + nx_ * 1.5, p[1] + nz_ * 1.5), sampleSmooth(p[0] + nx_ * 2.0, p[1] + nz_ * 2.0)]);
    });
    const n = ring.length;
    const tops = probes.map((_, i) => Math.max(topLo, Math.min(topHi, median([-2, -1, 0, 1, 2].map(k => probes[(i + k + n) % n])))));
    ringTops.push({ ring, tops });
    ring.forEach((p, i) => wallTops.set(key(p), tops[i]));
  }
  /** wall-top height at any point of a ring edge (linear between the vertex tops) */
  const wallTop = (p: Pt): number => {
    const exact = wallTops.get(key(p));
    if (exact != null) return exact;
    let best = Infinity, y = b.groundY + b.eave;
    for (const { ring, tops } of ringTops) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], c = ring[(i + 1) % n];
        const dx = c[0] - a[0], dz = c[1] - a[1], l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
        const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
        if (d < best) { best = d; y = tops[i] * (1 - t) + tops[(i + 1) % n] * t; }
      }
    }
    return y;
  };

  // ---- cells: interior cells share grid vertices; boundary cells are clipped to the footprint
  const positions: number[] = [];
  const indices: number[] = [];
  const gridIdx = new Map<number, number>();
  const vtx = (i: number, j: number) => {
    const k = j * nx + i;
    let id = gridIdx.get(k);
    if (id == null) { id = positions.length / 3; positions.push((gx0 + i) * g, at(i, j), (gz0 + j) * g); gridIdx.set(k, id); }
    return id;
  };
  const inside = (i: number, j: number) => pointInPoly((gx0 + i) * g, (gz0 + j) * g, rings);
  const insideCache = new Int8Array(nx * nz).fill(-1);
  const ins = (i: number, j: number) => { const k = j * nx + i; if (insideCache[k] < 0) insideCache[k] = inside(i, j) ? 1 : 0; return insideCache[k] === 1; };
  const boundaryEps = 1e-3;
  for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) {
    const c00 = ins(i, j), c10 = ins(i + 1, j), c01 = ins(i, j + 1), c11 = ins(i + 1, j + 1);
    const count = +c00 + +c10 + +c01 + +c11;
    const cx0 = (gx0 + i) * g, cz0 = (gz0 + j) * g, cx1 = cx0 + g, cz1 = cz0 + g;
    // a cell whose corners are all inside may still be crossed by a thin wall: cheap test on the outer ring only
    const crossed = count === 4 && distToRing((cx0 + cx1) / 2, (cz0 + cz1) / 2, outer) < g * 0.71;
    if (count === 4 && !crossed) {
      const a = vtx(i, j), bb = vtx(i + 1, j), c = vtx(i + 1, j + 1), d = vtx(i, j + 1);
      // split along the diagonal that follows the surface better (smaller height difference)
      if (Math.abs(at(i, j) - at(i + 1, j + 1)) <= Math.abs(at(i + 1, j) - at(i, j + 1))) { indices.push(a, c, bb, a, d, c); } else { indices.push(a, d, bb, bb, d, c); }
      continue;
    }
    if (count === 0 && distToRing((cx0 + cx1) / 2, (cz0 + cz1) / 2, outer) > g) continue;
    const pieces = clipToBox([rings], cx0, cz0, cx1, cz1);
    for (const piece of pieces) {
      if (!piece.length || piece[0].length < 3) continue;
      const poly: Poly = piece;
      const { flat, tris } = triangulateCap(poly);
      const first = positions.length / 3;
      for (let k = 0; k < flat.length; k += 2) {
        const p: Pt = [flat[k], flat[k + 1]];
        const onEdge = rings.some(r => distToRing(p[0], p[1], r) < boundaryEps);
        positions.push(p[0], onEdge ? wallTop(p) : sampleSmooth(p[0], p[1]), p[1]);
      }
      for (let t = 0; t < tris.length; t += 3) indices.push(first + tris[t], first + tris[t + 1], first + tris[t + 2]);
    }
  }
  const trisBefore = indices.length / 3;
  if (trisBefore < 2) return null;

  // ---- simplify (border locked): flat roofs collapse, shape survives
  let idx: Uint32Array<ArrayBufferLike> = new Uint32Array(indices);
  const pos = new Float32Array(positions);
  try {
    const target = Math.max(2000 * 3, Math.floor(trisBefore * 0.15) * 3);
    if (idx.length > target) {
      const [res] = MeshoptSimplifier.simplify(idx, pos, 3, target, 0.15 / Math.max(1, b.ridge), ['LockBorder']);
      if (res.length >= 3) idx = res;
    }
  } catch (e) { log.warn(`dsm: simplify failed for ${b.id}: ${e instanceof Error ? e.message : e}`); }

  // ---- emit: keep the non-degenerate triangles, then compact the vertices they use
  const keep: number[] = [];
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k], bb = idx[k + 1], c = idx[k + 2];
    if (a === bb || bb === c || a === c) continue;
    // zero-area slivers (clipping precision, simplifier collapses) would give zero vertex normals -> NaN in the shader
    const ia = a * 3, ib = bb * 3, ic = c * 3;
    const ux = pos[ib] - pos[ia], uy = pos[ib + 1] - pos[ia + 1], uz = pos[ib + 2] - pos[ia + 2];
    const vx = pos[ic] - pos[ia], vy = pos[ic + 1] - pos[ia + 1], vz = pos[ic + 2] - pos[ia + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-8) continue;
    keep.push(a, bb, c);
  }
  const remap = new Map<number, number>();
  const col: [number, number, number, number] = [tint[0], tint[1], tint[2], SurfaceFlag.RoofDsm];
  for (const v of keep) if (!remap.has(v)) { const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]; remap.set(v, gb.vertex(x - ox, y, z - oz, x, z, meta, col)); }
  for (let k = 0; k < keep.length; k += 3) gb.tri(remap.get(keep[k])!, remap.get(keep[k + 1])!, remap.get(keep[k + 2])!);
  if (pits) log.info(`dsm: ${b.id}${b.name ? ` (${b.name})` : ''}: ${pits} pit cells lifted`);
  return { trisBefore, trisAfter: idx.length / 3, wallTop };
}
