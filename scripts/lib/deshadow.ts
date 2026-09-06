import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { CACHE_DIR, OUT_DIR } from '../config.ts';
import { ensureDir, exists, readJson, writeJson } from './http.ts';
import { loadTheme } from './overpass.ts';
import { loadBuildings } from './bdtopo.ts';
import { buildSpecs } from './buildings.ts';
import { loadHeightmap } from './build.ts';
import { GRID_N, ORTHO_MARGIN, ORTHO_TILE_M, ORTHO_TILE_PX, OVERVIEW_PX, TREE_STRIDE, WORLD_HALF, chunkKey, chunkOrigin } from '../../shared/layout.ts';
import type { Pt } from './polygons.ts';

/**
 * Lift the shadows baked into the IGN orthophoto. The capture-time sun is estimated from the Eiffel Tower's
 * shadow in the overview; a shadow mask is then rendered from geometry the bake already knows (building
 * footprints + eave heights, the tower, tree crowns) and the photo is brightened under it. Originals are kept
 * in cache/ortho_raw so the step can be re-run or undone. Skip with DESHADOW=0; override the sun with
 * ORTHO_SUN_AZ / ORTHO_SUN_ELEV (degrees).
 */

const TOWER: Pt = [1.3, 12.1];
const TOWER_H = 280;           // the shadow of the antenna tip is too thin to detect; use the top platform
const RECOVER = 0.8;           // fraction of the shadow darkening to remove
/** Verified by eye on the raw overview: building and tower shadows fall to the north-west (sun in the south-east, ~48 deg up). */
const DEFAULT_SUN: SunEstimate = { azDeg: 135, elevDeg: 48, shadowDirWorld: [-0.707, -0.707], shadowLenM: 280 / Math.tan(48 * Math.PI / 180), source: 'default (visual check of the overview)' };

interface SunEstimate { azDeg: number; elevDeg: number; shadowDirWorld: [number, number]; shadowLenM: number; source: string }

async function loadLuma(file: string, size: number): Promise<Float32Array> {
  const buf = await sharp(file).resize(size, size).greyscale().raw().toBuffer();
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = buf[i] / 255;
  return out;
}

/** Estimate the capture-time sun from the tower shadow in the overview. */
function estimateSun(luma: Float32Array, size: number): SunEstimate {
  const envAz = parseFloat(process.env.ORTHO_SUN_AZ ?? ''), envEl = parseFloat(process.env.ORTHO_SUN_ELEV ?? '');
  const mPerPx = (WORLD_HALF * 2) / size;
  const toPx = (x: number, z: number) => [(x + WORLD_HALF) / mPerPx, (z + WORLD_HALF) / mPerPx];
  const sample = (x: number, z: number) => { const [px, pz] = toPx(x, z); const i = Math.round(px), j = Math.round(pz); return i >= 0 && j >= 0 && i < size && j < size ? luma[j * size + i] : 1; };
  if (Number.isFinite(envAz) && Number.isFinite(envEl)) {
    const az = envAz * Math.PI / 180;
    return { azDeg: envAz, elevDeg: envEl, shadowDirWorld: [-Math.sin(az), Math.cos(az)], shadowLenM: TOWER_H / Math.tan(envEl * Math.PI / 180), source: 'env' };
  }
  // ring medians give a local reference brightness per radius
  const radii: number[] = []; for (let r = 90; r <= 520; r += 2) radii.push(r);
  const ref = radii.map(r => { const v: number[] = []; for (let a = 0; a < 360; a += 3) v.push(sample(TOWER[0] + Math.cos(a * Math.PI / 180) * r, TOWER[1] + Math.sin(a * Math.PI / 180) * r)); v.sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; });
  let best = { theta: 0, run: 0, len: 0 };
  for (let deg = 0; deg < 360; deg += 0.5) {
    const th = deg * Math.PI / 180, dx = Math.cos(th), dz = Math.sin(th);
    let run = 0, maxRun = 0, endR = 0, misses = 0;
    for (let k = 0; k < radii.length; k++) {
      const r = radii[k];
      // average across the shadow width (3 samples 3 m apart)
      let dark = 0;
      for (const w of [-3, 0, 3]) { const l = sample(TOWER[0] + dx * r - dz * w, TOWER[1] + dz * r + dx * w); if (l < ref[k] * 0.72) dark++; }
      if (dark >= 2) { run++; misses = 0; if (run > maxRun) { maxRun = run; endR = r; } }
      else if (++misses > 4) { run = 0; misses = 0; }
    }
    if (maxRun > best.run) best = { theta: th, run: maxRun, len: endR };
  }
  const shadowLen = best.len;
  const plausible = best.run >= 30 && shadowLen > 150 && shadowLen < 800;
  const shadowDir: [number, number] = plausible ? [Math.cos(best.theta), Math.sin(best.theta)] : [-0.64, -0.77];
  const elev = plausible ? Math.atan(TOWER_H / shadowLen) * 180 / Math.PI : 50;
  const az = ((Math.atan2(-shadowDir[0], shadowDir[1]) * 180 / Math.PI) + 360) % 360; // sun azimuth from north, clockwise
  return { azDeg: az, elevDeg: elev, shadowDirWorld: shadowDir, shadowLenM: plausible ? shadowLen : TOWER_H / Math.tan(elev * Math.PI / 180), source: plausible ? `tower shadow (run ${best.run} samples)` : 'fallback (tower shadow not found)' };
}

