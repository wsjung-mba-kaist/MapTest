import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import earcut from 'earcut';
import type { FeatureCollection, Geometry, LineString, MultiPolygon, Polygon } from 'geojson';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { OUT_DIR } from '../config.ts';
import { ensureDir, readJson, writeJson } from './http.ts';
import { loadTheme, type OsmProps } from './overpass.ts';
import { carriagewayWidth, classify } from './roadnet.ts';
import { collectBridges } from './bridges.ts';
import { makeFlowField, riverArms } from './river.ts';
import { encodeBinMesh, type SectionInput } from './binmesh.ts';
import { loadHeightmap } from './build.ts';
import { frame } from '../../shared/geo.ts';
import { CHUNK_SIZE, GRID_N, KERB_H, SURFACE_N, SURFACE_STEP, StreetFlag, SurfaceClass, WORLD_HALF, chunkKey, chunkOrigin } from '../../shared/layout.ts';
import type { Heightmap } from '../../shared/heightmap.ts';
import { area, bboxOf, distToRing, pointInPoly, type Poly, type Pt, type Ring } from './polygons.ts';
import { differencePolys, intersectPolys, offsetLine, offsetPolys } from './clip.ts';

/**
 * Sidewalk slabs: paved footprint (synthetic bands beside carriageways, mapped footway=sidewalk ways, pedestrian
 * areas) minus carriageways, bridge decks, water, rail and park interiors, per chunk. Each slab is triangulated on the
 * rendered terrain (meshY) and lifted by KERB_H, with a kerb skirt along its boundary. Output streets/{i}_{j}.bin
 * (PBM1 section "slab": position, uv, uvOv, sflag u8) plus the 2 m surface class grid surface.bin.
 */

export const SIDEWALK_W = 3.0;      // synthetic sidewalk width beside a carriageway
// a mapped footway=sidewalk runs along the sidewalk centre; a wide band around it reaches the kerb (the carriageway is
// subtracted anyway) and the building-side spill hides inside the buildings
const MAPPED_SIDEWALK_W = 8.0;
const PAD = 10;                     // metres of neighbouring geometry considered around a chunk
const MIN_AREA = 4;                 // m² - smaller slivers are dropped
const STEINER = 4;                  // m grid of interior points so wide slabs follow the terrain
const SKIRT = 0.12;                 // kerb face extends this far below the terrain
const WALL_PROBE = 1.6;             // m outside the edge where the drop is measured
const WALL_MIN = 0.8;               // a drop bigger than this is a retaining wall, not a kerb
const WALL_MAX = 12;                // m: the deepest real one here is the Trocadero parvis at 11.4 m
const STEEP_TOP = 0.34;             // min |normal.y| of a slab top: steeper than ~70 deg is a wall, not paving

export interface StreetInput { carriage: Poly[]; paved: Poly[]; blocked: Poly[]; grass: Poly[]; steps: StepsWay[] }
export interface StepsWay { pts: Pt[]; width: number }
const RISER = 0.165;               // m, Paris outdoor stairs
const TREAD_MIN = 0.26;

const toPts = (coords: number[][]): Pt[] => coords.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z] as Pt; });
const polysOf = (g: Polygon | MultiPolygon): Poly[] => g.type === 'Polygon' ? [g.coordinates.map(toPts)] : g.coordinates.map(p => p.map(toPts));
const r2 = (p: Pt): Pt => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
const roundPoly = (p: Poly): Poly => p.map(r => r.map(r2));

