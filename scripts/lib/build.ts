import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry } from 'geojson';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { OUT_DIR } from '../config.ts';
import { ensureDir, exists, readJson, writeJson, fmtBytes } from './http.ts';
import { loadTheme, type OsmProps } from './overpass.ts';
import { loadBuildings } from './bdtopo.ts';
import { buildSpecs, type BuildingSpec } from './buildings.ts';
import { extrudeBuilding, triangulateCap, type ChunkBuilders } from './extrude.ts';
import { DsmProvider, addDsmCap } from './dsmroof.ts';
import { GeomBuilder, encodeBinMesh } from './binmesh.ts';
import { buildBridges } from './bridges.ts';
import { makeFlowField, riverArms } from './river.ts';
import { buildFurniture } from './furniture.ts';
import { buildFountains } from './fountains.ts';
import { buildRail } from './rail.ts';
import { Heightmap } from '../../shared/heightmap.ts';
import { ORIGIN, DATUM_ALT, frame } from '../../shared/geo.ts';
import { CHUNK_SIZE, GRID_N, WORLD_HALF, chunkIndexOf, chunkKey, chunkOrigin, inGrid, SurfaceFlag, type Manifest } from '../../shared/layout.ts';
import { area, clipToBox, cleanRing, orient, pointInPoly, type Poly, type Ring } from './polygons.ts';

export async function loadHeightmap(raw = false): Promise<Heightmap> {
  const meta = await readJson<{ n: number; step: number; origin: number }>(path.join(OUT_DIR, 'terrain.json'));
  const rawFile = path.join(OUT_DIR, 'terrain_raw.bin');
  const buf = await fs.readFile(raw && await exists(rawFile) ? rawFile : path.join(OUT_DIR, 'terrain.bin'));
  return Heightmap.fromBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
}

function toWorldPolys(geom: Geometry): Poly[] {
  const conv = (ring: number[][]): Ring => cleanRing(ring.map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; }));
  const out: Poly[] = [];
  const push = (coords: number[][][]) => {
    const rings = coords.map(conv).filter(r => r.length >= 3);
    if (rings.length) out.push([orient(rings[0], false), ...rings.slice(1).map(r => orient(r, true))]);
  };
  if (geom.type === 'Polygon') push(geom.coordinates); else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(push);
  return out;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

