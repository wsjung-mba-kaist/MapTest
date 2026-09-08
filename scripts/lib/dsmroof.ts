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

/** One footprint edge and the height the wall on it reaches at either end. */
interface WallSeg { a: Pt; b: Pt; ya: number; yb: number }

/**
 * The footprint edges of a landmark group with the height each one reaches, binned on a 4 m grid, so the cap can
 * ask "is there already a wall here, and does it come up this far?" in O(1).
 */
export class WallIndex {
  private static readonly CELL = 4;
  private readonly bins = new Map<number, WallSeg[]>();
  private static key(i: number, j: number) { return i * 100003 + j; }

  /** `top` gives the height the wall reaches at a point of the ring; omit it for a wall of unknown height. */
  add(ring: Ring, top?: (p: Pt) => number) {
    const n = ring.length;
    for (let k = 0; k < n; k++) {
      const a = ring[k], b = ring[(k + 1) % n];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) continue;
      const seg: WallSeg = { a, b, ya: top ? top(a) : Infinity, yb: top ? top(b) : Infinity };
      const c = WallIndex.CELL;
      const i0 = Math.floor(Math.min(a[0], b[0]) / c), i1 = Math.floor(Math.max(a[0], b[0]) / c);
      const j0 = Math.floor(Math.min(a[1], b[1]) / c), j1 = Math.floor(Math.max(a[1], b[1]) / c);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const kk = WallIndex.key(i, j);
        const arr = this.bins.get(kk); if (arr) arr.push(seg); else this.bins.set(kk, [seg]);
      }
    }
  }

  /** True when a footprint edge within `d` of (x, z) carries a wall that reaches `y`. */
  reaches(x: number, z: number, d: number, y: number): boolean {
    const c = WallIndex.CELL;
    const i0 = Math.floor((x - d) / c), i1 = Math.floor((x + d) / c);
    const j0 = Math.floor((z - d) / c), j1 = Math.floor((z + d) / c);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const arr = this.bins.get(WallIndex.key(i, j)); if (!arr) continue;
      for (const { a, b, ya, yb } of arr) {
        const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
        if (Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)) > d) continue;
        if (ya * (1 - t) + yb * t >= y) return true;
      }
    }
    return false;
  }

  /** True when (x, z) is within `d` of a footprint edge, whatever height it reaches. */
  near(x: number, z: number, d: number): boolean { return this.reaches(x, z, d, -Infinity); }
}

export class DsmProvider {
  private constructor(private readonly windows: Map<string, Window>) {}

  /** Tallest ridge among a group's members, filled by `noteGroupHeights`. */
  private readonly ridges = new Map<string, number>();
  /** Footprint rings of a group's `building:part`s: the walls it models *inside* its outline. */
  private readonly parts = new Map<string, WallIndex>();
  /** Fitted wall tops of each `building:part`, so `extrude` and the cap agree on where a part reaches. */
  private readonly tops = new WeakMap<BuildingSpec, ((p: Pt) => number) | null>();
  /**
   * Record how tall each landmark group actually is, where its parts' walls run and how high each reaches. The
   * group's own outline is squashed to a plinth by its parts, so its ridge cannot bound the cap: the Invalides
   * outline reports 13.1 m for a 107 m dome.
   */
  noteGroupHeights(specs: BuildingSpec[]) {
    for (const s of specs) {
      const h = Math.max(s.ridge, s.eave), g = s.group ?? s.id;
      if (h > (this.ridges.get(g) ?? 0)) this.ridges.set(g, h);
    }
    // second pass: the fitted tops need the group ridges above, and the index needs the fitted tops
    for (const s of specs) {
      const g = s.group ?? s.id;
      if (!this.windows.has(g) || s.id === g) continue;   // the outline is not an interior wall
      const top = dsmPartTops(s, this);
      this.tops.set(s, top);
      if (!top) continue;                                 // no fitted wall: it cannot be relied on to close a cut
      let w = this.parts.get(g); if (!w) { w = new WallIndex(); this.parts.set(g, w); }
      for (const r of s.rings) w.add(r, top);
    }
  }
  groupRidge(group: string): number | undefined { return this.ridges.get(group); }
  groupParts(group: string): WallIndex | undefined { return this.parts.get(group); }
  /** The fitted wall top of a part, computed once in `noteGroupHeights`. */
  partTops(b: BuildingSpec): ((p: Pt) => number) | null { const t = this.tops.get(b); return t === undefined ? dsmPartTops(b, this) : t; }

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

