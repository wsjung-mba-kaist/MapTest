import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry, LineString } from 'geojson';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { OUT_DIR } from '../config.ts';
import { readJson, writeJson } from './http.ts';
import { loadTheme, type OsmProps } from './overpass.ts';
import { classify, type RoadSpec } from './roadnet.ts';
import { collectBridges, type Bridge, type PierBox } from './bridges.ts';
import { makeFlowField, polyLength, riverArms } from './river.ts';
import { encodeBinMesh } from './binmesh.ts';
import { loadHeightmap } from './build.ts';
import { frame } from '../../shared/geo.ts';
import { WORLD_HALF } from '../../shared/layout.ts';
import { EdgeFlag, NodeFlag, PATHS_VERSION, rightNormal, type PathsMeta, type RiverLoopMeta } from '../../shared/paths.ts';
import type { Heightmap } from '../../shared/heightmap.ts';
import { pointInPoly, type Poly, type Pt } from './polygons.ts';

/**
 * Street and path network for the moving city: nodes/edges split at shared OSM vertices, per-vertex terrain
 * (or bridge deck) heights for the centre and both sidewalk offsets, synthetic sidewalks where OSM has none
 * mapped, tunnel/boundary car sinks, and closed boat loops along the Seine that thread between bridge piers.
 */

export interface WayIn { id: number; pts: Pt[]; spec: RoadSpec; tags: Record<string, string> }

export interface GraphEdge {
  a: number; b: number; verts: Pt[]; spec: RoadSpec; wayId: number; tags: Record<string, string>;
  flags: number; length: number;
  yC: number[]; yL: number[]; yR: number[]; s: number[];
  sideL: number; sideR: number;
}
export interface GraphNode { x: number; z: number; y: number; edges: number[]; flags: number; boundary: boolean }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

const BOUND = WORLD_HALF + 60;
const DENSIFY = 6;
const SIDE_GAP = 1.3;          // sidewalk centre = carriageway edge + 1.3 m
const SIDE_MAX_STEP = 1.2;     // metres of height difference that disables a synthetic sidewalk (quay walls)
const MAPPED_SIDEWALK_R = 5;   // a mapped footway=sidewalk within this distance replaces the synthetic one

const key = (p: Pt) => `${Math.round(p[0] * 100)}_${Math.round(p[1] * 100)}`;

/** Clip a polyline to the square |x|,|z| <= bound, returning the inside runs (crossing points added, flagged). */
function clipRuns(pts: Pt[], bound: number): { run: Pt[]; startCut: boolean; endCut: boolean }[] {
  const inside = (p: Pt) => Math.abs(p[0]) <= bound && Math.abs(p[1]) <= bound;
  const cross = (a: Pt, b: Pt): Pt => {
    // first parameter t in (0,1] where the segment leaves/enters the box
    let t = 1;
    for (const [i, s] of [[0, 1], [0, -1], [1, 1], [1, -1]] as [number, number][]) {
      const da = a[i] * s - bound, db = b[i] * s - bound;
      if ((da <= 0) !== (db <= 0)) t = Math.min(t, da / (da - db));
    }
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const runs: { run: Pt[]; startCut: boolean; endCut: boolean }[] = [];
  let cur: Pt[] | null = null, startCut = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], inP = inside(p);
    if (inP) {
      if (!cur) { cur = []; startCut = i > 0; if (i > 0) cur.push(cross(p, pts[i - 1])); }
      cur.push(p);
    } else if (cur) {
      cur.push(cross(pts[i - 1], p));
      runs.push({ run: cur, startCut, endCut: true }); cur = null;
    }
  }
  if (cur) runs.push({ run: cur, startCut, endCut: false });
  return runs.filter(r => r.run.length >= 2);
}

