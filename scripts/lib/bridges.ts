import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry, LineString, Polygon, MultiPolygon } from 'geojson';
import { log } from './log.ts';
import { OUT_DIR } from '../config.ts';
import type { OsmProps } from './overpass.ts';
import { GeomBuilder, encodeBinMesh } from './binmesh.ts';
import { triangulateCap } from './extrude.ts';
import { frame } from '../../shared/geo.ts';
import { SurfaceFlag, WORLD_HALF } from '../../shared/layout.ts';
import type { Heightmap } from '../../shared/heightmap.ts';
import { area, centroid, cleanRing, insetRing, orient, pointInPoly, unionAll, type Poly, type Pt, type Ring } from './polygons.ts';

const DECK_THICK = 2.2;
const PARAPET_H = 1.05;
const PARAPET_T = 0.45;
const STONE: [number, number, number] = [196, 188, 172];
const STEEL: [number, number, number] = [74, 84, 76];   // the line 6 viaduct's dark green ironwork
const VIADUCT_RISE = 8.5;      // rail deck above the road deck / ground (Bir-Hakeim: ~9 m)
const VIADUCT_THICK = 1.4;
const ARCH_MAX_H = 6.5;
const ROAD: [number, number, number] = [110, 108, 104];

export interface Bridge {
  id: string; poly: Poly; deckTop: number; name: string; rail: boolean; columnsTo?: number;
  /**
   * The roadway/railway this deck carries, in world coordinates. Supports are placed along it by arc length so
   * they follow a curve; without it they used to sit on the polygon's straight PCA chord, which on the 2.4 km
   * Metro 6 alignment wandered up to 190 m off the deck and left columns standing in open water.
   */
  centre?: Pt[];
}
/** Oriented pier footprint: centre, across-flow unit direction (dx,dz), half-length across the flow (2.25 m), half-width along the flow. */
export interface PierBox { cx: number; cz: number; dx: number; dz: number; halfL: number; halfW: number; name: string }
export type FlowField = (x: number, z: number) => [number, number] | null;

function toWorldRing(coords: number[][]): Ring {
  return cleanRing(coords.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; }));
}
function toWorldPolys(geom: Polygon | MultiPolygon): Poly[] {
  const out: Poly[] = [];
  const push = (c: number[][][]) => { const rings = c.map(toWorldRing).filter(r => r.length >= 3); if (rings.length) out.push([orient(rings[0], false), ...rings.slice(1).map(r => orient(r, true))]); };
  if (geom.type === 'Polygon') push(geom.coordinates); else geom.coordinates.forEach(push);
  return out;
}

/** Buffer a polyline into a polygon of the given width (union of per-segment quads + round-ish joints). */
function bufferLine(line: Pt[], width: number): Poly[] {
  const h = width / 2;
  const quads: Poly[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1];
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const nx = (-dz / len) * h, nz = (dx / len) * h;
    quads.push([[[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]]]);
    if (i + 2 < line.length) { // joint disc
      const disc: Ring = []; for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; disc.push([bx + Math.cos(a) * h, bz + Math.sin(a) * h]); }
      quads.push([disc]);
    }
  }
  return unionAll(quads);
}

function roadWidth(tags: Record<string, string>): number {
  const w = parseFloat(tags.width ?? ''); if (w > 2) return w;
  const lanes = parseFloat(tags.lanes ?? '');
  if (tags.railway) return 9;
  if (lanes > 0) return lanes * 3.25 + 5;
  switch (tags.highway) {
    case 'primary': case 'trunk': return 18; case 'secondary': return 14; case 'tertiary': return 12;
    case 'footway': case 'path': case 'cycleway': case 'pedestrian': case 'steps': return 5;
    default: return 10;
  }
}

function addBox(gb: GeomBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, flag: SurfaceFlag, tint: [number, number, number]) {
  const ring: Ring = orient([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], false);
  addWalls(gb, ring, y0, y1, flag, tint);
  addCapAt(gb, [ring], y1, flag, tint, true);
}

