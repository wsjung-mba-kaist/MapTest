import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import { log } from './log.ts';
import { OUT_DIR } from '../config.ts';
import type { OsmProps } from './overpass.ts';
import { frame } from '../../shared/geo.ts';
import { WORLD_HALF } from '../../shared/layout.ts';
import type { Heightmap } from '../../shared/heightmap.ts';
import { area, cleanRing, type Ring } from './polygons.ts';

/**
 * Fountain jets (fountains.json) from the OSM fountain basins. The Fontaine de Varsovie below the Trocadéro gets its
 * real layout in spirit: 20 water cannons on the two long sides firing toward the axis and the tower, plus four big
 * geysers on the axis; every other basin gets a vertical jet sized by its area. The runtime (src/world/Fountains.ts)
 * animates each jet as a parabolic particle stream.
 */
export interface Jet { x: number; y: number; z: number; vx: number; vy: number; vz: number; n: number; w: number }
export interface FountainSite { name: string; x: number; y: number; z: number; jets: number }

const G = 9.81;

function axisOf(ring: Ring) {
  let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= ring.length; cz /= ring.length;
  let sxx = 0, sxz = 0, szz = 0; for (const p of ring) { const x = p[0] - cx, z = p[1] - cz; sxx += x * x; sxz += x * z; szz += z * z; }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  let dx = Math.cos(ang), dz = Math.sin(ang);
  // orient the axis toward the tower (origin) so "downstream" jets aim the right way
  if (dx * -cx + dz * -cz < 0) { dx = -dx; dz = -dz; }
  let lo = Infinity, hi = -Infinity, wlo = Infinity, whi = -Infinity;
  for (const p of ring) { const t = (p[0] - cx) * dx + (p[1] - cz) * dz, w = -(p[0] - cx) * dz + (p[1] - cz) * dx; lo = Math.min(lo, t); hi = Math.max(hi, t); wlo = Math.min(wlo, w); whi = Math.max(whi, w); }
  return { cx, cz, dx, dz, halfL: (hi - lo) / 2, halfW: (whi - wlo) / 2 };
}

export async function buildFountains(water: FeatureCollection<Geometry, OsmProps>, hm: Heightmap): Promise<{ count: number; sites: number }> {
  const jets: Jet[] = [];
  const sites: FountainSite[] = [];
  for (const f of water.features) {
    const t = f.properties.tags ?? {};
    const name = t.name ?? '';
    if (t.amenity !== 'fountain' && !/fontaine|miroir d'eau/i.test(name)) continue;
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    const coords = f.geometry.type === 'Polygon' ? (f.geometry as Polygon).coordinates[0] : (f.geometry as MultiPolygon).coordinates[0][0];
    const ring = cleanRing(coords.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z] as [number, number]; }));
    if (ring.length < 3) continue;
    const a = axisOf(ring);
    if (Math.abs(a.cx) > WORLD_HALF || Math.abs(a.cz) > WORLD_HALF) continue;
    const A = area(ring);
    if (A < 15) continue;
    const yAt = (x: number, z: number) => hm.sample(x, z) - 0.25 + 0.35;   // basin water sits 0.25 m under the local ground
    const before = jets.length;
    if (A > 2000) {
      // Varsovie: cannons on both long sides, aimed at the axis and downstream toward the tower, 32 degrees up
      const nPerSide = 10, lat = a.halfW - 4, v = 16, el = 32 * Math.PI / 180;
      for (let k = 0; k < nPerSide; k++) {
        const tt = -a.halfL + 8 + (2 * a.halfL - 16) * k / (nPerSide - 1);
        for (const side of [-1, 1]) {
          const x = a.cx + a.dx * tt - a.dz * lat * side, z = a.cz + a.dz * tt + a.dx * lat * side;
          // horizontal direction: 60 % toward the axis, 80 % along it
          let hx = a.dz * side * 0.6 + a.dx * 0.8, hz = -a.dx * side * 0.6 + a.dz * 0.8;
          const hl = Math.hypot(hx, hz); hx /= hl; hz /= hl;
          jets.push({ x, y: yAt(x, z), z, vx: hx * v * Math.cos(el), vy: v * Math.sin(el), vz: hz * v * Math.cos(el), n: 160, w: 0.25 });
        }
      }
      for (const tt of [-0.65, -0.22, 0.22, 0.65]) {
        const x = a.cx + a.dx * a.halfL * tt, z = a.cz + a.dz * a.halfL * tt;
        jets.push({ x, y: yAt(x, z), z, vx: 0, vy: 14, vz: 0, n: 220, w: 0.6 });
      }
    } else {
      const v = Math.max(6, Math.min(12, 5 + Math.sqrt(A) * 0.45));
      jets.push({ x: a.cx, y: yAt(a.cx, a.cz), z: a.cz, vx: 0, vy: v, vz: 0, n: A > 300 ? 120 : 70, w: A > 300 ? 0.4 : 0.2 });
      if (A > 300) for (let k = 0; k < 6; k++) {
        const ang = k * Math.PI / 3, r = Math.min(a.halfW, a.halfL) * 0.55;
        const x = a.cx + Math.cos(ang) * r, z = a.cz + Math.sin(ang) * r;
        jets.push({ x, y: yAt(x, z), z, vx: -Math.cos(ang) * 3, vy: 7, vz: -Math.sin(ang) * 3, n: 60, w: 0.15 });
      }
    }
    sites.push({ name: name || f.properties.id.toString(), x: a.cx, y: yAt(a.cx, a.cz), z: a.cz, jets: jets.length - before });
  }
  await fs.writeFile(path.join(OUT_DIR, 'fountains.json'), JSON.stringify({ jets, sites }));
  log.info(`fountains: ${sites.length} basins, ${jets.length} jets (${sites.map(s => `${s.name}:${s.jets}`).slice(0, 6).join(', ')}${sites.length > 6 ? '…' : ''})`);
  void G;
  return { count: jets.length, sites: sites.length };
}
