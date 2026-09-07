import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { CACHE_DIR, OUT_DIR, OVERPASS_ENDPOINTS } from '../config.ts';
import { cachedJson, ensureDir, exists, fetchRetry, limit, readJson, sleep, writeJson } from './http.ts';
import { frame } from '../../shared/geo.ts';
import type { Landmark, LandmarksData } from '../../shared/layout.ts';
import { bearingDeg } from '../../shared/landmarks.ts';
import { LANDMARKS, type LandmarkSpec } from './landmarks_registry.ts';

/**
 * bake:landmarks — resolve the curated registry into public/data/landmarks.json (+ landmarks/{id}.jpg):
 *   OSM centre + tags (one Overpass request for the listed ids) -> Wikidata entity (labels, architect, year, height,
 *   image, coordinates) -> Wikipedia summary ko > fr > en (1-2 sentences) -> Commons file metadata (artist, licence)
 *   -> 480 px JPEG. Every stage is optional: an entry always ships with a position and names.
 * All calls are keyless and cached under cache/landmarks/ so a re-run makes no requests.
 */

const WIKI_UA = 'paris-eiffel-walk-bake/0.1 (https://github.com/; open-data first-person Paris; contact via repo)';
const wikiHeaders = { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA };
const cacheRel = (f: string) => `landmarks/${f}`;

// ------------------------------------------------------------------------------------------------ pure helpers (tested)

export function parseWikidataYear(t: string | undefined): number | undefined {
  const m = t?.match(/^([+-]?\d{1,6})-/);
  if (!m) return undefined;
  const y = parseInt(m[1], 10);
  return Number.isFinite(y) ? y : undefined;
}

/** Commons file name from an upload.wikimedia.org URL (thumb or original). */
export function commonsFileFromUrl(url: string): string | undefined {
  const parts = url.split('/');
  const i = parts.indexOf('thumb');
  let name = i >= 0 ? parts[i + 3] : parts[parts.length - 1];
  if (!name) return undefined;
  name = decodeURIComponent(name);
  return name.replace(/^\d+px-/, '');
}

export function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** First one or two sentences, capped at ~220 characters. */
export function firstSentences(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').replace(/\([^)]*\)/g, m => (m.length > 40 ? '' : m)).trim();
  const parts = clean.split(/(?<=[.!?。])\s+/);
  let out = '';
  for (const p of parts.slice(0, 2)) {
    const next = out ? `${out} ${p}` : p;
    if (out && next.length > max) break;
    out = next;
    if (out.length > max) break;
  }
  if (out.length > max) out = out.slice(0, max - 1).replace(/[,\s]+\S*$/, '') + '…';
  return out;
}

/** Commons "Artist" fields range from a bare name to a paragraph: keep a name-sized string. */
export function cleanArtist(s: string): string {
  let a = s.trim();
  if (a.length > 40) { const m = a.match(/(?:by|par|von)\s+([^(,;:]{2,40})/i); a = m ? m[1].trim() : a.slice(0, 38).trim() + '…'; }
  return a;
}

const FREE = /^(cc0|public domain|pd|cc by(?!-nc)(?!-nd)|cc-by(?!-nc)(?!-nd)|attribution)/i;
export function freeLicense(short: string | undefined): boolean {
  return !!short && FREE.test(short.trim());
}

// ------------------------------------------------------------------------------------------------ OSM

interface OsmEl { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }

async function fetchOsm(specs: LandmarkSpec[], force: boolean): Promise<Map<string, OsmEl>> {
  const file = path.join(CACHE_DIR, cacheRel('osm.json'));
  const refs = [...new Set(specs.map(s => s.osm).filter((r): r is NonNullable<LandmarkSpec['osm']> => !!r))];
  let els: OsmEl[] = [];
  if (!force && await exists(file)) els = await readJson<{ elements: OsmEl[] }>(file).then(r => r.elements);
  else if (refs.length) {
    const by = (t: string) => refs.filter(r => r.startsWith(t + '/')).map(r => r.split('/')[1]);
    const q = `[out:json][timeout:60];(${['node', 'way', 'relation'].map(t => (by(t).length ? `${t}(id:${by(t).join(',')});` : '')).join('')});out tags center;`;
    let lastErr: unknown;
    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetchRetry(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, retries: 1, backoffMs: [8000], timeoutMs: 90_000 });
        const raw = await res.json() as { elements: OsmEl[] };
        els = raw.elements ?? [];
        await ensureDir(path.dirname(file));
        await writeJson(file, { elements: els });
        log.info(`landmarks: overpass ${els.length}/${refs.length} elements (${ep.split('/')[2]})`);
        break;
      } catch (e) { lastErr = e; log.warn(`landmarks: overpass failed at ${ep.split('/')[2]}: ${e instanceof Error ? e.message.split('\n')[0] : e}`); await sleep(3000); }
    }
    if (!els.length && lastErr) log.warn('landmarks: no OSM positions; falling back to Wikidata / approx');
  }
  return new Map(els.map(e => [`${e.type}/${e.id}`, e]));
}