function addWalls(gb: GeomBuilder, ring: Ring, y0: number, y1: number, flag: SurfaceFlag, tint: [number, number, number]) {
  const n = ring.length; let u = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.02) continue;
    const m: [number, number, number, number] = [3.1, 1, len, 2 * 256 + 17];
    const c: [number, number, number, number] = [tint[0], tint[1], tint[2], flag];
    const i0 = gb.vertex(a[0], y0, a[1], u, y0 - y0, m, c), i1 = gb.vertex(b[0], y0, b[1], u + len, 0, m, c);
    const i2 = gb.vertex(b[0], y1, b[1], u + len, y1 - y0, m, c), i3 = gb.vertex(a[0], y1, a[1], u, y1 - y0, m, c);
    gb.quad(i0, i1, i2, i3); u += len;
  }
}

/**
 * Deck side walls that reach the ground where there is ground: over the river they stop at the deck's underside,
 * on the bank they continue down to the terrain so the abutment is closed. The foot follows the terrain per
 * vertex, so a skewed abutment on sloping ground still meets it.
 */
function addWallsToGround(gb: GeomBuilder, ring: Ring, bottom: number, top: number, waterLevelY: number, hm: Heightmap) {
  const n = ring.length;
  let u = 0;
  const c: [number, number, number, number] = [STONE[0], STONE[1], STONE[2], SurfaceFlag.Plinth];
  const footAt = (p: Pt) => {
    const g = hm.sample(p[0], p[1]);
    return g > waterLevelY + 0.6 ? Math.min(bottom, g - 0.4) : bottom;
  };
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.02) continue;
    const m: [number, number, number, number] = [3.1, 1, len, 2 * 256 + 17];
    const ya = footAt(a), yb = footAt(b);
    const i0 = gb.vertex(a[0], ya, a[1], u, 0, m, c), i1 = gb.vertex(b[0], yb, b[1], u + len, 0, m, c);
    const i2 = gb.vertex(b[0], top, b[1], u + len, top - yb, m, c), i3 = gb.vertex(a[0], top, a[1], u, top - ya, m, c);
    gb.quad(i0, i1, i2, i3);
    u += len;
  }
}

function addCapAt(gb: GeomBuilder, rings: Poly, y: number, flag: SurfaceFlag, tint: [number, number, number], up: boolean) {
  const { flat, tris } = triangulateCap(rings);
  const base = gb.vertexCount;
  const m: [number, number, number, number] = [3.1, 1, 0, 2 * 256 + 17];
  for (let i = 0; i < flat.length; i += 2) gb.vertex(flat[i], y, flat[i + 1], flat[i], flat[i + 1], m, [tint[0], tint[1], tint[2], flag]);
  for (let t = 0; t < tris.length; t += 3) up ? gb.tri(base + tris[t], base + tris[t + 1], base + tris[t + 2]) : gb.tri(base + tris[t], base + tris[t + 2], base + tris[t + 1]);
}

/**
 * Spandrel walls with elliptical arch openings between the supports (abutments and piers), on both sides of the deck:
 * from the quays a masonry bridge reads as arches, not as a slab. The vault itself stays the flat underside.
 */
