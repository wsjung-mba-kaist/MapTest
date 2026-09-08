import earcut from 'earcut';
import { SurfaceFlag, ORTHO_MARGIN, CHUNK_SIZE, packStyleSeed } from '../../shared/layout.ts';
import { bearingToDir } from '../../shared/geo.ts';
import { GeomBuilder } from './binmesh.ts';
import { CURVED_ROOFS, type BuildingSpec, type RoofKind } from './buildings.ts';
import { area, centroid, clipToBand, distToRing, erodeRing, orient, perimeter, pointInRing, signedArea, type MinRect, type Poly, type Pt, type Ring } from './polygons.ts';
import { placeRoofDetails } from './roofdetails.ts';

export interface ChunkBuilders {
  walls: GeomBuilder; roofs: GeomBuilder; tops: GeomBuilder; lod: GeomBuilder; details?: number[];
  /** LiDAR surface-model caps of the landmarks, and their analytic roofs for the ?dsm=0 / mobile fallback */
  dsm?: GeomBuilder; roofsAlt?: GeomBuilder; topsAlt?: GeomBuilder;
}
/** True when this spec's landmark group has a surface-model window, i.e. its outline will carry a cap. */
export type DsmCovers = (b: BuildingSpec) => boolean;
/** Wall tops for a part of a capped group, read off the cap's own surface; null when the window does not reach it. */
export type DsmParts = (b: BuildingSpec) => ((p: Pt) => number) | null;
/** Hook for the DSM cap (scripts/lib/dsmroof.ts): returns null to fall back to the analytic roof. */
export type DsmHook = (gb: GeomBuilder, b: BuildingSpec, ox: number, oz: number, meta: [number, number, number, number], tint: [number, number, number]) => { trisBefore: number; trisAfter: number; wallTop: (p: Pt) => number } | null;

const MANSARD = { inset1: 1.3, rise1Max: 4.0, inset2Max: 4.0 };
/**
 * Extra wall-top samples along a long edge, matching the spacing the surface fit uses. Without them one quad spans
 * the whole edge and its top is a straight line between the two ends: the Maison de la Radio had a 42 m facade
 * whose top slid 10 m from one corner to the other.
 */
const followSurface = (a: Pt, b: Pt): number[] => {
  const n = Math.min(48, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
  return n > 1 ? Array.from({ length: n - 1 }, (_, i) => (i + 1) / n) : [];
};
type Meta = [number, number, number, number];
type Tint = [number, number, number];

/** Triangulate rings (outer + holes) into indices over the concatenated vertex list; ensures up-facing winding. */
export function triangulateCap(rings: Poly): { flat: number[]; holes: number[]; tris: number[] } {
  const flat: number[] = [];
  const holes: number[] = [];
  rings.forEach((r, k) => { if (k > 0) holes.push(flat.length / 2); for (const [x, z] of r) flat.push(x, z); });
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const sa = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
    if (sa > 0) { tris[t + 1] = c; tris[t + 2] = b; } // normal.y = -signedArea -> need negative area for +y
  }
  return { flat, holes, tris };
}

function addCap(gb: GeomBuilder, rings: Poly, y: number, ox: number, oz: number, meta: Meta, tint: Tint, flag: SurfaceFlag) {
  const { flat, tris } = triangulateCap(rings);
  const base = gb.vertexCount;
  for (let i = 0; i < flat.length; i += 2) gb.vertex(flat[i] - ox, y, flat[i + 1] - oz, flat[i], flat[i + 1], meta, [tint[0], tint[1], tint[2], flag]);
  for (let t = 0; t < tris.length; t += 3) gb.tri(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
}

/** Wall quads for a ring between y0 and y1. u = metres along the ring, v = metres above groundY. */
function addWalls(gb: GeomBuilder, ring: Ring, y0: number, y1: number, groundY: number, ox: number, oz: number, meta: Meta, tint: Tint, flag: SurfaceFlag) {
  const n = ring.length;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const m: Meta = [meta[0], meta[1], len, meta[3]];
    const c: [number, number, number, number] = [tint[0], tint[1], tint[2], flag];
    const i0 = gb.vertex(a[0] - ox, y0, a[1] - oz, u, y0 - groundY, m, c);
    const i1 = gb.vertex(b[0] - ox, y0, b[1] - oz, u + len, y0 - groundY, m, c);
    const i2 = gb.vertex(b[0] - ox, y1, b[1] - oz, u + len, y1 - groundY, m, c);
    const i3 = gb.vertex(a[0] - ox, y1, a[1] - oz, u, y1 - groundY, m, c);
    gb.quad(i0, i1, i2, i3);
    u += len;
  }
}