/** Split ways at shared vertices into edges; boundary crossings become sink/source nodes. */
export function buildGraph(ways: WayIn[], bound = BOUND): Graph {
  const count = new Map<string, number>();
  for (const w of ways) w.pts.forEach((p, i) => { const k = key(p); count.set(k, (count.get(k) ?? 0) + (i === 0 || i === w.pts.length - 1 ? 2 : 1)); });
  const nodes: GraphNode[] = [];
  const nodeId = new Map<string, number>();
  const nodeOf = (p: Pt, boundary: boolean) => {
    const k = key(p);
    let id = nodeId.get(k);
    if (id === undefined) { id = nodes.length; nodeId.set(k, id); nodes.push({ x: p[0], z: p[1], y: 0, edges: [], flags: 0, boundary }); }
    if (boundary) nodes[id].boundary = true;
    return id;
  };
  const edges: GraphEdge[] = [];
  const pushEdge = (run: Pt[], w: WayIn, startCut: boolean, endCut: boolean) => {
    const a = nodeOf(run[0], startCut), b = nodeOf(run[run.length - 1], endCut);
    if (a === b && run.length < 3) return;
    const e: GraphEdge = { a, b, verts: run, spec: w.spec, wayId: w.id, tags: w.tags, flags: 0, length: 0, yC: [], yL: [], yR: [], s: [], sideL: 0, sideR: 0 };
    nodes[a].edges.push(edges.length); nodes[b].edges.push(edges.length);
    edges.push(e);
  };
  for (const w of ways) {
    const pts = w.spec.reverse ? w.pts.slice().reverse() : w.pts;
    for (const { run, startCut, endCut } of clipRuns(pts, bound)) {
      // split the run at shared (node) vertices
      let start = 0;
      for (let i = 1; i < run.length; i++) {
        const isNode = i === run.length - 1 || (count.get(key(run[i])) ?? 0) >= 2;
        if (!isNode) continue;
        pushEdge(run.slice(start, i + 1), w, startCut && start === 0, endCut && i === run.length - 1);
        start = i;
      }
    }
  }
  return { nodes, edges };
}

function densify(pts: Pt[], maxSeg: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / maxSeg));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