function addArches(gb: GeomBuilder, b: Bridge, piers: PierBox[], bottom: number, waterLevelY: number) {
  if (!piers.length) return;
  const ax = principalAxis(b.poly[0]);
  const tOf = (x: number, z: number) => (x - ax.cx) * ax.dx + (z - ax.cz) * ax.dz;
  const supports = [{ t: -ax.half, half: 0 }, ...piers.map(p => ({ t: tOf(p.cx, p.cz), half: p.halfL })).sort((p, q) => p.t - q.t), { t: ax.half, half: 0 }];
  const spring = Math.max(waterLevelY + 1.2, bottom - ARCH_MAX_H);
  if (bottom - spring < 1.5) return;
  // Local half-width per station, not one figure for the whole span: a constant put Alexandre III's arcade 12.6 m
  // (max 15.6) outside its own deck, standing free in the water.
  const halfAt = (x: number, z: number) => Math.max(1, halfWidthAt(b.poly[0], x, z, -ax.dz, ax.dx) - 0.05);
  const m: [number, number, number, number] = [3.1, 1, 0, 2 * 256 + 17];
  const c: [number, number, number, number] = [STONE[0], STONE[1], STONE[2], SurfaceFlag.Plinth];
  for (let s = 0; s + 1 < supports.length; s++) {
    const a = supports[s].t + supports[s].half, e = supports[s + 1].t - supports[s + 1].half;
    if (e - a < 4) continue;
    const mid = (a + e) / 2, half = (e - a) / 2, steps = Math.max(12, Math.ceil((e - a) / 1.0));
    for (const side of [-1, 1]) {
      const nx = -ax.dz * side, nz = ax.dx * side;
      let prev: [number, number, number, number] | null = null;   // x, z, yArch, t
      for (let k = 0; k <= steps; k++) {
        const t = a + (e - a) * k / steps;
        const yArch = spring + (bottom - spring) * Math.sqrt(Math.max(0, 1 - ((t - mid) / half) ** 2));
        const cxT = ax.cx + ax.dx * t, czT = ax.cz + ax.dz * t;
        const w = halfAt(cxT, czT);
        const x = cxT + nx * w, z = czT + nz * w;
        if (prev) {
          const i0 = gb.vertex(prev[0], prev[2], prev[1], prev[3], prev[2] - spring, m, c), i1 = gb.vertex(x, yArch, z, t, yArch - spring, m, c);
          const i2 = gb.vertex(x, bottom + 0.02, z, t, bottom - spring, m, c), i3 = gb.vertex(prev[0], bottom + 0.02, prev[1], prev[3], bottom - spring, m, c);
          // outward = (nx, nz): the quad (i0, i1, i2) has normal cross(p1 - p0, p2 - p0); flip when it points inward
          const ux = x - prev[0], uz = z - prev[1], vy = bottom + 0.02 - yArch;
          const nyx = uz * vy, nyz = -ux * vy;   // cross((ux, 0, uz), (0, vy, 0)) -> (-uz*vy, 0, ux*vy) for the other order
          if (-nyx * nx - nyz * nz > 0) gb.quad(i0, i1, i2, i3); else gb.quad(i0, i3, i2, i1);
        }
        prev = [x, z, yArch, t];
      }
    }
  }
}

/** Elevated rail deck (métro line 6): thin steel-green deck, low parapet, pairs of columns every 7 m down to `columnsTo`. */
function addViaduct(deck: GeomBuilder, stone: GeomBuilder, parapet: GeomBuilder, b: Bridge, surfaceAt: (x: number, z: number) => number) {
  const top = b.deckTop, bottom = top - VIADUCT_THICK;
  addCapAt(deck, b.poly, top, SurfaceFlag.RoofTopOverview, ROAD, true);
  addCapAt(stone, b.poly, bottom, SurfaceFlag.Plinth, STEEL, false);
  for (const r of b.poly) addWalls(stone, r, bottom, top, SurfaceFlag.Plinth, STEEL);
  const inner = insetRing(b.poly[0], 0.3, 0.2);
  if (inner) {
    addWalls(parapet, b.poly[0], top, top + 0.9, SurfaceFlag.Plinth, STEEL);
    addWalls(parapet, orient(inner, true), top, top + 0.9, SurfaceFlag.Plinth, STEEL);
    addCapAt(parapet, [b.poly[0], orient(inner, true)], top + 0.9, SurfaceFlag.Plinth, STEEL, true);
  }
  const ax = principalAxis(b.poly[0]);
  // Columns follow the line the viaduct actually runs on. On the straight PCA chord of a 2.4 km curved alignment
  // 664 of 670 columns landed outside their own deck, dozens of them standing free in the Seine.
  const line: Pt[] = b.centre && b.centre.length >= 2
    ? b.centre
    : [[ax.cx - ax.dx * ax.half, ax.cz - ax.dz * ax.half], [ax.cx + ax.dx * ax.half, ax.cz + ax.dz * ax.half]];
  for (const st of stationsAlong(line, 7, 3.5)) {
    if (!pointInPoly(st.x, st.z, b.poly)) continue;
    // Pairs straddle the centreline, inset from the deck's real edge rather than a fixed ±3 m.
    const half = Math.max(0.6, Math.min(3.0, halfWidthAt(b.poly[0], st.x, st.z, -st.tz, st.tx) - 0.6));
    for (const side of [-1, 1]) {
      const cx = st.x - st.tz * side * half, cz = st.z + st.tx * side * half;
      const ring: Ring = orient([[cx - 0.28, cz - 0.28], [cx + 0.28, cz - 0.28], [cx + 0.28, cz + 0.28], [cx - 0.28, cz + 0.28]], false);
      // Foot on whatever is actually under THIS column — the road deck it crosses, or the ground. One height for
      // the whole line left the Metro 6 columns floating up to 5.6 m over the Bir-Hakeim roadway and buried 2 m
      // elsewhere, because a 2.4 km viaduct crosses a bridge deck, a quay and open ground in turn.
      const foot = Math.min(bottom - 0.5, surfaceAt(cx, cz));
      addWalls(stone, ring, foot - 0.15, bottom + 0.05, SurfaceFlag.Plinth, STEEL);
    }
  }
}

