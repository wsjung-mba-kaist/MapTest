import type { FeatureCollection, Geometry, LineString } from 'geojson';
import type { OsmProps } from './overpass.ts';
import { frame } from '../../shared/geo.ts';
import type { Pt } from './polygons.ts';

/** Seine centreline helpers shared by the bridge bake (pier orientation) and the path bake (boat loops). */

const key = (p: Pt) => `${Math.round(p[0] * 100)}_${Math.round(p[1] * 100)}`;
export const polyLength = (pts: Pt[]) => pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0);

/** Chain waterway=river ways (OSM direction = downstream) into polylines: [main arm, side arms...]. */
export function chainRiver(lines: { id: number; pts: Pt[] }[]): Pt[][] {
  const byStart = new Map<string, { id: number; pts: Pt[] }[]>();
  const endKeys = new Set<string>();
  for (const l of lines) { const k = key(l.pts[0]); const arr = byStart.get(k); if (arr) arr.push(l); else byStart.set(k, [l]); endKeys.add(key(l.pts[l.pts.length - 1])); }
  const sources = lines.filter(l => !endKeys.has(key(l.pts[0])));
  const out: Pt[][] = [];
  const used = new Set<number>();
  const follow = (start: { id: number; pts: Pt[] }): { pts: Pt[]; forks: { id: number; pts: Pt[] }[] } => {
    const pts: Pt[] = [...start.pts]; used.add(start.id);
    const forks: { id: number; pts: Pt[] }[] = [];
    let cur = start;
    for (let guard = 0; guard < 64; guard++) {
      const next = (byStart.get(key(cur.pts[cur.pts.length - 1])) ?? []).filter(l => !used.has(l.id));
      if (!next.length) break;
      next.sort((p, q) => polyLength(q.pts) - polyLength(p.pts)); // longest = main arm
      for (const f of next.slice(1)) forks.push(f);
      cur = next[0]; used.add(cur.id);
      pts.push(...cur.pts.slice(1));
    }
    return { pts, forks };
  };
  const queue = sources.length ? sources : lines.slice(0, 1);
  while (queue.length) {
    const s = queue.shift()!;
    if (used.has(s.id)) continue;
    const { pts, forks } = follow(s);
    out.push(pts);
    queue.push(...forks);
  }
  return out;
}

/** River arms (world metres, downstream order) from the OSM water theme. */
export function riverArms(water: FeatureCollection<Geometry, OsmProps>): Pt[][] {
  const lines: { id: number; pts: Pt[] }[] = [];
  for (const f of water.features) {
    const t = f.properties.tags ?? {};
    if (f.geometry.type !== 'LineString' || t.waterway !== 'river') continue;
    lines.push({ id: f.properties.id, pts: (f.geometry as LineString).coordinates.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z] as Pt; }) });
  }
  return chainRiver(lines);
}

/** Unit flow direction of the nearest river segment within `maxDist`, or null. */
export function makeFlowField(arms: Pt[][], maxDist = 400, window = 60): (x: number, z: number) => [number, number] | null {
  const segs: { arm: number; i: number; a: Pt; b: Pt; s0: number }[] = [];
  const cum: number[][] = [];
  arms.forEach((arm, ai) => {
    const c = [0]; for (let i = 1; i < arm.length; i++) c.push(c[i - 1] + Math.hypot(arm[i][0] - arm[i - 1][0], arm[i][1] - arm[i - 1][1]));
    cum.push(c);
    for (let i = 0; i + 1 < arm.length; i++) segs.push({ arm: ai, i, a: arm[i], b: arm[i + 1], s0: c[i] });
  });
  const pointAt = (ai: number, s: number): Pt => {
    const arm = arms[ai], c = cum[ai];
    const ss = Math.max(0, Math.min(c[c.length - 1], s));
    let i = 0; while (i + 2 < arm.length && c[i + 1] < ss) i++;
    const len = c[i + 1] - c[i] || 1, t = (ss - c[i]) / len;
    return [arm[i][0] + (arm[i + 1][0] - arm[i][0]) * t, arm[i][1] + (arm[i + 1][1] - arm[i][1]) * t];
  };
  return (x, z) => {
    let best: typeof segs[number] | null = null, bestD = maxDist, bestS = 0;
    for (const s of segs) {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / l2)) : 0;
      const d = Math.hypot(x - (s.a[0] + dx * t), z - (s.a[1] + dz * t));
      if (d < bestD) { bestD = d; best = s; bestS = s.s0 + Math.sqrt(l2) * t; }
    }
    if (!best) return null;
    const p0 = pointAt(best.arm, bestS - window), p1 = pointAt(best.arm, bestS + window);
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1], l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
}
