import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { FeatureCollection, Geometry, LineString, MultiPolygon, Polygon } from 'geojson';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { OUT_DIR } from '../config.ts';
import { ensureDir, exists } from './http.ts';
import { loadTheme, type OsmProps } from './overpass.ts';
import { frame } from '../../shared/geo.ts';
import { GRID_N, MASK_PX, ORTHO_MARGIN, ORTHO_TILE_M, chunkKey, chunkOrigin } from '../../shared/layout.ts';
import type { Pt } from './polygons.ts';

/**
 * Ground surface masks per chunk (RGBA PNG, same extent as the ortho tile):
 *   R = road carriageway, G = paved (sidewalks, squares), B = grass/vegetation,
 *   A = gravel/sand paths at 0.38 (#606060) and pavé (sett / cobbles / paving_stones carriageways) at 1.0 — pavé also
 *   carries R, so the runtime reads A > 0.6 with R as stone paving and A ~ 0.38 without R as gravel.
 * Rasterised from OSM roads and landcover with sharp's SVG renderer.
 */

type Ch = 'R' | 'G' | 'B' | 'A' | 'P';
interface Line { pts: Pt[]; width: number; channel: Ch }
interface Area { rings: Pt[][]; channel: Ch }
const PAVE_SURF = /sett|cobble|unhewn/;
const PAVE_ROAD_SURF = /sett|cobble|unhewn|paving_stones/;

const GRAVEL_SURF = /gravel|compacted|ground|dirt|sand|unpaved|earth|fine_gravel|pebble/;
const PAVED_SURF = /asphalt|paving|concrete|sett|paved|cobble|stone|wood|metal/;

function carriageway(t: Record<string, string>): number {
  const w = parseFloat(t.width ?? ''); if (w > 1) return w;
  const lanes = parseFloat(t.lanes ?? ''); if (lanes > 0) return lanes * 3.2;
  switch (t.highway) {
    case 'motorway': case 'trunk': return 14; case 'primary': return 12; case 'secondary': return 10; case 'tertiary': return 8;
    case 'residential': case 'unclassified': return 6.5; case 'living_street': return 5; case 'service': return 4;
    case 'pedestrian': return 6; case 'footway': case 'path': case 'cycleway': case 'bridleway': return 2.6; case 'steps': return 2.2;
    default: return 5;
  }
}

function toPts(coords: number[][]): Pt[] { return coords.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; }); }
function polysOf(g: Polygon | MultiPolygon): Pt[][][] { return g.type === 'Polygon' ? [g.coordinates.map(toPts)] : g.coordinates.map(p => p.map(toPts)); }

