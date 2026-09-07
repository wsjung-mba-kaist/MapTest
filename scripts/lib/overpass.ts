import fs from 'node:fs/promises';
import path from 'node:path';
import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { BBOX_PADDED, CACHE_DIR, OVERPASS_ENDPOINTS } from '../config.ts';
import { ensureDir, exists, fetchRetry, sleep, writeJson, readJson, fmtBytes } from './http.ts';

export const THEMES: Record<string, string> = {
  buildings: `( way["building"]; relation["building"]; way["building:part"]; relation["building:part"]; relation["type"="building"]; );`,
  roads: `( way["highway"]; way["railway"~"^(rail|subway|light_rail)$"]; way["man_made"="bridge"]; relation["man_made"="bridge"]; way["bridge"]["highway"]; );`,
  landcover: `( way["leisure"~"^(park|garden|pitch|playground)$"]; relation["leisure"~"^(park|garden)$"]; way["landuse"~"^(grass|forest|cemetery|flowerbed)$"]; way["natural"~"^(wood|scrub|grassland)$"]; way["highway"="pedestrian"]["area"="yes"]; way["place"="square"]; way["amenity"="parking"]; way["surface"]["area"="yes"]; );`,
  water: `( relation["natural"="water"]; way["natural"="water"]; way["waterway"~"^(river|canal)$"]; way["amenity"="fountain"]; way["water"]; );`,
  points: `( node["highway"="street_lamp"]; node["amenity"~"^(bench|fountain|drinking_water|bicycle_parking|bicycle_rental|waste_basket|shelter)$"]; node["barrier"="bollard"]; node["advertising"="column"]; node["natural"="tree"]["genus"]; node["railway"="subway_entrance"]; node["highway"="bus_stop"]; node["man_made"="flagpole"]; );`,
};

export interface OsmProps {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags: Record<string, string>;
  relations?: { role: string; rel: number; reltags: Record<string, string> }[];
  tainted?: boolean;
}
export type OsmFeature = Feature<Geometry, OsmProps>;

const rawDir = path.join(CACHE_DIR, 'overpass');
const geoDir = path.join(CACHE_DIR, 'osm');

function buildQuery(body: string): string {
  const b = BBOX_PADDED;
  // 256 MB is plenty for these themes; the public gateways answer a 1 GB reservation with an instant 504 when busy
  return `[out:json][timeout:180][maxsize:268435456][bbox:${b.south},${b.west},${b.north},${b.east}];${body}out body geom;`;
}