/** Total length of a polyline. */
function lineLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Fraction of a polyline's length whose sample points fall inside `poly` (sampled every ~2 m). */
function fractionInside(pts: Pt[], poly: Poly): number {
  let inside = 0, total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(seg / 2));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      total += seg / n;
      if (pointInPoly(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, poly)) inside += seg / n;
    }
  }
  return total > 0 ? inside / total : 0;
}

/** Evenly spaced points along a polyline with the local unit tangent at each, inset from both ends. */
export function stationsAlong(pts: Pt[], spacing: number, inset: number): { x: number; z: number; tx: number; tz: number }[] {
  const L = lineLength(pts);
  const span = L - 2 * inset;
  if (!(span > 0) || !(spacing > 0)) return [];
  const n = Math.max(1, Math.round(span / spacing));
  const out: { x: number; z: number; tx: number; tz: number }[] = [];
  for (let k = 0; k <= n; k++) {
    const target = inset + (span * k) / n;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (seg < 1e-6) continue;
      if (acc + seg >= target || i === pts.length - 1) {
        const t = Math.max(0, Math.min(1, (target - acc) / seg));
        out.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: (b[0] - a[0]) / seg, tz: (b[1] - a[1]) / seg });
        break;
      }
      acc += seg;
    }
  }
  return out;
}

/**
 * Principal axis of a ring via covariance (unit direction, centre of the ring's own extent, half-length).
 *
 * Callers lay piers and arch springings out across `[-half, +half]` about `(cx, cz)`, so `(cx, cz)` has to be the
 * middle of the deck, not just some point on the axis. Two things used to break that: the centre came from the
 * unweighted vertex mean, and the midpoints of the measured extents were thrown away. Measured over the 45 baked
 * decks that put the pier row up to 17.9 m along the bridge and the spandrel walls up to 7.8 m off its edges.
 */
export function principalAxis(ring: Ring): { cx: number; cz: number; dx: number; dz: number; half: number; width: number } {
  // Area-weighted centre: outlines carry far more vertices along a detailed kerb than a plain one, and buffered
  // polylines pile twelve into every joint disc, which drags a vertex mean toward the busy side.
  const [gx, gz] = centroid(ring);
  let sxx = 0, sxz = 0, szz = 0; for (const p of ring) { const x = p[0] - gx, z = p[1] - gz; sxx += x * x; sxz += x * z; szz += z * z; }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const dx = Math.cos(ang), dz = Math.sin(ang);
  let lo = Infinity, hi = -Infinity, wlo = Infinity, whi = -Infinity;
  for (const p of ring) { const t = (p[0] - gx) * dx + (p[1] - gz) * dz; const w = -(p[0] - gx) * dz + (p[1] - gz) * dx; lo = Math.min(lo, t); hi = Math.max(hi, t); wlo = Math.min(wlo, w); whi = Math.max(whi, w); }
  const tMid = (lo + hi) / 2, wMid = (wlo + whi) / 2;
  return {
    cx: gx + dx * tMid - dz * wMid,
    cz: gz + dz * tMid + dx * wMid,
    dx, dz, half: (hi - lo) / 2, width: whi - wlo,
  };
}

