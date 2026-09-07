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
import { area, cleanRing, insetRing, orient, pointInPoly, unionAll, type Poly, type Pt, type Ring } from './polygons.ts';

const DECK_THICK = 2.2;
const PARAPET_H = 1.05;
const PARAPET_T = 0.45;
const STONE: [number, number, number] = [196, 188, 172];
const STEEL: [number, number, number] = [74, 84, 76];   // the line 6 viaduct's dark green ironwork
const VIADUCT_RISE = 8.5;      // rail deck above the road deck / ground (Bir-Hakeim: ~9 m)
const VIADUCT_THICK = 1.4;
const ARCH_MAX_H = 6.5;
const ROAD: [number, number, number] = [110, 108, 104];

export interface Bridge { id: string; poly: Poly; deckTop: number; name: string; rail: boolean; columnsTo?: number }
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
  const w = ax.width / 2 - 0.05;
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
        const x = ax.cx + ax.dx * t + nx * w, z = ax.cz + ax.dz * t + nz * w;
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
function addViaduct(deck: GeomBuilder, stone: GeomBuilder, parapet: GeomBuilder, b: Bridge) {
  const top = b.deckTop, bottom = top - VIADUCT_THICK, base = b.columnsTo!;
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
  const n = Math.max(1, Math.floor(ax.half * 2 / 7));
  for (let k = 0; k < n; k++) {
    const t = -ax.half + 3.5 + (ax.half * 2 - 7) * (n > 1 ? k / (n - 1) : 0.5);
    for (const side of [-1, 1]) {
      const cx = ax.cx + ax.dx * t - ax.dz * side * 3.0, cz = ax.cz + ax.dz * t + ax.dx * side * 3.0;
      const ring: Ring = orient([[cx - 0.28, cz - 0.28], [cx + 0.28, cz - 0.28], [cx + 0.28, cz + 0.28], [cx - 0.28, cz + 0.28]], false);
      addWalls(stone, ring, base + 0.05, bottom + 0.05, SurfaceFlag.Plinth, STEEL);
    }
  }
}

/** Principal axis of a ring via covariance (unit direction, centre, half-length along the axis). */
function principalAxis(ring: Ring): { cx: number; cz: number; dx: number; dz: number; half: number; width: number } {
  let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= ring.length; cz /= ring.length;
  let sxx = 0, sxz = 0, szz = 0; for (const p of ring) { const x = p[0] - cx, z = p[1] - cz; sxx += x * x; sxz += x * z; szz += z * z; }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const dx = Math.cos(ang), dz = Math.sin(ang);
  let lo = Infinity, hi = -Infinity, wlo = Infinity, whi = -Infinity;
  for (const p of ring) { const t = (p[0] - cx) * dx + (p[1] - cz) * dz; const w = -(p[0] - cx) * dz + (p[1] - cz) * dx; lo = Math.min(lo, t); hi = Math.max(hi, t); wlo = Math.min(wlo, w); whi = Math.max(whi, w); }
  return { cx, cz, dx, dz, half: (hi - lo) / 2, width: whi - wlo };
}

