import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry, LineString } from 'geojson';
import { log } from './log.ts';
import { OUT_DIR } from '../config.ts';
import type { OsmProps } from './overpass.ts';
import { collectBridges, type FlowField } from './bridges.ts';
import { frame } from '../../shared/geo.ts';
import { WORLD_HALF } from '../../shared/layout.ts';
import type { Heightmap } from '../../shared/heightmap.ts';
import { pointInPoly, type Pt } from './polygons.ts';

/**
 * Elevated rail (rail.json): the métro line 6 viaduct segments (railway ways with a bridge tag) chained into
 * polylines, with the y of each vertex taken from the viaduct deck baked by bridges.ts. src/world/life/Metro.ts runs a
 * train back and forth on each polyline long enough to matter.
 */
export interface RailLine { name: string; pts: [number, number, number][] }

export async function buildRail(roads: FeatureCollection<Geometry, OsmProps>, hm: Heightmap, waterLevelY: number, flowAt?: FlowField): Promise<{ lines: number; length: number }> {
  const { bridges } = collectBridges(roads, hm, waterLevelY, flowAt);
  const viaducts = bridges.filter(b => b.columnsTo !== undefined);
  const deckY = (x: number, z: number): number | null => { for (const b of viaducts) if (pointInPoly(x, z, b.poly)) return b.deckTop; return null; };
  // ways -> chains sharing endpoints (rounded to 0.5 m)
  const ways: { pts: Pt[]; name: string }[] = [];
  for (const f of roads.features) {
    const t = f.properties.tags ?? {};
    if (!t.railway || !/^(subway|rail|light_rail)$/.test(t.railway) || !t.bridge || t.bridge === 'no') continue;
    if (f.geometry.type !== 'LineString') continue;
    const pts: Pt[] = (f.geometry as LineString).coordinates.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; });
    if (pts.every(p => Math.abs(p[0]) > WORLD_HALF || Math.abs(p[1]) > WORLD_HALF)) continue;
    ways.push({ pts, name: t.name ?? '' });
  }
  const key = (p: Pt) => `${Math.round(p[0] * 2)}_${Math.round(p[1] * 2)}`;
  const used = new Set<number>();
  const chains: { pts: Pt[]; name: string }[] = [];
  for (let i = 0; i < ways.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let pts = [...ways[i].pts]; let name = ways[i].name;
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < ways.length; j++) {
        if (used.has(j)) continue;
        const w = ways[j].pts;
        if (key(w[0]) === key(pts[pts.length - 1])) { pts = [...pts, ...w.slice(1)]; used.add(j); grew = true; }
        else if (key(w[w.length - 1]) === key(pts[pts.length - 1])) { pts = [...pts, ...[...w].reverse().slice(1)]; used.add(j); grew = true; }
        else if (key(w[w.length - 1]) === key(pts[0])) { pts = [...w, ...pts.slice(1)]; used.add(j); grew = true; }
        else if (key(w[0]) === key(pts[0])) { pts = [...[...w].reverse(), ...pts.slice(1)]; used.add(j); grew = true; }
        if (!name && ways[j].name) name = ways[j].name;
      }
    }
    chains.push({ pts, name });
  }
  const lines: RailLine[] = [];
  let total = 0;
  for (const c of chains) {
    // clip to the world square (keep the inside run), 3D with the deck height (fallback: ground + 8.5 like the bake)
    const inside = c.pts.filter(p => Math.abs(p[0]) <= WORLD_HALF + 60 && Math.abs(p[1]) <= WORLD_HALF + 60);
    if (inside.length < 2) continue;
    let len = 0; for (let i = 1; i < inside.length; i++) len += Math.hypot(inside[i][0] - inside[i - 1][0], inside[i][1] - inside[i - 1][1]);
    if (len < 120) continue;
    const pts3 = inside.map(p => [p[0], (deckY(p[0], p[1]) ?? hm.sample(p[0], p[1]) + 8.5) + 0.15, p[1]] as [number, number, number]);
    lines.push({ name: c.name, pts: pts3 });
    total += len;
  }
  await fs.writeFile(path.join(OUT_DIR, 'rail.json'), JSON.stringify({ lines }));
  log.info(`rail: ${lines.length} elevated lines, ${total.toFixed(0)} m (${lines.map(l => l.name || '?').join(', ')})`);
  return { lines: lines.length, length: total };
}