// ------------------------------------------------------------------------------------------------ Wikidata / Wikipedia / Commons

interface WdClaim { mainsnak: { datavalue?: { value: any } } }
interface WdEntity { labels?: Record<string, { value: string }>; sitelinks?: Record<string, { title: string }>; claims?: Record<string, WdClaim[]> }

async function wikidataEntity(q: string): Promise<WdEntity | null> {
  try {
    const j = await cachedJson<{ entities: Record<string, WdEntity> }>(`https://www.wikidata.org/wiki/Special:EntityData/${q}.json`, cacheRel(`wd_${q}.json`), { headers: wikiHeaders, retries: 2, timeoutMs: 60_000 });
    return j.entities?.[q] ?? Object.values(j.entities ?? {})[0] ?? null;
  } catch (e) { log.warn(`landmarks: wikidata ${q}: ${e instanceof Error ? e.message.split('\n')[0] : e}`); return null; }
}

const claimVal = (e: WdEntity | null, p: string) => e?.claims?.[p]?.[0]?.mainsnak.datavalue?.value;
const claimVals = (e: WdEntity | null, p: string) => (e?.claims?.[p] ?? []).map(c => c.mainsnak.datavalue?.value).filter(v => v != null);

async function wikidataLabels(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids)].sort();
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    try {
      const j = await cachedJson<{ entities: Record<string, WdEntity> }>(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${chunk.join('|')}&props=labels&languages=ko|fr|en&format=json`,
        cacheRel(`wd_labels_${chunk[0]}_${chunk.length}.json`), { headers: wikiHeaders, retries: 2 });
      for (const [id, e] of Object.entries(j.entities ?? {})) { const l = e.labels?.ko?.value ?? e.labels?.en?.value ?? e.labels?.fr?.value; if (l) out.set(id, l); }
    } catch (e) { log.warn(`landmarks: wikidata labels: ${e instanceof Error ? e.message.split('\n')[0] : e}`); }
  }
  return out;
}

interface WpSummary { title: string; extract?: string; thumbnail?: { source: string; width: number; height: number }; originalimage?: { source: string }; content_urls?: { desktop?: { page?: string } } }

async function wikipediaSummary(lang: string, title: string, id: string): Promise<WpSummary | null> {
  try {
    return await cachedJson<WpSummary>(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, cacheRel(`wp_${lang}_${id}.json`), { headers: wikiHeaders, retries: 1, backoffMs: [5000], timeoutMs: 30_000 });
  } catch (e) { log.warn(`landmarks: ${id}: ${lang}.wikipedia "${title}": ${e instanceof Error ? e.message.split('\n')[0] : e}`); return null; }
}

interface CommonsInfo { thumburl?: string; url?: string; descriptionurl?: string; extmetadata?: Record<string, { value: string }> }

async function commonsInfo(file: string, id: string): Promise<CommonsInfo | null> {
  try {
    const j = await cachedJson<{ query?: { pages?: Record<string, { imageinfo?: CommonsInfo[] }> } }>(
      `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent('File:' + file)}&prop=imageinfo&iiprop=extmetadata|url&iiurlwidth=640&format=json`,
      cacheRel(`commons_${id}.json`), { headers: wikiHeaders, retries: 1, backoffMs: [5000], timeoutMs: 30_000 });
    return Object.values(j.query?.pages ?? {})[0]?.imageinfo?.[0] ?? null;
  } catch (e) { log.warn(`landmarks: ${id}: commons ${file}: ${e instanceof Error ? e.message.split('\n')[0] : e}`); return null; }
}

// ------------------------------------------------------------------------------------------------ resolution

interface Resolved { landmark: Landmark; architectIds: string[]; status: 'ok' | 'partial' | 'failed' }

async function resolveOne(spec: LandmarkSpec, osm: Map<string, OsmEl>, imgDir: string, credits: Set<string>): Promise<Resolved> {
  const el = spec.osm ? osm.get(spec.osm) : undefined;
  const tags = el?.tags ?? {};
  let lat = el?.center?.lat ?? el?.lat, lon = el?.center?.lon ?? el?.lon;
  const q = spec.wikidata ?? tags.wikidata;
  const wd = q ? await wikidataEntity(q) : null;
  if (lat == null || lon == null) { const c = claimVal(wd, 'P625'); if (c?.latitude != null) { lat = c.latitude; lon = c.longitude; } }
  let x: number, z: number;
  if (lat != null && lon != null) { const w = frame.toWorld(lon, lat); x = w.x; z = w.z; }
  else { [x, z] = spec.approx; const ll = frame.fromWorld(x, z); lat = ll.lat; lon = ll.lon; log.warn(`landmarks: ${spec.id}: no position from OSM/Wikidata, using approx`); }
  if (Math.hypot(x - spec.approx[0], z - spec.approx[1]) > 250) log.warn(`landmarks: ${spec.id}: resolved position ${x.toFixed(0)},${z.toFixed(0)} is far from approx ${spec.approx}`);

  const label = (l: string) => wd?.labels?.[l]?.value;
  const name = {
    ko: label('ko') ?? tags['name:ko'] ?? spec.short,
    fr: label('fr') ?? tags.name ?? label('en') ?? spec.short,
    en: label('en') ?? tags['name:en'] ?? tags.name ?? spec.short,
  };

  // Wikipedia summary: ko > fr > en via sitelinks (or the OSM wikipedia tag)
  let desc: Landmark['desc'], wiki: Landmark['links']['wiki'], summary: WpSummary | null = null;
  const candidates: [Landmark['desc'] extends infer D ? (D extends { lang: infer L } ? L : never) : never, string | undefined][] = [
    ['ko', wd?.sitelinks?.kowiki?.title], ['fr', wd?.sitelinks?.frwiki?.title ?? (tags.wikipedia?.startsWith('fr:') ? tags.wikipedia.slice(3) : undefined)], ['en', wd?.sitelinks?.enwiki?.title],
  ];
  for (const [lang, title] of candidates) {
    if (!title) continue;
    const s = await wikipediaSummary(lang, title, spec.id);
    await sleep(300);
    if (!s) continue;
    if (!summary) summary = s;
    if (!desc && s.extract) { desc = { lang, text: firstSentences(s.extract) }; wiki = { lang, url: s.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` }; }
    if (desc && lang === 'ko') break;
    if (desc && summary) break;
  }

  // facts
  const architectIds = claimVals(wd, 'P84').map(v => v.id as string).filter(Boolean);
  // official opening (P1619) beats inception (P571): the tower "began" in 1887 but opened in 1889
  const year = parseWikidataYear(claimVal(wd, 'P1619')?.time) ?? parseWikidataYear(claimVal(wd, 'P571')?.time);
  const hv = claimVal(wd, 'P2048');
  const height = hv && /Q11573$/.test(hv.unit ?? '') ? parseFloat(hv.amount) : undefined;

  // image: Wikidata P18, else the summary's original image
  let image: Landmark['image'];
  const p18 = claimVal(wd, 'P18') as string | undefined;
  const file = p18 ?? (summary?.originalimage ? commonsFileFromUrl(summary.originalimage.source) : undefined);
  if (file) {
    const info = await commonsInfo(file, spec.id);
    await sleep(300);
    const md = info?.extmetadata ?? {};
    const license = md.LicenseShortName?.value;
    if (info?.thumburl && freeLicense(license)) {
      try {
        const out = path.join(imgDir, `${spec.id}.jpg`);
        if (!await exists(out)) {
          const res = await fetchRetry(info.thumburl, { headers: wikiHeaders, retries: 1, timeoutMs: 60_000 });
          const buf = Buffer.from(await res.arrayBuffer());
          await sharp(buf).resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(out);
        }
        const meta = await sharp(out).metadata();
        const artist = md.Artist?.value ? cleanArtist(stripHtml(md.Artist.value)) : undefined;
        image = { file: `landmarks/${spec.id}.jpg`, w: meta.width ?? 480, h: meta.height ?? 320, artist, license, licenseUrl: md.LicenseUrl?.value, source: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}` };
        credits.add(`${spec.short}: ${artist ?? 'Wikimedia Commons'} (${license})`);
      } catch (e) { log.warn(`landmarks: ${spec.id}: image failed: ${e instanceof Error ? e.message.split('\n')[0] : e}`); }
    } else if (file) log.info(`landmarks: ${spec.id}: image skipped (${license ?? 'no licence info'})`);
  }

  // landing spot and yaw
  const towerFacing = spec.face === 'tower' || (!spec.face && (spec.category === 'park' || spec.category === 'square' || spec.category === 'bridge'));
  let vx: number, vz: number;
  if (spec.view) { vx = spec.view.x; vz = spec.view.z; }
  else if (spec.category === 'bridge') { vx = x; vz = z; }   // stand on the deck (the runtime probes the bridge height)
  else { const d = Math.hypot(x, z) || 1, off = Math.max(25, Math.min(spec.radius * 0.8, 120)); vx = x - (x / d) * off; vz = z - (z / d) * off; }
  vx = Math.round(vx * 10) / 10; vz = Math.round(vz * 10) / 10;
  const yaw = spec.view?.yaw ?? (towerFacing ? bearingDeg(vx, vz, 0, 0) : bearingDeg(vx, vz, x, z));

  const landmark: Landmark = {
    id: spec.id, osm: spec.osm, wikidata: q, category: spec.category, hotkey: spec.hotkey, hidden: spec.hidden || undefined,
    x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, lon: Math.round(lon * 1e6) / 1e6, lat: Math.round(lat * 1e6) / 1e6, radius: spec.radius,
    view: { x: vx, z: vz, yaw: Math.round(yaw), deck: spec.view?.deck },
    name, short: spec.short, blurb: spec.blurbKo, desc,
    facts: (architectIds.length || year || height) ? { year, height } : undefined,
    links: { wiki, wikidata: q ? `https://www.wikidata.org/wiki/${q}` : undefined, osm: spec.osm ? `https://www.openstreetmap.org/${spec.osm}` : undefined },
    image,
  };
  const status: Resolved['status'] = desc && (image || !file) ? 'ok' : (wd || el) ? 'partial' : 'failed';
  return { landmark, architectIds, status };
}

export async function run(ctx: BakeContext) {
  const out = path.join(OUT_DIR, 'landmarks.json');
  const imgDir = path.join(OUT_DIR, 'landmarks');
  if (!ctx.force && await exists(out)) { log.info('landmarks: cached'); return; }
  await ensureDir(imgDir);
  const osm = await fetchOsm(LANDMARKS, ctx.force);
  const credits = new Set<string>();
  const lim = limit(2);
  const resolved = await Promise.all(LANDMARKS.map(spec => lim(() => resolveOne(spec, osm, imgDir, credits).catch(e => {
    log.warn(`landmarks: ${spec.id} failed: ${e instanceof Error ? e.message : e}`);
    const [x, z] = spec.approx; const ll = frame.fromWorld(x, z);
    const yaw = bearingDeg(spec.view?.x ?? x, spec.view?.z ?? z, 0, 0);
    const landmark: Landmark = { id: spec.id, osm: spec.osm, wikidata: spec.wikidata, category: spec.category, hotkey: spec.hotkey, hidden: spec.hidden || undefined, x, z, lon: ll.lon, lat: ll.lat, radius: spec.radius,
      view: { x: spec.view?.x ?? x, z: spec.view?.z ?? z, yaw: spec.view?.yaw ?? yaw, deck: spec.view?.deck }, name: { ko: spec.short, fr: spec.short, en: spec.short }, short: spec.short, blurb: spec.blurbKo, links: {} };
    return { landmark, architectIds: [], status: 'failed' as const };
  }))));
  // architect labels in one batch
  const labels = await wikidataLabels(resolved.flatMap(r => r.architectIds));
  for (const r of resolved) {
    const names = r.architectIds.map(id => labels.get(id)).filter((n): n is string => !!n);
    if (names.length) r.landmark.facts = { ...(r.landmark.facts ?? {}), architect: names.slice(0, 3) };
  }
  const counts = { ok: 0, partial: 0, failed: 0 };
  for (const r of resolved) counts[r.status]++;
  const data: LandmarksData = { version: 1, generated: new Date().toISOString(), landmarks: resolved.map(r => r.landmark), credits: [...credits].sort() };
  await writeJson(out, data);
  const manifestFile = path.join(OUT_DIR, 'manifest.json');
  if (await exists(manifestFile)) {
    const m = await readJson<{ files: Record<string, string>; counts: Record<string, number> }>(manifestFile);
    m.files.landmarks = 'landmarks.json'; m.counts.landmarks = data.landmarks.length;
    await writeJson(manifestFile, m);
  } else log.warn('landmarks: manifest.json missing (run bake:build); landmarks.json written anyway');
  const withImg = data.landmarks.filter(l => l.image).length, withDesc = data.landmarks.filter(l => l.desc).length, ko = data.landmarks.filter(l => l.desc?.lang === 'ko').length;
  log.info(`landmarks: ${data.landmarks.length} entries (ok ${counts.ok}, partial ${counts.partial}, failed ${counts.failed}); ${withDesc} descriptions (${ko} Korean), ${withImg} photos -> public/data/landmarks.json`);
  void fs;
}