  /** Smoothed surface height at (x, z): a 5-tap median, the cheap stand-in for the cap's own 3x3 grid filter. */
  smoothY(group: string, x: number, z: number): number {
    return median([this.sampleY(group, x, z), this.sampleY(group, x + 0.5, z), this.sampleY(group, x - 0.5, z), this.sampleY(group, x, z + 0.5), this.sampleY(group, x, z - 0.5)]);
  }

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
 * A ring with a vertex at least every `EDGE_STEP` metres. A wall top is read at the vertices and interpolated
 * between them, so a 42 m edge with a 25 m change at one end came out as a 42 m diagonal; sampling along it lets
 * the top follow the roof instead.
 */
const EDGE_STEP = 4;
export function densify(ring: Ring): Ring {
  const n = ring.length, out: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    out.push(a);
    const k = Math.min(48, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / EDGE_STEP));
    for (let j = 1; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
  }
  return out;
}

/**
 * Height at fraction `t` of an edge whose ends are `ya` and `yb`. A facade top that changes by more than a storey
 * between two samples is a corner of the building, not a slope: the Maison de la Radio's crown meets a service
 * court along one 17 m edge and the LiDAR drops from 37 m to 8 m in the last 5 m of it, so interpolating cut a
 * 25 m diagonal notch out of the facade. Hold the level and step down beside the low end.
 */
function alongEdge(ya: number, yb: number, t: number, len: number): number {
  const d = yb - ya;
  if (Math.abs(d) < 2 || len < 2) return ya + d * t;
  const w = Math.min(0.5, 1.5 / len);
  return ya + d * Math.min(1, d < 0 ? Math.max(0, (t - (1 - w)) / w) : t / w);
}

/**
 * Wall-top height along a set of rings, read off a surface: the surface just inside each vertex, running median
 * along the ring so one vertex that catches an aerial cannot spike it, clamped into [lo, hi] and to a little over
 * the ring's own 90th percentile — which is what stops a probe reaching the tower next door from dragging the
 * wall up with it. Linear between the vertices for any other point on a ring edge.
 */
export function ringTops(rings: readonly Ring[], sample: (x: number, z: number) => number, lo: number, hi: number, fallback: number): (p: Pt) => number {
  const tops = new Map<string, number>();
  const key = (p: Pt) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const perRing: { ring: Ring; ys: number[] }[] = [];
  for (const raw of rings) {
    const ring = densify(raw);
    const sign = signedArea(ring) < 0 ? 1 : -1;
    const probes = ring.map((p, i) => {
      const [nx, nz] = inwardAt(ring, i, sign);
      return median([sample(p[0] + nx * 1.0, p[1] + nz * 1.0), sample(p[0] + nx * 1.5, p[1] + nz * 1.5), sample(p[0] + nx * 2.0, p[1] + nz * 2.0)]);
    });
    const sorted = probes.filter(Number.isFinite).sort((a, b) => a - b);
    const ceil = sorted.length ? Math.min(hi, sorted[Math.floor((sorted.length - 1) * 0.9)] + 3) : hi;
    const n = ring.length;
    const ys = probes.map((_, i) => {
      const m = median([-2, -1, 0, 1, 2].map(k => probes[(i + k + n) % n]));
      return Number.isFinite(m) ? Math.max(lo, Math.min(Math.max(lo, ceil), m)) : fallback;
    });
    perRing.push({ ring, ys });
    ring.forEach((p, i) => tops.set(key(p), ys[i]));
  }
  return (p: Pt): number => {
    const exact = tops.get(key(p));
    if (exact != null) return exact;
    let best = Infinity, y = fallback;
    for (const { ring, ys } of perRing) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], c = ring[(i + 1) % n];
        const dx = c[0] - a[0], dz = c[1] - a[1], l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
        const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
        if (d < best) { best = d; y = alongEdge(ys[i], ys[(i + 1) % n], t, Math.sqrt(l2)); }
      }
    }
    return y;
  };
}

/**
 * Wall tops for a `building:part` of a capped group, read off the same surface the cap is built from, so the part
 * reaches the cap instead of stopping wherever OSM guessed. Those guesses are the whole problem at the Maison de
 * la Radio: the crown arcs stop 7 m under the measured roof, which opens a slot right round the 500 m facade,
 * while Studio 101 and Studio 106 stand 13 m above it — the chimneys on the roof of a building that has none.
 * Returns null when the window does not reach the part or reads below its base, so the caller keeps the analytic
 * roof.
 */
