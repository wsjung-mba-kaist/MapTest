import { KERB_H, SURFACE_N, SURFACE_STEP, SurfaceClass, WORLD_HALF } from './layout.ts';

/** Ground surface class per 2 m cell (baked by scripts/lib/streets.ts); shared by agents, audio and the minimap. */
export class SurfaceGrid {
  constructor(readonly data: Uint8Array, readonly n = SURFACE_N, readonly step = SURFACE_STEP, readonly origin = -WORLD_HALF) {}

  static fromBuffer(buf: ArrayBuffer): SurfaceGrid {
    const n = Math.round(Math.sqrt(buf.byteLength));
    return new SurfaceGrid(new Uint8Array(buf), n, (WORLD_HALF * 2) / n);
  }

  classAt(x: number, z: number): SurfaceClass {
    const i = Math.floor((x - this.origin) / this.step), j = Math.floor((z - this.origin) / this.step);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return SurfaceClass.None;
    return this.data[j * this.n + i] as SurfaceClass;
  }

  /** Height the walking surface sits above the terrain (kerb lift on sidewalk slabs). */
  lift(x: number, z: number): number { return this.classAt(x, z) === SurfaceClass.Sidewalk ? KERB_H : 0; }

  /** Share of cells of class `cls` within radius r (coarse 5 x 5 sampling). */
  fractionNear(x: number, z: number, r: number, cls: SurfaceClass | SurfaceClass[]): number {
    const set = Array.isArray(cls) ? cls : [cls];
    let hit = 0, n = 0;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      n++;
      if (set.includes(this.classAt(x + a * r / 2, z + b * r / 2))) hit++;
    }
    return hit / n;
  }
}
