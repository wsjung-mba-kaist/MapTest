import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry, LineString } from 'geojson';
import { log } from './log.ts';
import { MODELS_DIR, OUT_DIR, STATUES } from '../config.ts';
import type { OsmProps } from './overpass.ts';
import { frame } from '../../shared/geo.ts';
import { FURNITURE_STRIDE, FurnitureKind, WORLD_HALF } from '../../shared/layout.ts';
import type { Heightmap } from '../../shared/heightmap.ts';
import type { Pt } from './polygons.ts';
import type { BuildingSpec } from './buildings.ts';
import { pointInPoly } from './polygons.ts';
import { classify } from './roadnet.ts';

/** Street lamps along roads (and park alleys), plus OSM-mapped lamps/benches when the points theme is available. */
export async function buildFurniture(roads: FeatureCollection<Geometry, OsmProps>, points: FeatureCollection<Geometry, OsmProps> | null, buildings: BuildingSpec[], hm: Heightmap, waterLevelY: number, land: FeatureCollection<Geometry, OsmProps> | null = null): Promise<{ count: number; bytes: number }> {
  const rows: number[] = [];
  let statues = 0;
  const occupied = new Map<string, true>();
  const cellKey = (x: number, z: number) => `${Math.floor(x / 6)}_${Math.floor(z / 6)}`;

  // Building footprint index to keep lamps off private ground.
  const cell = 40;
  const bIndex = new Map<string, BuildingSpec[]>();
  for (const b of buildings) {
    const xs = b.rings[0].map(p => p[0]), zs = b.rings[0].map(p => p[1]);
    for (let i = Math.floor(Math.min(...xs) / cell); i <= Math.floor(Math.max(...xs) / cell); i++)
      for (let j = Math.floor(Math.min(...zs) / cell); j <= Math.floor(Math.max(...zs) / cell); j++) {
        const k = `${i}_${j}`; const arr = bIndex.get(k); if (arr) arr.push(b); else bIndex.set(k, [b]);
      }
  }
  const inBuilding = (x: number, z: number) => (bIndex.get(`${Math.floor(x / cell)}_${Math.floor(z / cell)}`) ?? []).some(b => pointInPoly(x, z, b.rings));

  const place = (x: number, z: number, yaw: number, kind: FurnitureKind, scale = 1) => {
    if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return false;
    const y = hm.sample(x, z);
    if (y < waterLevelY + 0.8) return false;
    const k = cellKey(x, z);
    if (occupied.has(k)) return false;
    if (inBuilding(x, z)) return false;
    occupied.set(k, true);
    rows.push(x, y, z, yaw, kind, scale);
    return true;
  };

  let fromOsm = 0;
  // mapped lamps: procedural lamps yield within LAMP_YIELD_R of one (partial OSM coverage then blends naturally)
  const LAMP_YIELD_R = 18, lampCell = 20;
  const osmLamps = new Map<string, Pt[]>();
  const nearOsmLamp = (x: number, z: number) => {
    for (let i = Math.floor((x - LAMP_YIELD_R) / lampCell); i <= Math.floor((x + LAMP_YIELD_R) / lampCell); i++)
      for (let j = Math.floor((z - LAMP_YIELD_R) / lampCell); j <= Math.floor((z + LAMP_YIELD_R) / lampCell); j++)
        for (const p of osmLamps.get(`${i}_${j}`) ?? []) if (Math.hypot(p[0] - x, p[1] - z) < LAMP_YIELD_R) return true;
    return false;
  };
  // Hand-placed monument statues (config.STATUES). These go down first so the OSM pass can defer to them, and so
  // the landmarks the app advertises are there whether or not the points theme happened to include artwork.
  // A hero model (scripts/landmarks_models.ts) replaces the procedural figure wherever one has been baked, so the
  // two never stand in the same spot.
  const heroIds = new Set<string>();
  const heroSpots: { x: number; z: number; r: number }[] = [];
  try {
    const idx = JSON.parse(await fs.readFile(path.join(MODELS_DIR, 'landmarks.json'), 'utf8')) as { models?: { id: string; json: string }[] };
    for (const m of idx.models ?? []) {
      heroIds.add(m.id);
      try {
        const meta = JSON.parse(await fs.readFile(path.join(MODELS_DIR, m.json), 'utf8')) as { centre?: [number, number]; radius?: number };
        if (meta.centre) heroSpots.push({ x: meta.centre[0], z: meta.centre[1], r: Math.max(12, (meta.radius ?? 0) + 6) });
      } catch { /* no metadata for this model */ }
    }
  } catch { /* no hero models baked yet */ }
  /** A real model already stands here, so no procedural figure — from either source — may share the spot. */
  const nearHero = (x: number, z: number) => heroSpots.some(h => Math.hypot(h.x - x, h.z - z) < h.r);
  const curated: Pt[] = [];
  for (const st of STATUES) {
    if (heroIds.has(st.id)) { log.info(`furniture: ${st.id}: hero model present, procedural statue skipped`); continue; }
    const w = frame.toWorld(st.lon, st.lat);
    if (Math.abs(w.x) > WORLD_HALF || Math.abs(w.z) > WORLD_HALF) continue;
    curated.push([w.x, w.z]);
    // scale 1 is a ~4.5 m figure on its plinth (see statue() in src/world/Furniture.ts)
    const kind = st.kind === 'flame' ? FurnitureKind.Flame : st.kind === 'peacewall' ? FurnitureKind.PeaceWall : FurnitureKind.Statue;
    const unit = st.kind === 'flame' ? 3.5 : st.kind === 'peacewall' ? 9 : 4.5;   // the reference height each mesh is modelled at
    if (place(w.x, w.z, (st.facing * Math.PI) / 180, kind, Math.max(0.5, st.height / unit))) statues++;
  }
  const nearCurated = (x: number, z: number) => curated.some(c => Math.hypot(c[0] - x, c[1] - z) < 12);
  if (points) {
    for (const f of points.features) {
      const t = f.properties.tags ?? {};
      // A few statues are mapped as small areas rather than nodes; stand them at the footprint centre.
      let lon: number, lat: number;
      if (f.geometry.type === 'Point') { [lon, lat] = f.geometry.coordinates; }
      else if (f.geometry.type === 'Polygon' && (t.man_made === 'statue' || t.tourism === 'artwork')) {
        const r = f.geometry.coordinates[0];
        lon = r.reduce((a, p) => a + p[0], 0) / r.length;
        lat = r.reduce((a, p) => a + p[1], 0) / r.length;
      } else continue;
      const w = frame.toWorld(lon, lat);
      const seed = (f.properties.id * 0.618) % 1;
      if (t.highway === 'street_lamp') {
        const k = `${Math.floor(w.x / lampCell)}_${Math.floor(w.z / lampCell)}`; const arr = osmLamps.get(k); if (arr) arr.push([w.x, w.z]); else osmLamps.set(k, [[w.x, w.z]]);
        if (place(w.x, w.z, seed * Math.PI * 2, FurnitureKind.StreetLamp)) fromOsm++;
      }
      else if (t.amenity === 'bench') { if (place(w.x, w.z, seed * Math.PI * 2, FurnitureKind.Bench)) fromOsm++; }
      else if (t.barrier === 'bollard') { if (place(w.x, w.z, 0, FurnitureKind.Bollard, 0.9)) fromOsm++; }
      else if (t.advertising === 'column') { if (place(w.x, w.z, 0, FurnitureKind.MorrisColumn)) fromOsm++; }
      // Wallace fountains and the small drinking fountains share one mesh (the big basins are water polygons)
      else if (t.amenity === 'drinking_water' || (t.amenity === 'fountain' && t.fountain !== 'roundabout')) { if (place(w.x, w.z, seed * Math.PI * 2, FurnitureKind.Fountain, t.amenity === 'fountain' ? 1.15 : 1)) fromOsm++; }
      else if (t.railway === 'subway_entrance') { if (place(w.x, w.z, seed * Math.PI * 2, FurnitureKind.SubwayEntrance)) fromOsm++; }
      else if (t.highway === 'bus_stop' || t.amenity === 'shelter') { if (place(w.x, w.z, seed * Math.PI * 2, FurnitureKind.BusStop)) fromOsm++; }
      else if (t.amenity === 'bicycle_parking' || t.amenity === 'bicycle_rental') { if (place(w.x, w.z, seed * Math.PI * 2, FurnitureKind.BikeRack, t.amenity === 'bicycle_rental' ? 1.6 : 1)) fromOsm++; }
      else if (t.amenity === 'waste_basket') { if (place(w.x, w.z, seed * Math.PI * 2, FurnitureKind.WasteBasket)) fromOsm++; }
      else if (t.man_made === 'flagpole') { if (place(w.x, w.z, 0, FurnitureKind.Flagpole)) fromOsm++; }
      // Statues and memorials (the Liberty replica on the Ile aux Cygnes, the Flame of Liberty, park bronzes).
      // OSM rarely gives a height, so scale 1 is a ~4.5 m figure on a plinth and the tagged height overrides it.
      else if (t.man_made === 'statue' || t.historic === 'memorial' || t.tourism === 'artwork') {
        if (nearCurated(w.x, w.z) || nearHero(w.x, w.z)) continue;   // a hand-placed figure or a real model wins
        const h = parseFloat(t.height ?? '');
        if (place(w.x, w.z, seed * Math.PI * 2, FurnitureKind.Statue, Number.isFinite(h) && h > 1 ? Math.min(6, h / 4.5) : 1)) fromOsm++;
      }
    }
  }

  // Procedural lamps along streets: alternate sides, spacing by road class.
  let fromRoads = 0;
  const width = (t: Record<string, string>) => { const w = parseFloat(t.width ?? ''); if (w > 1) return w; const l = parseFloat(t.lanes ?? ''); if (l > 0) return l * 3.2; return ({ primary: 12, secondary: 10, tertiary: 8, residential: 6.5, unclassified: 6.5, living_street: 5, pedestrian: 6, service: 4 } as Record<string, number>)[t.highway] ?? 5; };
  for (const f of roads.features) {
    const t = f.properties.tags ?? {};
    if (f.geometry.type !== 'LineString' || !t.highway) continue;
    if (t.tunnel && t.tunnel !== 'no') continue;
    const cls = t.highway;
    const isStreet = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'pedestrian'].includes(cls);
    const isAlley = ['footway', 'path'].includes(cls) && (t.lit === 'yes' || t.name);
    if (!isStreet && !isAlley) continue;
    const spacing = isAlley ? 38 : cls === 'primary' || cls === 'secondary' ? 26 : 32;
    const off = width(t) / 2 + (isAlley ? 0.6 : 1.3);
    const pts: Pt[] = (f.geometry as LineString).coordinates.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; });
    let acc = spacing * 0.5, side = 1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const ux = dx / len, uz = dz / len;
      let d = spacing - acc;
      while (d <= len) {
        const px = ax + ux * d - uz * off * side, pz = az + uz * d + ux * off * side;
        const yaw = Math.atan2(-ux, -uz) + (side > 0 ? Math.PI / 2 : -Math.PI / 2);   // object -z -> (-sin r, -cos r): arm toward the road
        if (!nearOsmLamp(px, pz) && place(px, pz, yaw, FurnitureKind.StreetLamp, isAlley ? 0.85 : 1)) fromRoads++;
        side = -side;
        d += spacing;
      }
      acc = len - (d - spacing);
    }
  }
  // ---- parked cars along the kerb (both sides, ~55 % occupancy) and people on sidewalks / squares / parks
  const carCells = new Set<string>();
  const rnd = (a: number, b: number) => { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s); };
  const placeCar = (x: number, z: number, yaw: number, variant: number) => {
    if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return false;
    const y = hm.sample(x, z); if (y < waterLevelY + 0.8 || inBuilding(x, z)) return false;
    const k = `${Math.floor(x / 3)}_${Math.floor(z / 3)}`; if (carCells.has(k)) return false; carCells.add(k);
    rows.push(x, y, z, yaw, FurnitureKind.Car + variant, 1); return true;
  };
  let cars = 0, people = 0;
  const placePerson = (x: number, z: number, yaw: number, seed: number) => {
    if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return false;
    const y = hm.sample(x, z); if (y < waterLevelY + 0.8 || inBuilding(x, z)) return false;
    rows.push(x, y, z, yaw, FurnitureKind.Person + Math.floor(seed * 4) % 4, 0.92 + seed * 0.16); people++; return true;
  };
  for (const f of roads.features) {
    const t = f.properties.tags ?? {};
    if (f.geometry.type !== 'LineString' || !t.highway) continue;
    if ((t.tunnel && t.tunnel !== 'no') || (t.bridge && t.bridge !== 'no')) continue;
    const cls = t.highway;
    const pts: Pt[] = (f.geometry as LineString).coordinates.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; });
    const isStreet = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street'].includes(cls);
    const isWalk = ['footway', 'pedestrian', 'path', 'steps'].includes(cls) || isStreet;
    const half = width(t) / 2;
    const spec = classify(t);
    const parkingSides = spec?.parkingSides ?? 0;
    const flip = spec?.reverse ? -1 : 1; // parking side is defined relative to the way's forward direction
    let acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz); if (len < 0.01) continue;
      const ux = dx / len, uz = dz / len; const yaw = Math.atan2(-ux, -uz);   // a Y rotation r turns -z into (-sin r, -cos r)
      for (let d = 3 - acc; d < len; d += 6.2) {
        const px = ax + ux * d, pz = az + uz * d;
        const h = rnd(f.properties.id + i, d);
        if (isStreet && parkingSides > 0) {
          const side = parkingSides === 2 ? (h > 0.5 ? 1 : -1) : flip; // one side only: the right of the way direction
          if (rnd(d, f.properties.id) < 0.55) { if (placeCar(px - uz * (half - 1.05) * side, pz + ux * (half - 1.05) * side, yaw + (side > 0 ? 0 : Math.PI), Math.floor(rnd(px, pz) * 8))) cars++; }
        }
        if (isWalk && rnd(pz, px) < (isStreet ? 0.08 : 0.12)) {
          const off = isStreet ? half + 1.6 + rnd(px, d) * 1.5 : (rnd(px, d) - 0.5) * 2.5;
          const side = rnd(d, pz) > 0.5 ? 1 : -1;
          placePerson(px - uz * off * side, pz + ux * off * side, yaw + (rnd(px + d, pz) > 0.5 ? 0 : Math.PI) + (rnd(d, px) - 0.5) * 0.6, rnd(px * 3, pz * 5));
        }
      }
      acc = (len - (3 - acc)) % 6.2;
    }
  }
  // Crowds on squares and in parks (Trocadéro esplanade, Champ de Mars lawns).
  if (land) for (const f of land.features) {
    const t = f.properties.tags ?? {};
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    const isSquare = t.highway === 'pedestrian' || t.place === 'square';
    const isPark = t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass';
    if (!isSquare && !isPark) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const coords of polys) {
      const ring: Pt[] = coords[0].map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; });
      const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      const area = (x1 - x0) * (z1 - z0); if (area < 200 || area > 400000) continue;
      const n = Math.min(400, Math.floor(area / (isSquare ? 140 : 900)));
      for (let k = 0; k < n; k++) {
        const x = x0 + rnd(k, f.properties.id) * (x1 - x0), z = z0 + rnd(f.properties.id, k) * (z1 - z0);
        if (!pointInPoly(x, z, [ring])) continue;
        placePerson(x, z, rnd(x, z) * Math.PI * 2, rnd(z, x));
      }
    }
  }
  log.info(`furniture: ${cars} parked cars, ${people} people`);

  const arr = new Float32Array(rows);
  await fs.writeFile(path.join(OUT_DIR, 'furniture.bin'), Buffer.from(arr.buffer));
  log.info(`furniture: ${arr.length / FURNITURE_STRIDE} items (${fromOsm} from OSM points, ${fromRoads} lamps along streets)`);
  return { count: arr.length / FURNITURE_STRIDE, bytes: arr.byteLength };
}
