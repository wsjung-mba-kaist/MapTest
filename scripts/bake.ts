/**
 * Bake pipeline orchestrator.
 *   npm run bake                 # all steps (each skips if its outputs exist, unless --force)
 *   npm run bake -- --step=osm   # a single step (comma-separated for several)
 *   npm run bake -- --force
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './lib/log.ts';
import { exists } from './lib/http.ts';
import { CACHE_DIR, OUT_DIR, ROOT, BBOX, BBOX_PADDED } from './config.ts';

export interface BakeContext {
  force: boolean;
  only: Set<string> | null;
}

/** `requires`: repo-relative files the step reads unconditionally (its optional inputs are not listed); checked before `run`. */
type Step = { name: string; requires?: string[]; run: (ctx: BakeContext) => Promise<void> };

/**
 * Which step writes each prerequisite, for the error message. Only files a later step reads without a fallback are
 * listed here; `cache/` files count too, since `build` and friends run entirely from the cache.
 */
const PRODUCED_BY: Record<string, string> = {
  'cache/osm/buildings.geojson': 'osm', 'cache/osm/roads.geojson': 'osm', 'cache/osm/water.geojson': 'osm', 'cache/osm/landcover.geojson': 'osm',
  'cache/bdtopo/batiment.geojson': 'bdtopo',
  'public/data/terrain.json': 'terrain', 'public/data/terrain.bin': 'terrain',
  'public/data/ground/ground.json': 'ortho', 'public/data/ground/overview.jpg': 'ortho',
  'public/models/eiffel.glb': 'eiffel',
  'public/data/manifest.json': 'build',
};
const osm = (theme: string) => `cache/osm/${theme}.geojson`;
const BDTOPO = 'cache/bdtopo/batiment.geojson';
/** loadHeightmap() in lib/build.ts reads both: the meta and the Int16 grid */
const TERRAIN = ['public/data/terrain.json', 'public/data/terrain.bin'];
const MANIFEST = 'public/data/manifest.json';

const args = process.argv.slice(2);
const force = args.includes('--force');
const stepArgs = args.filter(a => a.startsWith('--step=')).map(a => a.slice(7));
const only = stepArgs.length ? new Set(stepArgs.flatMap(s => s.split(','))) : null;

const steps: Step[] = [
  { name: 'assets', run: async ctx => (await import('./lib/assets.ts')).run(ctx) },
  { name: 'osm', run: async ctx => (await import('./lib/overpass.ts')).run(ctx) },
  { name: 'bdtopo', run: async ctx => (await import('./lib/bdtopo.ts')).run(ctx) },
  { name: 'terrain', run: async ctx => (await import('./lib/terrain.ts')).run(ctx) },
  { name: 'ortho', run: async ctx => (await import('./lib/ortho.ts')).run(ctx) },
  // ortho, eiffel, models and trees take the OSM themes they use through a try/catch (degraded output, not a failure)
  { name: 'trees', requires: TERRAIN, run: async ctx => (await import('./lib/trees.ts')).run(ctx) },
  { name: 'eiffel', run: async ctx => (await import('./lib/eiffel.ts')).run(ctx) },
  { name: 'towerwalk', requires: ['public/models/eiffel.glb'], run: async ctx => (await import('./lib/eiffel_walk.ts')).run(ctx) },
  { name: 'models', run: async ctx => (await import('./lib/models.ts')).run(ctx) },
  { name: 'dsm', requires: [...TERRAIN, osm('buildings'), BDTOPO], run: async ctx => (await import('./lib/dsm.ts')).run(ctx) },
  { name: 'build', requires: [...TERRAIN, osm('buildings'), osm('water'), osm('roads'), BDTOPO], run: async ctx => (await import('./lib/build.ts')).run(ctx) },
  { name: 'paths', requires: [MANIFEST, ...TERRAIN, osm('roads'), osm('water'), osm('landcover')], run: async ctx => (await import('./lib/paths.ts')).run(ctx) },
  { name: 'deshadow', requires: ['public/data/ground/overview.jpg', 'public/data/ground/ground.json', ...TERRAIN, osm('buildings'), BDTOPO], run: async ctx => (await import('./lib/deshadow.ts')).run(ctx) },
  { name: 'markings', requires: [MANIFEST, ...TERRAIN, osm('roads'), osm('water')], run: async ctx => (await import('./lib/markings.ts')).run(ctx) },
  { name: 'streets', requires: [MANIFEST, ...TERRAIN, osm('roads'), osm('water'), osm('landcover')], run: async ctx => (await import('./lib/streets.ts')).run(ctx) },
  { name: 'masks', requires: [osm('roads'), osm('landcover')], run: async ctx => (await import('./lib/masks.ts')).run(ctx) },
  { name: 'far', run: async ctx => (await import('./lib/far.ts')).run(ctx) },
  { name: 'landmarks', run: async ctx => (await import('./lib/landmarks.ts')).run(ctx) },
];

/** Throws naming every missing prerequisite and the step that writes it; the step's own file reads would fail later with a bare ENOENT. */
async function checkRequires(step: Step) {
  const missing: string[] = [];
  for (const rel of step.requires ?? []) if (!await exists(path.join(ROOT, rel))) missing.push(rel);
  if (missing.length) throw new Error(missing.map(rel => `${step.name} needs ${rel} — run npm run bake:${PRODUCED_BY[rel] ?? '?'} first`).join('\n'));
}

async function main() {
  // a typo in --step= used to run nothing and exit 0, which reads as "cached"
  const unknown = [...(only ?? [])].filter(n => !steps.some(s => s.name === n));
  if (unknown.length) throw new Error(`unknown step(s) ${unknown.join(', ')}; valid: ${steps.map(s => s.name).join(', ')}`);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  log.info('bbox      ', JSON.stringify(BBOX));
  log.info('bbox (pad)', JSON.stringify(BBOX_PADDED));
  const ctx: BakeContext = { force, only };
  for (const s of steps) {
    if (only && !only.has(s.name)) continue;
    log.step(s.name);
    try {
      await checkRequires(s);   // inside the try: under `npm run bake` a step whose producer failed logs and the rest continue
      await s.run(ctx);
    } catch (e) {
      log.warn(`step "${s.name}" failed:`, e instanceof Error ? e.stack ?? e.message : e);
      process.exitCode = 1;
      if (only) throw e;
      log.warn('continuing with remaining steps');
    }
  }
  log.info('done ->', path.relative(process.cwd(), OUT_DIR));
}

main().catch(e => { console.error(e); process.exit(1); });