/** Collect the world polygons the slabs are computed from. */
export function collectStreetPolys(roads: FeatureCollection<Geometry, OsmProps>, land: FeatureCollection<Geometry, OsmProps>, water: FeatureCollection<Geometry, OsmProps>, decks: Poly[]): StreetInput {
  const carriage: Poly[] = [], paved: Poly[] = [], blocked: Poly[] = [], grass: Poly[] = [], steps: StepsWay[] = [];
  for (const f of land.features) {
    const t = f.properties.tags ?? {};
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    const polys = polysOf(f.geometry);
    if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'cemetery' || t.landuse === 'forest' || t.natural === 'wood') {
      grass.push(...polys);
      blocked.push(...offsetPolys(polys, -SIDEWALK_W));   // park interior: the fence-line margin may still carry a sidewalk
    } else if ((t.highway === 'pedestrian' && t.area === 'yes') || t.place === 'square') paved.push(...polys);
    else if (t.amenity === 'parking' && !['underground', 'multi-storey', 'rooftop'].includes(t.parking ?? '') && t.motorcycle !== 'yes' && t.bicycle !== 'designated') carriage.push(...polys);   // car parking lots / bays only (bike and moto bays sit on the sidewalk)
  }
  const inGrass = (p: Pt) => grass.some(g => pointInPoly(p[0], p[1], g));
  for (const f of roads.features) {
    const t = f.properties.tags ?? {};
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.layer && parseFloat(t.layer) < 0) continue;
    if (f.geometry.type === 'LineString') {
      const pts = toPts((f.geometry as LineString).coordinates);
      if (pts.length < 2) continue;
      if (t.railway) { blocked.push(...offsetLine(pts, 9)); continue; }
      if (!t.highway || t.highway === 'proposed' || t.highway === 'construction') continue;
      const spec = classify(t);
      if (spec?.drive) {
        const w = Math.max(spec.width, carriagewayWidth(t)) + 1.0;
        carriage.push(...offsetLine(pts, w));
        if (!inGrass(pts[Math.floor(pts.length / 2)])) paved.push(...offsetLine(pts, w + 2 * SIDEWALK_W));
      } else if (t.highway === 'pedestrian') paved.push(...offsetLine(pts, 6));
      else if (t.footway === 'sidewalk') paved.push(...offsetLine(pts, MAPPED_SIDEWALK_W));
      else if (t.highway === 'steps') {
        const w = Math.max(1.5, Math.min(12, parseFloat(t.width ?? '') || 3));
        carriage.push(...offsetLine(pts, w));   // keep the slabs off the flight
        steps.push({ pts, width: w });
      }
    } else if ((f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') && t.area === 'yes' && t.highway) {
      (t.highway === 'pedestrian' || t.highway === 'footway' ? paved : carriage).push(...polysOf(f.geometry));
    }
  }
  for (const f of water.features) {
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    blocked.push(...polysOf(f.geometry));
  }
  for (const d of decks) { carriage.push(d); blocked.push(d); }
  return { carriage, paved, blocked, grass, steps };
}

const overlaps = (p: Poly, x0: number, z0: number, x1: number, z1: number) => { const b = bboxOf([p[0]]); return b[2] >= x0 && b[0] <= x1 && b[3] >= z0 && b[1] <= z1; };
const boxPoly = (x0: number, z0: number, x1: number, z1: number): Poly => [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]];

/** Sidewalk polygons of one chunk (world coordinates, clipped to the chunk square with a 5 mm overlap). */
export function chunkSidewalks(input: StreetInput, ox: number, oz: number): Poly[] {
  const x0 = ox - PAD, z0 = oz - PAD, x1 = ox + CHUNK_SIZE + PAD, z1 = oz + CHUNK_SIZE + PAD;
  const sel = (list: Poly[]) => list.filter(p => overlaps(p, x0, z0, x1, z1)).map(roundPoly);
  const paved = sel(input.paved);
  if (!paved.length) return [];
  const cut = [...sel(input.carriage), ...sel(input.blocked)];
  const padBox = [boxPoly(x0, z0, x1, z1)];
  try {
    const inside = intersectPolys(paved, padBox);
    const cutIn = cut.length ? intersectPolys(cut, padBox) : [];
    const slabs = differencePolys(inside, cutIn);
    const clipped = intersectPolys(slabs, [boxPoly(ox - 0.005, oz - 0.005, ox + CHUNK_SIZE + 0.005, oz + CHUNK_SIZE + 0.005)]);
    return clipped.filter(p => area(p[0]) >= MIN_AREA);
  } catch (e) {
    log.warn(`streets: polygon ops failed for chunk at ${ox},${oz}: ${(e as Error).message.slice(0, 80)}`);
    return [];
  }
}

