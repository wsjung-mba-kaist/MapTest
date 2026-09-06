import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Point } from 'geojson';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { OUT_DIR, PARIS_TREES } from '../config.ts';
import { cachedJson, exists, writeJson } from './http.ts';
import { loadTheme } from './overpass.ts';
import { loadHeightmap } from './build.ts';
import { frame, ORIGIN } from '../../shared/geo.ts';
import { TREE_STRIDE, TreeSpecies, WORLD_HALF } from '../../shared/layout.ts';

interface ParisTree {
  idbase?: number;
  libellefrancais?: string | null;
  genre?: string | null;
  espece?: string | null;
  hauteurenm?: number | null;
  circonferenceencm?: number | null;
  stadedeveloppement?: string | null;
  domanialite?: string | null;
  geo_point_2d?: { lon: number; lat: number } | null;
}

const GENUS: [RegExp, TreeSpecies][] = [
  [/platanus/i, TreeSpecies.Platanus], [/tilia/i, TreeSpecies.Tilia], [/aesculus/i, TreeSpecies.Aesculus],
  [/sophora|styphnolobium/i, TreeSpecies.Sophora], [/acer/i, TreeSpecies.Acer], [/celtis/i, TreeSpecies.Celtis],
];
const speciesOf = (genus: string | null | undefined): TreeSpecies => {
  for (const [re, s] of GENUS) if (genus && re.test(genus)) return s;
  return TreeSpecies.Other;
};
const stageHeight: Record<string, number> = { 'Jeune (arbre)': 5, 'Jeune (arbre)Adulte': 9, Adulte: 13, Mature: 17 };

export async function run(ctx: BakeContext) {
  const out = path.join(OUT_DIR, 'trees.bin');
  if (!ctx.force && await exists(out)) { log.info('trees: cached'); return; }
  const hm = await loadHeightmap();
  const radius = Math.ceil(Math.hypot(WORLD_HALF, WORLD_HALF)) + 50;
  const fc = await cachedJson<FeatureCollection<Point, ParisTree>>(PARIS_TREES(ORIGIN.lon, ORIGIN.lat, radius), 'paris/les-arbres.geojson', { timeoutMs: 300_000 });
  log.info(`trees: ${fc.features.length} Paris Data trees within ${radius} m`);

  const rows: number[] = [];
  const grid = new Map<string, number>(); // dedupe cell (4 m)
  const cellKey = (x: number, z: number) => `${Math.floor(x / 4)}_${Math.floor(z / 4)}`;
  const push = (x: number, z: number, h: number, circ: number, species: TreeSpecies, seed: number) => {
    if (Math.abs(x) > WORLD_HALF + 40 || Math.abs(z) > WORLD_HALF + 40) return false;
    const k = cellKey(x, z);
    if (grid.has(k)) return false;
    grid.set(k, rows.length / TREE_STRIDE);
    const y = hm.sample(x, z);
    const trunkR = Math.max(0.08, Math.min(0.9, circ / 100 / (2 * Math.PI)));
    rows.push(x, y, z, h, trunkR, species, seed);
    return true;
  };

  const stats: Record<string, number> = {};
  let n = 0;
  for (const f of fc.features) {
    const p = f.properties;
    const c = f.geometry?.coordinates ?? (p.geo_point_2d ? [p.geo_point_2d.lon, p.geo_point_2d.lat] : null);
    if (!c) continue;
    const w = frame.toWorld(c[0], c[1]);
    let h = p.hauteurenm ?? 0;
    if (!(h >= 2 && h <= 35)) h = stageHeight[p.stadedeveloppement ?? ''] ?? 10;
    let circ = p.circonferenceencm ?? 0;
    if (!(circ >= 20 && circ <= 600)) circ = 60 + h * 6;
    const sp = speciesOf(p.genre);
    const seed = ((p.idbase ?? n) * 2654435761) % 256;
    if (push(w.x, w.z, h, circ, sp, seed)) { n++; stats[TreeSpecies[sp]] = (stats[TreeSpecies[sp]] ?? 0) + 1; }
  }
  log.info(`trees: ${n} kept from Paris Data`, JSON.stringify(stats));

  // OSM natural=tree only where the city dataset has nothing within 4 m.
  try {
    const pts = await loadTheme('points');
    let added = 0;
    for (const f of pts.features) {
      if (f.geometry.type !== 'Point' || f.properties.tags?.natural !== 'tree') continue;
      const [lon, lat] = f.geometry.coordinates;
      const w = frame.toWorld(lon, lat);
      const near = [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]].some(([dx, dz]) => grid.has(cellKey(w.x + dx, w.z + dz)));
      if (near) continue;
      const h = parseFloat(f.properties.tags.height ?? '') || 9;
      const genus = f.properties.tags.genus ?? f.properties.tags.species ?? '';
      if (push(w.x, w.z, Math.min(30, Math.max(3, h)), 60 + h * 6, speciesOf(genus), (f.properties.id * 7919) % 256)) added++;
    }
    log.info(`trees: +${added} from OSM`);
  } catch { log.warn('trees: OSM points theme unavailable, skipping'); }

  const arr = new Float32Array(rows);
  await fs.writeFile(out, Buffer.from(arr.buffer));
  await writeJson(path.join(OUT_DIR, 'trees.json'), { count: arr.length / TREE_STRIDE, stride: TREE_STRIDE, species: Object.fromEntries(Object.entries(TreeSpecies).filter(([k]) => isNaN(Number(k)))) });
  log.info(`trees: wrote ${arr.length / TREE_STRIDE} trees`);
}
