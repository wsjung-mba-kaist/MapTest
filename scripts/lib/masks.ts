import path from 'node:path';
import sharp from 'sharp';
import type { LineString } from 'geojson';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { OUT_DIR } from '../config.ts';
import { ensureDir, exists } from './http.ts';
import { loadTheme } from './overpass.ts';
import { GRID_N, MASK_PX, ORTHO_MARGIN, ORTHO_TILE_M, chunkKey, chunkOrigin } from '../../shared/layout.ts';
import { pointInPoly, toWorldPolysRaw, toWorldPts, type Pt } from './polygons.ts';
import { carriagewayWidth } from './roadnet.ts';

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
    const polys = toWorldPolysRaw(f.geometry);
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
  const inPark = (p: Pt) => parks.some(poly => pointInPoly(p[0], p[1], poly));
  for (const f of roads.features) {
    const t = f.properties.tags ?? {};
    if (!t.highway || t.highway === 'proposed' || t.highway === 'construction') continue;
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.layer && parseFloat(t.layer) < 0) continue;
    if (f.geometry.type === 'LineString') {
      const pts = toWorldPts((f.geometry as LineString).coordinates);
      const w = carriagewayWidth(t);   // the same carriageway the slabs and lane markings use, so the R channel matches them
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
      for (const rings of toWorldPolysRaw(f.geometry)) areas.push({ rings, channel: ch });
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
}
