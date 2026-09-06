import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { ASSETS, MODELS_DIR, TEXTURES_DIR } from '../config.ts';
import { cachedBytes, cachedJson, ensureDir, exists } from './http.ts';

/** Sets seen at arm's length (facade grain, rusticated ground floors, pavement) stay 2K; the rest are 1K to save VRAM. */
const SIZE_2K = new Set(['plaster_grey_04', 'large_sandstone_blocks', 'Asphalt033', 'PavingStones138']);
const sizeFor = (id: string) => (SIZE_2K.has(id) ? 2048 : 1024);

type PhFiles = Record<string, Record<string, Record<string, { url: string; size: number }>>>;

/** Poly Haven texture: Diffuse / nor_gl / Rough (or arm) / AO at 2k jpg -> resized jpg maps. */
async function polyhavenTexture(id: string, outDir: string, lines: string[]) {
  const files = await cachedJson<PhFiles>(`https://api.polyhaven.com/files/${id}`, `assets/polyhaven_${id}.json`);
  const maps: [string, string][] = [['Diffuse', 'color'], ['nor_gl', 'normal'], ['Rough', 'roughness'], ['AO', 'ao'], ['arm', 'arm']];
  let got = 0;
  for (const [key, name] of maps) {
    const entry = files[key]?.['2k']?.jpg ?? files[key]?.['2k']?.png ?? files[key]?.['1k']?.jpg;
    if (!entry) continue;
    const out = path.join(outDir, `${id}_${name}.jpg`);
    if (await exists(out)) { got++; continue; }
    const ext = entry.url.split('.').pop() ?? 'jpg';
    const buf = await cachedBytes(entry.url, `assets/polyhaven/${id}_${key}.${ext}`, { timeoutMs: 300_000 });
    await sharp(buf).resize(sizeFor(id), sizeFor(id), { fit: 'fill' }).jpeg({ quality: 88 }).toFile(out);
    got++;
  }
  lines.push(`- ${id} (Poly Haven, CC0) https://polyhaven.com/a/${id}`);
  log.info(`assets: polyhaven ${id}: ${got} maps`);
}

async function polyhavenHdri(id: string, outDir: string, lines: string[]) {
  const out = path.join(outDir, `${id}_2k.hdr`);
  if (await exists(out)) { log.info(`assets: hdri ${id}: cached`); return; }
  const files = await cachedJson<PhFiles>(`https://api.polyhaven.com/files/${id}`, `assets/polyhaven_${id}.json`);
  const entry = files.hdri?.['2k']?.hdr ?? files.hdri?.['1k']?.hdr;
  if (!entry) { log.warn(`assets: hdri ${id}: no 2k hdr`); return; }
  const buf = await cachedBytes(entry.url, `assets/polyhaven/${id}_2k.hdr`, { timeoutMs: 300_000 });
  await fs.writeFile(out, buf);
  lines.push(`- ${id} (Poly Haven HDRI, CC0) https://polyhaven.com/a/${id}`);
  log.info(`assets: hdri ${id}: ${(buf.length / 1e6).toFixed(1)} MB`);
}

interface AcgJson { foundAssets: { assetId: string; downloadFolders: Record<string, { downloadFiletypeCategories: Record<string, { downloads: { attribute: string; downloadLink: string }[] }> }> }[] }

async function ambientcgTexture(id: string, outDir: string, lines: string[]) {
  const wanted: [RegExp, string][] = [[/_Color\./, 'color'], [/_NormalGL\./, 'normal'], [/_Roughness\./, 'roughness'], [/_AmbientOcclusion\./, 'ao']];
  const done = await Promise.all(wanted.map(([, n]) => exists(path.join(outDir, `${id}_${n}.jpg`))));
  if (done[0] && done[1]) { lines.push(`- ${id} (ambientCG, CC0) https://ambientcg.com/a/${id}`); log.info(`assets: ambientcg ${id}: cached`); return; }
  const meta = await cachedJson<AcgJson>(`https://ambientcg.com/api/v2/full_json?id=${id}&include=downloadData`, `assets/ambientcg_${id}.json`);
  const asset = meta.foundAssets?.[0];
  const dl = asset?.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads?.find(d => d.attribute === '2K-JPG')
    ?? asset?.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads?.find(d => d.attribute === '1K-JPG');
  if (!dl) { log.warn(`assets: ambientcg ${id}: no 2K-JPG download`); return; }
  const zip = await cachedBytes(dl.downloadLink, `assets/ambientcg/${id}_${dl.attribute}.zip`, { timeoutMs: 300_000 });
  const entries = unzipSync(new Uint8Array(zip));
  let got = 0;
  for (const [file, data] of Object.entries(entries)) {
    const w = wanted.find(([re]) => re.test(file));
    if (!w) continue;
    await sharp(Buffer.from(data)).resize(sizeFor(id), sizeFor(id), { fit: 'fill' }).jpeg({ quality: 88 }).toFile(path.join(outDir, `${id}_${w[1]}.jpg`));
    got++;
  }
  lines.push(`- ${id} (ambientCG, CC0) https://ambientcg.com/a/${id}`);
  log.info(`assets: ambientcg ${id}: ${got} maps`);
}