export function dsmPartTops(b: BuildingSpec, dsm: DsmProvider): ((p: Pt) => number) | null {
  const group = b.group ?? b.id;
  const sample = (x: number, z: number) => dsm.smoothY(group, x, z);
  const base = b.groundY + b.minH;
  const probes: number[] = [];
  for (const ring of b.rings) {
    const sign = signedArea(ring) < 0 ? 1 : -1;
    ring.forEach((p, i) => { const [nx, nz] = inwardAt(ring, i, sign); probes.push(sample(p[0] + nx * 1.5, p[1] + nz * 1.5)); });
  }
  const ok = probes.filter(Number.isFinite);
  if (ok.length < probes.length * 0.7) return null;
  const m = median(ok);
  if (!(m > base + 1.5)) return null;   // the surface never sees this part: an arcade, a court, a wing under a dome
  const hi = b.groundY + (dsm.groupRidge(group) ?? Math.max(b.ridge, b.eave)) + 3;
  return ringTops(b.rings, sample, base + 1.5, hi, m);
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
  // The outline of a landmark is squashed to a plinth by its parts, so its own ridge is no guide to how tall the
  // building is: the Invalides outline reports 13.1 m and clamped the cap to a flat grey plate at 43.1 m across
  // 96 % of the dome. Take the tallest member of the group.
  const groupRidge = dsm.groupRidge(group) ?? Math.max(b.ridge, b.eave);
  const lo = base + 1, hi = b.groundY + Math.max(groupRidge, b.ridge, b.eave) * 1.8 + 15;
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

  // ---- where the cap meets the walls. The ceiling cannot come from this outline's own ridge: a landmark group's
  // outline is squashed to a plinth by its parts, so the Maison de la Radio reports a 10 m eave for a crown whose
  // roof the LiDAR puts at 38 m. Pinning the cap's edge to that hung a 26 m curtain of roof material down the
  // inside of the whole 500 m facade. Take the ceiling from the tallest member of the group, as `hi` already does.
  const topLo = b.groundY + Math.max(b.minH + 2, b.eave - 3);
  const topHi = b.groundY + Math.max(groupRidge, b.ridge, b.eave) + 3;
  const wallTop = ringTops(rings, sampleSmooth, topLo, topHi, b.groundY + b.eave);

  // ---- cells: interior cells share grid vertices; boundary cells are clipped to the footprint
  const positions: number[] = [];
  const indices: number[] = [];
  /** true for a vertex sitting on the footprint, where the cap is *meant* to fall steeply to meet the wall tops */
  const onRing: boolean[] = [];
  const gridIdx = new Map<number, number>();
  const vtx = (i: number, j: number) => {
    const k = j * nx + i;
    let id = gridIdx.get(k);
    if (id == null) { id = positions.length / 3; positions.push((gx0 + i) * g, at(i, j), (gz0 + j) * g); onRing.push(false); gridIdx.set(k, id); }
    return id;
  };
  const inside = (i: number, j: number) => pointInPoly((gx0 + i) * g, (gz0 + j) * g, rings);
  const insideCache = new Int8Array(nx * nz).fill(-1);
  const ins = (i: number, j: number) => { const k = j * nx + i; if (insideCache[k] < 0) insideCache[k] = inside(i, j) ? 1 : 0; return insideCache[k] === 1; };
  const boundaryEps = 1e-3;
  /**
   * A LiDAR surface has cliffs in it — a tower through the middle of a roof, a set-back storey, the inner face of
   * a crown — and triangulating one as a continuous sheet hangs a curtain of *roof* material down what is really a
   * facade. The Maison de la Radio wore 24,000 m2 of that: grey shards over a modelled tower and over the inside
   * of its 500 m crown. Cut a cliff only where a `building:part` already stands there to close the gap, so the
   * drape is replaced by the real facade and never by a hole — and never along the footprint itself, where the cap
   * is *meant* to fall to meet the wall tops. Cutting there tore the rim off Le Passy Kennedy's roof.
   */
  const cliff = Math.max(2.5, g * 4);
  const parts = dsm.groupParts(group);
  const seam = new WallIndex();
  for (const r of rings) seam.add(r);
  const isDrape = (ys: number[], x: number, z: number) => {
    if (parts == null) return false;
    const hiY = Math.max(...ys);
    // Only where the part's wall actually comes up to the top of the curtain. Cutting on proximity alone tore a
    // hole in the Maison de la Radio's roof over its service court, where the wall beside the cliff stops 24 m
    // below it, and left the surviving triangles hanging in the air as shards.
    return hiY - Math.min(...ys) > cliff && !seam.near(x, z, g + 1.5) && parts.reaches(x, z, g + 1.5, hiY - 1);
  };
  for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) {
    const c00 = ins(i, j), c10 = ins(i + 1, j), c01 = ins(i, j + 1), c11 = ins(i + 1, j + 1);
    const count = +c00 + +c10 + +c01 + +c11;
    const cx0 = (gx0 + i) * g, cz0 = (gz0 + j) * g, cx1 = cx0 + g, cz1 = cz0 + g;
    // a cell whose corners are all inside may still be crossed by a thin wall: cheap test on the outer ring only
    const crossed = count === 4 && distToRing((cx0 + cx1) / 2, (cz0 + cz1) / 2, outer) < g * 0.71;
    if (count === 4 && !crossed) {
      const y00 = at(i, j), y10 = at(i + 1, j), y11 = at(i + 1, j + 1), y01 = at(i, j + 1);
      // split along the diagonal that follows the surface better (smaller height difference)
      const cells: [number, number, number][][] = Math.abs(y00 - y11) <= Math.abs(y10 - y01)
        ? [[[i, j, y00], [i + 1, j + 1, y11], [i + 1, j, y10]], [[i, j, y00], [i, j + 1, y01], [i + 1, j + 1, y11]]]
        : [[[i, j, y00], [i, j + 1, y01], [i + 1, j, y10]], [[i + 1, j, y10], [i, j + 1, y01], [i + 1, j + 1, y11]]];
      for (const tri of cells) {
        const mx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, mz = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
        if (isDrape(tri.map(v => v[2]), (gx0 + mx) * g, (gz0 + mz) * g)) continue;
        for (const v of tri) indices.push(vtx(v[0], v[1]));
      }
      continue;
    }
    if (count === 0 && distToRing((cx0 + cx1) / 2, (cz0 + cz1) / 2, outer) > g) continue;
    const pieces = clipToBox([rings], cx0, cz0, cx1, cz1);
    for (const piece of pieces) {
      if (!piece.length || piece[0].length < 3) continue;
      const poly: Poly = piece;
      const { flat, tris } = triangulateCap(poly);
      const first = positions.length / 3;
      const edged: boolean[] = [];
      for (let k = 0; k < flat.length; k += 2) {
        const p: Pt = [flat[k], flat[k + 1]];
        const onEdge = rings.some(r => distToRing(p[0], p[1], r) < boundaryEps);
        edged.push(onEdge); onRing.push(onEdge);
        positions.push(p[0], onEdge ? wallTop(p) : sampleSmooth(p[0], p[1]), p[1]);
      }
      for (let t = 0; t < tris.length; t += 3) {
        const v = [tris[t], tris[t + 1], tris[t + 2]];
        // The seam along the footprint is meant to be steep — that is where the cap comes down to meet the wall
        // tops — so only a triangle clear of the outline counts as a drape.
        if (!v.some(k => edged[k])) {
          const px = v.map(k => positions[(first + k) * 3]), pz = v.map(k => positions[(first + k) * 3 + 2]);
          if (isDrape(v.map(k => positions[(first + k) * 3 + 1]), (px[0] + px[1] + px[2]) / 3, (pz[0] + pz[1] + pz[2]) / 3)) continue;
        }
        indices.push(first + v[0], first + v[1], first + v[2]);
      }
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
    // Again after simplification: the simplifier only locks the outline, not the borders of the cuts above, so it
    // bridges straight back across them and put half the Maison de la Radio's curtain back.
    if (!onRing[a] && !onRing[bb] && !onRing[c] && isDrape([pos[ia + 1], pos[ib + 1], pos[ic + 1]], (pos[ia] + pos[ib] + pos[ic]) / 3, (pos[ia + 2] + pos[ib + 2] + pos[ic + 2]) / 3)) continue;
    keep.push(a, bb, c);
  }
  const remap = new Map<number, number>();
  const col: [number, number, number, number] = [tint[0], tint[1], tint[2], SurfaceFlag.RoofDsm];
  for (const v of keep) if (!remap.has(v)) { const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]; remap.set(v, gb.vertex(x - ox, y, z - oz, x, z, meta, col)); }
  for (let k = 0; k < keep.length; k += 3) gb.tri(remap.get(keep[k])!, remap.get(keep[k + 1])!, remap.get(keep[k + 2])!);
  if (pits) log.info(`dsm: ${b.id}${b.name ? ` (${b.name})` : ''}: ${pits} pit cells lifted`);
  // The cap's edge is where it is; the building's own wall is another matter. An outline squashed to a plinth has
  // parts standing on it, and where one does it already carries the facade, so following the cap up would stand a
  // blank stone cylinder in front of it. Where no part does, the wall has to reach the cap or the roof is left
  // hanging over a gap: Le Passy Kennedy's parts cover 45 % of its outline and the other 55 % was open to the sky.
  const ownTop = b.isPlinth && parts ? (p: Pt) => (parts.near(p[0], p[1], 1.5) ? Math.min(wallTop(p), b.groundY + b.eave) : wallTop(p)) : wallTop;
  return { trisBefore, trisAfter: idx.length / 3, wallTop: ownTop };
}