/** Simple uniform grid of segments for proximity queries. */
class SegGrid {
  private cells = new Map<string, [Pt, Pt][]>();
  constructor(private readonly cell = 20) {}
  add(a: Pt, b: Pt) {
    const i0 = Math.floor(Math.min(a[0], b[0]) / this.cell), i1 = Math.floor(Math.max(a[0], b[0]) / this.cell);
    const j0 = Math.floor(Math.min(a[1], b[1]) / this.cell), j1 = Math.floor(Math.max(a[1], b[1]) / this.cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = `${i}_${j}`; const arr = this.cells.get(k); if (arr) arr.push([a, b]); else this.cells.set(k, [[a, b]]); }
  }
  near(x: number, z: number, r: number): boolean {
    const i0 = Math.floor((x - r) / this.cell), i1 = Math.floor((x + r) / this.cell), j0 = Math.floor((z - r) / this.cell), j1 = Math.floor((z + r) / this.cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (const [a, b] of this.cells.get(`${i}_${j}`) ?? []) if (distSeg(x, z, a, b) <= r) return true;
    }
    return false;
  }
}
function distSeg(x: number, z: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

/** Per-vertex heights: terrain (or bridge deck) at the centre and at both sidewalk offsets. */
function assignHeights(g: Graph, hm: Heightmap, bridges: Bridge[]) {
  // A carriageway's end node usually sits a few centimetres OUTSIDE the deck outline it belongs to, so a strict
  // containment test dropped it to the terrain and the last segment of every bridge became a cliff — 4.95 m at the
  // Pont d'Iena. Accept a deck the point is nearly on.
  const NEAR_DECK = 2.5;
  const deckAt = (x: number, z: number): number | null => {
    for (const b of bridges) if (pointInPoly(x, z, b.poly)) return b.deckTop;
    let best: { d: number; y: number } | null = null;
    for (const b of bridges) {
      for (const r of b.poly) for (let i = 0; i < r.length; i++) {
        const d = distSeg(x, z, r[i], r[(i + 1) % r.length]);
        if (d < NEAR_DECK && (!best || d < best.d)) best = { d, y: b.deckTop };
      }
    }
    return best ? best.y : null;
  };
  for (const e of g.edges) {
    e.verts = densify(e.verts, DENSIFY);
    const n = e.verts.length;
    const off = e.spec.width / 2 + SIDE_GAP;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const p = e.verts[i];
      const q = e.verts[Math.min(n - 1, i + 1)], r = e.verts[Math.max(0, i - 1)];
      const dx = q[0] - r[0], dz = q[1] - r[1], l = Math.hypot(dx, dz) || 1;
      const [nx, nz] = rightNormal(dx / l, dz / l);
      const deck = e.spec.bridge ? deckAt(p[0], p[1]) : null;
      const yC = deck ?? hm.sample(p[0], p[1]);
      const yL = deck ?? hm.sample(p[0] - nx * off, p[1] - nz * off);
      const yR = deck ?? hm.sample(p[0] + nx * off, p[1] + nz * off);
      e.yC.push(yC); e.yL.push(yL); e.yR.push(yR);
      if (i > 0) s += Math.hypot(p[0] - e.verts[i - 1][0], p[1] - e.verts[i - 1][1]);
      e.s.push(s);
    }
    e.length = s;
    if (e.spec.bridge) e.flags |= EdgeFlag.BRIDGE;
  }
  // Node height = highest incident endpoint (bridge decks win over the quay under them), then ramp edge ends to it.
  for (const nd of g.nodes) {
    let y = -Infinity;
    for (const ei of nd.edges) y = Math.max(y, endpointY(g, ei, nd));
    nd.y = Number.isFinite(y) ? y : hm.sample(nd.x, nd.z);
  }
  for (let ei = 0; ei < g.edges.length; ei++) {
    const e = g.edges[ei];
    if (!e.spec.drive) continue; // walkers follow the terrain exactly (steps, quays)
    rampEnds(e, g.nodes[e.a].y, g.nodes[e.b].y, 25);
  }
}
function endpointY(g: Graph, ei: number, nd: GraphNode): number {
  const e = g.edges[ei];
  const atA = g.nodes[e.a] === nd;
  return atA ? e.yC[0] : e.yC[e.yC.length - 1];
}
function rampEnds(e: GraphEdge, ya: number, yb: number, over: number) {
  const n = e.yC.length, L = e.length;
  for (let i = 0; i < n; i++) {
    const s = e.s[i];
    const wa = Math.max(0, 1 - s / over), wb = Math.max(0, 1 - (L - s) / over);
    const y = e.yC[i];
    e.yC[i] = y + (ya - e.yC[0]) * wa + (yb - e.yC[n - 1]) * wb;
  }
}