/** Pier boxes of a deck along its principal axis (30 m spacing, only where the ground is under water). */
function pierBoxes(b: Bridge, hm: Heightmap, waterLevelY: number, flowAt?: FlowField): PierBox[] {
  const ax = principalAxis(b.poly[0]);
  const pierW = Math.max(3, Math.min(ax.width * 0.8, 40)), pierL = 4.5, spacing = 30;
  const n = Math.max(0, Math.floor((ax.half * 2 - 20) / spacing));
  const out: PierBox[] = [];
  for (let k = 0; k < n; k++) {
    const t = -ax.half + 10 + spacing * (k + 0.5) + (spacing * (n) < ax.half * 2 - 20 ? (ax.half * 2 - 20 - spacing * n) / 2 : 0);
    const px = ax.cx + ax.dx * t, pz = ax.cz + ax.dz * t;
    if (hm.sample(px, pz) > waterLevelY + 1.5) continue; // pier on land is a wall, skip
    // Real piers are streamlined along the current; without a flow field fall back to the deck's perpendicular.
    const flow = flowAt?.(px, pz);
    const [fx, fz] = flow ?? [-ax.dz, ax.dx];
    const halfW = Math.min(pierW / 2, flow ? 14 : pierW / 2);
    out.push({ cx: px, cz: pz, dx: -fz, dz: fx, halfL: pierL / 2, halfW, name: b.name });
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
    const pts: Pt[] = (f.geometry as LineString).coordinates.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; });
    if (pts.every(p => Math.abs(p[0]) > WORLD_HALF + 100 || Math.abs(p[1]) > WORLD_HALF + 100)) continue;
    lines.push({ pts, tags: t, id: `${f.properties.type}/${f.properties.id}` });
  }

  const deckLevel = (ring: Ring): number => {
    const ys = ring.map(p => hm.sample(p[0], p[1])).filter(y => y > waterLevelY + 1.0).sort((a, b) => a - b);
    if (!ys.length) return waterLevelY + 8;
    const top = ys.slice(Math.floor(ys.length * 0.5));
    return top.reduce((s, v) => s + v, 0) / top.length + 0.15;
  };

  for (const o of outlines) {
    const rail = /rail|subway|viaduc|métro|metro/i.test(o.tags.name ?? '') || !!o.tags.railway;
    bridges.push({ id: o.id, poly: o.poly, deckTop: deckLevel(o.poly[0]), name: o.tags.name ?? o.id, rail });
  }
  // elevated métro: every railway bridge line rides VIADUCT_RISE above the road deck (inside an outline) or the ground,
  // on steel columns; the road outline below keeps its own deck
  for (const l of lines) {
    if (!l.tags.railway) continue;
    const mid = l.pts[Math.floor(l.pts.length / 2)];
    const over = outlines.find(o => pointInPoly(mid[0], mid[1], o.poly));
    for (const poly of bufferLine(l.pts, roadWidth(l.tags))) {
      const base = over ? bridges.find(b => b.id === over.id)?.deckTop ?? deckLevel(poly[0]) : deckLevel(poly[0]);
      bridges.push({ id: l.id, poly, deckTop: base + VIADUCT_RISE, name: l.tags.name ?? l.id, rail: true, columnsTo: base });
    }
  }
  // Lines not covered by an outline become simple decks (skip tiny spans, e.g. over a ditch).
  let fromLines = 0;
  for (const l of lines) {
    if (l.tags.railway) continue;   // handled above
    const mid = l.pts[Math.floor(l.pts.length / 2)];
    if (outlines.some(o => pointInPoly(mid[0], mid[1], o.poly))) continue;
    const len = l.pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - l.pts[i - 1][0], p[1] - l.pts[i - 1][1]) : 0, 0);
    if (len < 12) continue;
    const polys = bufferLine(l.pts, roadWidth(l.tags));
    for (const poly of polys) { bridges.push({ id: l.id, poly, deckTop: deckLevel(poly[0]), name: l.tags.name ?? l.id, rail: !!l.tags.railway }); fromLines++; }
  }
  const piers: PierBox[] = [];
  for (const b of bridges) if (b.columnsTo === undefined) piers.push(...pierBoxes(b, hm, waterLevelY, flowAt));
  return { bridges, piers, outlines: outlines.length, fromLines };
}

export async function buildBridges(roads: FeatureCollection<Geometry, OsmProps>, hm: Heightmap, waterLevelY: number, flowAt?: FlowField): Promise<{ count: number; bytes: number; names: string[] }> {
  const { bridges, outlines, fromLines } = collectBridges(roads, hm, waterLevelY, flowAt);
  const deck = new GeomBuilder(), stone = new GeomBuilder(), parapet = new GeomBuilder();
  for (const b of bridges) {
    const outer = b.poly[0];
    if (b.columnsTo !== undefined) { addViaduct(deck, stone, parapet, b); continue; }
    const top = b.deckTop, bottom = top - DECK_THICK;
    // Deck top samples the overview ortho (flag 4), underside and sides are stone.
    addCapAt(deck, b.poly, top, SurfaceFlag.RoofTopOverview, ROAD, true);
    addCapAt(stone, b.poly, bottom, SurfaceFlag.Plinth, STONE, false);
    for (const r of b.poly) addWalls(stone, r, bottom, top, SurfaceFlag.Plinth, STONE);
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
