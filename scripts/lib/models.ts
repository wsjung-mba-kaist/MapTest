import fs from 'node:fs/promises';
import path from 'node:path';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { MODELS_DIR } from '../config.ts';
import { cachedBytes, ensureDir, exists, readJson, writeJson } from './http.ts';
import { loadTheme } from './overpass.ts';
import { LANDMARK_MODELS, licenseAllowed } from '../landmarks_models.ts';
import { heroFootprints } from './landmarks_footprints.ts';
import { processModel } from './model_fit.ts';

/**
 * bake:models — every hero model of the registry (scripts/landmarks_models.ts) except the tower, which keeps its
 * own step (bake:eiffel, tower-specific fitting). Writes public/models/{id}.glb, {id}_lod.glb, {id}.json and the
 * index public/models/landmarks.json that the runtime loads.
 */
export async function run(ctx: BakeContext) {
  await ensureDir(MODELS_DIR);
  const osm = await loadTheme('buildings').catch(() => null);
  const feet = osm ? heroFootprints(osm) : [];
  const index: { id: string; glb: string; lod?: string; json: string }[] = [];
  for (const entry of LANDMARK_MODELS) {
    const glb = path.join(MODELS_DIR, `${entry.id}.glb`), json = path.join(MODELS_DIR, `${entry.id}.json`), lod = path.join(MODELS_DIR, `${entry.id}_lod.glb`);
    if (entry.id === 'eiffel') {
      if (await exists(glb) && await exists(json)) index.push({ id: 'eiffel', glb: 'eiffel.glb', json: 'eiffel.json' });
      else log.warn('models: eiffel.glb missing (npm run bake:eiffel)');
      continue;
    }
    if (!licenseAllowed(entry.credits.license)) { log.warn(`models: ${entry.id}: licence "${entry.credits.license}" is not free for redistribution; skipped (ALLOW_NONFREE=1 overrides)`); continue; }
    if (!ctx.force && await exists(glb) && await exists(json)) { index.push({ id: entry.id, glb: `${entry.id}.glb`, lod: await exists(lod) ? `${entry.id}_lod.glb` : undefined, json: `${entry.id}.json` }); log.info(`models: ${entry.id}: cached`); continue; }
    const foot = feet.find(f => f.id === entry.id);
    if (!foot) { log.warn(`models: ${entry.id}: OSM footprint not in the cached buildings theme; skipped`); continue; }
    let src = path.join(MODELS_DIR, entry.source);
    if (/^https?:\/\//.test(entry.source)) {
      const buf = await cachedBytes(entry.source, `models/${entry.id}_src.glb`, { timeoutMs: 600_000 });
      src = path.join(MODELS_DIR, `${entry.id}_src.glb`);
      await fs.writeFile(src, buf);
    }
    if (!await exists(src)) { log.warn(`models: ${entry.id}: source ${entry.source} not found in public/models; skipped`); continue; }
    try {
      const r = await processModel(src, entry, { rect: foot.rect, centre: foot.centre, radius: foot.radius }, glb, lod, json);
      index.push({ id: entry.id, glb: `${entry.id}.glb`, lod: `${entry.id}_lod.glb`, json: `${entry.id}.json` });
      log.info(`models: ${entry.id}: ${r.tris} tris, ${r.height.toFixed(1)} m, yaw ${r.yawDeg.toFixed(1)}° -> public/models/${entry.id}.glb`);
    } catch (e) { log.warn(`models: ${entry.id} failed: ${e instanceof Error ? e.message : e}`); }
  }
  const prev = await readJson<{ models: typeof index }>(path.join(MODELS_DIR, 'landmarks.json')).catch(() => null);
  void prev;
  await writeJson(path.join(MODELS_DIR, 'landmarks.json'), { version: 1, models: index });
  log.info(`models: index with ${index.length} model(s) -> public/models/landmarks.json`);
}
