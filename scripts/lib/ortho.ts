import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { CACHE_DIR, OUT_DIR, ORTHO_OVERVIEW_ZOOM, ORTHO_ZOOM, WMTS_ORTHO, EIFFEL_OSM_WAY_ID } from '../config.ts';
import { cachedBytes, ensureDir, exists, limit } from './http.ts';
import { frame, lonLatToTile, TILE_SIZE } from '../../shared/geo.ts';
import { CHUNK_SIZE, GRID_N, ORTHO_MARGIN, ORTHO_TILE_M, ORTHO_TILE_PX, OVERVIEW_PX, WORLD_HALF, chunkOrigin, chunkKey } from '../../shared/layout.ts';
import { loadTheme } from './overpass.ts';
import { pointInRing, distToRing, type Ring } from './polygons.ts';

const groundDir = path.join(OUT_DIR, 'ground');
const tilesDir = path.join(groundDir, 'tiles');

/** Decoded-tile LRU keyed by "x_y" for one zoom level. */
class TileStore {
  private cache = new Map<string, Uint8Array>();
  constructor(readonly z: number, private readonly maxTiles = 700) {}

  file(x: number, y: number) { return `wmts/${this.z}/${x}/${y}.jpg`; }

  async download(x: number, y: number) {
    await cachedBytes(WMTS_ORTHO(this.z, x, y), this.file(x, y), { timeoutMs: 60_000, retries: 5 });
  }

  async ensure(x: number, y: number): Promise<void> {
    const key = `${x}_${y}`;
    if (this.cache.has(key)) { const v = this.cache.get(key)!; this.cache.delete(key); this.cache.set(key, v); return; }
    const buf = await cachedBytes(WMTS_ORTHO(this.z, x, y), this.file(x, y), { timeoutMs: 60_000, retries: 5 });
    const { data, info } = await sharp(buf).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    let rgb: Uint8Array = data;
    if (info.channels !== 3) {
      rgb = new Uint8Array(TILE_SIZE * TILE_SIZE * 3);
      for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) { const v = data[i * info.channels]; rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v; }
    }
    this.cache.set(key, rgb);
    while (this.cache.size > this.maxTiles) { const k = this.cache.keys().next().value as string; this.cache.delete(k); }
  }

  /** Synchronous pixel read at global Mercator pixel (px, py). Tile must be ensured. */
  read(px: number, py: number, out: Float64Array, o: number): boolean {
    const t = this.cache.get(`${px >> 8}_${py >> 8}`);
    if (!t) return false;
    const i = ((py & 255) * TILE_SIZE + (px & 255)) * 3;
    out[o] = t[i]; out[o + 1] = t[i + 1]; out[o + 2] = t[i + 2];
    return true;
  }
}

function worldToMercPx(x: number, z: number, zoom: number): [number, number] {
  const { lon, lat } = frame.fromWorld(x, z);
  const t = lonLatToTile(lon, lat, zoom);
  return [t.x * TILE_SIZE, t.y * TILE_SIZE];
}

interface Inpaint { ring: Ring; cx: number; cz: number; bbox: [number, number, number, number]; radius: number }

async function loadEiffelFootprint(): Promise<Inpaint | null> {
  try {
    const fc = await loadTheme('buildings');
    const f = fc.features.find(f => f.properties.type === 'way' && f.properties.id === EIFFEL_OSM_WAY_ID);
    if (!f || f.geometry.type !== 'Polygon') return null;
    const ring: Ring = f.geometry.coordinates[0].map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; });
    let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= ring.length; cz /= ring.length;
    const r = 12;
    const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
    return { ring, cx, cz, radius: r, bbox: [Math.min(...xs) - r, Math.min(...zs) - r, Math.max(...xs) + r, Math.max(...zs) + r] };
  } catch { return null; }
}

const hash = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };

/**
 * Warp a square world region [x0,x0+size]x[z0,z0+size] into an outPx² RGB buffer,
 * sampling Mercator tiles with per-pixel inverse mapping (bilinearly interpolated on a coarse grid).
 */