interface Caster { poly: Pt[][]; h: number }
interface Crown { x: number; z: number; r: number; h: number }

/** SVG of shadow polygons for a square window [x0,x0+w] x [z0,z0+w] at px resolution. */
export function shadowSvg(casters: Caster[], crowns: Crown[], sun: SunEstimate, x0: number, z0: number, w: number, px: number): Buffer {
  const scale = px / w;
  const cot = 1 / Math.tan(sun.elevDeg * Math.PI / 180);
  const [sx, sz] = sun.shadowDirWorld;
  const P = (x: number, z: number) => `${((x - x0) * scale).toFixed(1)},${((z - z0) * scale).toFixed(1)}`;
  const parts: string[] = [];
  for (const c of casters) {
    const ring = c.poly[0];
    const reach = c.h * cot + 2; // this caster's own shadow length
    let inside = false;
    for (const p of ring) if (p[0] > x0 - reach && p[0] < x0 + w + reach && p[1] > z0 - reach && p[1] < z0 + w + reach) { inside = true; break; }
    if (!inside) continue;
    const dx = sx * c.h * cot, dz = sz * c.h * cot;
    // footprint plus one quad per edge swept along the shadow vector (nonzero fill unions them)
    parts.push(`M${ring.map(p => P(p[0], p[1])).join('L')}Z`);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      parts.push(`M${P(a[0], a[1])}L${P(b[0], b[1])}L${P(b[0] + dx, b[1] + dz)}L${P(a[0] + dx, a[1] + dz)}Z`);
    }
  }
  const circles: string[] = [];
  for (const t of crowns) {
    const cx = t.x + sx * t.h * 0.7 * cot, cz = t.z + sz * t.h * 0.7 * cot;
    if (cx < x0 - 40 || cx > x0 + w + 40 || cz < z0 - 40 || cz > z0 + w + 40) continue;
    circles.push(`<circle cx="${((cx - x0) * scale).toFixed(1)}" cy="${((cz - z0) * scale).toFixed(1)}" r="${(t.r * scale).toFixed(1)}"/>`);
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}"><rect width="100%" height="100%" fill="black"/><g fill="white"><path d="${parts.join('')}"/>${circles.join('')}</g></svg>`);
}

const srgbToLin = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const linToSrgb = (v: number) => { const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); };

