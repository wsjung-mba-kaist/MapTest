import earcut from 'earcut';
import { SurfaceFlag, ORTHO_MARGIN, CHUNK_SIZE } from '../../shared/layout.ts';
import type { GeomBuilder } from './binmesh.ts';
import type { BuildingSpec } from './buildings.ts';
import { area, distToRing, erodeRing, orient, perimeter, pointInRing, signedArea, type Poly, type Ring } from './polygons.ts';
import { placeRoofDetails } from './roofdetails.ts';

export interface ChunkBuilders { walls: GeomBuilder; roofs: GeomBuilder; tops: GeomBuilder; lod: GeomBuilder; details?: number[] }

const MANSARD = { inset1: 1.3, rise1Max: 4.0, inset2Max: 4.0 };

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

function addCap(gb: GeomBuilder, rings: Poly, y: number, ox: number, oz: number, meta: [number, number, number, number], tint: [number, number, number], flag: SurfaceFlag) {
  const { flat, tris } = triangulateCap(rings);
  const base = gb.vertexCount;
  for (let i = 0; i < flat.length; i += 2) gb.vertex(flat[i] - ox, y, flat[i + 1] - oz, flat[i], flat[i + 1], meta, [tint[0], tint[1], tint[2], flag]);
  for (let t = 0; t < tris.length; t += 3) gb.tri(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
}

/** Wall quads for a ring between y0 and y1. u = metres along the ring, v = metres above groundY. */
function addWalls(gb: GeomBuilder, ring: Ring, y0: number, y1: number, groundY: number, ox: number, oz: number, meta: [number, number, number, number], tint: [number, number, number], flag: SurfaceFlag) {
  const n = ring.length;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const m: [number, number, number, number] = [meta[0], meta[1], len, meta[3]];
    const c: [number, number, number, number] = [tint[0], tint[1], tint[2], flag];
    const i0 = gb.vertex(a[0] - ox, y0, a[1] - oz, u, y0 - groundY, m, c);
    const i1 = gb.vertex(b[0] - ox, y0, b[1] - oz, u + len, y0 - groundY, m, c);
    const i2 = gb.vertex(b[0] - ox, y1, b[1] - oz, u + len, y1 - groundY, m, c);
    const i3 = gb.vertex(a[0] - ox, y1, a[1] - oz, u, y1 - groundY, m, c);
    gb.quad(i0, i1, i2, i3);
    u += len;
  }
}