export interface SlabMesh { pos: number[]; flag: number[]; idx: number[]; tris: number; kerbs: number }

/** Triangulate slabs on the rendered terrain with kerb skirts along every boundary edge (except chunk borders). */
export function buildSlabMesh(polys: Poly[], ox: number, oz: number, groundY: (x: number, z: number) => number, waterY = -Infinity): SlabMesh {
  const out: SlabMesh = { pos: [], flag: [], idx: [], tris: 0, kerbs: 0 };
  const vert = (x: number, z: number, y: number, flag: number) => {
    const lx = x - ox, lz = z - oz;
    out.pos.push(lx, y, lz);   // ortho / overview uvs are derived from the position in the street shader variant
    out.flag.push(flag);
    return out.pos.length / 3 - 1;
  };
  const onBorder = (a: Pt, b: Pt) => {
    for (const bx of [ox, ox + CHUNK_SIZE]) if (Math.abs(a[0] - bx) < 0.02 && Math.abs(b[0] - bx) < 0.02) return true;
    for (const bz of [oz, oz + CHUNK_SIZE]) if (Math.abs(a[1] - bz) < 0.02 && Math.abs(b[1] - bz) < 0.02) return true;
    return false;
  };
  for (const raw of polys) {
    // long straight edges would cut under / float over the 4 m terrain mesh: keep every edge at <= 4 m
    const poly = raw.map(r => densify(r, 4));
    const outer = poly[0], holes = poly.slice(1);
    // interior grid points so the slab follows the 4 m terrain mesh on wide areas
    const [bx0, bz0, bx1, bz1] = bboxOf([outer]);
    const steiner: Pt[] = [];
    if (bx1 - bx0 > 3 * STEINER && bz1 - bz0 > 3 * STEINER) {
      for (let gx = Math.ceil(bx0 / STEINER) * STEINER; gx < bx1; gx += STEINER) for (let gz = Math.ceil(bz0 / STEINER) * STEINER; gz < bz1; gz += STEINER) {
        if (!pointInPoly(gx, gz, poly)) continue;
        if (distToRing(gx, gz, outer) < 0.6 || holes.some(h => distToRing(gx, gz, h) < 0.6)) continue;
        steiner.push([gx, gz]);
      }
    }
    const flat: number[] = [];
    const holeIdx: number[] = [];
    for (const p of outer) flat.push(p[0], p[1]);
    for (const h of holes) { holeIdx.push(flat.length / 2); for (const p of h) flat.push(p[0], p[1]); }
    for (const s of steiner) { holeIdx.push(flat.length / 2); flat.push(s[0], s[1]); }
    const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    const base = out.pos.length / 3;
    const ys: number[] = [];
    for (let k = 0; k < flat.length; k += 2) { const y = groundY(flat[k], flat[k + 1]) + KERB_H; ys.push(y); vert(flat[k], flat[k + 1], y, StreetFlag.Top); }
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ax = flat[a * 2], az = flat[a * 2 + 1], bx = flat[b * 2], bz = flat[b * 2 + 1], cx = flat[c * 2], cz = flat[c * 2 + 1];
      // +y normal: cross(b - a, c - a).y = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      if (Math.abs(ny) < 1e-9) continue;
      // A pavement is not a wall. Where a slab polygon straddles a step in the ground - a quay edge, a bridge
      // abutment - the triangulation drapes a vertical sheet down it: 11227 of those stood across the city, the
      // largest 527 m2. Nothing walkable is that steep, so leave them out and let the ground show through.
      const ex = [bx - ax, ys[b] - ys[a], bz - az], fx = [cx - ax, ys[c] - ys[a], cz - az];
      const n3 = [ex[1] * fx[2] - ex[2] * fx[1], ex[2] * fx[0] - ex[0] * fx[2], ex[0] * fx[1] - ex[1] * fx[0]];
      const n3l = Math.hypot(n3[0], n3[1], n3[2]);
      if (n3l > 1e-9 && Math.abs(n3[1]) / n3l < STEEP_TOP) continue;
      if (ny > 0) out.idx.push(base + a, base + b, base + c); else out.idx.push(base + a, base + c, base + b);
      out.tris++;
    }
    // kerb skirt along every ring edge, deepened into a retaining wall where the ground outside drops away
    for (const ring of poly) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        if (len < 0.02 || onBorder(a, b)) continue;
        let nx = dz / len, nz = -dx / len;
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        if (pointInPoly(mx + nx * 0.05, mz + nz * 0.05, poly)) { nx = -nx; nz = -nz; }
        const ya = groundY(a[0], a[1]), yb = groundY(b[0], b[1]);
        // A surveyed paved area sitting on a terrace has its retaining wall exactly on this boundary — the parvis
        // at the Trocadéro stands 11.4 m above the gardens. The 12 cm skirt drew that as a kerb, so the terraces
        // read as smooth slopes. Where the ground a step outside is well below the slab, carry the face down to it.
        const outA = groundY(a[0] + nx * WALL_PROBE, a[1] + nz * WALL_PROBE);
        const outB = groundY(b[0] + nx * WALL_PROBE, b[1] + nz * WALL_PROBE);
        // A retaining wall stands on dry ground. Along the quays the terrain a step outside the slab is the dredged
        // river bed - `build` lowers it 1.5 m under the water line - so the Beaugrenelle deck grew a 17 m wall down
        // into the Seine, a black wedge standing over the water. Only follow ground that is above the water, and
        // never deeper than a terrace could really stand.
        const foot = (y: number, out: number) => (out > waterY + 0.3 && y - out > WALL_MIN ? Math.max(out - 0.3, y - WALL_MAX) : y - SKIRT);
        const footA = foot(ya, outA), footB = foot(yb, outB);
        const aT = vert(a[0], a[1], ya + KERB_H, StreetFlag.Kerb), bT = vert(b[0], b[1], yb + KERB_H, StreetFlag.Kerb);
        const aB = vert(a[0], a[1], footA, StreetFlag.Kerb), bB = vert(b[0], b[1], footB, StreetFlag.Kerb);
        // (aT, bT, aB) faces (dz, -dx); flip when the outward normal is the other way
        if (nx * dz - nz * dx > 0) out.idx.push(aT, bT, aB, bT, bB, aB); else out.idx.push(aT, aB, bT, bT, aB, bB);
        out.kerbs++;
      }
    }
  }
  return out;
}

