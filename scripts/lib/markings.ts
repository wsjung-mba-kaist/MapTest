import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry, LineString } from 'geojson';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { OUT_DIR } from '../config.ts';
import { ensureDir, readJson, writeJson } from './http.ts';
import { loadTheme, type OsmProps } from './overpass.ts';
import { classify } from './roadnet.ts';
import { collectBridges, type Bridge } from './bridges.ts';
import { makeFlowField, riverArms } from './river.ts';
import { encodeBinMesh } from './binmesh.ts';
import { loadHeightmap } from './build.ts';
import { frame } from '../../shared/geo.ts';
import { GRID_N, MarkKind, WORLD_HALF, chunkIndexOf, chunkKey, chunkOrigin, inGrid } from '../../shared/layout.ts';
import { laneOffset, rightNormal } from '../../shared/paths.ts';
import type { Heightmap } from '../../shared/heightmap.ts';
import { pointInPoly, type Pt } from './polygons.ts';
import { buildPlaques } from './plaques.ts';

/**
 * Road markings as thin decal strips on the rendered ground: zebra crossings from OSM footway=crossing ways,
 * lane separators and centre dashes on multi-lane streets. Output marks/{i}_{j}.bin (PBM1, section "marks":
 * position f32x3 chunk-local, muv f32x2 = (across -1..1, metres along), mkind u8).
 */

const LIFT = 0.012;          // metres above the ground mesh (plus polygon offset at runtime)
const SUBDIV = 1.5;          // strip subdivision along its length so it follows the terrain

interface Strip { pts: Pt[]; width: number; kind: MarkKind }

export class MarkBuilder {
  pos: number[] = []; muv: number[] = []; kind: number[] = []; idx: number[] = [];
  constructor(readonly ox: number, readonly oz: number, readonly y: (x: number, z: number) => number) {}
  get vertexCount() { return this.pos.length / 3; }
  strip(s: Strip) {
    const h = s.width / 2;
    let along = 0;
    for (let i = 0; i + 1 < s.pts.length; i++) {
      const a = s.pts[i], b = s.pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.02) continue;
      const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
      const [nx, nz] = rightNormal(ux, uz);
      const n = Math.max(1, Math.ceil(len / SUBDIV));
      let prev = -1;
      for (let k = 0; k <= n; k++) {
        const t = (k / n) * len;
        const px = a[0] + ux * t, pz = a[1] + uz * t;
        const base = this.vertexCount;
        for (const side of [-1, 1]) {
          const x = px + nx * h * side, z = pz + nz * h * side;
          this.pos.push(x - this.ox, this.y(x, z) + LIFT, z - this.oz);
          this.muv.push(side, along + t);
          this.kind.push(s.kind);
        }
        // (prevL, prevR, curL) / (curL, prevR, curR): counter-clockwise seen from above, i.e. normals +y (front face up)
        if (prev >= 0) { this.idx.push(prev, prev + 1, base, base, prev + 1, base + 1); }
        prev = base;
      }
      along += len;
    }
  }
  section() {
    return {
      name: 'marks', vertexCount: this.vertexCount, indices: this.idx,
      attrs: [
        { spec: { name: 'position', size: 3, type: 'f32' as const }, data: new Float32Array(this.pos) },
        { spec: { name: 'muv', size: 2, type: 'f32' as const }, data: new Float32Array(this.muv) },
        { spec: { name: 'mkind', size: 1, type: 'u8' as const }, data: new Uint8Array(this.kind) },
      ],
    };
  }
}

const toPts = (coords: number[][]): Pt[] => coords.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z] as Pt; });
const segDist = (x: number, z: number, a: Pt, b: Pt) => { const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz; const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0; return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)); };

