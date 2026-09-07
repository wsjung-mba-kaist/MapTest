import path from 'node:path';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { BBOX_PADDED, CACHE_DIR, WFS_BDTOPO, type LonLatBox } from '../config.ts';
import { exists, fetchRetry, readJson, writeJson } from './http.ts';

export interface BdTopoProps {
  cleabs: string;
  nature: string | null;
  usage_1: string | null;
  construction_legere: boolean | null;
  hauteur: number | null;
  altitude_minimale_sol: number | null;
  altitude_maximale_toit: number | null;
  nombre_d_etages: number | null;
  materiaux_de_la_toiture: string | null;
  precision_altimetrique: number | null;
  etat_de_l_objet?: string | null;
}
export type BdTopoFeature = Feature<Polygon | MultiPolygon, BdTopoProps>;

const dir = path.join(CACHE_DIR, 'bdtopo');
const PAGE = 5000;

export async function fetchLayer(typename: string, bbox: LonLatBox, tag: string, force: boolean, cql?: string): Promise<FeatureCollection<Polygon | MultiPolygon, BdTopoProps>> {
  const out = path.join(dir, `${tag}.geojson`);
  if (!force && await exists(out)) return readJson(out);
  const features: BdTopoFeature[] = [];
  for (let start = 0; ; start += PAGE) {
    const url = WFS_BDTOPO(typename, bbox, PAGE, start, cql);
    const res = await fetchRetry(url, { timeoutMs: 180_000, onRetry: (n, why) => log.warn(`wfs retry ${n}: ${why}`) });
    const fc = await res.json() as FeatureCollection<Polygon | MultiPolygon, BdTopoProps> & { numberMatched?: number };
    features.push(...fc.features);
    log.info(`bdtopo ${tag}: +${fc.features.length} (total ${features.length}${fc.numberMatched != null ? ` / ${fc.numberMatched}` : ''})`);
    if (fc.features.length < PAGE) break;
  }
  // Strip z from coordinates (z = roof altitude) to keep things 2D.
  for (const f of features) {
    const strip = (ring: number[][]) => ring.forEach(c => c.length = 2);
    if (f.geometry.type === 'Polygon') f.geometry.coordinates.forEach(strip);
    else f.geometry.coordinates.forEach(p => p.forEach(strip));
  }
  const result: FeatureCollection<Polygon | MultiPolygon, BdTopoProps> = { type: 'FeatureCollection', features };
  await writeJson(out, result);
  return result;
}

export async function loadBuildings(): Promise<FeatureCollection<Polygon | MultiPolygon, BdTopoProps>> {
  return readJson(path.join(dir, 'batiment.geojson'));
}

export async function run(ctx: BakeContext) {
  const fc = await fetchLayer('BDTOPO_V3:batiment', BBOX_PADDED, 'batiment', ctx.force);
  const withH = fc.features.filter(f => f.properties.hauteur != null && f.properties.hauteur > 0).length;
  const withRidge = fc.features.filter(f => f.properties.altitude_maximale_toit != null && f.properties.altitude_minimale_sol != null).length;
  log.info(`bdtopo: ${fc.features.length} buildings, ${withH} with hauteur, ${withRidge} with roof/ground altitudes`);
  const natures: Record<string, number> = {};
  for (const f of fc.features) { const k = f.properties.nature ?? 'null'; natures[k] = (natures[k] ?? 0) + 1; }
  log.info('bdtopo natures:', JSON.stringify(natures));
}
