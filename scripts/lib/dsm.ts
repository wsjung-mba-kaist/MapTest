import path from 'node:path';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { CACHE_DIR, DSM_MAX_PX, DSM_PAD_M, DSM_STEP_M, WMS_CAPABILITIES, WMS_DSM, WMS_DSM_LAYERS, type LonLatBox } from '../config.ts';
import { cachedText, exists, readJson, writeJson } from './http.ts';
import { loadTheme } from './overpass.ts';
import { loadBuildings } from './bdtopo.ts';
import { loadHeightmap } from './build.ts';
import { buildSpecs, type BuildingSpec } from './buildings.ts';
import { bboxOf } from './polygons.ts';
import { frame } from '../../shared/geo.ts';
import { fetchBil, nodataFraction } from './wmsgrid.ts';

/**
 * bake:dsm — download IGN LiDAR HD surface-model windows (50 cm float32 BIL) around every landmark footprint group.
 * Only the download lives here; `bake:build` turns the windows into roof caps (dsmroof.ts), so re-meshing needs no
 * network. Windows are cached under cache/dsm/, the list in cache/dsm/index.json.
 *   DSM=0          skip the step
 *   DSM_IDS=way/1,relation/2   force windows for extra buildings
 */

export interface DsmTile { box: LonLatBox; w: number; h: number; file: string }
export interface DsmWindow { group: string; ids: string[]; world: [number, number, number, number]; tiles: DsmTile[]; nodata: number }
export interface DsmIndex { layer: string; step: number; windows: DsmWindow[] }

export const DSM_DIR = path.join(CACHE_DIR, 'dsm');
export const DSM_INDEX = path.join(DSM_DIR, 'index.json');

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '_');

async function pickLayer(): Promise<string> {
  try {
    const caps = await cachedText(WMS_CAPABILITIES, 'dsm/capabilities.xml', { timeoutMs: 120_000, retries: 2 });
    for (const l of WMS_DSM_LAYERS) if (caps.includes(`<Name>${l}</Name>`)) return l;
    log.warn(`dsm: none of ${WMS_DSM_LAYERS.join(', ')} in the capabilities; trying the first anyway`);
  } catch (e) { log.warn(`dsm: capabilities unavailable (${e instanceof Error ? e.message.split('\n')[0] : e}); assuming ${WMS_DSM_LAYERS[0]}`); }
  return WMS_DSM_LAYERS[0];
}

/** Footprint groups (an outline with its parts, or a standalone landmark) that get a surface-model window. */
export function dsmGroups(specs: BuildingSpec[], extra: Set<string>): Map<string, BuildingSpec[]> {
  const groups = new Map<string, BuildingSpec[]>();
  for (const s of specs) {
    const wanted = s.landmark || extra.has(s.id) || (s.group && extra.has(s.group));
    if (!wanted) continue;
    const g = s.group ?? s.id;
    const arr = groups.get(g); if (arr) arr.push(s); else groups.set(g, [s]);
  }
  return groups;
}

export async function run(ctx: BakeContext) {
  if (process.env.DSM === '0') { log.info('dsm: skipped (DSM=0)'); return; }
  const extra = new Set((process.env.DSM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
  const hm = await loadHeightmap(true);
  const { specs } = buildSpecs(await loadTheme('buildings'), await loadBuildings(), hm);
  const groups = dsmGroups(specs, extra);
  const prev: DsmIndex | null = !ctx.force && await exists(DSM_INDEX) ? await readJson<DsmIndex>(DSM_INDEX) : null;
  const layer = prev?.layer ?? await pickLayer();
  log.info(`dsm: layer ${layer}, ${groups.size} landmark groups (${[...groups.values()].reduce((s, g) => s + g.length, 0)} footprints)`);
  const windows: DsmWindow[] = [];
  let fetched = 0, reused = 0, failed = 0;
  for (const [group, list] of groups) {
    const done = prev?.windows.find(w => w.group === group);
    if (done && list.every(s => done.ids.includes(s.id))) { windows.push(done); reused++; continue; }
    const [x0, z0, x1, z1] = bboxOf(list.flatMap(s => s.rings.flat().length ? [s.rings[0]] : []));
    const world: [number, number, number, number] = [x0 - DSM_PAD_M, z0 - DSM_PAD_M, x1 + DSM_PAD_M, z1 + DSM_PAD_M];
    const wM = world[2] - world[0], hM = world[3] - world[1];
    const nx = Math.ceil(wM / DSM_STEP_M / DSM_MAX_PX), nz = Math.ceil(hM / DSM_STEP_M / DSM_MAX_PX);
    const tiles: DsmTile[] = [];
    let nodata = 0, ok = true;
    for (let j = 0; j < nz && ok; j++) for (let i = 0; i < nx && ok; i++) {
      const tx0 = world[0] + (wM * i) / nx, tx1 = world[0] + (wM * (i + 1)) / nx;
      const tz0 = world[1] + (hM * j) / nz, tz1 = world[1] + (hM * (j + 1)) / nz;
      const w = Math.max(8, Math.round((tx1 - tx0) / DSM_STEP_M)), h = Math.max(8, Math.round((tz1 - tz0) / DSM_STEP_M));
      // world z runs south: the north edge of the tile is the smaller z
      const c = [frame.fromWorld(tx0, tz0), frame.fromWorld(tx1, tz0), frame.fromWorld(tx0, tz1), frame.fromWorld(tx1, tz1)];
      const box: LonLatBox = { west: Math.min(...c.map(p => p.lon)), east: Math.max(...c.map(p => p.lon)), south: Math.min(...c.map(p => p.lat)), north: Math.max(...c.map(p => p.lat)) };
      const file = `dsm/${slug(group)}_${i}_${j}.bin`;
      try {
        const g = await fetchBil(WMS_DSM(layer, box, w, h), file, w, h);
        nodata = Math.max(nodata, nodataFraction(g));
        tiles.push({ box, w, h, file });
      } catch (e) { log.warn(`dsm: ${group}: ${e instanceof Error ? e.message.split('\n')[0] : e}`); ok = false; }
    }
    if (!ok) { failed++; continue; }
    windows.push({ group, ids: list.map(s => s.id), world, tiles, nodata });
    fetched++;
    log.info(`dsm: ${group} (${list[0].name ?? list.length + ' parts'}): ${wM.toFixed(0)} x ${hM.toFixed(0)} m, ${tiles.length} tile(s), nodata ${(nodata * 100).toFixed(1)} %`);
  }
  await writeJson(DSM_INDEX, { layer, step: DSM_STEP_M, windows } satisfies DsmIndex);
  log.info(`dsm: ${windows.length} windows (${fetched} fetched, ${reused} reused, ${failed} failed) -> cache/dsm/index.json`);
}