/** Brighten the photo under the mask; gain from the shadow/lit median ratio of this image (clamped). */
async function deshadowImage(src: string, mask: Buffer, size: number, outFile: string, quality: number): Promise<number> {
  const rgb = await sharp(src).resize(size, size).removeAlpha().raw().toBuffer();
  const m = await sharp(mask).resize(size, size).blur(1.5).greyscale().raw().toBuffer();
  const inV: number[] = [], outV: number[] = [];
  for (let i = 0; i < size * size; i += 7) {
    const l = srgbToLin[rgb[i * 3]] * 0.3 + srgbToLin[rgb[i * 3 + 1]] * 0.59 + srgbToLin[rgb[i * 3 + 2]] * 0.11;
    if (m[i] > 200) inV.push(l); else if (m[i] < 20) outV.push(l);
  }
  const med = (a: number[]) => { if (!a.length) return NaN; a.sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
  const mi = med(inV), mo = med(outV);
  const gain = Number.isFinite(mi) && Number.isFinite(mo) && mi > 0.002 ? Math.max(1, Math.min(3, mo / mi)) : 1;
  if (gain > 1.02) {
    const g = [gain * 1.06, gain * 1.0, gain * 0.92]; // shadows in aerial photos are blue-ish: warm them back
    for (let i = 0; i < size * size; i++) {
      const k = m[i] / 255 * RECOVER; if (k <= 0.002) continue;
      for (let c = 0; c < 3; c++) { const lin = srgbToLin[rgb[i * 3 + c]]; rgb[i * 3 + c] = linToSrgb(lin * (1 + (g[c] - 1) * k)); }
    }
  }
  await sharp(rgb, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality }).toFile(outFile);
  return gain;
}

/** Shadow casters: buildings (eave height), the tower as stacked boxes, tree crowns. */
export async function collectCasters(): Promise<{ casters: Caster[]; crowns: Crown[] }> {
  const hm = await loadHeightmap(false);
  const { specs } = buildSpecs(await loadTheme('buildings'), await loadBuildings(), hm);
  const casters: Caster[] = specs.filter(s => !s.isPlinth && s.eave > 2.5).map(s => ({ poly: s.rings, h: s.eave }));
  const half = 62.5;
  casters.push({ poly: [[[TOWER[0] - half, TOWER[1] - half], [TOWER[0] + half, TOWER[1] - half], [TOWER[0] + half, TOWER[1] + half], [TOWER[0] - half, TOWER[1] + half]]], h: 60 });
  casters.push({ poly: [[[TOWER[0] - 20, TOWER[1] - 20], [TOWER[0] + 20, TOWER[1] - 20], [TOWER[0] + 20, TOWER[1] + 20], [TOWER[0] - 20, TOWER[1] + 20]]], h: 130 });
  casters.push({ poly: [[[TOWER[0] - 6, TOWER[1] - 6], [TOWER[0] + 6, TOWER[1] - 6], [TOWER[0] + 6, TOWER[1] + 6], [TOWER[0] - 6, TOWER[1] + 6]]], h: 300 });
  const crowns: Crown[] = [];
  try {
    const tb = await fs.readFile(path.join(OUT_DIR, 'trees.bin'));
    const t = new Float32Array(tb.buffer, tb.byteOffset, tb.byteLength / 4);
    for (let i = 0; i + TREE_STRIDE <= t.length; i += TREE_STRIDE) { const h = t[i + 3]; if (h >= 4) crowns.push({ x: t[i], z: t[i + 2], r: Math.max(1.5, 0.28 * h), h }); }
  } catch { log.warn('deshadow: trees.bin missing, no tree shadows'); }
  return { casters, crowns };
}

export { DEFAULT_SUN };

