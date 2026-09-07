import type { FeatureCollection, Geometry } from 'geojson';
import { frame } from '../../shared/geo.ts';
import { LANDMARK_MODELS } from '../landmarks_models.ts';
import type { OsmProps } from './overpass.ts';
import { area, bboxOf, centroid, cleanRing, convexHull, minAreaRect, orient, pointInRing, type MinRect, type Ring } from './polygons.ts';

/** World-space footprint of a hero model: what the extrusion drops, the orthophoto inpaints and the deshadow casts. */
export interface HeroFootprint {
  id: string; rings: Ring[]; centre: [number, number]; rect: MinRect; radius: number; bbox: [number, number, number, number];
  /** convex hull of all rings: the tower's outline is star-shaped, but the platforms and arch skirts between its legs belong to the model too */
  hull: Ring;
}

/** Footprints of every registry entry found in the cached OSM buildings theme. */
export function heroFootprints(osm: FeatureCollection<Geometry, OsmProps>): HeroFootprint[] {
  const out: HeroFootprint[] = [];
  for (const m of LANDMARK_MODELS) {
    const rings: Ring[] = [];
    for (const ref of m.osm) {
      const f = osm.features.find(f => f.properties.type === ref.type && f.properties.id === ref.id);
      if (!f) continue;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      for (const coords of polys) {
        const ring = cleanRing(coords[0].map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z] as [number, number]; }));
        if (ring.length >= 3 && area(ring) > 4) rings.push(orient(ring, false));
      }
    }
    if (!rings.length) continue;
    const big = rings.reduce((a, b) => (area(a) >= area(b) ? a : b));
    const c = centroid(big);
    const rect = minAreaRect(big);
    let radius = 0;
    for (const r of rings) for (const p of r) radius = Math.max(radius, Math.hypot(p[0] - c[0], p[1] - c[1]));
    out.push({ id: m.id, rings, centre: c, rect, radius, bbox: bboxOf(rings), hull: convexHull(rings.flat()) });
  }
  return out;
}

/** true when (x, z) lies inside one of the hero footprints' convex hulls (their parts and platforms are drawn by the model). */
export function inHero(list: HeroFootprint[], x: number, z: number): boolean {
  for (const h of list) {
    if (x < h.bbox[0] || x > h.bbox[2] || z < h.bbox[1] || z > h.bbox[3]) continue;
    if (pointInRing(x, z, h.hull)) return true;
  }
  return false;
}