/** Half-width of a ring measured across `dir` through the point `(px, pz)`; used to keep a pier inside its deck. */
function halfWidthAt(ring: Ring, px: number, pz: number, dx: number, dz: number): number {
  // Distance to the nearest ring EDGE each way along the ray, not the ring's overall extent. Projecting every
  // vertex answers "how wide is this deck anywhere", which on the skewed Pont d'Iena parallelogram put the arch
  // wall a constant 19.9 m out while the real edge slid between 16.6 and 19.8 — up to 3.2 m outboard of the deck,
  // reading as a detached panel with open water behind it.
  let back = Infinity, fwd = Infinity;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    // solve a + u*e = p + t*d
    const den = ex * dz - ez * dx;
    if (Math.abs(den) < 1e-9) continue;
    const rx = a[0] - px, rz = a[1] - pz;
    const u = (rx * dz - rz * dx) / -den;          // parameter along the edge
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    const t = (rx * ez - rz * ex) / -den;          // signed distance along the ray
    if (t >= 0) { if (t < fwd) fwd = t; } else if (-t < back) back = -t;
  }
  const half = Math.min(back, fwd);
  if (Number.isFinite(half)) return half;
  // outside the ring, or a degenerate crossing: fall back to the overall extent
  let lo = Infinity, hi = -Infinity;
  for (const p of ring) {
    const t = (p[0] - px) * dx + (p[1] - pz) * dz;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return Math.min(Math.abs(lo), Math.abs(hi));
}

/** Pier boxes of a deck along its principal axis (30 m spacing, only where the ground is under water). */
function pierBoxes(b: Bridge, hm: Heightmap, waterLevelY: number, flowAt?: FlowField): PierBox[] {
  const ax = principalAxis(b.poly[0]);
  // Prefer the carriageway this deck actually carries. The outline of a road bridge is asymmetric — the
  // carriageway sits to one side of the footways — so its PCA axis is up to 8 m off the road, and on a curved
  // viaduct the straight axis leaves the deck entirely.
  const line: Pt[] = b.centre && b.centre.length >= 2
    ? b.centre
    : [[ax.cx - ax.dx * ax.half, ax.cz - ax.dz * ax.half], [ax.cx + ax.dx * ax.half, ax.cz + ax.dz * ax.half]];
  const L = lineLength(line);
  // One pier per span boundary rather than a blind 30 m grid: a single-span bridge (Alexandre III) used to get
  // four piers it does not have.
  const spans = Math.max(1, Math.round(L / 35));
  if (spans < 2) return [];
  const stations = stationsAlong(line, L / spans, L / spans);
  const pierW = Math.max(3, Math.min(ax.width * 0.8, 24)), pierL = 4.5;
  const out: PierBox[] = [];
  for (const st of stations) {
    if (!pointInPoly(st.x, st.z, b.poly)) continue;          // never a support outside the deck it holds up
    if (hm.sample(st.x, st.z) > waterLevelY + 1.5) continue; // pier on land is a wall, skip
    // Real piers are streamlined along the current; without a flow field fall back to the deck's perpendicular.
    // Reject a flow vector that has swung far off it — near the Ile aux Cygnes fork the 60 m secant window
    // straddles two arms and comes back up to 29 degrees out, which visibly slews the pier.
    const perp: [number, number] = [-st.tz, st.tx];
    const flow = flowAt?.(st.x, st.z);
    const [fx, fz] = flow && Math.abs(flow[0] * perp[0] + flow[1] * perp[1]) > 0.94 ? flow : perp;
    // Keep the pier inside the deck: a constant half-width made a 40 m pier under a 14 m deck, damming the river.
    const deckHalf = halfWidthAt(b.poly[0], st.x, st.z, fx, fz);
    const halfW = Math.max(2, Math.min(pierW / 2, deckHalf - 0.5));
    out.push({ cx: st.x, cz: st.z, dx: -fz, dz: fx, halfL: pierL / 2, halfW, name: b.name });
  }
  return out;
}