/**
 * Wall quads whose top follows a height function (gable ends, barrel-vault ends, skillion): each edge is split at the
 * parameter values `splitAt` returns, so a gable peak or a curved end is reproduced. Still 4-vertex quads, as
 * BuildingDetails expects.
 */
function addWallsProfile(gb: GeomBuilder, ring: Ring, y0: number, groundY: number, topY: (p: Pt) => number, splitAt: (a: Pt, b: Pt) => number[], ox: number, oz: number, meta: Meta, tint: Tint, flag: SurfaceFlag) {
  const n = ring.length;
  let u = 0;
  const c: [number, number, number, number] = [tint[0], tint[1], tint[2], flag];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const ts = [0, ...splitAt(a, b).filter(t => t > 1e-4 && t < 1 - 1e-4).sort((p, q) => p - q), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      const p: Pt = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
      const q: Pt = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
      const seg = len * (ts[k + 1] - ts[k]);
      if (seg < 0.02) continue;
      const m: Meta = [meta[0], meta[1], seg, meta[3]];
      const yp = topY(p), yq = topY(q);
      const i0 = gb.vertex(p[0] - ox, y0, p[1] - oz, u, y0 - groundY, m, c);
      const i1 = gb.vertex(q[0] - ox, y0, q[1] - oz, u + seg, y0 - groundY, m, c);
      const i2 = gb.vertex(q[0] - ox, yq, q[1] - oz, u + seg, yq - groundY, m, c);
      const i3 = gb.vertex(p[0] - ox, yp, p[1] - oz, u, yp - groundY, m, c);
      gb.quad(i0, i1, i2, i3);
      u += seg;
    }
  }
}

/** Sloped quads between ring r0 at y0 and the vertex-corresponding ring r1 at y1. */
function addSlope(gb: GeomBuilder, r0: Ring, r1: Ring, y0: number, y1: number, ox: number, oz: number, meta: Meta, tint: Tint) {
  const n = r0.length;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = r0[i], b = r0[(i + 1) % n], a1 = r1[i], b1 = r1[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const rise = Math.hypot(y1 - y0, Math.hypot(a1[0] - a[0], a1[1] - a[1]));
    const c: [number, number, number, number] = [tint[0], tint[1], tint[2], SurfaceFlag.RoofSlope];
    const i0 = gb.vertex(a[0] - ox, y0, a[1] - oz, u, 0, meta, c);
    const i1 = gb.vertex(b[0] - ox, y0, b[1] - oz, u + len, 0, meta, c);
    const i2 = gb.vertex(b1[0] - ox, y1, b1[1] - oz, u + len, rise, meta, c);
    const i3 = gb.vertex(a1[0] - ox, y1, a1[1] - oz, u, rise, meta, c);
    gb.quad(i0, i1, i2, i3);
    u += len;
  }
}

/**
 * Sloped band between an eave ring and an eroded inner ring of any vertex count: the ring-shaped region is
 * triangulated (inner ring as a hole) and the inner vertices are lifted. uv = (metres along the eave, metres up the slope).
 */