export async function run(ctx: BakeContext) {
  if (process.env.DESHADOW === '0') { log.info('deshadow: skipped (DESHADOW=0)'); return; }
  const groundDir = path.join(OUT_DIR, 'ground');
  const rawDir = path.join(CACHE_DIR, 'ortho_raw');
  const stamp = path.join(groundDir, 'deshadow.json');
  if (!ctx.force && await exists(stamp)) { log.info('deshadow: cached'); return; }
  await ensureDir(rawDir); await ensureDir(path.join(rawDir, 'tiles'));
  // keep pristine originals (copy once)
  const copyOnce = async (rel: string) => { const dst = path.join(rawDir, rel); if (!await exists(dst)) await fs.copyFile(path.join(groundDir, rel), dst); return dst; };
  const rawOverview = await copyOnce('overview.jpg');

  const luma = await loadLuma(rawOverview, 2048);
  const detected = estimateSun(luma, 2048);
  log.info(`deshadow: detector says azimuth ${detected.azDeg.toFixed(1)}°, elevation ${detected.elevDeg.toFixed(1)}° (${detected.source})`);
  const sun = detected.source === 'env' || process.env.ORTHO_SUN_AUTO === '1' ? detected : DEFAULT_SUN;
  log.info(`deshadow: capture sun azimuth ${sun.azDeg.toFixed(1)}°, elevation ${sun.elevDeg.toFixed(1)}° (tower shadow ${sun.shadowLenM.toFixed(0)} m toward ${sun.shadowDirWorld.map(v => v.toFixed(2))}) — ${sun.source}`);

  const { casters, crowns } = await collectCasters();
  log.info(`deshadow: ${casters.length} casters, ${crowns.length} crowns`);

  // tiles
  const gains: number[] = [];
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
    const k = chunkKey(i, j);
    const raw = await copyOnce(`tiles/${k}.jpg`);
    const o = chunkOrigin(i, j);
    const x0 = o.x - ORTHO_MARGIN, z0 = o.z - ORTHO_MARGIN;
    const svg = shadowSvg(casters, crowns, sun, x0, z0, ORTHO_TILE_M, ORTHO_TILE_PX);
    const g = await deshadowImage(raw, svg, ORTHO_TILE_PX, path.join(groundDir, 'tiles', `${k}.jpg`), 84);
    await sharp(path.join(groundDir, 'tiles', `${k}.jpg`)).resize(512, 512).jpeg({ quality: 82 }).toFile(path.join(groundDir, 'tiles', `${k}_s.jpg`));
    gains.push(g);
    if ((j * GRID_N + i) % 24 === 0) log.info(`deshadow: tile ${k} gain ${g.toFixed(2)}`);
  }
  // overview
  const halfPx = OVERVIEW_PX / 2;
  const quads: { input: Buffer; left: number; top: number }[] = [];
  for (const [qi, qj] of [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]) {
    const svg = shadowSvg(casters, crowns, sun, -WORLD_HALF + qi * WORLD_HALF, -WORLD_HALF + qj * WORLD_HALF, WORLD_HALF, halfPx);
    quads.push({ input: await sharp(svg).greyscale().png().toBuffer(), left: qi * halfPx, top: qj * halfPx });
  }
  const maskO = await sharp({ create: { width: OVERVIEW_PX, height: OVERVIEW_PX, channels: 3, background: 'black' } }).composite(quads).png().toBuffer();
  const gO = await deshadowImage(rawOverview, maskO, OVERVIEW_PX, path.join(groundDir, 'overview.jpg'), 80);
  const meanGain = gains.reduce((s, v) => s + v, 0) / gains.length;
  await writeJson(stamp, { sun, meanTileGain: meanGain, overviewGain: gO, recover: RECOVER, generated: new Date().toISOString() });
  const gj = path.join(groundDir, 'ground.json');
  try { const g = await readJson<Record<string, unknown>>(gj); g.captureSun = sun; await writeJson(gj, g); } catch { /* optional */ }
  log.info(`deshadow: done, mean tile gain ${meanGain.toFixed(2)}, overview gain ${gO.toFixed(2)}`);
}