/** Deck polygons (from man_made=bridge outlines, else buffered bridge=yes lines) and their piers. */
export function collectBridges(roads: FeatureCollection<Geometry, OsmProps>, hm: Heightmap, waterLevelY: number, flowAt?: FlowField): { bridges: Bridge[]; piers: PierBox[]; outlines: number; fromLines: number } {
  const bridges: Bridge[] = [];
  const outlines: { poly: Poly; tags: Record<string, string>; id: string }[] = [];
  for (const f of roads.features) {
    const t = f.properties.tags ?? {};
    if (t.man_made !== 'bridge') continue;
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    for (const poly of toWorldPolys(f.geometry)) if (area(poly[0]) > 30) outlines.push({ poly, tags: t, id: `${f.properties.type}/${f.properties.id}` });
  }
  const lines: { pts: Pt[]; tags: Record<string, string>; id: string }[] = [];
  for (const f of roads.features) {
    const t = f.properties.tags ?? {};
    if (!t.bridge || t.bridge === 'no' || f.geometry.type !== 'LineString') continue;
    if (!(t.highway || t.railway)) continue;
    if (t.highway === 'steps') continue;
    if (t.footway === 'sidewalk') continue;   // a sidewalk rides the road deck; it never gets a deck and piers of its own
    const pts: Pt[] = (f.geometry as LineString).coordinates.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; });
    if (pts.every(p => Math.abs(p[0]) > WORLD_HALF + 100 || Math.abs(p[1]) > WORLD_HALF + 100)) continue;
    lines.push({ pts, tags: t, id: `${f.properties.type}/${f.properties.id}` });
  }

  /**
   * Height of a deck. The outline's own footprint is a poor guide on its own: at the Pont d'Iéna the outline
   * touches the low riverside walkway, so the deck came out 3.5 m BELOW the quays it joins and traffic dropped
   * off a step at each end. When the carriageway is known, sample the ground just beyond both of its ends — that
   * is the road the deck has to meet — and never sit lower than that.
   */
  const deckLevel = (ring: Ring, centre?: Pt[]): number => {
    const ys = ring.map(p => hm.sample(p[0], p[1])).filter(y => y > waterLevelY + 1.0).sort((a, b) => a - b);
    // A level inferred from one or two bank samples is a guess, and two paths over open water came out with their
    // soffits below the surface. Fall back to a standard height unless several samples agree.
    let level = ys.length < 3 ? waterLevelY + 8 : ys.slice(Math.floor(ys.length * 0.5)).reduce((s, v) => s + v, 0) / ys.slice(Math.floor(ys.length * 0.5)).length + 0.15;
    if (centre && centre.length >= 2) {
      const onLand: number[] = [];
      for (const [end, prev] of [[centre[0], centre[1]], [centre[centre.length - 1], centre[centre.length - 2]]] as [Pt, Pt][]) {
        const dx = end[0] - prev[0], dz = end[1] - prev[1], L = Math.hypot(dx, dz) || 1;
        for (let d = 4; d <= 30; d += 3) {
          const y = hm.sample(end[0] + (dx / L) * d, end[1] + (dz / L) * d);
          if (y > waterLevelY + 1.0) onLand.push(y);
        }
      }
      if (onLand.length >= 3) {
        onLand.sort((a, b) => a - b);
        // Only ever raise: an approach that runs down to a low quay must not drag the span under the water.
        level = Math.max(level, onLand[Math.floor(onLand.length * 0.6)] + 0.15);
      }
    }
    // Keep a navigable soffit: Paris road bridges clear the water by about 6 m.
    return Math.max(level, waterLevelY + 0.3 + DECK_THICK + 3.5);
  };

  for (const o of outlines) {
    const rail = /rail|subway|viaduc|métro|metro/i.test(o.tags.name ?? '') || !!o.tags.railway;
    // The road this outline carries: the longest carriageway lying mostly inside it. Supports go along that, not
    // along the outline's own axis, which is pulled off-centre by the footways beside the carriageway.
    let best: { pts: Pt[]; len: number } | null = null;
    for (const l of lines) {
      if (fractionInside(l.pts, o.poly) < 0.6) continue;
      const len = lineLength(l.pts);
      if (!best || len > best.len) best = { pts: l.pts, len };
    }
    bridges.push({ id: o.id, poly: o.poly, deckTop: deckLevel(o.poly[0], best?.pts), name: o.tags.name ?? o.id, rail, centre: best?.pts });
  }
  // elevated métro: every railway bridge line rides VIADUCT_RISE above the road deck (inside an outline) or the ground,
  // on steel columns; the road outline below keeps its own deck
  for (const l of lines) {
    if (!l.tags.railway) continue;
    const over = outlines.find(o => fractionInside(l.pts, o.poly) > 0.5);
    for (const poly of bufferLine(l.pts, roadWidth(l.tags))) {
      const base = over ? bridges.find(b => b.id === over.id)?.deckTop ?? deckLevel(poly[0], l.pts) : deckLevel(poly[0], l.pts);
      bridges.push({ id: l.id, poly, deckTop: base + VIADUCT_RISE, name: l.tags.name ?? l.id, rail: true, columnsTo: base, centre: l.pts });
    }
  }
  // Lines not covered by an outline become simple decks (skip tiny spans, e.g. over a ditch).
  let fromLines = 0;
  for (const l of lines) {
    if (l.tags.railway) continue;   // handled above
    // Test how much of the line lies inside an outline, not just its middle VERTEX: the offenders had two
    // vertices, so their "middle" was an endpoint out on the approach ramp and they escaped this check, giving
    // Iena and Alexandre III a second parapeted deck hovering a metre above the real one.
    if (outlines.some(o => fractionInside(l.pts, o.poly) > 0.5)) continue;
    const len = l.pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - l.pts[i - 1][0], p[1] - l.pts[i - 1][1]) : 0, 0);
    if (len < 12) continue;
    const polys = bufferLine(l.pts, roadWidth(l.tags));
    for (const poly of polys) { bridges.push({ id: l.id, poly, deckTop: deckLevel(poly[0], l.pts), name: l.tags.name ?? l.id, rail: !!l.tags.railway, centre: l.pts }); fromLines++; }
  }
  // Reach the road. A `man_made=bridge` outline stops where the structure stops, which on the Seine bridges is
  // still inside the riverbank trench: the Pont d'Iena's outline ended 7.6 m short of ground at deck level, so
  // traffic met a 5.9 m drop at the abutment. Grow the deck along its centreline until the ground comes up to it.
  for (const b of bridges) {
    if (b.columnsTo !== undefined || !b.centre || b.centre.length < 2) continue;
    const ax = principalAxis(b.poly[0]);
    const w = Math.max(4, ax.width);
    const aprons: Poly[] = [];
    for (const [end, prev] of [[b.centre[0], b.centre[1]], [b.centre[b.centre.length - 1], b.centre[b.centre.length - 2]]] as [Pt, Pt][]) {
      const dx = end[0] - prev[0], dz = end[1] - prev[1], L = Math.hypot(dx, dz) || 1;
      const ux = dx / L, uz = dz / L;
      // Run out until the ground has come up to deck level, then a few metres more so the join is on solid ground
      // rather than on the lip of the trench the riverside walkway cuts under the bridge.
      let reach = 0;
      for (let d = 1; d <= 26; d += 1) {
        reach = d;
        if (hm.sample(end[0] + ux * d, end[1] + uz * d) >= b.deckTop - 0.25) { reach = Math.min(26, d + 5); break; }
      }
      if (reach < 1.5) continue;
      // a rectangular apron from a little inside the deck out to where the ground meets it
      const nx = -uz, nz = ux, back = 3;
      const p0: Pt = [end[0] - ux * back + nx * w / 2, end[1] - uz * back + nz * w / 2];
      const p1: Pt = [end[0] + ux * reach + nx * w / 2, end[1] + uz * reach + nz * w / 2];
      const p2: Pt = [end[0] + ux * reach - nx * w / 2, end[1] + uz * reach - nz * w / 2];
      const p3: Pt = [end[0] - ux * back - nx * w / 2, end[1] - uz * back - nz * w / 2];
      aprons.push([orient([p0, p1, p2, p3], false)]);
    }
    if (!aprons.length) continue;
    const merged = unionAll([b.poly, ...aprons]);
    const biggest = merged.reduce((p, q) => (area(p[0]) >= area(q[0]) ? p : q), merged[0]);
    if (biggest && area(biggest[0]) > area(b.poly[0]) * 0.95) b.poly = biggest;
  }

  const piers: PierBox[] = [];
  for (const b of bridges) if (b.columnsTo === undefined) piers.push(...pierBoxes(b, hm, waterLevelY, flowAt));
  return { bridges, piers, outlines: outlines.length, fromLines };
}