function addSlopeBand(gb: GeomBuilder, outer: Ring, inner: Ring, y0: number, y1: number, ox: number, oz: number, meta: Meta, tint: Tint) {
  const O = orient(outer, false), I = orient(inner, true);
  const uO: number[] = [0];
  for (let i = 1; i <= O.length; i++) uO.push(uO[i - 1] + Math.hypot(O[i % O.length][0] - O[i - 1][0], O[i % O.length][1] - O[i - 1][1]));
  // eave-perimeter parameter of an inner vertex = parameter of its projection on the nearest eave edge
  const projectU = (p: [number, number]): { u: number; d: number } => {
    let best = { u: 0, d: Infinity };
    for (let i = 0; i < O.length; i++) {
      const a = O[i], b = O[(i + 1) % O.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
      const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
      if (d < best.d) best = { u: uO[i] + Math.sqrt(l2) * t, d };
    }
    return best;
  };
  const { flat, tris } = triangulateCap([O, I]);
  const base = gb.vertexCount;
  const c: [number, number, number, number] = [tint[0], tint[1], tint[2], SurfaceFlag.RoofSlope];
  const nO = O.length;
  for (let i = 0; i < flat.length / 2; i++) {
    const x = flat[i * 2], z = flat[i * 2 + 1];
    if (i < nO) gb.vertex(x - ox, y0, z - oz, uO[i], 0, meta, c);
    else { const pr = projectU([x, z]); gb.vertex(x - ox, y1, z - oz, pr.u, Math.hypot(y1 - y0, pr.d), meta, c); }
  }
  for (let t = 0; t < tris.length; t += 3) gb.tri(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
}

function holesInside(outer: Ring, holes: Ring[]): boolean {
  return holes.every(h => h.every(p => pointInRing(p[0], p[1], outer)));
}

// ------------------------------------------------------------------------------------------------ curved roofs

/** Subdivide edges longer than maxEdge so a square drum still gets enough columns for a round dome. */
export function resampleRing(ring: Ring, maxEdge: number): Ring {
  const out: Ring = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(len / maxEdge));
    for (let s = 0; s < k; s++) out.push([a[0] + (b[0] - a[0]) * s / k, a[1] + (b[1] - a[1]) * s / k]);
  }
  return out;
}

/** Point of the rect's inscribed ellipse in the direction of p from the rect centre. */
function ellipsePoint(rect: MinRect, p: Pt): Pt {
  const dx = p[0] - rect.cx, dz = p[1] - rect.cz;
  const c = Math.cos(-rect.angle), s = Math.sin(-rect.angle);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;   // into the rect frame (w along x, h along z)
  const th = Math.atan2(lz, lx);
  const a = Math.max(0.5, rect.w / 2), b = Math.max(0.5, rect.h / 2);
  const r = (a * b) / Math.sqrt((b * Math.cos(th)) ** 2 + (a * Math.sin(th)) ** 2);
  const ex = r * Math.cos(th), ez = r * Math.sin(th);
  const cc = Math.cos(rect.angle), ss = Math.sin(rect.angle);
  return [rect.cx + ex * cc - ez * ss, rect.cz + ex * ss + ez * cc];
}

/**
 * Dome / onion over a footprint ring: `nLat` parallels scaled toward the centre, the base parallel being the ring
 * itself (so it seals to the walls) and the upper ones rounded onto the footprint's inscribed ellipse. Rows share
 * vertices, so the runtime's computeVertexNormals gives a smooth surface. uv = (metres along the base perimeter,
 * metres up the meridian). Winding matches addWalls (outer ring negative -> normals outward and up).
 */