/** Sloped quads between ring r0 at y0 and the vertex-corresponding ring r1 at y1. */
function addSlope(gb: GeomBuilder, r0: Ring, r1: Ring, y0: number, y1: number, ox: number, oz: number, meta: [number, number, number, number], tint: [number, number, number]) {
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
function addSlopeBand(gb: GeomBuilder, outer: Ring, inner: Ring, y0: number, y1: number, ox: number, oz: number, meta: [number, number, number, number], tint: [number, number, number]) {
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

export function extrudeBuilding(b: BuildingSpec, cb: ChunkBuilders, ox: number, oz: number) {
  const outer = b.rings[0], holes = b.rings.slice(1);
  const yBase = b.groundY - 1.0;
  const y0 = b.minH > 0 ? b.groundY + b.minH : yBase;
  const yEave = b.groundY + b.eave;
  const yRidge = b.groundY + b.ridge;
  const meta: [number, number, number, number] = [b.floorH, b.levels, 0, b.seed + b.style * 256];
  const wallFlag = b.isPlinth ? SurfaceFlag.Plinth : SurfaceFlag.Wall;
  // The roof tint doubles as the material id for the slope shader: zinc grey, slate blue-grey (b > r, dark), tile terracotta (r >> b).
  const roofTint: [number, number, number] = b.roofMat === 'slate' ? [74, 80, 92] : b.roofMat === 'tile' ? [168, 104, 78]
    : b.style === 1 ? [120, 125, 130] : [128, 134, 140];
  const [bx0, bz0, bx1, bz1] = [Math.min(...outer.map(p => p[0])), Math.min(...outer.map(p => p[1])), Math.max(...outer.map(p => p[0])), Math.max(...outer.map(p => p[1]))];
  const insideTile = bx0 >= ox - ORTHO_MARGIN && bz0 >= oz - ORTHO_MARGIN && bx1 <= ox + CHUNK_SIZE + ORTHO_MARGIN && bz1 <= oz + CHUNK_SIZE + ORTHO_MARGIN;
  const topFlag = insideTile ? SurfaceFlag.RoofTop : SurfaceFlag.RoofTopOverview;

  // Walls (outer + courtyards).
  for (const r of b.rings) addWalls(cb.walls, r, y0, yEave, b.groundY, ox, oz, meta, b.tint, wallFlag);

  // LOD1: walls + flat cap at ridge (no roof detail).
  for (const r of b.rings) addWalls(cb.lod, r, y0, yRidge, b.groundY, ox, oz, meta, b.tint, wallFlag);
  addCap(cb.lod, b.rings, yRidge, ox, oz, meta, roofTint, SurfaceFlag.RoofTop);

  let roofDone = false;
  const halfWidth = (2 * area(outer)) / Math.max(1e-6, perimeter(outer));
  if (b.roof === 'mansard' || b.roof === 'hipped' || b.roof === 'gabled') {
    const delta = yRidge - yEave;
    const d1 = b.roof === 'mansard' ? MANSARD.inset1 : Math.min(halfWidth - 0.4, 6);
    const r1 = erodeRing(outer, d1, 0.3);
    if (r1 && holesInside(r1, holes)) {
      if (b.roof === 'mansard') {
        const rise1 = Math.min(MANSARD.rise1Max, 0.7 * delta);
        addSlopeBand(cb.roofs, outer, r1, yEave, yEave + rise1, ox, oz, meta, roofTint);
        if (cb.details) placeRoofDetails({ outer, inner: r1, yEave, yBreak: yEave + rise1, insetD: d1, seed: b.seed, style: b.style }, cb.details);
        const d2 = Math.min(halfWidth - 0.6, MANSARD.inset2Max);
        const r2 = d2 > d1 + 0.3 ? erodeRing(outer, d2, 0.15) : null;
        if (r2 && holesInside(r2, holes)) {
          addSlopeBand(cb.roofs, r1, r2, yEave + rise1, yRidge, ox, oz, meta, roofTint);
          addCap(cb.tops, [r2, ...holes], yRidge, ox, oz, meta, roofTint, topFlag);
        } else {
          addCap(cb.tops, [r1, ...holes], yEave + rise1, ox, oz, meta, roofTint, topFlag);
        }
      } else {
        addSlopeBand(cb.roofs, outer, r1, yEave, yRidge, ox, oz, meta, roofTint);
        addCap(cb.tops, [r1, ...holes], yRidge, ox, oz, meta, roofTint, topFlag);
      }
      // Courtyard sides stay vertical up to the ridge so the roof reads closed from the inside.
      for (const h of holes) addWalls(cb.walls, h, yEave, yRidge, b.groundY, ox, oz, meta, b.tint, wallFlag);
      roofDone = true;
    }
  } else if (b.roof === 'pyramidal' && !holes.length) {
    const c = outer.reduce((s, p) => [s[0] + p[0] / outer.length, s[1] + p[1] / outer.length], [0, 0]);
    const n = outer.length;
    for (let i = 0; i < n; i++) {
      const a = outer[i], bb = outer[(i + 1) % n];
      const col: [number, number, number, number] = [roofTint[0], roofTint[1], roofTint[2], SurfaceFlag.RoofSlope];
      const i0 = cb.roofs.vertex(a[0] - ox, yEave, a[1] - oz, 0, 0, meta, col);
      const i1 = cb.roofs.vertex(bb[0] - ox, yEave, bb[1] - oz, Math.hypot(bb[0] - a[0], bb[1] - a[1]), 0, meta, col);
      const i2 = cb.roofs.vertex(c[0] - ox, yRidge, c[1] - oz, 0, yRidge - yEave, meta, col);
      cb.roofs.tri(i0, i1, i2);
    }
    roofDone = true;
  }
  if (!roofDone) {
    addCap(cb.tops, b.rings, yEave, ox, oz, meta, roofTint, topFlag);
  }
  void signedArea; void addSlope; void distToRing;
}
