/**
 * Validate the committed public/data against the readers of this build: the manifest frame, every PBM1 file
 * (version, alignment, bounds, expected sections), the raw Float32 side files (stride) and the landmarks / paths
 * versions. Run it after a bake or after touching anything in shared/ — it is the "the data and the code still agree"
 * check that a rebake cannot give when cache/ is not around.
 *
 *   npm run verify:data
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseBinMesh } from '../shared/binmesh.ts';
import { CHUNK_SIZE, DETAIL_STRIDE, FURNITURE_STRIDE, GRID_N, LANDMARKS_VERSION, MANIFEST_VERSION, TREE_STRIDE, WORLD_HALF, chunkKey, type LandmarksData, type Manifest } from '../shared/layout.ts';
import { DATUM_ALT } from '../shared/geo.ts';
import { PATHS_VERSION, type PathsMeta } from '../shared/paths.ts';
import { Heightmap } from '../shared/heightmap.ts';

const DATA = path.resolve('public/data');
const problems: string[] = [];
const bad = (s: string) => { problems.push(s); console.error(`  ✗ ${s}`); };
const ok = (s: string) => console.log(`  ✓ ${s}`);
const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

async function pbm(rel: string, sections?: string[]) {
  try {
    const { header, arrays } = parseBinMesh(ab(await readFile(path.join(DATA, rel))), rel);
    for (const s of sections ?? []) if (!arrays.has(s)) bad(`${rel}: section '${s}' missing (has ${[...arrays.keys()].join(', ')})`);
    return { header, arrays };
  } catch (e) { bad(`${rel}: ${e instanceof Error ? e.message : e}`); return null; }
}

async function main() {
  console.log('manifest');
  const m = JSON.parse(await readFile(path.join(DATA, 'manifest.json'), 'utf8')) as Manifest;
  if (m.version !== MANIFEST_VERSION) bad(`manifest version ${m.version} != ${MANIFEST_VERSION}`);
  if (m.worldHalf !== WORLD_HALF || m.chunkSize !== CHUNK_SIZE || m.gridN !== GRID_N) bad(`manifest grid ${m.worldHalf}/${m.chunkSize}/${m.gridN}`);
  if (Math.abs(m.datumAlt - DATUM_ALT) > 1e-9) bad(`manifest datumAlt ${m.datumAlt} != ${DATUM_ALT}`);
  if (!m.chunks || Object.keys(m.chunks).length !== GRID_N * GRID_N) bad(`manifest.chunks has ${Object.keys(m.chunks ?? {}).length} entries, expected ${GRID_N * GRID_N}`);
  ok(`version ${m.version}, grid ${m.gridN}×${m.chunkSize} m, ${Object.keys(m.counts).length} counts, ${Object.keys(m.files).length} files`);

  console.log('terrain');
  const tmeta = JSON.parse(await readFile(path.join(DATA, 'terrain.json'), 'utf8')) as { n: number; step: number; origin: number };
  for (const f of ['terrain.bin', 'terrain_raw.bin']) {
    const b = await readFile(path.join(DATA, f)).catch(() => null);
    if (!b) { if (f === 'terrain.bin') bad(`${f} missing`); continue; }
    if (b.length !== tmeta.n * tmeta.n * 2) bad(`${f}: ${b.length} bytes, expected ${tmeta.n}² × 2`);
    else { const hm = Heightmap.fromBuffer(ab(b), tmeta); ok(`${f}: ${tmeta.n}² samples, y(0,0) = ${hm.sample(0, 0).toFixed(2)} m, meshY = ${hm.meshY(0, 0).toFixed(2)} m`); }
  }

  console.log('chunks');
  let chunks = 0, dsm = 0, tris = 0;
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
    const k = chunkKey(i, j);
    const r = await pbm(`chunks/${k}.bin`, ['walls', 'roofs', 'tops', 'lod']);
    if (!r) continue;
    chunks++;
    if (r.arrays.has('dsm')) dsm++;
    for (const s of r.header.sections) tris += s.indexCount / 3;
    const info = m.chunks?.[k];
    if (info && info.tris !== undefined) {
      const own = ['walls', 'roofs', 'tops', 'dsm'].reduce((n, s) => n + (r.header.sections.find(x => x.name === s)?.indexCount ?? 0) / 3, 0);
      if (own !== info.tris) bad(`chunks/${k}.bin: ${own} tris, manifest says ${info.tris}`);
    }
    const det = await readFile(path.join(DATA, `details/${k}.bin`)).catch(() => null);
    if (det && det.length % (DETAIL_STRIDE * 4)) bad(`details/${k}.bin: ${det.length} bytes is not a multiple of DETAIL_STRIDE × 4`);
  }
  ok(`${chunks}/${GRID_N * GRID_N} chunks parse, ${dsm} with a LiDAR cap, ${(tris / 1e6).toFixed(2)} M triangles in all`);
  // the format is fine either way, so only the bake's own count can tell a run that silently lost landmark caps
  const dsmFailed = m.counts.dsmFailed ?? 0;
  if (dsmFailed > 0) bad(`manifest counts.dsmFailed = ${dsmFailed}: landmark groups baked without their LiDAR cap; rerun npm run bake:dsm, then bake:build`);
  const pointsMissing = m.counts.pointsMissingCells ?? 0;
  if (pointsMissing > 0) bad(`manifest counts.pointsMissingCells = ${pointsMissing}: furniture baked without part of the OSM points theme; rerun npm run bake:osm (it resumes the missing cells), then bake:build`);

  console.log('side files');
  for (const [f, stride] of [['trees.bin', TREE_STRIDE], ['furniture.bin', FURNITURE_STRIDE]] as const) {
    const b = await readFile(path.join(DATA, f)).catch(() => null);
    if (!b) { bad(`${f} missing`); continue; }
    if (b.length % (stride * 4)) bad(`${f}: ${b.length} bytes is not a multiple of stride ${stride} × 4`); else ok(`${f}: ${b.length / (stride * 4)} rows`);
  }
  for (const [f, secs] of [['water.bin', []], ['bridges.bin', []], ['far.bin', ['far']]] as [string, string[]][]) {
    const r = await pbm(f, secs);
    if (r) ok(`${f}: ${r.header.sections.map(s => `${s.name} ${s.vertexCount}v`).join(', ')}`);
  }
  const p = await pbm('paths.bin', ['nodes', 'adj', 'edges', 'verts']);
  if (p) {
    const meta = p.header.meta as unknown as PathsMeta;
    if (meta?.version !== PATHS_VERSION) bad(`paths.bin version ${meta?.version} != ${PATHS_VERSION}`); else ok(`paths.bin: v${meta.version}, ${meta.nodes} nodes, ${meta.edges} edges`);
  }
  for (const dir of ['streets', 'marks']) {
    const files = (await readdir(path.join(DATA, dir)).catch(() => [] as string[])).filter(f => f.endsWith('.bin'));
    let n = 0; for (const f of files) if (await pbm(`${dir}/${f}`)) n++;
    ok(`${dir}/: ${n}/${files.length} files parse`);
  }
  const lm = JSON.parse(await readFile(path.join(DATA, 'landmarks.json'), 'utf8').catch(() => 'null')) as LandmarksData | null;
  if (!lm) bad('landmarks.json missing');
  else if (lm.version !== LANDMARKS_VERSION) bad(`landmarks.json version ${lm.version} != ${LANDMARKS_VERSION}`);
  else { const empty = lm.landmarks.filter(l => !l.desc && !l.image).length; ok(`landmarks.json: v${lm.version}, ${lm.landmarks.length} sites, ${empty} without description or photo`); if (empty > lm.landmarks.length / 2) bad(`landmarks.json looks like an offline bake (${empty} empty entries)`); }

  if (problems.length) { console.error(`\n${problems.length} problem(s)`); process.exit(1); }
  console.log('\npublic/data matches this build');
}

void main();