export function addDome(gb: GeomBuilder, ring: Ring, y0: number, rise: number, kind: 'dome' | 'onion', rect: MinRect, ox: number, oz: number, meta: Meta, tint: Tint, nLat: number, maxEdge: number, flag: SurfaceFlag = SurfaceFlag.RoofCurved) {
  const base = resampleRing(orient(ring, false), maxEdge);
  const N = base.length;
  if (N < 3) return;
  const c = centroid(base);
  const uAt: number[] = [0];
  for (let i = 1; i <= N; i++) uAt.push(uAt[i - 1] + Math.hypot(base[i % N][0] - base[i - 1][0], base[i % N][1] - base[i - 1][1]));
  const profile = kind === 'onion'
    ? (t: number): [number, number] => [Math.cos(t * Math.PI / 2) * (1 + 0.45 * Math.sin(Math.PI * t)), Math.pow(t, 0.9)]
    : (t: number): [number, number] => [Math.cos(t * Math.PI / 2), Math.sin(t * Math.PI / 2)];
  const R0 = Math.max(1, Math.min(rect.w, rect.h) / 2);
  const col: [number, number, number, number] = [tint[0], tint[1], tint[2], flag];
  const rows: number[][] = [];
  let arc = 0, pr = 1, ph = 0;
  for (let k = 0; k < nLat; k++) {
    const t = k / nLat;
    const [r, h] = profile(t);
    if (k > 0) arc += Math.hypot((r - pr) * R0, (h - ph) * rise);
    pr = r; ph = h;
    const s = Math.min(1, t * 3);   // how round this parallel is (the base is the footprint, a third of the way up it is an ellipse)
    const row: number[] = [];
    for (let i = 0; i <= N; i++) {
      const p = base[i % N], e = ellipsePoint(rect, p);
      const qx = c[0] + ((p[0] - c[0]) * (1 - s) + (e[0] - c[0]) * s) * r;
      const qz = c[1] + ((p[1] - c[1]) * (1 - s) + (e[1] - c[1]) * s) * r;
      row.push(gb.vertex(qx - ox, y0 + rise * h, qz - oz, uAt[i], arc, meta, col));
    }
    rows.push(row);
  }
  const [rl, hl] = profile((nLat - 1) / nLat);
  const apexArc = arc + Math.hypot(rl * R0, (1 - hl) * rise);
  const apex = gb.vertex(c[0] - ox, y0 + rise, c[1] - oz, uAt[N] / 2, apexArc, meta, col);
  for (let k = 0; k + 1 < nLat; k++) for (let i = 0; i < N; i++) gb.quad(rows[k][i], rows[k][i + 1], rows[k + 1][i + 1], rows[k + 1][i]);
  const top = rows[nLat - 1];
  for (let i = 0; i < N; i++) gb.tri(top[i], top[i + 1], apex);
}

/** Cone / pyramid: a fan from the (resampled) ring to the apex. */
function addCone(gb: GeomBuilder, ring: Ring, y0: number, rise: number, ox: number, oz: number, meta: Meta, tint: Tint, maxEdge: number, flag: SurfaceFlag) {
  const base = maxEdge > 0 ? resampleRing(orient(ring, false), maxEdge) : orient(ring, false);
  const c = centroid(base);
  const n = base.length;
  const col: [number, number, number, number] = [tint[0], tint[1], tint[2], flag];
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = base[i], b = base[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const slope = Math.hypot(rise, Math.hypot(c[0] - a[0], c[1] - a[1]));
    const i0 = gb.vertex(a[0] - ox, y0, a[1] - oz, u, 0, meta, col);
    const i1 = gb.vertex(b[0] - ox, y0, b[1] - oz, u + len, 0, meta, col);
    const i2 = gb.vertex(c[0] - ox, y0 + rise, c[1] - oz, u + len / 2, slope, meta, col);
    gb.tri(i0, i1, i2);
    u += len;
  }
}

// ------------------------------------------------------------------------------------------------ profile roofs (ridge / barrel / skillion)

interface ProfileFrame { axis: Pt; perp: Pt; centre: Pt; half: number }