async function fetchTheme(theme: string, force: boolean): Promise<{ raw: any; fromCache: boolean }> {
  const file = path.join(rawDir, `${theme}.json`);
  if (!force && await exists(file)) return { raw: await readJson(file), fromCache: true };
  const query = buildQuery(THEMES[theme]);
  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      log.info(`overpass ${theme}: ${endpoint}`);
      const res = await fetchRetry(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        retries: 2,
        backoffMs: [10000, 30000],
        timeoutMs: 240_000,
        onRetry: (n, why) => log.warn(`overpass ${theme} retry ${n}: ${why}`),
      });
      const text = await res.text();
      let raw: any;
      try { raw = JSON.parse(text); } catch { throw new Error(`non-JSON response (${text.slice(0, 120)})`); }
      if (raw.remark && /timed out|runtime error/i.test(raw.remark)) throw new Error(`overpass remark: ${raw.remark}`);
      await ensureDir(rawDir);
      await fs.writeFile(file, text);
      log.info(`overpass ${theme}: ${raw.elements?.length ?? 0} elements, ${fmtBytes(text.length)}, db ${raw.osm3s?.timestamp_osm_base}`);
      return { raw, fromCache: false };
    } catch (e) {
      lastErr = e;
      log.warn(`overpass ${theme} failed at ${endpoint}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      await sleep(5000);
    }
  }
  throw lastErr;
}

/** Themes fetched as a 3 x 3 grid of small requests: the full-bbox point query hits the public gateways' 60 s limit. */
const TILED_THEMES = new Set(['points']);
const TILE_N = 3;

export interface Coverage { n: number; ok: number[]; boxes: { south: number; west: number; north: number; east: number }[] }

function subBoxes(b: { south: number; west: number; north: number; east: number }, n: number) {
  const out: { south: number; west: number; north: number; east: number }[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    out.push({
      west: b.west + (b.east - b.west) * i / n, east: b.west + (b.east - b.west) * (i + 1) / n,
      south: b.south + (b.north - b.south) * j / n, north: b.south + (b.north - b.south) * (j + 1) / n,
    });
  }
  return out;
}

async function probeEndpoint(endpoint: string): Promise<boolean> {
  try {
    const res = await fetchRetry(endpoint, { method: 'POST', body: 'data=' + encodeURIComponent('[out:json][timeout:10];node(1);out;'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, retries: 0, timeoutMs: 20_000 });
    return res.ok;
  } catch { return false; }
}

/** true when the cached tiled fetch still misses cells (so a later run keeps filling it in). */
async function tiledIncomplete(theme: string): Promise<boolean> {
  const file = path.join(rawDir, `${theme}.json`);
  if (!await exists(file)) return true;
  const cov = (await readJson<{ coverage?: Coverage }>(file)).coverage;
  return !!cov && cov.ok.length < cov.n * cov.n;
}

/** Fetch a theme cell by cell; cells that fail everywhere are recorded in `coverage` and skipped. */
async function fetchThemeTiled(theme: string, force: boolean): Promise<{ raw: any; fromCache: boolean }> {
  const file = path.join(rawDir, `${theme}.json`);
  const boxes = subBoxes(BBOX_PADDED, TILE_N);
  // a cached partial fetch is completed cell by cell on later runs (gateways rate-limit bursts with HTTP 429)
  let prev: any = null;
  if (!force && await exists(file)) {
    prev = await readJson(file);
    const cov = prev.coverage as Coverage | undefined;
    if (!cov || cov.ok.length >= boxes.length) return { raw: prev, fromCache: true };
    log.info(`overpass ${theme}: cache covers ${cov.ok.length}/${boxes.length} cells, fetching the rest`);
  }
  const healthy: string[] = [];
  for (const ep of OVERPASS_ENDPOINTS) { const ok = await probeEndpoint(ep); log.info(`overpass probe ${ep}: ${ok ? 'ok' : 'unreachable'}`); if (ok) healthy.push(ep); }
  if (!healthy.length) throw new Error('no Overpass endpoint reachable');
  const elements = new Map<string, any>();
  const ok: number[] = [];
  let osm3s: unknown = prev?.osm3s;
  if (prev) { for (const el of prev.elements ?? []) elements.set(`${el.type}/${el.id}`, el); ok.push(...(prev.coverage as Coverage).ok); }
  for (let k = 0; k < boxes.length; k++) {
    if (ok.includes(k)) continue;
    const b = boxes[k];
    const query = `[out:json][timeout:60][maxsize:268435456][bbox:${b.south},${b.west},${b.north},${b.east}];${THEMES[theme]}out body geom;`;
    let done = false;
    for (const endpoint of healthy) {
      try {
        const res = await fetchRetry(endpoint, {
          method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          retries: 1, backoffMs: [15000], timeoutMs: 100_000,
          onRetry: (n, why) => log.warn(`overpass ${theme} cell ${k + 1} retry ${n}: ${why}`),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        let raw: any;
        try { raw = JSON.parse(text); } catch { throw new Error(`non-JSON response (${text.slice(0, 80)})`); }
        if (raw.remark && /timed out|runtime error/i.test(raw.remark)) throw new Error(`overpass remark: ${raw.remark}`);
        for (const el of raw.elements ?? []) elements.set(`${el.type}/${el.id}`, el);
        osm3s = raw.osm3s;
        ok.push(k); done = true;
        log.info(`overpass ${theme} cell ${k + 1}/${boxes.length}: ${raw.elements?.length ?? 0} elements (${endpoint.split('/')[2]})`);
        break;
      } catch (e) {
        log.warn(`overpass ${theme} cell ${k + 1} failed at ${endpoint.split('/')[2]}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
        await sleep(5000);
      }
    }
    if (!done) log.warn(`overpass ${theme} cell ${k + 1}/${boxes.length}: no endpoint succeeded, left uncovered`);
    await sleep(12000);   // overpass-api.de answers bursts with 429: pace the cells
  }
  if (!ok.length) throw new Error(`overpass ${theme}: every cell failed`);
  ok.sort((a, b) => a - b);
  const coverage: Coverage = { n: TILE_N, ok, boxes };
  const raw = { version: 0.6, generator: 'tiled-fetch', osm3s, elements: [...elements.values()], coverage };
  await ensureDir(rawDir);
  await fs.writeFile(file, JSON.stringify(raw));
  log.info(`overpass ${theme}: ${raw.elements.length} elements from ${ok.length}/${boxes.length} cells`);
  return { raw, fromCache: false };
}