/**
 * Staircases: every highway=steps way whose midpoint lies in the chunk becomes a flight of boxes from its low end to
 * its high end (risers 16.5 cm, treads >= 26 cm), appended to the slab mesh: treads are slab tops (walkable, paving),
 * risers and flanks are kerb faces (granite). The flight is not a straight ramp between its two ends: the 2 m DTM
 * bulges and dips under it (the Trocadero slopes buried whole runs of treads and left others floating), so each
 * tread is lifted onto the rendered ground where the ground is higher than the line, the profile stays monotonic,
 * and every riser / flank is dropped to the lowest ground under its tread so no daylight shows beneath.
 */
export function addSteps(out: SlabMesh, steps: StepsWay[], ox: number, oz: number, groundY: (x: number, z: number) => number): number {
  const vert = (x: number, z: number, y: number, flag: number) => { out.pos.push(x - ox, y, z - oz); out.flag.push(flag); return out.pos.length / 3 - 1; };
  // two triangles for the quad a-b-c-d whose outward normal should point along (nx, ny, nz)
  const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], nx: number, ny: number, nz: number, flag: number) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const flip = cx * nx + cy * ny + cz * nz < 0;
    const ia = vert(a[0], a[2], a[1], flag), ib = vert(b[0], b[2], b[1], flag), ic = vert(c[0], c[2], c[1], flag), id = vert(d[0], d[2], d[1], flag);
    if (flip) out.idx.push(ia, ic, ib, ia, id, ic); else out.idx.push(ia, ib, ic, ia, ic, id);
    out.tris += 2;
  };
  let flights = 0, lifted = 0, liftMax = 0;
  for (const sw of steps) {
    const pts = sw.pts;
    const mid = pts[Math.floor(pts.length / 2)];
    if (mid[0] < ox || mid[0] >= ox + CHUNK_SIZE || mid[1] < oz || mid[1] >= oz + CHUNK_SIZE) continue;
    const y0 = groundY(pts[0][0], pts[0][1]), y1 = groundY(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    if (Math.abs(y1 - y0) < 0.3) continue;
    const line = y1 > y0 ? pts : [...pts].reverse();
    const yLow = Math.min(y0, y1), rise = Math.abs(y1 - y0);
    const cum: number[] = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const L = cum[cum.length - 1];
    if (L < 0.6) continue;
    let n = Math.max(2, Math.min(80, Math.round(rise / RISER)));
    if (L / n < TREAD_MIN) n = Math.max(2, Math.floor(L / TREAD_MIN));
    const tread = L / n, riser = rise / n, h = sw.width / 2;
    const at = (s: number): [number, number, number, number] => {   // x, z, ux, uz
      let i = 0; while (i + 2 < cum.length && cum[i + 1] < s) i++;
      const a = line[i], b = line[i + 1], seg = cum[i + 1] - cum[i] || 1, t = Math.max(0, Math.min(1, (s - cum[i]) / seg));
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      return [a[0] + dx * t, a[1] + dz * t, dx / l, dz / l];
    };
    // ground under each tread: highest and lowest of five samples (centre, both flanks, both ends)
    const under = (k: number) => {
      const [cx, cz, ux, uz] = at((k + 0.5) * tread), nx = -uz, nz = ux, hh = Math.max(0.1, h - 0.1);
      const ys = [groundY(cx, cz), groundY(cx + nx * hh, cz + nz * hh), groundY(cx - nx * hh, cz - nz * hh), groundY(cx - ux * tread * 0.45, cz - uz * tread * 0.45), groundY(cx + ux * tread * 0.45, cz + uz * tread * 0.45)];
      return [Math.max(...ys), Math.min(...ys)] as const;
    };
    const tops: number[] = [], lows: number[] = [];
    for (let k = 0; k < n; k++) {
      const [hi, lo] = under(k);
      const lift = Math.max(yLow + (k + 1) * riser, hi + 0.03);
      tops.push(Math.max(lift, k ? tops[k - 1] : -Infinity)); lows.push(lo);
      if (hi + 0.03 > yLow + (k + 1) * riser + 0.02) { lifted++; liftMax = Math.max(liftMax, hi + 0.03 - (yLow + (k + 1) * riser)); }
    }
    for (let k = 0; k < n; k++) {
      const [x0, z0, ux, uz] = at(k * tread), [x1, z1] = at((k + 1) * tread);
      const nx = -uz, nz = ux;   // right of travel
      const yT = tops[k], yB = Math.min((k ? tops[k - 1] : yLow) - 0.06, lows[k] - 0.1);
      const A: [number, number, number] = [x0 + nx * h, yT, z0 + nz * h], B: [number, number, number] = [x0 - nx * h, yT, z0 - nz * h];
      const C: [number, number, number] = [x1 - nx * h, yT, z1 - nz * h], D: [number, number, number] = [x1 + nx * h, yT, z1 + nz * h];
      quad(A, B, C, D, 0, 1, 0, StreetFlag.Top);                                                        // tread
      quad([A[0], yB, A[2]], [B[0], yB, B[2]], B, A, -ux, 0, -uz, StreetFlag.Kerb);                      // riser faces the low side
      quad([A[0], yB, A[2]], A, D, [D[0], yB, D[2]], nx, 0, nz, StreetFlag.Kerb);                        // right flank
      quad([B[0], yB, B[2]], B, C, [C[0], yB, C[2]], -nx, 0, -nz, StreetFlag.Kerb);                      // left flank
      out.kerbs += 3;
    }
    flights++;
  }
  if (lifted) stepStats.lifted += lifted; if (liftMax > stepStats.liftMax) stepStats.liftMax = liftMax;
  return flights;
}
/** treads lifted onto the ground and the largest lift, summed over the run (logged by `run`) */
export const stepStats = { lifted: 0, liftMax: 0 };