/** Ridge axis and cross direction of a gabled / round / skillion roof from roof:direction, roof:orientation or the min-area rect. */
export function profileFrame(b: BuildingSpec, kind: RoofKind): ProfileFrame {
  const rect = b.rect;
  const longDir: Pt = rect.w >= rect.h ? [Math.cos(rect.angle), Math.sin(rect.angle)] : [-Math.sin(rect.angle), Math.cos(rect.angle)];
  const shortDir: Pt = [-longDir[1], longDir[0]];
  let axis: Pt, perp: Pt;
  if (b.roofDir != null) {
    const d = bearingToDir(b.roofDir);
    perp = [d.x, d.z]; axis = [-perp[1], perp[0]];
  } else if (b.roofOrient === 'across') { axis = shortDir; perp = longDir; }
  else { axis = longDir; perp = shortDir; }
  const centre: Pt = [rect.cx, rect.cz];
  let half = 0.5;
  for (const p of b.rings[0]) half = Math.max(half, Math.abs((p[0] - centre[0]) * perp[0] + (p[1] - centre[1]) * perp[1]));
  return { axis, perp, centre, half };
}

/** Relative height (0 at the eave, 1 at the ridge) across the profile for cross parameter t in [-half, half]. */
export function profileHeight(kind: RoofKind, t: number, half: number): number {
  const x = Math.max(-1, Math.min(1, t / half));
  if (kind === 'round') return Math.sqrt(Math.max(0, 1 - x * x));
  if (kind === 'skillion') return (1 - x) / 2;
  return 1 - Math.abs(x);
}

