/**
 * Bake pipeline orchestrator.
 *   npm run bake                 # all steps (each skips if its outputs exist, unless --force)
 *   npm run bake -- --step=osm   # a single step (comma-separated for several)
 *   npm run bake -- --force
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './lib/log.ts';
import { CACHE_DIR, OUT_DIR, BBOX, BBOX_PADDED } from './config.ts';

export interface BakeContext {
  force: boolean;
  only: Set<string> | null;
}

type Step = { name: string; run: (ctx: BakeContext) => Promise<void> };

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
  { name: 'trees', run: async ctx => (await import('./lib/trees.ts')).run(ctx) },
  { name: 'eiffel', run: async ctx => (await import('./lib/eiffel.ts')).run(ctx) },
  { name: 'towerwalk', run: async ctx => (await import('./lib/eiffel_walk.ts')).run(ctx) },
  { name: 'models', run: async ctx => (await import('./lib/models.ts')).run(ctx) },
  { name: 'dsm', run: async ctx => (await import('./lib/dsm.ts')).run(ctx) },
  { name: 'build', run: async ctx => (await import('./lib/build.ts')).run(ctx) },
  { name: 'paths', run: async ctx => (await import('./lib/paths.ts')).run(ctx) },
  { name: 'deshadow', run: async ctx => (await import('./lib/deshadow.ts')).run(ctx) },
  { name: 'markings', run: async ctx => (await import('./lib/markings.ts')).run(ctx) },
  { name: 'streets', run: async ctx => (await import('./lib/streets.ts')).run(ctx) },
  { name: 'masks', run: async ctx => (await import('./lib/masks.ts')).run(ctx) },
  { name: 'far', run: async ctx => (await import('./lib/far.ts')).run(ctx) },
  { name: 'landmarks', run: async ctx => (await import('./lib/landmarks.ts')).run(ctx) },
];

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  log.info('bbox      ', JSON.stringify(BBOX));
  log.info('bbox (pad)', JSON.stringify(BBOX_PADDED));
  const ctx: BakeContext = { force, only };
  for (const s of steps) {
    if (only && !only.has(s.name)) continue;
    log.step(s.name);
    try {
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