/** Synthetic sidewalks where OSM maps none, park/crossing flags, sinks/sources. */
function classifyEdges(g: Graph, mapped: SegGrid, parks: Poly[], tunnelPortals: Set<string>) {
  let sidesOn = 0, sidesOff = 0, sidesWall = 0;
  for (const e of g.edges) {
    const sp = e.spec;
    if (sp.drive) e.flags |= EdgeFlag.DRIVE;
    if (sp.walkCentre) e.flags |= EdgeFlag.WALK;
    if (sp.oneway) e.flags |= EdgeFlag.ONEWAY;
    if (sp.steps) e.flags |= EdgeFlag.STEPS;
    if (e.tags.footway === 'crossing' || e.tags.cycleway === 'crossing') e.flags |= EdgeFlag.CROSSING;
    const mid = e.verts[Math.floor(e.verts.length / 2)];
    if (parks.some(p => pointInPoly(mid[0], mid[1], p))) e.flags |= EdgeFlag.PARK;
    const off = sp.width / 2 + SIDE_GAP;
    for (const side of [-1, 1] as const) {
      const allowed = side < 0 ? sp.sideL : sp.sideR;
      if (!allowed || e.length < 4) continue;
      // wall check: a sidewalk offset that lands on a quay below/above the road is not walkable
      let bad = 0;
      const ys = side < 0 ? e.yL : e.yR;
      for (let i = 0; i < ys.length; i++) if (Math.abs(ys[i] - e.yC[i]) > SIDE_MAX_STEP) bad++;
      if (bad > ys.length * 0.3) { sidesWall++; continue; }
      // mapped sidewalk nearby? sample 3 points
      let near = 0;
      for (const f of [0.25, 0.5, 0.75]) {
        const i = Math.min(e.verts.length - 1, Math.floor(f * (e.verts.length - 1)));
        const p = e.verts[i], q = e.verts[Math.min(e.verts.length - 1, i + 1)], r = e.verts[Math.max(0, i - 1)];
        const dx = q[0] - r[0], dz = q[1] - r[1], l = Math.hypot(dx, dz) || 1;
        const [nx, nz] = rightNormal(dx / l, dz / l);
        if (mapped.near(p[0] + nx * off * side, p[1] + nz * off * side, MAPPED_SIDEWALK_R)) near++;
      }
      if (near >= 2) { sidesOff++; continue; }
      if (side < 0) { e.flags |= EdgeFlag.SIDE_L; e.sideL = off; } else { e.flags |= EdgeFlag.SIDE_R; e.sideR = off; }
      sidesOn++;
    }
  }
  // Node flags
  let deadEnds = 0, driveNodes = 0, portals = 0;
  for (const nd of g.nodes) {
    const driveDeg = nd.edges.filter(ei => g.edges[ei].spec.drive).length;
    if (driveDeg >= 3) nd.flags |= NodeFlag.SIGNAL;
    if (driveDeg > 0) driveNodes++;
    if (nd.boundary) nd.flags |= NodeFlag.CAR_SINK | NodeFlag.CAR_SOURCE;
    else if (driveDeg === 1) {
      if (tunnelPortals.has(key([nd.x, nd.z]))) { nd.flags |= NodeFlag.CAR_SINK | NodeFlag.CAR_SOURCE; portals++; }
      else deadEnds++;
    }
  }
  return { sidesOn, sidesOff, sidesWall, deadEnds, driveNodes, portals };
}

// ---------------------------------------------------------------- river loops

function offsetPolyline(pts: Pt[], d: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const q = pts[Math.min(pts.length - 1, i + 1)], r = pts[Math.max(0, i - 1)];
    const dx = q[0] - r[0], dz = q[1] - r[1], l = Math.hypot(dx, dz) || 1;
    const [nx, nz] = rightNormal(dx / l, dz / l);
    out.push([pts[i][0] + nx * d, pts[i][1] + nz * d]);
  }
  return out;
}

/** Clearance between a lane segment and a pier slab (centre line along the flow, half-length halfW, radius halfL). */
function pierClearance(a: Pt, b: Pt, p: PierBox): number {
  const fx = -p.dz, fz = p.dx; // along-flow direction
  let m = Infinity;
  for (let k = -2; k <= 2; k++) { const t = (k / 2) * p.halfW; m = Math.min(m, distSeg(p.cx + fx * t, p.cz + fz * t, a, b)); }
  return m - p.halfL;
}

/**
 * Shift lane points across the flow so that, at every bridge zone, the lane passes at least `clearance` metres
 * from every pier slab. Piers within 60 m of each other form one zone (road deck + métro viaduct at Bir-Hakeim);
 * per zone the lateral offset is found by direct search, preferring the smallest move, then blended in over `lead` m.
 */
