import type { FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import { frame } from '../../shared/geo.ts';
import type { Heightmap } from '../../shared/heightmap.ts';
import { HAUSSMANN, ROOF_OVERRIDES } from '../config.ts';
import { LANDMARK_MODELS } from '../landmarks_models.ts';
import { heroFootprints, inHero } from './landmarks_footprints.ts';
import type { OsmProps } from './overpass.ts';
import type { BdTopoProps } from './bdtopo.ts';
import { area, bboxOf, centroid, cleanRing, minAreaRect, orient, pointInPoly, type MinRect, type Poly, type Pt, type Ring } from './polygons.ts';
import { log } from './log.ts';

export type RoofKind = 'flat' | 'mansard' | 'hipped' | 'gabled' | 'pyramidal' | 'dome' | 'onion' | 'cone' | 'round' | 'skillion';
/** roof kinds drawn as a surface of revolution over the footprint (no flat top) */
export const CURVED_ROOFS: ReadonlySet<RoofKind> = new Set<RoofKind>(['dome', 'onion', 'cone']);
export type HeightSource = 'osm' | 'bdtopo' | 'levels' | 'default';

export const enum Style { Haussmann = 0, Modern = 1, Stone = 2, Industrial = 3, Monument = 4 }

/** Roof surface material; the id travels in the roof vertices' meta.z and picks the shader branch. */
export type RoofMat = 'zinc' | 'slate' | 'tile' | 'copper' | 'lead' | 'glass' | 'gilded' | 'painted';
export const ROOF_MAT_ID: Record<RoofMat, number> = { zinc: 0, slate: 1, tile: 2, copper: 3, lead: 4, glass: 5, gilded: 6, painted: 7 };
export const ROOF_TINT: Record<RoofMat, [number, number, number]> = {
  zinc: [128, 134, 140], slate: [74, 80, 92], tile: [168, 104, 78], copper: [96, 150, 128], lead: [92, 94, 98], glass: [120, 140, 158], gilded: [222, 178, 80], painted: [150, 150, 150],
};

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
  /** Steep roof surface material (BD TOPO MAJIC code or OSM roof:material / roof:colour). */
  roofMat: RoofMat;
  roofMatId: number;
  roofTint: [number, number, number];
  /** roof:direction as a bearing (deg): the way a gable / barrel end faces, or the down-slope of a skillion */
  roofDir: number | null;
  roofOrient: 'along' | 'across' | null;
  /** minimum-area rectangle of the outer ring (dome ellipses, ridge axes, hero-model fits) */
  rect: MinRect;
  levels: number;
  floorH: number;
  seed: number;
  source: HeightSource;
  isPart: boolean;
  isPlinth: boolean;
  /** moored boat / pontoon: sits on the water, not on the river bed, and never gets a Haussmann roof */
  floating: boolean;
  /** notable building: gets the DSM roof cap and the hero-model checks */
  landmark: boolean;
  /** the outline id a landmark part belongs to (DSM windows are fetched per group) */
  group?: string;
  name?: string;
  wikidata?: string;
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

const COMPASS: Record<string, number> = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
/** roof:direction: degrees or a compass point -> bearing in [0, 360). */
export function parseDirection(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim().toUpperCase();
  if (s in COMPASS) return COMPASS[s];
  const n = parseFloat(s);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null;
}

const NAMED: Record<string, [number, number, number]> = {
  white: [235, 232, 225], beige: [222, 205, 170], cream: [232, 220, 190], grey: [160, 160, 160], gray: [160, 160, 160],
  brown: [130, 95, 65], red: [170, 70, 55], yellow: [220, 195, 110], black: [50, 50, 55], blue: [100, 120, 160], green: [95, 125, 90],
  sandstone: [214, 190, 150], limestone: [222, 212, 190], stone: [205, 198, 180], silver: [190, 192, 196], gold: [222, 178, 80], golden: [222, 178, 80],
  copper: [96, 150, 128], darkgrey: [90, 90, 95], darkgray: [90, 90, 95], lightgrey: [200, 200, 205], lightgray: [200, 200, 205], orange: [210, 130, 60],
};
export function parseColour(v: string | undefined): [number, number, number] | null {
  if (!v) return null;
  const s = v.trim().toLowerCase().replace(/[\s_-]/g, '');
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
const RELIGIOUS_BUILDING = /^(church|cathedral|chapel|basilica|temple|synagogue|mosque|monastery|convent)$/;
const CIVIC_BUILDING = /^(palace|museum|government|public|civic|castle|pavilion|train_station|university|theatre|hotel_particulier|city_hall|townhall)$/;
const MONUMENT_NAME = /monument|ch.teau|palais|mus.e|arc de|mairie|gare|h.tel des|.cole militaire|unesco|grand palais|petit palais|minist.re|ambassade|th..tre|cath.drale|.glise|chapelle|basilique|temple|synagogue|op.ra|biblioth.que|conseil|assembl.e|s.nat|invalides|conservatoire|institut/i;
const RESIDENTIAL = /^(apartments|residential|house|terrace|detached|semidetached_house|dormitory|bungalow)$/;

/** Style from OSM tags and the BD TOPO nature/usage; `landmark` gates the DSM cap and hero-model checks. */
export function classify(tags: Record<string, string>, nature: string, usage: string, light: boolean, levels: number, eave: number, area: number, ridge: number): { style: Style; landmark: boolean } {
  const material = (tags['building:material'] ?? '').toLowerCase();
  const b = tags.building ?? '';
  const religious = RELIGIOUS.test(nature) || RELIGIOUS_BUILDING.test(b) || tags.amenity === 'place_of_worship';
  const civic = MONUMENT.test(nature) || CIVIC_BUILDING.test(b) || ['attraction', 'museum', 'gallery'].includes(tags.tourism ?? '') || ['townhall', 'theatre'].includes(tags.amenity ?? '');
  // listed / historic buildings get the monument facade; a bare wikidata tag (hospitals, schools, offices) does not,
  // but such a building still counts as a landmark for the surface-model roof when it is big
  const notable = (!!tags.heritage || !!tags.historic) && !RESIDENTIAL.test(b);
  const named = !!tags.name && MONUMENT_NAME.test(tags.name) && !RESIDENTIAL.test(b);
  const monumental = religious || civic || named || notable;
  // A landmark of the Trente Glorieuses is not a masonry palace. The Maison de la Radio (start_date 1963) is a
  // smooth aluminium curtain wall, and the monument facade hung a stone cornice, a balustrade and a pilaster at
  // every bay on it: 40 m piers that stood out of the LiDAR cap as a radial comb of dark fins round the crown.
  // It stays a landmark either way - that is what gates the surface-model roof - it just is not made of stone.
  const postwar = Number((tags.start_date ?? '').slice(0, 4)) >= 1945;
  let style: Style = Style.Haussmann;
  if (monumental) style = postwar ? Style.Modern : Style.Monument;
  else if (levels > 10 || eave > 36 || material.includes('glass') || material.includes('metal')) style = Style.Modern;
  else if (usage.includes('industriel') || light || b === 'industrial' || b === 'warehouse') style = Style.Industrial;
  else if (tags['building:levels'] && levels <= 3) style = Style.Stone;
  const landmark = (monumental && (area >= 400 || ridge >= 25 || !!tags.wikidata)) || (!!tags.wikidata && !RESIDENTIAL.test(b) && area >= 400);
  return { style, landmark };
}

function mapShape(s: string): RoofKind | null {
  switch (s) {
    case 'flat': return 'flat';
    case 'skillion': return 'skillion';
    case 'mansard': case 'gambrel': return 'mansard';
    case 'gabled': return 'gabled';
    case 'round': return 'round';
    case 'hipped': case 'half-hipped': return 'hipped';
    case 'dome': return 'dome';
    case 'onion': return 'onion';
    case 'cone': return 'cone';
    case 'pyramidal': return 'pyramidal';
    default: return null;
  }
}

/** Roof rise when the tags give none, from the footprint's short side. */
export function defaultRise(kind: RoofKind, minor: number, available: number): number {
  let r: number;
  switch (kind) {
    case 'dome': r = 0.5 * minor; break;
    case 'onion': r = 0.9 * minor; break;
    case 'cone': r = 0.8 * minor; break;
    case 'round': r = 0.5 * minor; break;
    case 'pyramidal': r = 0.6 * minor; break;
    case 'skillion': r = Math.max(1, Math.min(4, 0.15 * minor)); break;
    case 'mansard': r = 5; break;
    case 'flat': return 0;
    default: r = Math.min(4.5, Math.tan(Math.PI / 5) * minor / 2); break;
  }
  return Math.max(1, Math.min(r, Math.max(1, available - 0.5)));
}

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

  const stats: Record<string, number> = { osm: 0, bdtopo: 0, levels: 0, default: 0, skipped: 0, parts: 0, plinths: 0, mansard: 0, flat: 0, other: 0, curved: 0, eiffel: 0, monument: 0, landmark: 0 };
  const raw: (BuildingSpec & { tags: Record<string, string> })[] = [];

  // Hero models (the tower, and whatever else scripts/landmarks_models.ts lists) replace their footprints: drop the
  // outline and every part / platform mapped inside it.
  const hero = heroFootprints(osm);
  const isHeroRef = (type: string, id: number) => LANDMARK_MODELS.some(m => m.osm.some(r => r.type === type && r.id === id));

  for (const f of osm.features) {
    const { tags, type, id } = f.properties;
    if (!tags) continue;
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    if (isHeroRef(type, id)) continue;
    const isPart = !!tags['building:part'] && tags['building:part'] !== 'no';
    const isBuilding = !!tags.building && tags.building !== 'no';
    if (!isPart && !isBuilding) continue;
    if (tags.man_made === 'tower' && (parseLen(tags.height) ?? 0) > 100) continue;
    if (tags.building === 'roof' || tags.building === 'shelter' || tags.building === 'carport') continue;
    // roof-only parts without walls (canopies, the tower's arch skirts mapped as skillion roofs) are not buildings
    if (tags['building:part'] === 'roof' || tags.wall === 'no') continue;
    if (tags.layer && parseFloat(tags.layer) < 0) continue;
    if (tags.location === 'underground' || tags.building === 'underground') continue;
    const osmId = `${type}/${id}`;
    const override = ROOF_OVERRIDES[osmId] ?? {};
    // Moored boats and pontoons are tagged as buildings but carry no height, and BD TOPO does not know them, so
    // the cascade below handed them the Haussmann default: a barge became an 18.5 m mansard block, half-sunk.
    const floating = tags.building === 'houseboat' || tags.building === 'boat' || tags.floating === 'yes' || tags.man_made === 'pier';

    for (const rings of toWorldPolys(f.geometry)) {
      const a = area(rings[0]);
      if (a < 4) { stats.skipped++; continue; }
      const c = centroid(rings[0]);
      if (inHero(hero, c[0], c[1])) { stats.eiffel++; continue; }
      const rect = minAreaRect(rings[0]);
      const minor = Math.max(1, Math.min(rect.w, rect.h));
      // Ground level under the footprint. A strict minimum latches onto any DTM pit the outline happens to touch —
      // at Beaugrenelle the sunken Front-de-Seine roadway is 9 m below the deck above it, which dropped two large
      // footprints about 5 m and buried their walls. Take a low percentile, and never stray far below the centre.
      const groundSamples: number[] = [];
      for (const r of rings) for (const [x, z] of r) groundSamples.push(hm.sample(x, z));
      const cSample = hm.sample(c[0], c[1]);
      groundSamples.push(cSample);
      groundSamples.sort((p, q) => p - q);
      let gy = groundSamples[Math.floor(groundSamples.length * 0.1)] ?? cSample;
      gy = Math.max(Math.min(gy, cSample), groundSamples[0], cSample - 3);

      // ---- part start height
      let minH = parseLen(tags.min_height) ?? 0;
      const minLevel = parseNum(tags['building:min_level']);
      if (!minH && minLevel != null && minLevel > 0) minH = HAUSSMANN.groundFloor + (minLevel - 1) * HAUSSMANN.floor;

      // ---- roof tags
      const levelsTag = parseNum(tags['building:levels']);
      const roofLevels = parseNum(tags['roof:levels']) ?? 0;
      const heightTag = parseLen(tags.height);
      const roofHeightTag = parseLen(tags['roof:height']);
      const shapeTag = (override.shape ?? tags['roof:shape'] ?? '').toLowerCase();
      const kindTag = mapShape(shapeTag);
      const roofDir = parseDirection(tags['roof:direction']);
      const orientTag = (tags['roof:orientation'] ?? '').toLowerCase();
      const roofOrient: BuildingSpec['roofOrient'] = orientTag === 'across' ? 'across' : orientTag === 'along' ? 'along' : null;
      const roofAngle = parseNum(tags['roof:angle']);
      const angleRise = roofAngle != null && roofAngle > 3 && roofAngle < 85 ? Math.tan((roofAngle * Math.PI) / 180) * minor / 2 : null;
      const shapedRise = (available: number) => roofHeightTag ?? angleRise ?? (kindTag ? defaultRise(kindTag, minor, available) : 4.5);

      // ---- height cascade
      let eave = 0, ridge = 0, source: HeightSource = 'default', bdp: BdTopoProps | null = null;
      let lowDefault = false;   // an untagged footprint too small or too narrow to be an apartment block
      if (heightTag != null && heightTag > 1.5) {
        // OSM "height" is the total height including the roof.
        ridge = heightTag;
        const flatish = kindTag === 'flat';
        let rise: number;
        if (roofHeightTag != null) rise = roofHeightTag;
        else if (flatish) rise = 0;
        else if (kindTag) rise = angleRise ?? defaultRise(kindTag, minor, ridge - minH);
        else rise = ridge > 12 && a >= 40 ? Math.max(3.5, Math.min(6, ridge * 0.22)) : 0;
        eave = Math.max(minH + 0.5, ridge - rise);
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
            const mansardOk = !light && eave >= 9 && eave <= 40 && a >= 40 && kindTag !== 'flat';
            ridge = mansardOk ? eave + Math.max(3.5, Math.min(6.0, eave * 0.3)) : eave;
          }
          source = 'bdtopo';
        } else if (levelsTag != null && levelsTag > 0) {
          eave = HAUSSMANN.groundFloor + (levelsTag - 1) * HAUSSMANN.floor;
          ridge = eave + (roofLevels > 0 ? roofLevels * HAUSSMANN.floor : levelsTag >= 4 ? 5.5 : 0);
          source = 'levels';
        } else {
          eave = HAUSSMANN.defaultEave; ridge = HAUSSMANN.defaultRidge; source = 'default';
          // A cadastre polygon carrying nothing but `building=yes` is not automatically a six-storey block. Half of
          // the 1317 that reach here are under 80 m2 and 696 are strips under 4 m wide: light wells, lift shafts,
          // bin stores, sheds traced off the cadastre. Four of them at the foot of the Eiffel Tower (10 to 57 m2,
          // one of them 0.4 m wide) stood in front of it as 24 m mansard blocks. Give the full default only to a
          // footprint that could hold flats, and fall to a single storey below that.
          const fit = Math.min(Math.max((a - 50) / 150, 0), 1) * Math.min(Math.max((minor - 3) / 4, 0), 1);
          if (fit < 1) { eave = HAUSSMANN.groundFloor + (HAUSSMANN.defaultEave - HAUSSMANN.groundFloor) * fit; ridge = eave; lowDefault = true; }
        }
        if (floating && source === 'default') {
          // A hull with a deckhouse: low and flat, a little taller for the bigger barges.
          eave = a > 300 ? 3.6 : 2.8; ridge = eave;
        }
        // a tagged shape without an OSM height: the eave above is the gutter, the roof sits on top of it
        if (kindTag && kindTag !== 'flat' && (CURVED_ROOFS.has(kindTag) || kindTag === 'round' || kindTag === 'pyramidal' || kindTag === 'skillion' || roofHeightTag != null || angleRise != null)) ridge = eave + shapedRise(eave + 40);
      }
      if (minH >= ridge - 0.5) minH = 0;

      // ---- roof kind
      let roof: RoofKind;
      const usage = (bdp?.usage_1 ?? '').toLowerCase();
      const nature = bdp?.nature ?? '';
      const noHoles = rings.length === 1;
      if (kindTag === 'dome' || kindTag === 'onion' || kindTag === 'cone' || kindTag === 'pyramidal') roof = noHoles ? kindTag : 'hipped';
      else if (kindTag) roof = kindTag;
      else if (RELIGIOUS.test(nature) || RELIGIOUS_BUILDING.test(tags.building ?? '')) roof = 'gabled';
      else if (bdp?.construction_legere || usage.includes('industriel')) roof = 'flat';
      else if (ridge - eave > HAUSSMANN.minMansardDelta) roof = 'mansard';
      else if (lowDefault) roof = 'flat';   // a shed gets a shed's roof, not a mansard raised on top of it
      else if (source === 'default' || (source === 'levels' && (levelsTag ?? 0) >= 4)) roof = 'mansard';
      else roof = 'flat';
      if (roof !== 'flat' && ridge - eave < 1.5) ridge = eave + (roof === 'mansard' ? 5.0 : CURVED_ROOFS.has(roof) || roof === 'round' ? Math.max(1.5, defaultRise(roof, minor, 40)) : 4.0);
      if (floating) { roof = 'flat'; ridge = eave; }
      if (roof === 'flat') ridge = eave;
      if (a < 25 && roof === 'mansard') { roof = 'flat'; ridge = eave; }
      if (a < 6 && (CURVED_ROOFS.has(roof) || roof === 'round')) { roof = 'flat'; ridge = eave; }

      // ---- style & tint
      const bdLevels = bdp?.nombre_d_etages != null && bdp.nombre_d_etages > 0 && bdp.nombre_d_etages < 60 ? bdp.nombre_d_etages : null;
      const levels = levelsTag != null && levelsTag > 0 ? levelsTag : bdLevels ?? Math.max(1, Math.round((eave - HAUSSMANN.groundFloor) / HAUSSMANN.floor) + 1);
      const floorH = levels > 1 ? (eave - HAUSSMANN.groundFloor) / (levels - 1) : eave;
      const { style, landmark } = classify(tags, nature, usage, !!bdp?.construction_legere, levels, eave, a, ridge);
      const seed = hash(osmId);
      const defaults: Record<number, [number, number, number]> = {
        [Style.Haussmann]: [224, 212, 186], [Style.Modern]: [150, 160, 170], [Style.Stone]: [206, 196, 172], [Style.Industrial]: [180, 176, 168], [Style.Monument]: [222, 214, 196],
      };
      const colourTag = tags['building:colour'] ?? tags['building:facade:colour'];
      let tint = parseColour(colourTag) ?? defaults[style];
      if (!colourTag) { const v = ((seed % 21) - 10) * (style === Style.Monument ? 0.6 : 1.2); tint = [tint[0] + v, tint[1] + v * 0.8, tint[2] + v * 0.5].map(c => Math.max(0, Math.min(255, Math.round(c)))) as [number, number, number]; }

      // ---- roof material: OSM roof:material / roof:colour first, then the BD TOPO MAJIC code (two digits: main then
      // secondary material; 1 tiles, 2 slate, 3 zinc, 4 concrete, 9 other). Haussmann mansards are mostly "23": slate
      // on the steep brisis, zinc on the terrasson, so any slate digit wins for the slopes.
      const rm = bdp?.materiaux_de_la_toiture ?? '';
      const osmRoofMat = (override.material ?? tags['roof:material'] ?? '').toLowerCase();
      const roofColourTag = override.colour ?? tags['roof:colour'];
      const roofColour = parseColour(roofColourTag);
      let roofMat: RoofMat | null = null;
      if (/slate|ardoise/.test(osmRoofMat)) roofMat = 'slate';
      else if (/tile|tuile/.test(osmRoofMat)) roofMat = 'tile';
      else if (/copper|cuivre|verdigris/.test(osmRoofMat)) roofMat = 'copper';
      else if (/lead|plomb/.test(osmRoofMat)) roofMat = 'lead';
      else if (/glass|verre/.test(osmRoofMat)) roofMat = 'glass';
      else if (/gold|gilded|or$|dor/.test(osmRoofMat)) roofMat = 'gilded';
      else if (/metal|zinc/.test(osmRoofMat)) roofMat = 'zinc';
      if (!roofMat && roofColour) roofMat = /gold|dor/i.test(roofColourTag ?? '') ? 'gilded' : 'painted';
      if (!roofMat) {
        if (rm[0] === '2' || rm[1] === '2') roofMat = 'slate';
        else if (rm[0] === '1') roofMat = 'tile';
        else roofMat = 'zinc';
        if (style === Style.Modern || style === Style.Industrial) roofMat = 'zinc';
      }
      const roofTint: [number, number, number] = roofColour && roofMat !== 'gilded' ? roofColour : roofMat === 'zinc' && style === Style.Modern ? [120, 125, 130] : ROOF_TINT[roofMat];

      raw.push({
        id: osmId, rings, centroid: c, area: a, minH, eave, ridge, groundY: gy, roof, style, tint, roofMat, roofMatId: ROOF_MAT_ID[roofMat], roofTint,
        roofDir, roofOrient, rect, levels, floorH, seed, source, isPart, isPlinth: false, floating, landmark, name: tags.name, wikidata: tags.wikidata, tags,
      });
    }
  }

  // ---- part / outline resolution
  const parts = raw.filter(b => b.isPart);
  const partIndex = new GridIndex<{ bbox: [number, number, number, number]; b: BuildingSpec & { tags: Record<string, string> } }>(50);
  for (const p of parts) partIndex.add({ bbox: bboxOf([p.rings[0]]), b: p });
  const specs: BuildingSpec[] = [];
  for (const b of raw) {
    if (b.isPart) { stats.parts++; specs.push(b); continue; }
    const [x0, z0, x1, z1] = bboxOf([b.rings[0]]);
    const inside: (BuildingSpec & { tags: Record<string, string> })[] = [];
    const seen = new Set<BuildingSpec>();
    for (let x = x0; x <= x1 + 50; x += 50) for (let z = z0; z <= z1 + 50; z += 50)
      for (const cand of partIndex.at(x, z)) {
        if (seen.has(cand.b)) continue; seen.add(cand.b);
        if (pointInPoly(cand.b.centroid[0], cand.b.centroid[1], b.rings)) inside.push(cand.b);
      }
    if (inside.length) {
      // Only parts that actually carry the massing decide the plinth. A single small annex used to squash the whole
      // outline: at the Palais de Chaillot a 41 m2 one-storey building (0.6 % of a 7507 m2 wing) pulled the wing's
      // eave down to 4.3 m and threw away its tagged height of 30 m. That clipped 70 % of the LiDAR roof samples
      // (8.6 m of roof, mean), left the west facade 7 m tall beside an 18 m east facade, and flagged every wall as
      // plinth stone so the palace got no cornice, balustrade or pilaster at all.
      const bulk = inside.filter(p => p.area >= b.area * 0.02);
      if (bulk.length) {
        const plinth = Math.max(2.5, Math.min(...bulk.map(p => (p.minH > 0 ? p.minH : p.eave))));
        b.isPlinth = true; b.eave = Math.min(b.eave, plinth); b.ridge = b.eave; b.roof = 'flat'; stats.plinths++;
      }
      // the parts of a landmark are the landmark: its facade style, its name and (unless they say otherwise) its colour
      if (b.landmark || b.style === Style.Monument) for (const p of inside) {
        p.style = b.style; p.landmark = p.landmark || b.landmark;
        p.name = p.name ?? b.name; p.wikidata = p.wikidata ?? b.wikidata;
        p.group = b.id;
        if (!p.tags['building:colour'] && !p.tags['building:facade:colour']) p.tint = b.tint;
      }
    }
    specs.push(b);
  }
  for (const s of specs) if (s.landmark && !s.group) s.group = s.id;
  for (const s of specs) {
    stats[s.source]++;
    if (s.roof === 'mansard') stats.mansard++; else if (s.roof === 'flat') stats.flat++; else if (CURVED_ROOFS.has(s.roof) || s.roof === 'round') stats.curved++; else stats.other++;
    if (s.style === Style.Monument) stats.monument++;
    if (s.landmark) stats.landmark++;
  }
  for (const s of specs) delete (s as any).tags;
  return { specs, stats };
}
