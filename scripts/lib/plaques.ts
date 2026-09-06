import type { FeatureCollection, Geometry, LineString } from 'geojson';
import type { OsmProps } from './overpass.ts';
import { frame } from '../../shared/geo.ts';
import { WORLD_HALF, type PlaquesData } from '../../shared/layout.ts';
import type { Pt } from './polygons.ts';

/**
 * Street-name plaque anchors: every junction where at least two differently named streets meet yields one "arm" per
 * (name, direction away from the junction). The runtime hangs a plaque on the facade that runs parallel to the arm
 * next to the junction (see src/world/BuildingDetails.ts). Rows: [x, z, ux, uz, nameIdx, arrondissement].
 */

export interface NamedLine { pts: Pt[]; name: string }

const SKIP = new Set(['footway', 'path', 'steps', 'cycleway', 'bridleway', 'corridor', 'platform', 'proposed', 'construction', 'raceway', 'bus_guideway', 'busway']);
const ARM_MIN_LEN = 4;   // metres walked from the junction before the direction is measured

export function namedLines(roads: FeatureCollection<Geometry, OsmProps>): NamedLine[] {
  const out: NamedLine[] = [];
  for (const f of roads.features) {
    if (f.geometry.type !== 'LineString') continue;
    const t = f.properties.tags ?? {};
    if (!t.highway || SKIP.has(t.highway) || !t.name || t.area === 'yes' || t.tunnel) continue;
    const pts = (f.geometry as LineString).coordinates.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z] as Pt; });
    if (pts.length >= 2) out.push({ pts, name: t.name.trim() });
  }
  return out;
}

/** Side of the river: +1 right bank (north here), -1 left bank, 0 when no river nearby. */
function riverSide(x: number, z: number, river: Pt[][]): number {
  let best = Infinity, side = 0;
  for (const arm of river) for (let i = 0; i + 1 < arm.length; i++) {
    const a = arm[i], b = arm[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    if (l2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    const px = a[0] + dx * t, pz = a[1] + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; const cross = dx * (z - pz) - dz * (x - px); side = cross > 0 ? 1 : -1; }
  }
  return best < 1500 ? side : 0;
}

/** Rough arrondissement from position: right bank 16e (8e east of the Alma), left bank 7e, 15e south-west of avenue de Suffren. */
export function arrondissementOf(x: number, z: number, river: Pt[][]): number {
  const side = riverSide(x, z, river);
  if (side > 0) return x > 750 ? 8 : 16;
  return z - x > 0 ? 15 : 7;
}

export function buildPlaquesFromLines(lines: NamedLine[], river: Pt[][]): PlaquesData {
  const key = (p: Pt) => `${Math.round(p[0] * 100)}_${Math.round(p[1] * 100)}`;
  const atVertex = new Map<string, { li: number; vi: number }[]>();
  lines.forEach((l, li) => l.pts.forEach((p, vi) => { const k = key(p); const arr = atVertex.get(k); if (arr) arr.push({ li, vi }); else atVertex.set(k, [{ li, vi }]); }));
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  const idxOf = (n: string) => { let i = nameIdx.get(n); if (i === undefined) { i = names.length; names.push(n); nameIdx.set(n, i); } return i; };
  const arms: number[][] = [];
  // direction away from vertex vi along the line towards +1 / -1, measured ARM_MIN_LEN metres out
  const dirFrom = (pts: Pt[], vi: number, step: 1 | -1): [number, number] | null => {
    const o = pts[vi];
    for (let j = vi + step; j >= 0 && j < pts.length; j += step) {
      const d = Math.hypot(pts[j][0] - o[0], pts[j][1] - o[1]);
      if (d >= ARM_MIN_LEN || j === 0 || j === pts.length - 1) { if (d < 0.5) return null; return [(pts[j][0] - o[0]) / d, (pts[j][1] - o[1]) / d]; }
    }
    return null;
  };
  for (const entries of atVertex.values()) {
    if (entries.length < 2) continue;
    const distinct = new Set(entries.map(e => lines[e.li].name));
    if (distinct.size < 2) continue;
    const p = lines[entries[0].li].pts[entries[0].vi];
    if (Math.abs(p[0]) > WORLD_HALF || Math.abs(p[1]) > WORLD_HALF) continue;
    const arr = arrondissementOf(p[0], p[1], river);
    const local: { ux: number; uz: number; name: number }[] = [];
    for (const e of entries) {
      const l = lines[e.li];
      const n = idxOf(l.name);
      for (const step of [1, -1] as const) {
        const d = dirFrom(l.pts, e.vi, step);
        if (!d) continue;
        if (local.some(a => a.name === n && a.ux * d[0] + a.uz * d[1] > 0.9)) continue;   // same street, same way out
        local.push({ ux: d[0], uz: d[1], name: n });
      }
    }
    if (local.length > 8) local.length = 8;
    for (const a of local) arms.push([+p[0].toFixed(2), +p[1].toFixed(2), +a.ux.toFixed(4), +a.uz.toFixed(4), a.name, arr]);
  }
  return { names, arms };
}

export function buildPlaques(roads: FeatureCollection<Geometry, OsmProps>, river: Pt[][]): PlaquesData {
  return buildPlaquesFromLines(namedLines(roads), river);
}
