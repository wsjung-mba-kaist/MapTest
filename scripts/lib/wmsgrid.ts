import type { LonLatBox } from '../config.ts';
import { cachedBytes } from './http.ts';

/** A float32 BIL grid from a WMS GetMap (row 0 = north). */
export interface BilGrid { box: LonLatBox; w: number; h: number; data: Float32Array }

const NODATA_MIN = -1000;

export async function fetchBil(url: string, rel: string, w: number, h: number, timeoutMs = 180_000): Promise<BilGrid & { box: LonLatBox }> {
  const buf = await cachedBytes(url, rel, { timeoutMs, retries: 3 });
  if (buf.length !== w * h * 4) throw new Error(`${rel}: unexpected ${buf.length} bytes (expected ${w * h * 4}); body starts "${buf.subarray(0, 80).toString('utf8')}"`);
  return { box: null as unknown as LonLatBox, w, h, data: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) };
}

/** Bilinear sample at lon/lat (NGF metres); NaN outside the grid or on NODATA. */
export function sampleBil(g: BilGrid, lon: number, lat: number): number {
  const { box, w, h, data } = g;
  if (lon < box.west || lon > box.east || lat < box.south || lat > box.north) return NaN;
  const u = ((lon - box.west) / (box.east - box.west)) * w - 0.5;
  const v = ((box.north - lat) / (box.north - box.south)) * h - 0.5;
  const x0 = Math.max(0, Math.min(w - 2, Math.floor(u))), y0 = Math.max(0, Math.min(h - 2, Math.floor(v)));
  const fx = Math.max(0, Math.min(1, u - x0)), fy = Math.max(0, Math.min(1, v - y0));
  const a = data[y0 * w + x0], b = data[y0 * w + x0 + 1], c = data[(y0 + 1) * w + x0], e = data[(y0 + 1) * w + x0 + 1];
  const vals = [a, b, c, e];
  if (vals.some(v => !(v > NODATA_MIN))) {
    const ok = vals.filter(v => v > NODATA_MIN);
    return ok.length ? ok.reduce((s, v) => s + v, 0) / ok.length : NaN;
  }
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}

/** Share of NODATA cells. */
export function nodataFraction(g: BilGrid): number {
  let bad = 0;
  for (let i = 0; i < g.data.length; i++) if (!(g.data[i] > NODATA_MIN)) bad++;
  return bad / g.data.length;
}