/** Barrel vaults and directed gables / skillions: the cap is cut into cross bands and each vertex lifted by the profile. */
function addProfileRoof(cb: ChunkBuilders, b: BuildingSpec, kind: RoofKind, yEave: number, rise: number, ox: number, oz: number, meta: Meta, tint: Tint, flag: SurfaceFlag) {
  const { axis, perp, centre, half } = profileFrame(b, kind);
  const tOf = (p: Pt) => (p[0] - centre[0]) * perp[0] + (p[1] - centre[1]) * perp[1];
  const sOf = (p: Pt) => (p[0] - centre[0]) * axis[0] + (p[1] - centre[1]) * axis[1];
  const yOf = (p: Pt) => yEave + rise * profileHeight(kind, tOf(p), half);
  const slopeLen = Math.hypot(half, rise);
  const vOf = (p: Pt) => {
    const t = tOf(p);
    if (kind === 'round') return half * Math.acos(Math.max(-1, Math.min(1, Math.abs(t) / half)));
    if (kind === 'skillion') return (half - t) / (2 * half) * Math.hypot(2 * half, rise);
    return (half - Math.abs(t)) / half * slopeLen;
  };
  const cuts: number[] = kind === 'round' ? Array.from({ length: 9 }, (_, i) => -half + (i + 1) * (2 * half / 10)) : kind === 'gabled' ? [0] : [];
  let L = 0;
  for (const p of b.rings[0]) L = Math.max(L, Math.abs(sOf(p)));
  L += 5;
  const edges = [-Infinity, ...cuts, Infinity];
  const col: [number, number, number, number] = [tint[0], tint[1], tint[2], flag];
  for (let k = 0; k + 1 < edges.length; k++) {
    const lo = Number.isFinite(edges[k]) ? edges[k] : -half - 5, hi = Number.isFinite(edges[k + 1]) ? edges[k + 1] : half + 5;
    const pieces = cuts.length ? clipToBand(b.rings.length ? [b.rings] : [], centre, axis, perp, lo, hi, L) : [b.rings];
    for (const piece of pieces) {
      if (!piece.length || piece[0].length < 3) continue;
      const rings: Poly = [orient(piece[0], false), ...piece.slice(1).map(r => orient(r, true))];
      const { flat, tris } = triangulateCap(rings);
      const base = cb.roofs.vertexCount;
      for (let i = 0; i < flat.length; i += 2) {
        const p: Pt = [flat[i], flat[i + 1]];
        cb.roofs.vertex(p[0] - ox, yOf(p), p[1] - oz, sOf(p), vOf(p), meta, col);
      }
      for (let t = 0; t < tris.length; t += 3) cb.roofs.tri(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
    }
  }
  // where the walls must be split so their tops follow the profile: at the ridge (gable) or every ~half/4 (barrel)
  const splitAt = (a: Pt, bb: Pt): number[] => {
    const ta = tOf(a), tb = tOf(bb);
    if (kind === 'gabled') return ta * tb < 0 ? [ta / (ta - tb)] : [];
    if (kind === 'round') { const n = Math.min(8, Math.ceil(Math.abs(tb - ta) / (half / 4))); return Array.from({ length: n - 1 }, (_, i) => (i + 1) / n); }
    return [];
  };
  return { yOf, splitAt };
}

// ------------------------------------------------------------------------------------------------ building

export function extrudeBuilding(b: BuildingSpec, cb: ChunkBuilders, ox: number, oz: number, dsm?: DsmHook, dsmCovers?: DsmCovers, dsmParts?: DsmParts): { dsmTris?: [number, number] } {
  if (dsm && b.landmark && cb.dsm && cb.roofsAlt && cb.topsAlt) {
    const rmeta: Meta = [b.floorH, b.levels, b.roofMatId, packStyleSeed(b.style, b.seed)];
    // Only the group's outline gets a surface-model cap. Every `building:part` of a landmark shares one DSM window,
    // so capping each of them re-sampled the SAME roof once per part: the Grand Palais came out as nine coincident
    // caps 9 cm apart and the Invalides dome as thirty-nine, which z-fought into grey and dark shards. The parts
    // still need their walls, so they are extruded normally but their roof goes to the ?dsm=0 fallback sections,
    // where it cannot fight the cap that already covers them.
    // Every `building:part` of a capped group takes the ordinary analytic path. Only the group's outline gets a
    // surface-model cap: the parts all share one DSM window, so capping each of them re-sampled the same roof once
    // per part — 20 coincident caps over the Invalides dome, 4 over the Grand Palais nave, z-fighting into shards.
    if (b.group !== undefined && b.group !== b.id && dsmCovers?.(b)) {
      // A part of a capped group carries the facade, so it is the part — not the outline, which its own parts have
      // squashed to a plinth — that has to reach the cap. Its walls follow the same LiDAR surface the cap is built
      // from, because OSM's part heights are guesses: at the Maison de la Radio the crown arcs stop 7 m under the
      // measured roof, opening a slot right round the 500 m facade, while Studio 101 and Studio 106 stand 13 m
      // above it — the chimneys on the roof of a building that has none. The analytic roof then goes to the
      // ?dsm=0 sections, moved to sit on the fitted wall so it does not float there either.
      const tops = dsmParts?.(b);
      if (tops) {
        const y0 = b.minH > 0 ? b.groundY + b.minH : (b.floating ? b.groundY : b.groundY - 1.0);
        const meta: Meta = [b.floorH, b.levels, 0, packStyleSeed(b.style, b.seed)];
        for (const r of b.rings) addWallsProfile(cb.walls, r, y0, b.groundY, tops, followSurface, ox, oz, meta, b.tint, b.isPlinth ? SurfaceFlag.Plinth : SurfaceFlag.Wall);
        const ys = b.rings.flat().map(tops).sort((p, q) => p - q);
        const eave = Math.max(b.minH + 0.5, ys[ys.length >> 1] - b.groundY);
        extrudeAnalytic({ ...b, eave, ridge: eave + Math.max(0, b.ridge - b.eave) }, { walls: new GeomBuilder(), roofs: cb.roofsAlt, tops: cb.topsAlt, lod: cb.lod }, ox, oz);
        return {};
      }
      // No usable surface over this part (an arcade, a court, a wing under a dome): the analytic roof stands, and
      // it goes to the main sections or a part raised on `min_height` — the Quai Branly dome starts at 27.5 m —
      // is left as a bare wall ring hanging in the air.
      extrudeAnalytic(b, cb, ox, oz);
      return {};
    }
    const res = dsm(cb.dsm, b, ox, oz, rmeta, b.roofTint);
    if (res) {
      // walls follow the surface model's edge, LOD1 stays the analytic box, the analytic roof goes to the alt sections
      const yBase = b.floating ? b.groundY : b.groundY - 1.0;   // the 1 m skirt hides terrain gaps on land; on water it just drowns the hull
      const y0 = b.minH > 0 ? b.groundY + b.minH : yBase;
      const meta: Meta = [b.floorH, b.levels, 0, packStyleSeed(b.style, b.seed)];
      const wallFlag = b.isPlinth ? SurfaceFlag.Plinth : SurfaceFlag.Wall;
      for (const r of b.rings) addWallsProfile(cb.walls, r, y0, b.groundY, res.wallTop, followSurface, ox, oz, meta, b.tint, wallFlag);
      const scratch: ChunkBuilders = { walls: new GeomBuilder(), roofs: cb.roofsAlt, tops: cb.topsAlt, lod: cb.lod };
      extrudeBuilding(b, scratch, ox, oz);
      return { dsmTris: [res.trisBefore, res.trisAfter] };
    }
  }
  extrudeAnalytic(b, cb, ox, oz);
  return {};
}

function extrudeAnalytic(b: BuildingSpec, cb: ChunkBuilders, ox: number, oz: number) {
  const outer = b.rings[0], holes = b.rings.slice(1);
  const yBase = b.floating ? b.groundY : b.groundY - 1.0;   // the 1 m skirt hides terrain gaps on land; on water it just drowns the hull
  const y0 = b.minH > 0 ? b.groundY + b.minH : yBase;
  const yEave = b.groundY + b.eave;
  const yRidge = b.groundY + b.ridge;
  const rise = yRidge - yEave;
  const meta: Meta = [b.floorH, b.levels, 0, packStyleSeed(b.style, b.seed)];
  const rmeta: Meta = [b.floorH, b.levels, b.roofMatId, packStyleSeed(b.style, b.seed)];
  const wallFlag = b.isPlinth ? SurfaceFlag.Plinth : SurfaceFlag.Wall;
  const roofTint = b.roofTint;
  const [bx0, bz0, bx1, bz1] = [Math.min(...outer.map(p => p[0])), Math.min(...outer.map(p => p[1])), Math.max(...outer.map(p => p[0])), Math.max(...outer.map(p => p[1]))];
  const insideTile = bx0 >= ox - ORTHO_MARGIN && bz0 >= oz - ORTHO_MARGIN && bx1 <= ox + CHUNK_SIZE + ORTHO_MARGIN && bz1 <= oz + CHUNK_SIZE + ORTHO_MARGIN;
  const topFlag = insideTile ? SurfaceFlag.RoofTop : SurfaceFlag.RoofTopOverview;
  const curved = CURVED_ROOFS.has(b.roof) && !holes.length;
  const profile = (b.roof === 'round' || b.roof === 'skillion' || (b.roof === 'gabled' && (b.roofDir != null || b.roofOrient != null))) && rise > 0.5;
  const maxEdge = Math.max(1.5, perimeter(outer) / 48);

  if (profile) {
    // Barrel vault / directed gable / skillion: roof first (it defines the wall tops), then walls up to the profile.
    const { yOf, splitAt } = addProfileRoof(cb, b, b.roof, yEave, rise, ox, oz, rmeta, roofTint, b.roof === 'round' ? SurfaceFlag.RoofCurved : SurfaceFlag.RoofSlope);
    for (const r of b.rings) addWallsProfile(cb.walls, r, y0, b.groundY, yOf, splitAt, ox, oz, meta, b.tint, wallFlag);
    for (const r of b.rings) addWalls(cb.lod, r, y0, yEave + rise * 0.5, b.groundY, ox, oz, meta, b.tint, wallFlag);
    addCap(cb.lod, b.rings, yEave + rise * 0.5, ox, oz, rmeta, roofTint, SurfaceFlag.RoofTop);
    return;
  }

  // Walls (outer + courtyards).
  for (const r of b.rings) addWalls(cb.walls, r, y0, yEave, b.groundY, ox, oz, meta, b.tint, wallFlag);

  if (curved) {
    const nLat = Math.max(5, Math.min(14, Math.round(rise / 1.2)));
    if (b.roof === 'cone') addCone(cb.roofs, outer, yEave, rise, ox, oz, rmeta, roofTint, maxEdge, SurfaceFlag.RoofCurved);
    else addDome(cb.roofs, outer, yEave, rise, b.roof as 'dome' | 'onion', b.rect, ox, oz, rmeta, roofTint, nLat, maxEdge);
    // LOD1: walls to the eave plus a coarse dome (a 100 m spire must not become a 100 m cylinder)
    for (const r of b.rings) addWalls(cb.lod, r, y0, yEave, b.groundY, ox, oz, meta, b.tint, wallFlag);
    if (b.roof === 'cone') addCone(cb.lod, outer, yEave, rise, ox, oz, rmeta, roofTint, 0, SurfaceFlag.RoofCurved);
    else addDome(cb.lod, outer, yEave, rise, b.roof as 'dome' | 'onion', b.rect, ox, oz, rmeta, roofTint, 3, maxEdge * 3);
    return;
  }

  // LOD1: walls + flat cap at ridge (no roof detail).
  for (const r of b.rings) addWalls(cb.lod, r, y0, yRidge, b.groundY, ox, oz, meta, b.tint, wallFlag);
  addCap(cb.lod, b.rings, yRidge, ox, oz, rmeta, roofTint, SurfaceFlag.RoofTop);

  let roofDone = false;
  const halfWidth = (2 * area(outer)) / Math.max(1e-6, perimeter(outer));
  if (b.roof === 'mansard' || b.roof === 'hipped' || b.roof === 'gabled') {
    const delta = yRidge - yEave;
    const d1 = b.roof === 'mansard' ? MANSARD.inset1 : Math.min(halfWidth - 0.4, 6);
    const r1 = erodeRing(outer, d1, 0.3);
    if (r1 && holesInside(r1, holes)) {
      if (b.roof === 'mansard') {
        const rise1 = Math.min(MANSARD.rise1Max, 0.7 * delta);
        addSlopeBand(cb.roofs, outer, r1, yEave, yEave + rise1, ox, oz, rmeta, roofTint);
        if (cb.details) placeRoofDetails({ outer, inner: r1, yEave, yBreak: yEave + rise1, insetD: d1, seed: b.seed, style: b.style }, cb.details);
        const d2 = Math.min(halfWidth - 0.6, MANSARD.inset2Max);
        const r2 = d2 > d1 + 0.3 ? erodeRing(outer, d2, 0.15) : null;
        if (r2 && holesInside(r2, holes)) {
          addSlopeBand(cb.roofs, r1, r2, yEave + rise1, yRidge, ox, oz, rmeta, roofTint);
          addCap(cb.tops, [r2, ...holes], yRidge, ox, oz, rmeta, roofTint, topFlag);
        } else {
          addCap(cb.tops, [r1, ...holes], yEave + rise1, ox, oz, rmeta, roofTint, topFlag);
        }
      } else {
        addSlopeBand(cb.roofs, outer, r1, yEave, yRidge, ox, oz, rmeta, roofTint);
        addCap(cb.tops, [r1, ...holes], yRidge, ox, oz, rmeta, roofTint, topFlag);
      }
      // Courtyard sides stay vertical up to the ridge so the roof reads closed from the inside.
      for (const h of holes) addWalls(cb.walls, h, yEave, yRidge, b.groundY, ox, oz, meta, b.tint, wallFlag);
      roofDone = true;
    }
  } else if (b.roof === 'pyramidal' && !holes.length) {
    addCone(cb.roofs, outer, yEave, rise, ox, oz, rmeta, roofTint, 0, SurfaceFlag.RoofSlope);
    roofDone = true;
  }
  if (!roofDone) {
    addCap(cb.tops, b.rings, yEave, ox, oz, rmeta, roofTint, topFlag);
  }
  void signedArea; void addSlope; void distToRing;
}
