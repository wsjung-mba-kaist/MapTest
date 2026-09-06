import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { BBOX_PADDED, CACHE_DIR, OUT_DIR, WMS_ELEVATION, type LonLatBox } from '../config.ts';
import { cachedBytes, exists, writeJson } from './http.ts';
import { frame, altToY } from '../../shared/geo.ts';
import { TERRAIN_N, TERRAIN_STEP, WORLD_HALF } from '../../shared/layout.ts';

const PX = 2048;
const NODATA_MIN = -1000;

interface Quad { box: LonLatBox; data: Float32Array }

function splitQuads(b: LonLatBox): LonLatBox[] {
  const midLon = (b.west + b.east) / 2, midLat = (b.south + b.north) / 2;
  return [
    { west: b.west, east: midLon, south: midLat, north: b.north }, // NW
    { west: midLon, east: b.east, south: midLat, north: b.north }, // NE
    { west: b.west, east: midLon, south: b.south, north: midLat }, // SW
    { west: midLon, east: b.east, south: b.south, north: midLat }, // SE
  ];
}

async function fetchQuad(box: LonLatBox, i: number): Promise<Quad> {
  const buf = await cachedBytes(WMS_ELEVATION(box, PX, PX), `bil/quad${i}.bin`, { timeoutMs: 180_000, retries: 3 });
  if (buf.length !== PX * PX * 4) {
    throw new Error(`elevation quad ${i}: unexpected ${buf.length} bytes (expected ${PX * PX * 4}); body starts "${buf.subarray(0, 80).toString('utf8')}"`);
  }
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  return { box, data };
}

/** Bilinear altitude sample (NGF metres) at lon/lat from the quad grid; NaN when no data. */
function sampleAlt(quads: Quad[], lon: number, lat: number): number {
  const q = quads.find(q => lon >= q.box.west && lon <= q.box.east && lat >= q.box.south && lat <= q.box.north);
  if (!q) return NaN;
  const u = ((lon - q.box.west) / (q.box.east - q.box.west)) * PX - 0.5;
  const v = ((q.box.north - lat) / (q.box.north - q.box.south)) * PX - 0.5;
  const x0 = Math.max(0, Math.min(PX - 2, Math.floor(u))), y0 = Math.max(0, Math.min(PX - 2, Math.floor(v)));
  const fx = Math.max(0, Math.min(1, u - x0)), fy = Math.max(0, Math.min(1, v - y0));
  const d = q.data;
  const a = d[y0 * PX + x0], b = d[y0 * PX + x0 + 1], c = d[(y0 + 1) * PX + x0], e = d[(y0 + 1) * PX + x0 + 1];
  const vals = [a, b, c, e];
  if (vals.some(v => !(v > NODATA_MIN))) {
    const ok = vals.filter(v => v > NODATA_MIN);
    return ok.length ? ok.reduce((s, v) => s + v, 0) / ok.length : NaN;
  }
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}

export async function run(ctx: BakeContext) {
  const binOut = path.join(OUT_DIR, 'terrain.bin');
  const jsonOut = path.join(OUT_DIR, 'terrain.json');
  if (!ctx.force && await exists(binOut) && await exists(jsonOut)) { log.info('terrain: cached'); return; }

  const quads: Quad[] = [];
  const boxes = splitQuads(BBOX_PADDED);
  for (let i = 0; i < 4; i++) {
    quads.push(await fetchQuad(boxes[i], i));
    log.info(`terrain: quad ${i} ok`);
  }
  const n = TERRAIN_N;
  const out = new Int16Array(n * n);
  let min = Infinity, max = -Infinity, bad = 0;
  for (let iz = 0; iz < n; iz++) {
    const z = -WORLD_HALF + iz * TERRAIN_STEP;
    for (let ix = 0; ix < n; ix++) {
      const x = -WORLD_HALF + ix * TERRAIN_STEP;
      const { lon, lat } = frame.fromWorld(x, z);
      let alt = sampleAlt(quads, lon, lat);
      if (!Number.isFinite(alt)) { bad++; alt = 33.8; }
      const y = altToY(alt);
      min = Math.min(min, y); max = Math.max(max, y);
      out[iz * n + ix] = Math.round(Math.max(-320, Math.min(320, y)) * 100);
    }
  }
  const towerY = out[((n - 1) / 2) * n + (n - 1) / 2] / 100;
  log.info(`terrain: ${n}x${n} @ ${TERRAIN_STEP} m, y range ${min.toFixed(2)}..${max.toFixed(2)} m, tower base y=${towerY.toFixed(2)}, nodata ${bad}`);
  await fs.writeFile(binOut, Buffer.from(out.buffer));
  await fs.writeFile(path.join(OUT_DIR, 'terrain_raw.bin'), Buffer.from(out.buffer)); // untouched copy; build.ts lowers river beds into terrain.bin
  await writeJson(jsonOut, { n, step: TERRAIN_STEP, origin: -WORLD_HALF, format: 'int16cm', minY: min, maxY: max });

  // Debug preview.
  const img = Buffer.alloc(n * n);
  for (let i = 0; i < n * n; i++) img[i] = Math.max(0, Math.min(255, Math.round(((out[i] / 100 - min) / (max - min)) * 255)));
  await sharp(img, { raw: { width: n, height: n, channels: 1 } }).png().toFile(path.join(CACHE_DIR, 'terrain_preview.png'));
}