/** Kenney Car Kit (CC0): pick a handful of everyday cars for the parked-car layer. */
async function kenneyCars(lines: string[]) {
  const outDir = path.join(MODELS_DIR, 'cars');
  await ensureDir(outDir);
  const wanted = ['sedan', 'hatchback-sports', 'suv', 'van', 'taxi', 'sedan-sports', 'police', 'delivery'];
  const texOut = path.join(outDir, 'Textures', 'colormap.png');
  const have = await Promise.all([...wanted.map(w => exists(path.join(outDir, w + '.glb'))), exists(texOut)]);
  if (have.every(Boolean)) { lines.push('- Kenney Car Kit (CC0) https://kenney.nl/assets/car-kit'); log.info('assets: kenney cars cached'); return; }
  const zip = await cachedBytes('https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', 'assets/kenney_car-kit.zip', { timeoutMs: 300_000 });
  const entries = unzipSync(new Uint8Array(zip));
  const names = Object.keys(entries);
  let got = 0;
  for (const w of wanted) {
    const key = names.find(n => /glb/i.test(n) && n.toLowerCase().endsWith('/' + w + '.glb'));
    if (!key) { log.warn(`assets: kenney car ${w} not in kit (${names.filter(n => n.endsWith('.glb')).length} glbs)`); continue; }
    await fs.writeFile(path.join(outDir, w + '.glb'), Buffer.from(entries[key])); got++;
  }
  // The glbs reference Textures/colormap.png (palette) relative to the model folder.
  const texKey = names.find(n => /textures[\\/]colormap\.png$/i.test(n));
  if (texKey) { await ensureDir(path.dirname(texOut)); await fs.writeFile(texOut, Buffer.from(entries[texKey])); }
  else log.warn('assets: kenney colormap.png not found in kit');
  lines.push('- Kenney Car Kit (CC0) https://kenney.nl/assets/car-kit');
  log.info(`assets: kenney cars: ${got}/${wanted.length} models, texture ${texKey ? 'ok' : 'missing'}`);
}

export async function run(_ctx: BakeContext) {
  const texDir = path.join(TEXTURES_DIR, 'pbr');
  const hdriDir = path.join(TEXTURES_DIR, 'hdri');
  await ensureDir(texDir); await ensureDir(hdriDir);
  const lines: string[] = ['# Third-party assets', '', 'All textures and HDRIs below are CC0 (public domain).', ''];
  for (const id of ASSETS.polyhaven.textures) { try { await polyhavenTexture(id, texDir, lines); } catch (e) { log.warn(`assets: ${id} failed: ${e instanceof Error ? e.message : e}`); } }
  for (const id of ASSETS.ambientcg) { try { await ambientcgTexture(id, texDir, lines); } catch (e) { log.warn(`assets: ${id} failed: ${e instanceof Error ? e.message : e}`); } }
  for (const id of ASSETS.polyhaven.hdris) { try { await polyhavenHdri(id, hdriDir, lines); } catch (e) { log.warn(`assets: ${id} failed: ${e instanceof Error ? e.message : e}`); } }
  try { await kenneyCars(lines); } catch (e) { log.warn(`assets: kenney cars failed: ${e instanceof Error ? e.message : e}`); }
  lines.push('', '- Eiffel Tower model: 3DMR #4 by n42k (CC0) https://3dmr.eu/model/4', '- Building footprints/roads: © OpenStreetMap contributors (ODbL)', '- Building heights: IGN BD TOPO (Licence Ouverte / Etalab 2.0)', '- Orthophotos and elevation: IGN BD ORTHO / RGE ALTI (Licence Ouverte / Etalab 2.0)', '- Trees: Ville de Paris open data (ODbL)');
  await fs.writeFile(path.join(TEXTURES_DIR, 'LICENSES.md'), lines.join('\n') + '\n');
  log.info('assets: LICENSES.md written');
}