async function warpRegion(store: TileStore, x0: number, z0: number, size: number, outPx: number, inpaint: Inpaint | null): Promise<Buffer> {
  const CELL = 32;
  const g = outPx / CELL + 1;
  const gx = new Float64Array(g * g), gy = new Float64Array(g * g);
  const mpp = size / outPx;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
    const [X, Y] = worldToMercPx(x0 + i * CELL * mpp, z0 + j * CELL * mpp, store.z);
    gx[j * g + i] = X; gy[j * g + i] = Y;
    minX = Math.min(minX, X); maxX = Math.max(maxX, X); minY = Math.min(minY, Y); maxY = Math.max(maxY, Y);
  }
  // Ensure all tiles covering the region (+1 tile margin for bilinear + inpaint reach).
  const pad = 2;
  const tx0 = (minX >> 8) - pad, tx1 = (maxX >> 8) + pad, ty0 = (minY >> 8) - pad, ty1 = (maxY >> 8) + pad;
  const lim = limit(8);
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(lim(() => store.ensure(tx, ty)));
  await Promise.all(jobs);

  const out = Buffer.alloc(outPx * outPx * 3);
  const px4 = new Float64Array(12);
  const sample = (X: number, Y: number, o: number) => {
    const xf = X - 0.5, yf = Y - 0.5;
    const xi = Math.floor(xf), yi = Math.floor(yf);
    const fx = xf - xi, fy = yf - yi;
    const ok = store.read(xi, yi, px4, 0) && store.read(xi + 1, yi, px4, 3) && store.read(xi, yi + 1, px4, 6) && store.read(xi + 1, yi + 1, px4, 9);
    if (!ok) { out[o] = 90; out[o + 1] = 95; out[o + 2] = 90; return; }
    for (let c = 0; c < 3; c++) {
      const top = px4[c] * (1 - fx) + px4[3 + c] * fx;
      const bot = px4[6 + c] * (1 - fx) + px4[9 + c] * fx;
      out[o + c] = Math.round(top * (1 - fy) + bot * fy);
    }
  };

  const doInpaint = inpaint && !(x0 > inpaint.bbox[2] || x0 + size < inpaint.bbox[0] || z0 > inpaint.bbox[3] || z0 + size < inpaint.bbox[1]);
  for (let py = 0; py < outPx; py++) {
    const cj = Math.min(g - 2, Math.floor(py / CELL)), fj = py / CELL - cj;
    const wz = z0 + (py + 0.5) * mpp;
    for (let px = 0; px < outPx; px++) {
      const ci = Math.min(g - 2, Math.floor(px / CELL)), fi = px / CELL - ci;
      const o = (py * outPx + px) * 3;
      if (doInpaint) {
        const wx = x0 + (px + 0.5) * mpp;
        const ip = inpaint!;
        if (wx >= ip.bbox[0] && wx <= ip.bbox[2] && wz >= ip.bbox[1] && wz <= ip.bbox[3] &&
            (pointInRing(wx, wz, ip.ring) || distToRing(wx, wz, ip.ring) <= ip.radius)) {
          // March outward from the footprint centre until outside the dilated footprint, then clone from just beyond.
          let dx = wx - ip.cx, dz = wz - ip.cz;
          const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
          let t = 0, qx = wx, qz = wz;
          while (t < 160 && (pointInRing(qx, qz, ip.ring) || distToRing(qx, qz, ip.ring) <= ip.radius)) { t += 1; qx = wx + dx * t; qz = wz + dz * t; }
          const n = hash(px, py), n2 = hash(py * 3.1, px * 1.7);
          const reach = 3 + n * 14;
          qx += dx * reach - dz * (n2 - 0.5) * 8; qz += dz * reach + dx * (n2 - 0.5) * 8;
          const [X, Y] = worldToMercPx(qx, qz, store.z);
          // Tiles for far samples may be missing from the store; fall back to the gridded sample below.
          const xi = Math.floor(X - 0.5), yi = Math.floor(Y - 0.5);
          if (store.read(xi, yi, px4, 0) && store.read(xi + 1, yi + 1, px4, 9)) { sample(X, Y, o); continue; }
        }
      }
      const a = cj * g + ci;
      const X = (gx[a] * (1 - fi) + gx[a + 1] * fi) * (1 - fj) + (gx[a + g] * (1 - fi) + gx[a + g + 1] * fi) * fj;
      const Y = (gy[a] * (1 - fi) + gy[a + 1] * fi) * (1 - fj) + (gy[a + g] * (1 - fi) + gy[a + g + 1] * fi) * fj;
      sample(X, Y, o);
    }
  }
  return out;
}