export function avoidPiers(lane: Pt[], piers: PierBox[], clearance = 8, lead = 45): Pt[] {
  const out = lane.map(p => [p[0], p[1]] as Pt);
  if (!piers.length || lane.length < 2) return out;
  // zones by proximity
  const zone = piers.map((_, i) => i);
  const find = (i: number): number => (zone[i] === i ? i : (zone[i] = find(zone[i])));
  for (let i = 0; i < piers.length; i++) for (let j = i + 1; j < piers.length; j++) if (Math.hypot(piers[i].cx - piers[j].cx, piers[i].cz - piers[j].cz) < 60) zone[find(i)] = find(j);
  const groups = new Map<number, PierBox[]>();
  piers.forEach((p, i) => { const r = find(i); const arr = groups.get(r); if (arr) arr.push(p); else groups.set(r, [p]); });
  for (const group of groups.values()) {
    const gx = group.reduce((s, p) => s + p.cx, 0) / group.length, gz = group.reduce((s, p) => s + p.cz, 0) / group.length;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < out.length; i++) { const d = Math.hypot(out[i][0] - gx, out[i][1] - gz); if (d < bestD) { bestD = d; best = i; } }
    if (best < 0 || bestD > 120) continue;
    const la = out[Math.max(0, best - 1)], lb = out[Math.min(out.length - 1, best + 1)];
    const ll = Math.hypot(lb[0] - la[0], lb[1] - la[1]) || 1, ldx = (lb[0] - la[0]) / ll, ldz = (lb[1] - la[1]) / ll;
    const [ux, uz] = rightNormal(ldx, ldz);
    const P = out[best];
    const clearanceAt = (c: number) => {
      const cx = P[0] + ux * c, cz = P[1] + uz * c;
      const a: Pt = [cx - ldx * 45, cz - ldz * 45], b: Pt = [cx + ldx * 45, cz + ldz * 45];
      let m = Infinity; for (const p of group) m = Math.min(m, pierClearance(a, b, p));
      return m;
    };
    if (clearanceAt(0) >= clearance) continue;
    let pick = 0, pickScore = -Infinity;
    for (let c = -30; c <= 30; c += 1) {
      const cl = clearanceAt(c);
      const score = cl >= clearance ? 1000 - Math.abs(c) : cl * 10 - Math.abs(c); // feasible: smallest move; else: best clearance
      if (score > pickScore) { pickScore = score; pick = c; }
    }
    if (pick === 0) continue;
    // full shift on a plateau covering the slab length, then a smooth lead-out
    const plateau = 40;
    for (let i = 0; i < out.length; i++) {
      const along = Math.hypot(lane[i][0] - lane[best][0], lane[i][1] - lane[best][1]);
      if (along >= plateau + lead) continue;
      const x = Math.max(0, along - plateau) / lead, w = 1 - x * x * (3 - 2 * x);
      out[i][0] += ux * pick * w; out[i][1] += uz * pick * w;
    }
  }
  return out;
}

/** Closed loop: downstream lane, U-turn, upstream lane, U-turn. Offsets are measured right of the flow. */
export function makeLoop(centre: Pt[], offset: number, piers: PierBox[]): Pt[] {
  const down = avoidPiers(avoidPiers(offsetPolyline(centre, offset), piers), piers);
  const up = avoidPiers(avoidPiers(offsetPolyline(centre, -offset), piers), piers).reverse();
  const arc = (from: Pt, to: Pt, ahead: Pt): Pt[] => {
    const mx = (from[0] + to[0]) / 2, mz = (from[1] + to[1]) / 2, r = Math.hypot(to[0] - from[0], to[1] - from[1]) / 2;
    const a0 = Math.atan2(from[1] - mz, from[0] - mx);
    // sweep on the side that continues the travel direction (ahead = point before `from`)
    const dir = (from[0] - ahead[0]) * (to[1] - from[1]) - (from[1] - ahead[1]) * (to[0] - from[0]) > 0 ? 1 : -1;
    const pts: Pt[] = [];
    for (let k = 1; k < 8; k++) { const a = a0 + dir * Math.PI * k / 8; pts.push([mx + Math.cos(a) * r, mz + Math.sin(a) * r]); }
    return pts;
  };
  return [...down, ...arc(down[down.length - 1], up[0], down[down.length - 2]), ...up, ...arc(up[up.length - 1], down[0], up[up.length - 2])];
}

