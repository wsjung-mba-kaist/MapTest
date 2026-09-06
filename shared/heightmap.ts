/** Regular-grid terrain heightmap (Int16 centimetres of world y), shared by bake and runtime. */
export class Heightmap {
  constructor(readonly data: Int16Array, readonly n: number, readonly step: number, readonly origin: number) {}

  static fromBuffer(buf: ArrayBuffer, meta: { n: number; step: number; origin: number }): Heightmap {
    return new Heightmap(new Int16Array(buf), meta.n, meta.step, meta.origin);
  }

  /** Bilinear world-y sample; clamps to the grid edge outside the baked square. */
  sample(x: number, z: number): number {
    const n = this.n;
    const u = (x - this.origin) / this.step, v = (z - this.origin) / this.step;
    const x0 = Math.max(0, Math.min(n - 2, Math.floor(u))), z0 = Math.max(0, Math.min(n - 2, Math.floor(v)));
    const fx = Math.max(0, Math.min(1, u - x0)), fz = Math.max(0, Math.min(1, v - z0));
    const d = this.data;
    const a = d[z0 * n + x0], b = d[z0 * n + x0 + 1], c = d[(z0 + 1) * n + x0], e = d[(z0 + 1) * n + x0 + 1];
    return ((a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + e * fx) * fz) / 100;
  }

  /**
   * Height of the RENDERED ground mesh at (x, z): 4 m cells built from every other sample, each cell split along the
   * anti-diagonal (triangles a-c-b and b-c-d). Geometry that must sit on the visible ground (markings, kerbs) uses this,
   * not the 2 m bilinear sample, or it floats/sinks by up to the odd-sample difference.
   */
  meshY(x: number, z: number, cellM = 4): number {
    const s = Math.max(1, Math.round(cellM / this.step));
    const gx = (x - this.origin) / cellM, gz = (z - this.origin) / cellM;
    const cells = Math.floor((this.n - 1) / s);
    const i = Math.max(0, Math.min(cells - 1, Math.floor(gx))), j = Math.max(0, Math.min(cells - 1, Math.floor(gz)));
    const fx = Math.max(0, Math.min(1, gx - i)), fz = Math.max(0, Math.min(1, gz - j));
    const ya = this.at(i * s, j * s), yb = this.at(i * s + s, j * s), yc = this.at(i * s, j * s + s), yd = this.at(i * s + s, j * s + s);
    return fx + fz <= 1 ? ya + fx * (yb - ya) + fz * (yc - ya) : yd + (1 - fx) * (yc - yd) + (1 - fz) * (yb - yd);
  }

  /** Nearest-sample raw access (world y). */
  at(ix: number, iz: number): number {
    const n = this.n;
    return this.data[Math.max(0, Math.min(n - 1, iz)) * n + Math.max(0, Math.min(n - 1, ix))] / 100;
  }

  /** Approximate surface normal (y-up) at world x/z. */
  normal(x: number, z: number, out: { x: number; y: number; z: number }) {
    const h = this.step;
    const dx = (this.sample(x + h, z) - this.sample(x - h, z)) / (2 * h);
    const dz = (this.sample(x, z + h) - this.sample(x, z - h)) / (2 * h);
    const l = Math.hypot(dx, 1, dz);
    out.x = -dx / l; out.y = 1 / l; out.z = -dz / l;
    return out;
  }
}