export async function buildMarkings(roads: FeatureCollection<Geometry, OsmProps>, hm: Heightmap, bridges: Bridge[]): Promise<{ strips: number; bytes: number; zebras: number; dashes: number; stops: number }> {
  // ---- streets with lane info and their segments (for crossing -> street association and dash suppression)
  interface Street { pts: Pt[]; width: number; lanesF: number; lanesB: number; laneW: number; band: number; oneway: boolean; cls: string; steps: boolean }
  const streets: Street[] = [];
  const crossingLines: Pt[][] = [];
  for (const f of roads.features) {
    if (f.geometry.type !== 'LineString') continue;
    const t = f.properties.tags ?? {};
    const spec = classify(t);
    if (!spec || spec.tunnel) continue;
    const pts = toPts((f.geometry as LineString).coordinates);
    if (pts.every(p => Math.abs(p[0]) > WORLD_HALF + 30 || Math.abs(p[1]) > WORLD_HALF + 30)) continue;
    if (spec.drive) streets.push({ pts, width: spec.width, lanesF: spec.lanesF, lanesB: spec.lanesB, laneW: spec.laneW, band: spec.bandCenter, oneway: spec.oneway, cls: spec.cls, steps: spec.steps });
    const marked = (t.footway === 'crossing') && !['unmarked', 'informal'].includes(t.crossing ?? '') && t['crossing:markings'] !== 'no';
    if (marked && pts.length >= 2) crossingLines.push(pts);
  }
  // spatial grid of street segments
  const cell = 40;
  const grid = new Map<string, { s: Street; i: number }[]>();
  for (const s of streets) for (let i = 0; i + 1 < s.pts.length; i++) {
    const a = s.pts[i], b = s.pts[i + 1];
    for (let gi = Math.floor(Math.min(a[0], b[0]) / cell); gi <= Math.floor(Math.max(a[0], b[0]) / cell); gi++)
      for (let gj = Math.floor(Math.min(a[1], b[1]) / cell); gj <= Math.floor(Math.max(a[1], b[1]) / cell); gj++) {
        const k = `${gi}_${gj}`; const arr = grid.get(k); if (arr) arr.push({ s, i }); else grid.set(k, [{ s, i }]);
      }
  }
  const nearStreets = (x: number, z: number, r: number) => {
    const out: { s: Street; i: number; d: number }[] = [];
    for (let gi = Math.floor((x - r) / cell); gi <= Math.floor((x + r) / cell); gi++) for (let gj = Math.floor((z - r) / cell); gj <= Math.floor((z + r) / cell); gj++)
      for (const e of grid.get(`${gi}_${gj}`) ?? []) { const d = segDist(x, z, e.s.pts[e.i], e.s.pts[e.i + 1]); if (d <= r) out.push({ ...e, d }); }
    return out;
  };
  // Only a deck this surface can actually rest on. A rail viaduct is not one: the RER C crosses the Grenelle quay
  // 8 m up, and lifting the vertices under it onto the rail deck while their neighbours stayed on the ground
  // reared the pavement into a vertical sheet 11 m tall - a black wedge standing over the Seine.
  const deckAt = (x: number, z: number): number | null => { for (const b of bridges) if (!b.rail && pointInPoly(x, z, b.poly)) return b.deckTop; return null; };
  const groundY = (x: number, z: number) => deckAt(x, z) ?? hm.meshY(x, z);

  const perChunk = new Map<string, MarkBuilder>();
  const builderFor = (x: number, z: number): MarkBuilder | null => {
    const { i, j } = chunkIndexOf(x, z);
    if (!inGrid(i, j)) return null;
    const k = chunkKey(i, j);
    let b = perChunk.get(k);
    if (!b) { const o = chunkOrigin(i, j); b = new MarkBuilder(o.x, o.z, groundY); perChunk.set(k, b); }
    return b;
  };

  // ---- zebra crossings: bars parallel to the traffic, every metre along the crossing line
  let zebras = 0, dashes = 0;
  const zebraCentres: Pt[] = [];
  for (const line of crossingLines) {
    const a = line[0], b = line[line.length - 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 2 || len > 40) continue;
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const near = nearStreets(mx, mz, 6).filter(e => !e.s.steps).sort((p, q) => p.d - q.d)[0];
    if (!near) continue;
    const bar = near.s.lanesF + near.s.lanesB >= 3 || ['primary', 'secondary'].includes(near.s.cls) ? 4.0 : 2.8;
    // direction of the bars = street direction (traffic flow)
    const sa = near.s.pts[near.i], sb = near.s.pts[near.i + 1];
    const sl = Math.hypot(sb[0] - sa[0], sb[1] - sa[1]) || 1;
    const tx = (sb[0] - sa[0]) / sl, tz = (sb[1] - sa[1]) / sl;
    // keep the bars inside the carriageway: trim the crossing line to the street's half width around its centreline
    // the mapped crossing runs sidewalk centre to sidewalk centre (~1.6 m past each kerb), which is a better carriageway
    // estimate than the class width on wide streets; never narrower than the class width
    const half = Math.max(near.s.width / 2, len / 2 - 1.6);
    let made = 0;
    for (let s = 0.5; s < len; s += 1.0) {
      const cx = a[0] + ux * s, cz = a[1] + uz * s;
      if (segDist(cx, cz, sa, sb) > half - 0.1) continue;
      const bld = builderFor(cx, cz); if (!bld) continue;
      bld.strip({ pts: [[cx - tx * bar / 2, cz - tz * bar / 2], [cx + tx * bar / 2, cz + tz * bar / 2]], width: 0.5, kind: MarkKind.Zebra });
      made++;
    }
    if (made) { zebras++; zebraCentres.push([mx, mz]); }
  }
  const nearZebra = (x: number, z: number) => { for (const c of zebraCentres) if (Math.hypot(c[0] - x, c[1] - z) < 6) return true; return false; };

  // ---- lane markings: centre dashes on wide two-way streets, separators between same-direction lanes
  for (const s of streets) {
    const total = s.lanesF + s.lanesB;
    if (total < 2 || s.cls === 'service' || s.cls === 'living_street') continue;
    const centreLine = !s.oneway && (total >= 3 || s.cls === 'primary' || s.cls === 'secondary');
    const lines: { lat: number; kind: MarkKind; dash: number; gap: number; w: number }[] = [];
    if (centreLine) lines.push({ lat: s.band, kind: MarkKind.CentreDash, dash: 1.5, gap: 5, w: 0.15 });
    const sep = (n: number, dir: 1 | -1) => { for (let k = 0; k + 1 < n; k++) { const l0 = laneOffset(s.lanesF, s.lanesB, s.laneW, s.band, s.oneway, k, dir), l1 = laneOffset(s.lanesF, s.lanesB, s.laneW, s.band, s.oneway, k + 1, dir); lines.push({ lat: (l0 + l1) / 2, kind: MarkKind.LaneDash, dash: 2.5, gap: 4, w: 0.12 }); } };
    if (s.oneway) sep(s.lanesF, 1); else { sep(s.lanesF, 1); sep(s.lanesB, -1); }
    if (!lines.length) continue;
    // walk the polyline with a continuous phase per line
    const total_len = s.pts.reduce((acc, p, i) => i ? acc + Math.hypot(p[0] - s.pts[i - 1][0], p[1] - s.pts[i - 1][1]) : 0, 0);
    if (total_len < 14) continue;
    for (const ln of lines) {
      let phase = 0;
      let travelled = 0;
      for (let i = 0; i + 1 < s.pts.length; i++) {
        const a = s.pts[i], b = s.pts[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.05) continue;
        const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
        const [nx, nz] = rightNormal(ux, uz);
        let d = phase;
        while (d < len) {
          const d1 = Math.min(len, d + ln.dash);
          const s0 = travelled + d, s1 = travelled + d1;
          // keep clear of the ends (junctions) and of zebra crossings
          if (s0 > 8 && s1 < total_len - 8) {
            const cx = a[0] + ux * (d + d1) / 2 + nx * ln.lat, cz = a[1] + uz * (d + d1) / 2 + nz * ln.lat;
            if (!nearZebra(cx, cz)) {
              const bld = builderFor(cx, cz);
              if (bld) { bld.strip({ pts: [[a[0] + ux * d + nx * ln.lat, a[1] + uz * d + nz * ln.lat], [a[0] + ux * d1 + nx * ln.lat, a[1] + uz * d1 + nz * ln.lat]], width: ln.w, kind: ln.kind }); dashes++; }
            }
          }
          d += ln.dash + ln.gap;
        }
        phase = d - len;
        travelled += len;
      }
    }
  }

  // ---- stop lines: where a drivable street arrives at a junction of >= 3 drivable ways, one line across the arriving
  // lanes, set back behind the zebra crossing when there is one. Lane laterals are in the polyline (a->b) frame:
  // forward lanes on the right (+), backward lanes on the left (-), see shared/paths.ts laneOffset.
  const nodeKey = (p: Pt) => `${Math.round(p[0] * 100)}_${Math.round(p[1] * 100)}`;
  const junction = new Map<string, Set<Street>>();
  for (const s of streets) for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) {
    const k = nodeKey(p); let set = junction.get(k); if (!set) { set = new Set(); junction.set(k, set); } set.add(s);
  }
  let stops = 0;
  for (const s of streets) {
    if (s.steps || s.cls === 'service' || s.cls === 'living_street') continue;
    const n = s.pts.length;
    for (const dir of [1, -1] as const) {
      if (s.oneway && dir === -1) continue;
      const lanes = dir === 1 ? s.lanesF : s.lanesB;
      if (lanes < 1) continue;
      const node = dir === 1 ? s.pts[n - 1] : s.pts[0];
      if ((junction.get(nodeKey(node))?.size ?? 0) < 3) continue;
      const setback = nearZebra(node[0], node[1]) ? 7.0 : 2.5;
      // walk back from the node along the polyline by the setback
      let rem = setback, i = dir === 1 ? n - 1 : 0;
      let found: { x: number; z: number; ux: number; uz: number } | null = null;
      for (;;) {
        const j = i - dir; if (j < 0 || j >= n) break;
        const a = s.pts[i], b = s.pts[j];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len >= rem) {
          const t = rem / len;
          // polyline (a->b) direction of this segment, independent of the walking direction
          const p0 = dir === 1 ? b : a, p1 = dir === 1 ? a : b;
          found = { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, ux: (p1[0] - p0[0]) / len, uz: (p1[1] - p0[1]) / len };
          break;
        }
        rem -= len; i = j;
      }
      if (!found) continue;
      const [nx, nz] = rightNormal(found.ux, found.uz);
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < lanes; k++) {
        const l = laneOffset(s.lanesF, s.lanesB, s.laneW, s.band, s.oneway, k, dir);
        lo = Math.min(lo, l - s.laneW / 2 + 0.15); hi = Math.max(hi, l + s.laneW / 2 - 0.15);
      }
      const bld = builderFor(found.x, found.z); if (!bld) continue;
      bld.strip({ pts: [[found.x + nx * lo, found.z + nz * lo], [found.x + nx * hi, found.z + nz * hi]], width: 0.4, kind: MarkKind.StopLine });
      stops++;
    }
  }

  // ---- write per chunk
  const dir = path.join(OUT_DIR, 'marks');
  await ensureDir(dir);
  let bytes = 0, strips = 0;
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
    const k = chunkKey(i, j);
    const b = perChunk.get(k);
    const o = chunkOrigin(i, j);
    const buf = encodeBinMesh({ x: o.x, z: o.z }, b ? [b.section()] : [], { strips: b ? b.idx.length / 6 : 0 });
    await fs.writeFile(path.join(dir, `${k}.bin`), buf);
    bytes += buf.length; strips += b ? b.idx.length / 6 : 0;
  }
  log.info(`markings: ${zebras} zebra crossings, ${dashes} lane dashes, ${stops} stop lines, ${strips} quads, ${(bytes / 1e6).toFixed(2)} MB`);
  return { strips, bytes, zebras, dashes, stops };
}

export async function run(_ctx: BakeContext) {
  const hm = await loadHeightmap(false);
  const manifest = await readJson<{ waterLevelY: number; files: Record<string, string>; counts: Record<string, number> }>(path.join(OUT_DIR, 'manifest.json'));
  const roads = await loadTheme('roads');
  const water = await loadTheme('water');
  const { bridges } = collectBridges(roads, hm, manifest.waterLevelY, makeFlowField(riverArms(water)));
  const res = await buildMarkings(roads, hm, bridges);
  const plaques = buildPlaques(roads, riverArms(water));
  await writeJson(path.join(OUT_DIR, 'plaques.json'), plaques);
  log.info(`plaques: ${plaques.arms.length} junction arms, ${plaques.names.length} street names`);
  manifest.files.plaques = 'plaques.json';
  manifest.counts.plaqueArms = plaques.arms.length;
  manifest.files.marks = 'marks/{i}_{j}.bin';
  manifest.counts.markStrips = res.strips; manifest.counts.zebras = res.zebras; manifest.counts.stopLines = res.stops;
  await writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);
}