function minPierDistance(loop: Pt[], piers: PierBox[]): number {
  let m = Infinity;
  for (let i = 0; i + 1 < loop.length; i++) for (const p of piers) m = Math.min(m, pierClearance(loop[i], loop[i + 1], p));
  return m;
}

// ---------------------------------------------------------------- bake entry

export async function buildPaths(roads: FeatureCollection<Geometry, OsmProps>, water: FeatureCollection<Geometry, OsmProps>, land: FeatureCollection<Geometry, OsmProps> | null, hm: Heightmap, waterLevelY: number, bridges: Bridge[], piers: PierBox[]): Promise<{ bytes: number; meta: PathsMeta }> {
  const ways: WayIn[] = [];
  const mapped = new SegGrid(20);
  const tunnelPortals = new Set<string>();
  for (const f of roads.features) {
    if (f.geometry.type !== 'LineString') continue;
    const t = f.properties.tags ?? {};
    const spec = classify(t);
    if (!spec) continue;
    const pts: Pt[] = (f.geometry as LineString).coordinates.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; });
    if (pts.length < 2 || pts.every(p => Math.abs(p[0]) > BOUND || Math.abs(p[1]) > BOUND)) continue;
    if (spec.tunnel) { tunnelPortals.add(key(pts[0])); tunnelPortals.add(key(pts[pts.length - 1])); continue; }
    if (t.footway === 'sidewalk') for (let i = 0; i + 1 < pts.length; i++) mapped.add(pts[i], pts[i + 1]);
    ways.push({ id: f.properties.id, pts, spec, tags: t });
  }
  const parks: Poly[] = [];
  if (land) for (const f of land.features) {
    const t = f.properties.tags ?? {};
    if (!(t.leisure === 'park' || t.leisure === 'garden')) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    for (const rings of polys) parks.push(rings.map(r => r.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z] as Pt; })));
  }
  const g = buildGraph(ways);
  assignHeights(g, hm, bridges);
  const st = classifyEdges(g, mapped, parks, tunnelPortals);
  const driveEdges = g.edges.filter(e => e.spec.drive);
  const driveLen = driveEdges.reduce((s, e) => s + e.length, 0);
  log.info(`paths: ${ways.length} ways -> ${g.nodes.length} nodes, ${g.edges.length} edges (${driveEdges.length} drivable, ${(driveLen / 1000).toFixed(1)} km); sides on ${st.sidesOn}, mapped ${st.sidesOff}, walls ${st.sidesWall}; dead ends ${st.deadEnds}/${st.driveNodes} drivable nodes, portals ${st.portals}`);

  // ---- river loops
  const arms = riverArms(water);
  const loops: { pts: Pt[]; meta: RiverLoopMeta }[] = [];
  const riverBound = WORLD_HALF - 40; // turn round just inside the baked water mesh
  arms.forEach((arm, idx) => {
    const runs = clipRuns(arm, riverBound).map(r => r.run).sort((p, q) => polyLength(q) - polyLength(p));
    const centre = runs[0];
    if (!centre || polyLength(centre) < 400) return;
    const offset = idx === 0 ? 12 : 22; // side arm: keep away from the island bank
    const pts = makeLoop(densify(centre, 10), offset, piers);
    const length = polyLength([...pts, pts[0]]);
    const kind: RiverLoopMeta['kind'] = idx === 0 ? 'mouche' : 'barge';
    const start = loops.reduce((s, l) => s + l.pts.length, 0);
    loops.push({ pts, meta: { start, count: pts.length, length, kind, boats: idx === 0 ? 2 : 1 } });
    log.info(`paths: river loop ${idx} (${kind}): ${pts.length} pts, ${(length / 1000).toFixed(2)} km, min pier clearance ${minPierDistance(pts, piers).toFixed(1)} m`);
    if (process.env.PATHS_DEBUG) for (const p of piers) {
      let m = Infinity, seg = 0;
      for (let i = 0; i + 1 < pts.length; i++) { const d = pierClearance(pts[i], pts[i + 1], p); if (d < m) { m = d; seg = i; } }
      if (m < 8) {
        const a = pts[seg], b = pts[seg + 1]; const fl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const cosang = Math.abs(((b[0] - a[0]) * p.dx + (b[1] - a[1]) * p.dz) / fl);
        log.warn(`  pier "${p.name}" at (${p.cx.toFixed(0)},${p.cz.toFixed(0)}) halfW ${p.halfW.toFixed(1)} axis-flow angle ${(Math.acos(Math.min(1, cosang)) * 180 / Math.PI).toFixed(0)}° clearance ${m.toFixed(1)}`);
      }
    }
  });

  // ---- serialise
  const N = g.nodes.length, E = g.edges.length;
  let V = 0; for (const e of g.edges) V += e.verts.length;
  const nodePos = new Float32Array(N * 3), adjStart = new Uint32Array(N), adjCount = new Uint8Array(N), nodeFlags = new Uint8Array(N);
  const adj: number[] = [];
  g.nodes.forEach((nd, i) => { nodePos.set([nd.x, nd.y, nd.z], i * 3); adjStart[i] = adj.length; adjCount[i] = Math.min(255, nd.edges.length); adj.push(...nd.edges); nodeFlags[i] = nd.flags; });
  const eA = new Uint32Array(E), eB = new Uint32Array(E), eV0 = new Uint32Array(E), eNv = new Uint16Array(E), eFlags = new Uint16Array(E), eWidth = new Float32Array(E);
  const eLanes = new Uint8Array(E * 2), eSpeed = new Uint8Array(E), eSide = new Float32Array(E * 2), eLen = new Float32Array(E), eWay = new Uint32Array(E), eCls = new Uint8Array(E), ePark = new Uint8Array(E), eLane = new Float32Array(E * 2);
  const vPos = new Float32Array(V * 3), vYs = new Float32Array(V * 2), vS = new Float32Array(V);
  let v = 0;
  g.edges.forEach((e, i) => {
    eA[i] = e.a; eB[i] = e.b; eV0[i] = v; eNv[i] = e.verts.length; eFlags[i] = e.flags; eWidth[i] = e.spec.width;
    eLanes[i * 2] = e.spec.lanesF; eLanes[i * 2 + 1] = e.spec.lanesB; eSpeed[i] = Math.min(255, Math.round(e.spec.speed * 10));
    eSide[i * 2] = e.sideL; eSide[i * 2 + 1] = e.sideR; eLen[i] = e.length; eWay[i] = e.wayId >>> 0; eCls[i] = e.spec.clsId; ePark[i] = e.spec.parkingSides;
    eLane[i * 2] = e.spec.laneW; eLane[i * 2 + 1] = e.spec.bandCenter;
    for (let k = 0; k < e.verts.length; k++, v++) { vPos.set([e.verts[k][0], e.yC[k], e.verts[k][1]], v * 3); vYs.set([e.yL[k], e.yR[k]], v * 2); vS[v] = e.s[k]; }
  });
  const river = new Float32Array(loops.reduce((s, l) => s + l.pts.length, 0) * 3);
  let r = 0; for (const l of loops) for (const p of l.pts) { river.set([p[0], waterLevelY + 0.3, p[1]], r * 3); r++; }
  const meta: PathsMeta = { version: PATHS_VERSION, nodes: N, edges: E, verts: V, riverLoops: loops.map(l => l.meta), waterY: waterLevelY };
  const buf = encodeBinMesh({ x: 0, z: 0 }, [
    { name: 'nodes', vertexCount: N, indices: [], attrs: [
      { spec: { name: 'pos', size: 3, type: 'f32' }, data: nodePos }, { spec: { name: 'adjStart', size: 1, type: 'u32' }, data: adjStart },
      { spec: { name: 'adjCount', size: 1, type: 'u8' }, data: adjCount }, { spec: { name: 'flags', size: 1, type: 'u8' }, data: nodeFlags }] },
    { name: 'adj', vertexCount: adj.length, indices: [], attrs: [{ spec: { name: 'edge', size: 1, type: 'u32' }, data: new Uint32Array(adj) }] },
    { name: 'edges', vertexCount: E, indices: [], attrs: [
      { spec: { name: 'a', size: 1, type: 'u32' }, data: eA }, { spec: { name: 'b', size: 1, type: 'u32' }, data: eB }, { spec: { name: 'v0', size: 1, type: 'u32' }, data: eV0 },
      { spec: { name: 'nv', size: 1, type: 'u16' }, data: eNv }, { spec: { name: 'flags', size: 1, type: 'u16' }, data: eFlags }, { spec: { name: 'width', size: 1, type: 'f32' }, data: eWidth },
      { spec: { name: 'lanes', size: 2, type: 'u8' }, data: eLanes }, { spec: { name: 'speed', size: 1, type: 'u8' }, data: eSpeed }, { spec: { name: 'side', size: 2, type: 'f32' }, data: eSide },
      { spec: { name: 'length', size: 1, type: 'f32' }, data: eLen }, { spec: { name: 'wayId', size: 1, type: 'u32' }, data: eWay }, { spec: { name: 'cls', size: 1, type: 'u8' }, data: eCls },
      { spec: { name: 'park', size: 1, type: 'u8' }, data: ePark }, { spec: { name: 'lane', size: 2, type: 'f32' }, data: eLane }] },
    { name: 'verts', vertexCount: V, indices: [], attrs: [
      { spec: { name: 'pos', size: 3, type: 'f32' }, data: vPos }, { spec: { name: 'ys', size: 2, type: 'f32' }, data: vYs }, { spec: { name: 's', size: 1, type: 'f32' }, data: vS }] },
    { name: 'river', vertexCount: r, indices: [], attrs: [{ spec: { name: 'pos', size: 3, type: 'f32' }, data: river }] },
  ], meta as unknown as Record<string, unknown>);
  await fs.writeFile(path.join(OUT_DIR, 'paths.bin'), buf);
  log.info(`paths: wrote ${(buf.length / 1e6).toFixed(2)} MB (${V} vertices, ${r} river points)`);
  return { bytes: buf.length, meta };
}

export async function run(_ctx: BakeContext) {
  const hm = await loadHeightmap(false); // the lowered terrain (river bed) so quays keep their height and the water is below
  const manifest = await readJson<{ waterLevelY: number; files: Record<string, string>; counts: Record<string, number> }>(path.join(OUT_DIR, 'manifest.json'));
  const roads = await loadTheme('roads');
  const water = await loadTheme('water');
  const land = await loadTheme('landcover').catch(() => null);
  const { bridges, piers } = collectBridges(roads, hm, manifest.waterLevelY, makeFlowField(riverArms(water)));
  log.info(`paths: ${bridges.length} bridge decks, ${piers.length} piers`);
  const res = await buildPaths(roads, water, land, hm, manifest.waterLevelY, bridges, piers);
  manifest.files.paths = 'paths.bin';
  manifest.counts.pathEdges = res.meta.edges; manifest.counts.pathNodes = res.meta.nodes; manifest.counts.riverLoops = res.meta.riverLoops.length;
  await writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);
}