export async function buildBridges(roads: FeatureCollection<Geometry, OsmProps>, hm: Heightmap, waterLevelY: number, flowAt?: FlowField): Promise<{ count: number; bytes: number; names: string[] }> {
  const { bridges, outlines, fromLines } = collectBridges(roads, hm, waterLevelY, flowAt);
  const deck = new GeomBuilder(), stone = new GeomBuilder(), parapet = new GeomBuilder();
  // What a viaduct column at (x, z) stands on: the highest road deck it crosses, otherwise the ground.
  const roadDecks = bridges.filter(b => b.columnsTo === undefined);
  const surfaceAt = (x: number, z: number): number => {
    let y = hm.sample(x, z);
    for (const o of roadDecks) if (o.deckTop > y && pointInPoly(x, z, o.poly)) y = o.deckTop;
    return y;
  };
  for (const b of bridges) {
    const outer = b.poly[0];
    if (b.columnsTo !== undefined) { addViaduct(deck, stone, parapet, b, surfaceAt); continue; }
    const top = b.deckTop, bottom = top - DECK_THICK;
    // Deck top samples the overview ortho (flag 4), underside and sides are stone.
    addCapAt(deck, b.poly, top, SurfaceFlag.RoofTopOverview, ROAD, true);
    addCapAt(stone, b.poly, bottom, SurfaceFlag.Plinth, STONE, false);
    // Side and end faces. Carry them down to the ground wherever the deck stands over land, so the abutments meet
    // the bank instead of ending in mid-air: the Pont d'Iena's end faces hung 3.7 m and 1.7 m clear of the ground.
    for (const r of b.poly) addWallsToGround(stone, r, bottom, top, waterLevelY, hm);
    // Parapets along the outer ring.
    const inner = insetRing(outer, PARAPET_T, 0.2);
    if (inner) {
      addWalls(parapet, outer, top, top + PARAPET_H, SurfaceFlag.Plinth, STONE);
      addWalls(parapet, orient(inner, true), top, top + PARAPET_H, SurfaceFlag.Plinth, STONE);
      addCapAt(parapet, [outer, orient(inner, true)], top + PARAPET_H, SurfaceFlag.Plinth, STONE, true);
    }
    // Piers along the principal axis (shared with the boat lanes of the path bake), and the arches between them.
    const piers = pierBoxes(b, hm, waterLevelY, flowAt);
    addArches(stone, b, piers, bottom, waterLevelY);
    for (const p of piers) {
      const hx = p.dx * p.halfL, hz = p.dz * p.halfL, wx = -p.dz * p.halfW, wz = p.dx * p.halfW;
      const ring: Ring = orient([[p.cx - hx - wx, p.cz - hz - wz], [p.cx + hx - wx, p.cz + hz - wz], [p.cx + hx + wx, p.cz + hz + wz], [p.cx - hx + wx, p.cz - hz + wz]], false);
      addWalls(stone, ring, waterLevelY - 3, bottom + 0.05, SurfaceFlag.Plinth, STONE);
    }
  }
  void addBox;
  const buf = encodeBinMesh({ x: 0, z: 0 }, [deck.toSection('deck'), stone.toSection('stone'), parapet.toSection('parapet')], { count: bridges.length });
  await fs.writeFile(path.join(OUT_DIR, 'bridges.bin'), buf);
  const names = [...new Set(bridges.map(b => b.name))];
  log.info(`bridges: ${bridges.length} decks (${outlines} outlines, ${fromLines} from lines): ${names.slice(0, 12).join(', ')}${names.length > 12 ? '…' : ''}`);
  return { count: bridges.length, bytes: buf.length, names };
}