async function buildWater(water: FeatureCollection<Geometry, OsmProps>, hm: Heightmap): Promise<{ waterLevelY: number; bytes: number; count: number }> {
  const river: Poly[] = [];
  const basins: { poly: Poly; y: number }[] = [];
  for (const f of water.features) {
    const t = f.properties.tags ?? {};
    const isWater = t.natural === 'water' || !!t.water || t.amenity === 'fountain' || t.waterway === 'riverbank';
    if (!isWater) continue;
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
    const polys = toWorldPolys(f.geometry);
    const isRiver = t.water === 'river' || t.water === 'canal' || t.waterway === 'riverbank';
    if (isRiver) river.push(...polys);
    else for (const p of polys) {
      if (area(p[0]) < 3) continue;
      let ys: number[] = [];
      for (const [x, z] of p[0]) ys.push(hm.sample(x, z));
      basins.push({ poly: p, y: percentile(ys, 0.2) - 0.25 });
    }
  }
  const clipped = clipToBox(river, -WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF);
  // Water level = 5th percentile of DTM inside the river polygons.
  const ys: number[] = [];
  for (const p of clipped) {
    const xs = p[0].map(q => q[0]), zs = p[0].map(q => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    for (let x = x0; x <= x1; x += 12) for (let z = z0; z <= z1; z += 12) if (pointInPoly(x, z, p)) ys.push(hm.sample(x, z));
  }
  let waterLevelY = percentile(ys, 0.05);
  if (!Number.isFinite(waterLevelY)) waterLevelY = 26.5 - DATUM_ALT;
  log.info(`water: ${river.length} river polys -> ${clipped.length} clipped, ${basins.length} basins, level y=${waterLevelY.toFixed(2)} (alt ${(waterLevelY + DATUM_ALT).toFixed(2)})`);

  const gbRiver = new GeomBuilder();
  const gbBasin = new GeomBuilder();
  const meta: [number, number, number, number] = [0, 0, 0, 0];
  for (const p of clipped) {
    const { flat, tris } = triangulateCap(p);
    const base = gbRiver.vertexCount;
    for (let i = 0; i < flat.length; i += 2) gbRiver.vertex(flat[i], waterLevelY + 0.3, flat[i + 1], flat[i], flat[i + 1], meta, [40, 70, 80, 0]);
    for (let t = 0; t < tris.length; t += 3) gbRiver.tri(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
  }
  for (const b of basins) {
    const { flat, tris } = triangulateCap(b.poly);
    const base = gbBasin.vertexCount;
    for (let i = 0; i < flat.length; i += 2) gbBasin.vertex(flat[i], b.y, flat[i + 1], flat[i], flat[i + 1], meta, [40, 70, 80, 0]);
    for (let t = 0; t < tris.length; t += 3) gbBasin.tri(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
  }
  const buf = encodeBinMesh({ x: 0, z: 0 }, [gbRiver.toSection('river'), gbBasin.toSection('basins')], { waterLevelY });
  await fs.writeFile(path.join(OUT_DIR, 'water.bin'), buf);

  // Depress the terrain under water so the surfaces never z-fight (river bed 1.5 m below, basins 0.6 m below).
  let lowered = 0;
  const lowerUnder = (polys: { poly: Poly; y: number }[]) => {
    for (const { poly, y } of polys) {
      const xs = poly[0].map(q => q[0]), zs = poly[0].map(q => q[1]);
      const i0 = Math.max(0, Math.floor((Math.min(...xs) - hm.origin) / hm.step)), i1 = Math.min(hm.n - 1, Math.ceil((Math.max(...xs) - hm.origin) / hm.step));
      const j0 = Math.max(0, Math.floor((Math.min(...zs) - hm.origin) / hm.step)), j1 = Math.min(hm.n - 1, Math.ceil((Math.max(...zs) - hm.origin) / hm.step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = hm.origin + i * hm.step, z = hm.origin + j * hm.step;
        if (!pointInPoly(x, z, poly)) continue;
        const cur = hm.data[j * hm.n + i];
        const target = Math.round(y * 100);
        if (cur > target) { hm.data[j * hm.n + i] = target; lowered++; }
      }
    }
  };
  lowerUnder(clipped.map(poly => ({ poly, y: waterLevelY - 1.5 })));
  lowerUnder(basins.map(b => ({ poly: b.poly, y: b.y - 0.6 })));
  await fs.writeFile(path.join(OUT_DIR, 'terrain.bin'), Buffer.from(hm.data.buffer, hm.data.byteOffset, hm.data.byteLength));
  log.info(`water: lowered ${lowered} terrain samples under water`);
  return { waterLevelY, bytes: buf.length, count: clipped.length + basins.length };
}

export async function run(_ctx: BakeContext) {
  const hm = await loadHeightmap(true); // raw DTM: water level and river-bed lowering are recomputed from scratch
  const osmBuildings = await loadTheme('buildings');
  const bd = await loadBuildings();
  const water = await loadTheme('water');
  const roads = await loadTheme('roads');
  const points = await loadTheme('points').catch(() => null);
  const land = await loadTheme('landcover').catch(() => null);
  const summary = await readJson<Record<string, { timestamp?: string }>>(path.join(OUT_DIR, '..', '..', 'cache', 'osm', 'summary.json')).catch(() => ({} as Record<string, { timestamp?: string }>));

  const { specs, stats } = buildSpecs(osmBuildings, bd, hm);
  log.info('buildings:', JSON.stringify(stats));

  // Group by chunk.
  const byChunk = new Map<string, BuildingSpec[]>();
  let outside = 0;
  for (const s of specs) {
    const { i, j } = chunkIndexOf(s.centroid[0], s.centroid[1]);
    if (!inGrid(i, j)) { outside++; continue; }
    const k = chunkKey(i, j);
    const arr = byChunk.get(k); if (arr) arr.push(s); else byChunk.set(k, [s]);
  }
  log.info(`buildings: ${specs.length - outside} in grid, ${outside} outside`);

  const chunkDir = path.join(OUT_DIR, 'chunks');
  await ensureDir(chunkDir);
  const detailDir = path.join(OUT_DIR, 'details');
  await ensureDir(detailDir);
  // LiDAR HD surface-model caps for the landmarks (npm run bake:dsm); null = analytic roofs everywhere
  const dsm = await DsmProvider.load();
  dsm?.noteGroupHeights(specs);
  const dsmHook = dsm ? ((gb: GeomBuilder, b: BuildingSpec, ox: number, oz: number, meta: [number, number, number, number], tint: [number, number, number]) => (dsm.has(b.group ?? b.id) ? addDsmCap(gb, b, dsm, ox, oz, meta, tint) : null)) : undefined;
  const dsmCovers = dsm ? ((b: BuildingSpec) => dsm.has(b.group ?? b.id)) : undefined;
  const dsmParts = dsm ? ((b: BuildingSpec) => dsm.partTops(b)) : undefined;
  let detailRows = 0;
  let totalBytes = 0, totalTris = 0, dsmBuildings = 0, dsmTrisTotal = 0, dsmTrisRaw = 0;
  const DSM_BUDGET = 1_200_000;
  const chunkInfo: Record<string, { buildings: number; bytes: number; tris: number; dsmTris?: number }> = {};
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
    const k = chunkKey(i, j);
    const list = byChunk.get(k) ?? [];
    const o = chunkOrigin(i, j);
    const cb: ChunkBuilders = { walls: new GeomBuilder(), roofs: new GeomBuilder(), tops: new GeomBuilder(), lod: new GeomBuilder(), details: [], dsm: new GeomBuilder(), roofsAlt: new GeomBuilder(), topsAlt: new GeomBuilder() };
    for (const b of list) {
      try {
        const r = extrudeBuilding(b, cb, o.x, o.z, dsmHook, dsmCovers, dsmParts);
        if (r.dsmTris) { dsmBuildings++; dsmTrisRaw += r.dsmTris[0]; dsmTrisTotal += r.dsmTris[1]; if (r.dsmTris[0] > 20000) log.info(`dsm: ${b.id}${b.name ? ` (${b.name})` : ''}: ${r.dsmTris[0]} -> ${r.dsmTris[1]} tris`); }
      } catch (e) { log.warn(`extrude ${b.id} failed: ${e instanceof Error ? e.message : e}`); }
    }
    const sections = [cb.walls.toSection('walls'), cb.roofs.toSection('roofs'), cb.tops.toSection('tops'), cb.lod.toSection('lod')];
    if (cb.dsm!.indices.length) sections.push(cb.dsm!.toSection('dsm'), cb.roofsAlt!.toSection('roofs_alt'), cb.topsAlt!.toSection('tops_alt'));
    const buf = encodeBinMesh({ x: o.x, z: o.z }, sections, { buildings: list.length });
    await fs.writeFile(path.join(chunkDir, `${k}.bin`), buf);
    await fs.writeFile(path.join(detailDir, `${k}.bin`), Buffer.from(new Float32Array(cb.details ?? []).buffer));
    detailRows += (cb.details?.length ?? 0) / 9;
    const tris = (cb.walls.indices.length + cb.roofs.indices.length + cb.tops.indices.length + cb.dsm!.indices.length) / 3;
    chunkInfo[k] = { buildings: list.length, bytes: buf.length, tris, ...(cb.dsm!.indices.length ? { dsmTris: cb.dsm!.indices.length / 3 } : {}) };
    totalBytes += buf.length; totalTris += tris;
  }
  log.info(`buildings: ${GRID_N * GRID_N} chunks, ${fmtBytes(totalBytes)}, ${(totalTris / 1e6).toFixed(2)} M tris (LOD0), ${detailRows} roof detail rows`);
  if (dsm) log.info(`dsm: ${dsmBuildings} landmark footprints capped, ${(dsmTrisRaw / 1e6).toFixed(2)} M -> ${(dsmTrisTotal / 1e6).toFixed(2)} M tris`);
  if (dsmTrisTotal > DSM_BUDGET) throw new Error(`dsm: ${dsmTrisTotal} triangles exceed the ${DSM_BUDGET} budget; raise the grid step or the simplification error in dsmroof.ts`);

  const w = await buildWater(water, hm);
  const br = await buildBridges(roads, hm, w.waterLevelY, makeFlowField(riverArms(water)));
  const fu = await buildFurniture(roads, points, specs, hm, w.waterLevelY, land);
  const fo = await buildFountains(water, hm);
  const ra = await buildRail(roads, hm, w.waterLevelY, makeFlowField(riverArms(water)));

  // later steps (paths, markings, streets) add their own files/counts: keep them across a rebuild
  const prevManifest = await readJson<Manifest>(path.join(OUT_DIR, 'manifest.json')).catch(() => null);
  const manifest: Manifest = {
    version: 1,
    generated: new Date().toISOString(),
    origin: { lon: ORIGIN.lon, lat: ORIGIN.lat },
    datumAlt: DATUM_ALT,
    worldHalf: WORLD_HALF,
    chunkSize: CHUNK_SIZE,
    gridN: GRID_N,
    waterLevelY: w.waterLevelY,
    osmTimestamp: summary.buildings?.timestamp,
    counts: { ...(prevManifest?.counts ?? {}), buildings: specs.length - outside, water: w.count, bridges: br.count, furniture: fu.count, roofDetails: detailRows, fountainJets: fo.count, railLines: ra.lines, dsmBuildings, dsmTris: dsmTrisTotal },
    heightSources: { osm: stats.osm, bdtopo: stats.bdtopo, levels: stats.levels, default: stats.default, plinths: stats.plinths, parts: stats.parts, mansard: stats.mansard, flat: stats.flat, curved: stats.curved, monument: stats.monument, landmark: stats.landmark },
    files: { ...(prevManifest?.files ?? {}), chunks: 'chunks/{i}_{j}.bin', details: 'details/{i}_{j}.bin', terrain: 'terrain.bin', water: 'water.bin', bridges: 'bridges.bin', trees: 'trees.bin', furniture: 'furniture.bin', far: 'far.bin', fountains: 'fountains.json', rail: 'rail.json', groundTiles: 'ground/tiles/{i}_{j}.jpg', overview: 'ground/overview.jpg' },
  };
  (manifest as Manifest & { chunks: typeof chunkInfo }).chunks = chunkInfo;
  await writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);
  log.info('manifest written');
  void SurfaceFlag;
}