export async function run(ctx: BakeContext) {
  const outDir = path.join(OUT_DIR, 'ground', 'mask');
  await ensureDir(outDir);
  const roads = await loadTheme('roads');
  const land = await loadTheme('landcover');
  const parks: Pt[][][] = [];
  const lines: Line[] = [];
  const areas: Area[] = [];

  for (const f of land.features) {
    const t = f.properties.tags ?? {};
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    const polys = polysOf(f.geometry);
    const surface = t.surface ?? '';
    let ch: Area['channel'] | null = null;
    if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'flowerbed' || t.landuse === 'cemetery' || t.landuse === 'forest' || t.natural === 'wood' || t.natural === 'grassland' || t.natural === 'scrub' || t.leisure === 'pitch' && !surface) ch = 'B';
    if (t.leisure === 'park' || t.leisure === 'garden') parks.push(...polys);
    if (t.highway === 'pedestrian' || t.place === 'square') ch = GRAVEL_SURF.test(surface) ? 'A' : 'G';
    if (t.amenity === 'parking') ch = 'R';
    if (GRAVEL_SURF.test(surface)) ch = 'A'; else if (PAVED_SURF.test(surface) && t.leisure !== 'park') ch = PAVE_SURF.test(surface) ? 'P' : 'G';
    if (t.leisure === 'playground') ch = 'A';
    if (!ch) continue;
    for (const rings of polys) areas.push({ rings, channel: ch });
  }
  const inPark = (p: Pt) => parks.some(poly => pointInRings(p, poly));
  for (const f of roads.features) {
    const t = f.properties.tags ?? {};
    if (!t.highway || t.highway === 'proposed' || t.highway === 'construction') continue;
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.layer && parseFloat(t.layer) < 0) continue;
    if (f.geometry.type === 'LineString') {
      const pts = toPts((f.geometry as LineString).coordinates);
      const w = carriageway(t);
      const surface = t.surface ?? '';
      const foot = ['footway', 'path', 'cycleway', 'steps', 'bridleway', 'pedestrian'].includes(t.highway);
      if (foot) {
        const gravel = GRAVEL_SURF.test(surface) || (!PAVED_SURF.test(surface) && inPark(pts[Math.floor(pts.length / 2)]));
        lines.push({ pts, width: w, channel: gravel ? 'A' : 'G' });
      } else {
        lines.push({ pts, width: w + 4.5, channel: 'G' }); // sidewalks
        lines.push({ pts, width: w, channel: PAVE_ROAD_SURF.test(surface) ? 'P' : 'R' });   // 702 sett + 651 paving_stones ways in this area
      }
    } else if ((f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') && t.area === 'yes') {
      const ch: Area['channel'] = t.highway === 'pedestrian' || t.highway === 'footway' ? (GRAVEL_SURF.test(t.surface ?? '') ? 'A' : 'G') : 'R';
      for (const rings of polysOf(f.geometry)) areas.push({ rings, channel: ch });
    }
  }
  log.info(`masks: ${lines.length} road lines, ${areas.length} areas, ${parks.length} park polygons`);

  const scale = MASK_PX / ORTHO_TILE_M;
  let written = 0, skipped = 0;
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
    const out = path.join(outDir, `${chunkKey(i, j)}.png`);
    if (!ctx.force && await exists(out)) { skipped++; continue; }
    const o = chunkOrigin(i, j);
    const x0 = o.x - ORTHO_MARGIN, z0 = o.z - ORTHO_MARGIN, x1 = x0 + ORTHO_TILE_M, z1 = z0 + ORTHO_TILE_M;
    const px = (p: Pt) => `${((p[0] - x0) * scale).toFixed(1)},${((p[1] - z0) * scale).toFixed(1)}`;
    const inBox = (pts: Pt[]) => pts.some(p => p[0] > x0 - 20 && p[0] < x1 + 20 && p[1] > z0 - 20 && p[1] < z1 + 20);
    const svgFor = (ch: Ch) => {
      const parts: string[] = [];
      // pavé ('P') is painted into R (it is a carriageway) and into A at full white, above the grey gravel
      const passes: [Ch, string][] = ch === 'A' ? [['A', '#606060'], ['P', 'white']] : ch === 'R' ? [['R', 'white'], ['P', 'white']] : [[ch, 'white']];
      for (const [want, col] of passes) {
        for (const a of areas) if (a.channel === want && inBox(a.rings[0])) parts.push(`<path fill="${col}" fill-rule="evenodd" d="${a.rings.map(r => 'M' + r.map(px).join('L') + 'Z').join('')}"/>`);
        for (const l of lines) if (l.channel === want && inBox(l.pts)) parts.push(`<polyline fill="none" stroke="${col}" stroke-width="${(l.width * scale).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" points="${l.pts.map(px).join(' ')}"/>`);
      }
      return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${MASK_PX}" height="${MASK_PX}" viewBox="0 0 ${MASK_PX} ${MASK_PX}"><rect width="100%" height="100%" fill="black"/>${parts.join('')}</svg>`);
    };
    const chans = await Promise.all((['R', 'G', 'B', 'A'] as Ch[]).map(ch => sharp(svgFor(ch)).greyscale().raw().toBuffer()));
    const rgba = Buffer.alloc(MASK_PX * MASK_PX * 4);
    for (let k = 0; k < MASK_PX * MASK_PX; k++) { rgba[k * 4] = chans[0][k]; rgba[k * 4 + 1] = chans[1][k]; rgba[k * 4 + 2] = chans[2][k]; rgba[k * 4 + 3] = chans[3][k]; }
    await sharp(rgba, { raw: { width: MASK_PX, height: MASK_PX, channels: 4 } }).png({ compressionLevel: 8 }).toFile(out);
    written++;
  }
  log.info(`masks: ${written} written, ${skipped} cached`);
  void fs;
}

function pointInRings(p: Pt, poly: Pt[][]): boolean {
  const inRing = (r: Pt[]) => { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) ins = !ins; } return ins; };
  if (!inRing(poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(poly[k])) return false;
  return true;
}
void (0 as unknown as Geometry); void (0 as unknown as FeatureCollection<Geometry, OsmProps>);