/** Insert points along edges longer than maxLen (ring stays closed-by-convention, no repeated last point). */
export function densify(ring: Ring, maxLen: number): Ring {
  const out: Ring = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    out.push(a);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.ceil(len / maxLen);
    for (let s = 1; s < k; s++) out.push([a[0] + (b[0] - a[0]) * s / k, a[1] + (b[1] - a[1]) * s / k]);
  }
  return out;
}

export function slabSection(m: SlabMesh): SectionInput {
  return {
    name: 'slab', vertexCount: m.pos.length / 3, indices: m.idx,
    attrs: [
      { spec: { name: 'position', size: 3, type: 'f32' }, data: new Float32Array(m.pos) },
      { spec: { name: 'sflag', size: 1, type: 'u8' }, data: new Uint8Array(m.flag) },
    ],
  };
}

/** Rasterise polygon classes into the 2 m surface grid cells of one chunk (priority: sidewalk > road > grass > paved). */
async function rasterChunk(grid: Uint8Array, i: number, j: number, layers: { polys: Poly[]; cls: SurfaceClass }[]) {
  const o = chunkOrigin(i, j);
  const n = CHUNK_SIZE / SURFACE_STEP;
  const scale = 1 / SURFACE_STEP;
  const px = (p: Pt) => `${((p[0] - o.x) * scale).toFixed(2)},${((p[1] - o.z) * scale).toFixed(2)}`;
  const masks = await Promise.all(layers.map(async l => {
    const parts = l.polys.filter(p => overlaps(p, o.x - 2, o.z - 2, o.x + CHUNK_SIZE + 2, o.z + CHUNK_SIZE + 2))
      .map(p => `<path fill="white" fill-rule="evenodd" d="${p.map(r => 'M' + r.map(px).join('L') + 'Z').join('')}"/>`);
    if (!parts.length) return null;
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="black"/>${parts.join('')}</svg>`);
    return sharp(svg).greyscale().raw().toBuffer();
  }));
  for (let cz = 0; cz < n; cz++) for (let cx = 0; cx < n; cx++) {
    const gi = i * n + cx, gj = j * n + cz;
    let cls = SurfaceClass.None;
    for (let l = 0; l < layers.length; l++) { const m = masks[l]; if (m && m[cz * n + cx] > 127) { cls = layers[l].cls; break; } }
    if (cls !== SurfaceClass.None) grid[gj * SURFACE_N + gi] = cls;
  }
}

export async function run(_ctx: BakeContext) {
  const hm = await loadHeightmap(false);
  const manifest = await readJson<{ waterLevelY: number; files: Record<string, string>; counts: Record<string, number> }>(path.join(OUT_DIR, 'manifest.json'));
  const [roads, land, water] = await Promise.all([loadTheme('roads'), loadTheme('landcover'), loadTheme('water')]);
  const { bridges } = collectBridges(roads, hm, manifest.waterLevelY, makeFlowField(riverArms(water)));
  const decks = bridges.map(b => b.poly);
  // Only a deck this surface can actually rest on. A rail viaduct is not one: the RER C crosses the Grenelle quay
  // 8 m up, and lifting the vertices under it onto the rail deck while their neighbours stayed on the ground
  // reared the pavement into a vertical sheet 11 m tall - a black wedge standing over the Seine.
  const deckAt = (x: number, z: number): number | null => { for (const b of bridges) if (!b.rail && pointInPoly(x, z, b.poly)) return b.deckTop; return null; };
  const groundY = (x: number, z: number) => deckAt(x, z) ?? hm.meshY(x, z);
  const t0 = Date.now();
  const input = collectStreetPolys(roads, land, water, decks);
  log.info(`streets: ${input.paved.length} paved, ${input.carriage.length} carriageway, ${input.blocked.length} blocked, ${input.grass.length} grass polygons (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const dir = path.join(OUT_DIR, 'streets');
  await ensureDir(dir);
  const grid = new Uint8Array(SURFACE_N * SURFACE_N);
  let bytes = 0, tris = 0, kerbs = 0, polys = 0, empty = 0, flights = 0;
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
    const o = chunkOrigin(i, j);
    const slabs = chunkSidewalks(input, o.x, o.z);
    const mesh = buildSlabMesh(slabs, o.x, o.z, groundY, manifest.waterLevelY);
    flights += addSteps(mesh, input.steps, o.x, o.z, groundY);
    const buf = encodeBinMesh({ x: o.x, z: o.z }, mesh.tris ? [slabSection(mesh)] : [], { polys: slabs.length, tris: mesh.tris, kerbs: mesh.kerbs });
    await fs.writeFile(path.join(dir, `${chunkKey(i, j)}.bin`), buf);
    bytes += buf.length; tris += mesh.tris; kerbs += mesh.kerbs; polys += slabs.length; if (!slabs.length) empty++;
    await rasterChunk(grid, i, j, [
      { polys: slabs, cls: SurfaceClass.Sidewalk }, { polys: input.carriage, cls: SurfaceClass.Road },
      { polys: input.grass, cls: SurfaceClass.Grass }, { polys: input.paved, cls: SurfaceClass.Paved },
    ]);
    if ((j * GRID_N + i) % 24 === 23) log.info(`  streets: ${j * GRID_N + i + 1}/144 chunks, ${polys} slabs so far`);
  }
  // water cells from the heightmap (below the water line)
  for (let gj = 0; gj < SURFACE_N; gj++) for (let gi = 0; gi < SURFACE_N; gi++) {
    const x = -WORLD_HALF + (gi + 0.5) * SURFACE_STEP, z = -WORLD_HALF + (gj + 0.5) * SURFACE_STEP;
    if (hm.sample(x, z) < manifest.waterLevelY + 0.3) grid[gj * SURFACE_N + gi] = SurfaceClass.Water;
  }
  await fs.writeFile(path.join(OUT_DIR, 'surface.bin'), grid);
  const counts: Record<number, number> = {}; for (const v of grid) counts[v] = (counts[v] ?? 0) + 1;
  log.info(`streets: ${polys} slabs, ${flights} staircases (of ${input.steps.length} steps ways, ${stepStats.lifted} treads lifted onto the ground, max ${stepStats.liftMax.toFixed(2)} m), ${tris} slab tris, ${kerbs} kerb quads, ${(bytes / 1e6).toFixed(1)} MB, ${empty} empty chunks; surface cells ${JSON.stringify(counts)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  manifest.files.streets = 'streets/{i}_{j}.bin';
  manifest.files.surface = 'surface.bin';
  manifest.counts.sidewalkSlabs = polys; manifest.counts.sidewalkTris = tris;
  await writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);
}
