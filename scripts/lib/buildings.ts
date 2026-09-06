import type { FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import { frame } from '../../shared/geo.ts';
import type { Heightmap } from '../../shared/heightmap.ts';
import { EIFFEL_OSM_WAY_ID, HAUSSMANN } from '../config.ts';
import type { OsmProps } from './overpass.ts';
import type { BdTopoProps } from './bdtopo.ts';
import { area, bboxOf, centroid, cleanRing, orient, pointInPoly, type Poly, type Pt, type Ring } from './polygons.ts';
import { log } from './log.ts';

export type RoofKind = 'flat' | 'mansard' | 'hipped' | 'gabled' | 'pyramidal';
export type HeightSource = 'osm' | 'bdtopo' | 'levels' | 'default';

export const enum Style { Haussmann = 0, Modern = 1, Stone = 2, Industrial = 3, Monument = 4 }

export interface BuildingSpec {
  id: string;
  rings: Poly;          // outer (negative signed area), holes (positive)
  centroid: Pt;
  area: number;
  minH: number;         // part start height above ground
  eave: number;
  ridge: number;
  groundY: number;      // min terrain y under the footprint
  roof: RoofKind;
  style: Style;
  tint: [number, number, number];
  /** Steep roof surface material (BD TOPO MAJIC code or OSM roof:material); the slope shader keys off the baked roof tint. */
  roofMat: 'zinc' | 'slate' | 'tile';
  levels: number;
  floorH: number;
  seed: number;
  source: HeightSource;
  isPart: boolean;
  isPlinth: boolean;
}

interface Bd { rings: Poly; area: number; bbox: [number, number, number, number]; p: BdTopoProps }

/** Parse "12", "12 m", "12.5m", "40 ft" -> metres. */
export function parseLen(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.trim().toLowerCase().replace(',', '.').match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|feet|')?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] && m[2] !== 'm' ? n * 0.3048 : n;
}
const parseNum = (v: string | undefined): number | null => { if (!v) return null; const n = parseFloat(v.replace(',', '.')); return Number.isFinite(n) ? n : null; };

const NAMED: Record<string, [number, number, number]> = {
  white: [235, 232, 225], beige: [222, 205, 170], cream: [232, 220, 190], grey: [160, 160, 160], gray: [160, 160, 160],
  brown: [130, 95, 65], red: [170, 70, 55], yellow: [220, 195, 110], black: [50, 50, 55], blue: [100, 120, 160], green: [95, 125, 90],
  sandstone: [214, 190, 150], limestone: [222, 212, 190], stone: [205, 198, 180], silver: [190, 192, 196],
};
export function parseColour(v: string | undefined): [number, number, number] | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  const hex = s.match(/^#?([0-9a-f]{6})$/);
  if (hex) return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)];
  const h3 = s.match(/^#?([0-9a-f]{3})$/);
  if (h3) return [parseInt(h3[1][0] + h3[1][0], 16), parseInt(h3[1][1] + h3[1][1], 16), parseInt(h3[1][2] + h3[1][2], 16)];
  return NAMED[s] ?? null;
}

function toWorldPolys(geom: Geometry): Poly[] {
  const conv = (ring: number[][]): Ring => cleanRing(ring.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; }));
  const polys: Poly[] = [];
  const push = (coords: number[][][]) => {
    const rings = coords.map(conv).filter(r => r.length >= 3);
    if (!rings.length) return;
    const outer = orient(rings[0], false);
    const holes = rings.slice(1).map(r => orient(r, true)).filter(r => area(r) > 1);
    polys.push([outer, ...holes]);
  };
  if (geom.type === 'Polygon') push(geom.coordinates);
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(push);
  return polys;
}

class GridIndex<T extends { bbox: [number, number, number, number] }> {
  private cells = new Map<string, T[]>();
  constructor(private readonly cell = 50) {}
  add(item: T) {
    const [x0, z0, x1, z1] = item.bbox;
    for (let i = Math.floor(x0 / this.cell); i <= Math.floor(x1 / this.cell); i++)
      for (let j = Math.floor(z0 / this.cell); j <= Math.floor(z1 / this.cell); j++) {
        const k = `${i}_${j}`; const arr = this.cells.get(k); if (arr) arr.push(item); else this.cells.set(k, [item]);
      }
  }
  at(x: number, z: number): T[] { return this.cells.get(`${Math.floor(x / this.cell)}_${Math.floor(z / this.cell)}`) ?? []; }
}

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 256; };