async function downloadRange(store: TileStore, half: number, label: string) {
  const corners = [[-half, -half], [half, -half], [-half, half], [half, half]].map(([x, z]) => worldToMercPx(x, z, store.z));
  const tx0 = Math.floor(Math.min(...corners.map(c => c[0])) / TILE_SIZE) - 1, tx1 = Math.floor(Math.max(...corners.map(c => c[0])) / TILE_SIZE) + 1;
  const ty0 = Math.floor(Math.min(...corners.map(c => c[1])) / TILE_SIZE) - 1, ty1 = Math.floor(Math.max(...corners.map(c => c[1])) / TILE_SIZE) + 1;
  const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  log.info(`ortho ${label}: z${store.z} tiles x ${tx0}..${tx1}, y ${ty0}..${ty1} (${total})`);
  const lim = limit(8);
  let done = 0;
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push(lim(async () => { await store.download(tx, ty); if (++done % 400 === 0) log.info(`ortho ${label}: ${done}/${total}`); }));
  }
  await Promise.all(jobs);
  log.info(`ortho ${label}: ${total} tiles on disk`);
}

export async function run(ctx: BakeContext) {
  await ensureDir(tilesDir);
  const inpaint = await loadEiffelFootprint();
  log.info(inpaint ? `ortho: Eiffel footprint loaded (${inpaint.ring.length} pts, centre ${inpaint.cx.toFixed(1)},${inpaint.cz.toFixed(1)})` : 'ortho: no Eiffel footprint (run osm step first) - skipping inpaint');

  const near = new TileStore(ORTHO_ZOOM);
  const far = new TileStore(ORTHO_OVERVIEW_ZOOM, 400);
  await downloadRange(near, WORLD_HALF + ORTHO_MARGIN, 'near');
  await downloadRange(far, WORLD_HALF, 'overview');

  const overviewOut = path.join(groundDir, 'overview.jpg');
  if (ctx.force || !await exists(overviewOut)) {
    const t = Date.now();
    const buf = await warpRegion(far, -WORLD_HALF, -WORLD_HALF, WORLD_HALF * 2, OVERVIEW_PX, inpaint);
    await sharp(buf, { raw: { width: OVERVIEW_PX, height: OVERVIEW_PX, channels: 3 } }).jpeg({ quality: 82, mozjpeg: true }).toFile(overviewOut);
    log.info(`ortho: overview ${OVERVIEW_PX}px written in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } else log.info('ortho: overview cached');

  let written = 0, skipped = 0;
  const t0 = Date.now();
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
    const key = chunkKey(i, j);
    const out = path.join(tilesDir, `${key}.jpg`);
    const outS = path.join(tilesDir, `${key}_s.jpg`);
    if (!ctx.force && await exists(out) && await exists(outS)) { skipped++; continue; }
    const o = chunkOrigin(i, j);
    const buf = await warpRegion(near, o.x - ORTHO_MARGIN, o.z - ORTHO_MARGIN, ORTHO_TILE_M, ORTHO_TILE_PX, inpaint);
    const img = sharp(buf, { raw: { width: ORTHO_TILE_PX, height: ORTHO_TILE_PX, channels: 3 } });
    await img.clone().jpeg({ quality: 85, mozjpeg: true }).toFile(out);
    await img.clone().resize(512, 512, { kernel: 'lanczos3' }).jpeg({ quality: 80, mozjpeg: true }).toFile(outS);
    written++;
    if (written % 12 === 0) log.info(`ortho: ${written} tiles written (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  log.info(`ortho: ${written} chunk tiles written, ${skipped} cached, ${CHUNK_SIZE} m chunks with ${ORTHO_MARGIN} m margin`);
  await fs.writeFile(path.join(groundDir, 'ground.json'), JSON.stringify({ tilePx: ORTHO_TILE_PX, tileM: ORTHO_TILE_M, margin: ORTHO_MARGIN, overviewPx: OVERVIEW_PX, overviewHalf: WORLD_HALF, small: 512, inpaint: !!inpaint }));
  void CACHE_DIR;
}