/**
 * osmtogeojson 3.x writes flat properties ({...tags, id: "way/123", type: <relation type>}).
 * Normalise into { type, id, tags } so the rest of the pipeline has a stable shape.
 */
export function normalizeFeature(f: Feature<Geometry, any>): OsmFeature {
  const p = f.properties ?? {};
  const fid = String(f.id ?? p.id ?? '');
  const [kind, num] = fid.split('/');
  if (p.tags && typeof p.type === 'string' && typeof p.id === 'number') {
    return { ...f, properties: { type: p.type, id: p.id, tags: p.tags, tainted: !!p.tainted } } as OsmFeature;
  }
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (k !== 'id' && k !== 'tainted' && typeof v === 'string') tags[k] = v;
  return { ...f, properties: { type: kind as OsmProps['type'], id: Number(num), tags, tainted: !!p.tainted } } as OsmFeature;
}

export async function loadTheme(theme: string): Promise<FeatureCollection<Geometry, OsmProps>> {
  const fc = await readJson<FeatureCollection<Geometry, any>>(path.join(geoDir, `${theme}.geojson`));
  return { type: 'FeatureCollection', features: fc.features.map(normalizeFeature) };
}

export async function run(ctx: BakeContext) {
  await ensureDir(geoDir);
  const summaryFile = path.join(geoDir, 'summary.json');
  const summary: Record<string, unknown> = await exists(summaryFile) ? await readJson(summaryFile) : {};
  for (const theme of Object.keys(THEMES)) {
    const out = path.join(geoDir, `${theme}.geojson`);
    if (!ctx.force && await exists(out) && !(TILED_THEMES.has(theme) && await tiledIncomplete(theme))) { log.info(`osm ${theme}: cached`); continue; }
    const { raw } = TILED_THEMES.has(theme) ? await fetchThemeTiled(theme, ctx.force) : await fetchTheme(theme, ctx.force);
    const fc = osmtogeojson(raw) as FeatureCollection<Geometry, OsmProps>;
    const tainted = fc.features.filter(f => (f.properties as any)?.tainted).length;
    if (tainted) log.warn(`osm ${theme}: ${tainted} tainted (incomplete) features`);
    const byType: Record<string, number> = {};
    for (const f of fc.features) byType[f.geometry.type] = (byType[f.geometry.type] ?? 0) + 1;
    log.info(`osm ${theme}: ${fc.features.length} features`, JSON.stringify(byType));
    summary[theme] = { count: fc.features.length, byType, timestamp: raw.osm3s?.timestamp_osm_base, coverage: raw.coverage };
    await writeJson(out, fc);
    // Be polite between themes.
    await sleep(2000);
  }
  if (Object.keys(summary).length) await writeJson(summaryFile, summary);
}