const RELIGIOUS = /glise|chapelle|cath|temple|synagogue|mosqu/i;
const MONUMENT = /monument|ch.teau|palais|mus|arc de|tour|fort|mairie|gare/i;

export function buildSpecs(osm: FeatureCollection<Geometry, OsmProps>, bd: FeatureCollection<Polygon | MultiPolygon, BdTopoProps>, hm: Heightmap): { specs: BuildingSpec[]; stats: Record<string, number> } {
  // ---- BD TOPO index
  const bdIndex = new GridIndex<Bd>(50);
  let bdCount = 0;
  for (const f of bd.features) {
    const p = f.properties;
    if (p.hauteur == null || p.hauteur < 2.5) continue;
    if (p.nature === 'Tour, donjon' && p.hauteur > 100) continue;
    for (const rings of toWorldPolys(f.geometry)) {
      const a = area(rings[0]); if (a < 4) continue;
      bdIndex.add({ rings, area: a, bbox: bboxOf(rings), p }); bdCount++;
    }
  }
  log.info(`buildings: ${bdCount} BD TOPO polygons indexed`);

  const stats: Record<string, number> = { osm: 0, bdtopo: 0, levels: 0, default: 0, skipped: 0, parts: 0, plinths: 0, mansard: 0, flat: 0, other: 0, eiffel: 0 };
  const raw: (BuildingSpec & { tags: Record<string, string> })[] = [];

  // The tower itself is a separate 3D model: drop its footprint and every part/platform mapped inside it.
  const eiffelWay = osm.features.find(f => f.properties.type === 'way' && f.properties.id === EIFFEL_OSM_WAY_ID);
  const eiffelRings = eiffelWay ? toWorldPolys(eiffelWay.geometry)[0] : null;
  const inEiffel = (x: number, z: number) => !!eiffelRings && Math.hypot(x, z) < 90 && pointInPoly(x, z, [eiffelRings[0]]);

  for (const f of osm.features) {
    const { tags, type, id } = f.properties;
    if (!tags) continue;
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    if (type === 'way' && id === EIFFEL_OSM_WAY_ID) continue;
    const isPart = !!tags['building:part'] && tags['building:part'] !== 'no';
    const isBuilding = !!tags.building && tags.building !== 'no';
    if (!isPart && !isBuilding) continue;
    if (tags.man_made === 'tower' && (parseLen(tags.height) ?? 0) > 100) continue;
    if (tags.building === 'roof' || tags.building === 'shelter' || tags.building === 'carport') continue;
    if (tags.layer && parseFloat(tags.layer) < 0) continue;
    if (tags.location === 'underground' || tags.building === 'underground') continue;

    for (const rings of toWorldPolys(f.geometry)) {
      const a = area(rings[0]);
      if (a < 4) { stats.skipped++; continue; }
      const c = centroid(rings[0]);
      if (inEiffel(c[0], c[1])) { stats.eiffel++; continue; }
      // Ground level under the footprint.
      let gy = Infinity;
      for (const r of rings) for (const [x, z] of r) gy = Math.min(gy, hm.sample(x, z));
      gy = Math.min(gy, hm.sample(c[0], c[1]));

      // ---- height cascade
      const levelsTag = parseNum(tags['building:levels']);
      const roofLevels = parseNum(tags['roof:levels']) ?? 0;
      const heightTag = parseLen(tags.height);
      const roofHeightTag = parseLen(tags['roof:height']);
      const shapeTag = (tags['roof:shape'] ?? '').toLowerCase();
      let eave = 0, ridge = 0, source: HeightSource = 'default', bdp: BdTopoProps | null = null;
      if (heightTag != null && heightTag > 1.5) {
        // OSM "height" is the total height including the roof.
        ridge = heightTag;
        const flatish = shapeTag === 'flat' || shapeTag === 'skillion';
        if (roofHeightTag != null) eave = Math.max(2, ridge - roofHeightTag);
        else if (flatish) eave = ridge;
        else if (shapeTag === '') eave = ridge > 12 && a >= 40 ? ridge - Math.max(3.5, Math.min(6, ridge * 0.22)) : ridge;
        else eave = Math.max(2, ridge - 4.5);
        source = 'osm';
      } else {
        // BD TOPO match on 5 samples.
        const [bx0, bz0, bx1, bz1] = bboxOf([rings[0]]);
        const hx = (bx1 - bx0) * 0.3, hz = (bz1 - bz0) * 0.3;
        const candidates: Pt[] = [c, [c[0] - hx, c[1] - hz], [c[0] + hx, c[1] - hz], [c[0] - hx, c[1] + hz], [c[0] + hx, c[1] + hz]];
        const samples = candidates.filter(p => pointInPoly(p[0], p[1], rings));
        const votes = new Map<Bd, number>();
        for (const s of samples) for (const cand of bdIndex.at(s[0], s[1])) if (pointInPoly(s[0], s[1], cand.rings)) votes.set(cand, (votes.get(cand) ?? 0) + 1);
        let best: Bd | null = null, bestV = 0;
        for (const [k, v] of votes) if (v > bestV) { best = k; bestV = v; }
        if (best && bestV >= Math.min(2, samples.length)) {
          const ratio = best.area / a;
          if (ratio > 1 / 3 && ratio < 3 || bestV >= 4) bdp = best.p;
        }
        if (bdp) {
          // BD TOPO "hauteur" is measured to the gutter (eave). Ridge altitudes are almost never filled in Paris,
          // so a typical Parisian mansard (roughly 30 % of the eave height, 3.5-6 m) is inferred below.
          eave = bdp.hauteur!;
          const rr = bdp.altitude_maximale_toit != null && bdp.altitude_minimale_sol != null ? bdp.altitude_maximale_toit - bdp.altitude_minimale_sol : NaN;
          if (Number.isFinite(rr) && rr >= eave) ridge = Math.min(rr, eave + 12);
          else {
            const light = bdp.construction_legere || (bdp.usage_1 ?? '').toLowerCase().includes('industriel');
            const mansardOk = !light && eave >= 9 && eave <= 40 && a >= 40 && shapeTag !== 'flat';
            ridge = mansardOk ? eave + Math.max(3.5, Math.min(6.0, eave * 0.3)) : eave;
          }
          source = 'bdtopo';
        } else if (levelsTag != null && levelsTag > 0) {
          eave = HAUSSMANN.groundFloor + (levelsTag - 1) * HAUSSMANN.floor;
          ridge = eave + (roofLevels > 0 ? roofLevels * HAUSSMANN.floor : levelsTag >= 4 ? 5.5 : 0);
          source = 'levels';
        } else {
          eave = HAUSSMANN.defaultEave; ridge = HAUSSMANN.defaultRidge; source = 'default';
        }
      }
      if (isPart && tags['building:min_level'] == null && tags.min_height == null && source === 'bdtopo') { /* keep */ }
      let minH = parseLen(tags.min_height) ?? 0;
      const minLevel = parseNum(tags['building:min_level']);
      if (!minH && minLevel != null && minLevel > 0) minH = HAUSSMANN.groundFloor + (minLevel - 1) * HAUSSMANN.floor;
      if (minH >= eave) minH = 0;

      // ---- roof kind
      let roof: RoofKind;
      const usage = (bdp?.usage_1 ?? '').toLowerCase();
      const nature = bdp?.nature ?? '';
      if (['flat', 'skillion'].includes(shapeTag)) roof = 'flat';
      else if (shapeTag === 'mansard') roof = 'mansard';
      else if (shapeTag === 'gabled' || shapeTag === 'round') roof = 'gabled';
      else if (shapeTag === 'hipped' || shapeTag === 'dome' || shapeTag === 'half-hipped') roof = 'hipped';
      else if (shapeTag === 'pyramidal') roof = 'pyramidal';
      else if (RELIGIOUS.test(nature) || RELIGIOUS.test(tags.building ?? '')) roof = 'gabled';
      else if (bdp?.construction_legere || usage.includes('industriel')) roof = 'flat';
      else if (ridge - eave > HAUSSMANN.minMansardDelta) roof = 'mansard';
      else if (source === 'default' || (source === 'levels' && (levelsTag ?? 0) >= 4)) roof = 'mansard';
      else roof = 'flat';
      if (roof !== 'flat' && ridge - eave < 1.5) ridge = eave + (roof === 'mansard' ? 5.0 : 4.0);
      if (roof === 'flat') ridge = eave;
      if (a < 25 && roof === 'mansard') { roof = 'flat'; ridge = eave; }

      // ---- style & tint
      const bdLevels = bdp?.nombre_d_etages != null && bdp.nombre_d_etages > 0 && bdp.nombre_d_etages < 60 ? bdp.nombre_d_etages : null;
      const levels = levelsTag != null && levelsTag > 0 ? levelsTag : bdLevels ?? Math.max(1, Math.round((eave - HAUSSMANN.groundFloor) / HAUSSMANN.floor) + 1);
      const floorH = levels > 1 ? (eave - HAUSSMANN.groundFloor) / (levels - 1) : eave;
      const material = (tags['building:material'] ?? '').toLowerCase();
      let style: Style = Style.Haussmann;
      if (levels > 10 || eave > 36 || material.includes('glass') || material.includes('metal')) style = Style.Modern;
      else if (usage.includes('industriel') || bdp?.construction_legere || tags.building === 'industrial' || tags.building === 'warehouse') style = Style.Industrial;
      else if (RELIGIOUS.test(nature) || MONUMENT.test(nature) || tags.historic || tags.tourism === 'museum' || tags.amenity === 'place_of_worship') style = Style.Monument;
      else if (tags['building:levels'] && levels <= 3) style = Style.Stone;
      const seed = hash(`${type}/${id}`);
      const defaults: Record<number, [number, number, number]> = {
        [Style.Haussmann]: [224, 212, 186], [Style.Modern]: [150, 160, 170], [Style.Stone]: [206, 196, 172], [Style.Industrial]: [180, 176, 168], [Style.Monument]: [218, 208, 184],
      };
      let tint = parseColour(tags['building:colour']) ?? defaults[style];
      if (!tags['building:colour']) { const v = ((seed % 21) - 10) * 1.2; tint = [tint[0] + v, tint[1] + v * 0.8, tint[2] + v * 0.5].map(c => Math.max(0, Math.min(255, Math.round(c)))) as [number, number, number]; }

      // BD TOPO roof material is a two-digit MAJIC code: main material then secondary (1 tiles, 2 slate, 3 zinc, 4 concrete, 9 other).
      // Haussmann mansards are mostly "23": slate on the steep brisis, zinc on the terrasson, so any slate digit wins for the slopes.
      const rm = bdp?.materiaux_de_la_toiture ?? '';
      const osmRoofMat = (tags['roof:material'] ?? '').toLowerCase();
      let roofMat: 'zinc' | 'slate' | 'tile' = 'zinc';
      if (osmRoofMat.includes('slate')) roofMat = 'slate';
      else if (osmRoofMat.includes('tile')) roofMat = 'tile';
      else if (osmRoofMat.includes('metal') || osmRoofMat.includes('zinc')) roofMat = 'zinc';
      else if (rm[0] === '2' || rm[1] === '2') roofMat = 'slate';
      else if (rm[0] === '1') roofMat = 'tile';
      if (style === Style.Modern || style === Style.Industrial) roofMat = 'zinc';

      raw.push({
        id: `${type}/${id}`, rings, centroid: c, area: a, minH, eave, ridge, groundY: gy, roof, style, tint, roofMat, levels, floorH, seed, source, isPart, isPlinth: false, tags,
      });
    }
  }

  // ---- part / outline resolution
  const parts = raw.filter(b => b.isPart);
  const partIndex = new GridIndex<{ bbox: [number, number, number, number]; b: BuildingSpec }>(50);
  for (const p of parts) partIndex.add({ bbox: bboxOf([p.rings[0]]), b: p });
  const specs: BuildingSpec[] = [];
  for (const b of raw) {
    if (b.isPart) { stats.parts++; specs.push(b); continue; }
    const rel = (b as any).tags && (Array.isArray((b as any).relations) ? (b as any).relations : null);
    void rel;
    const [x0, z0, x1, z1] = bboxOf([b.rings[0]]);
    const inside: BuildingSpec[] = [];
    const seen = new Set<BuildingSpec>();
    for (let x = x0; x <= x1 + 50; x += 50) for (let z = z0; z <= z1 + 50; z += 50)
      for (const cand of partIndex.at(x, z)) {
        if (seen.has(cand.b)) continue; seen.add(cand.b);
        if (pointInPoly(cand.b.centroid[0], cand.b.centroid[1], b.rings)) inside.push(cand.b);
      }
    if (inside.length) {
      const plinth = Math.max(2.5, Math.min(...inside.map(p => (p.minH > 0 ? p.minH : p.eave))));
      b.isPlinth = true; b.eave = Math.min(b.eave, plinth); b.ridge = b.eave; b.roof = 'flat'; stats.plinths++;
    }
    specs.push(b);
  }
  for (const s of specs) { stats[s.source]++; if (s.roof === 'mansard') stats.mansard++; else if (s.roof === 'flat') stats.flat++; else stats.other++; }
  for (const s of specs) delete (s as any).tags;
  return { specs, stats };
}
