import { GRID_N, chunkCentreX, chunkCentreZ } from '../../shared/layout';

/**
 * Per-frame "which 256 m chunks are around the player" scan with hysteresis: a chunk enters below `load` and leaves
 * only past `unload` (> load), so pacing on a boundary never thrashes a streaming layer. Streets, Markings and the
 * facade details each wrote this 12×12 loop by hand with a Set standing in for the inside flags; here the flags are
 * one Uint8Array(144) so `onEnter` / `onLeave` fire exactly once per transition and the layer keeps only its own
 * work (fetch, dispose, register) in the callbacks. `d2` is the squared distance to the chunk centre.
 */
export class ChunkRadius {
  private readonly inside = new Uint8Array(GRID_N * GRID_N);
  private n = 0;
  constructor(public load: number, public unload: number) {}
  setRadii(load: number, unload: number) { this.load = load; this.unload = unload; }
  /** chunks currently inside (entered and not yet left) */
  get count() { return this.n; }
  has(i: number, j: number) { return this.inside[j * GRID_N + i] === 1; }
  update(x: number, z: number, onEnter: (i: number, j: number, d2: number) => void, onLeave: (i: number, j: number, d2: number) => void) {
    const ld2 = this.load ** 2, ud2 = this.unload ** 2;
    for (let j = 0; j < GRID_N; j++) {
      const dz2 = (chunkCentreZ(j) - z) ** 2;
      for (let i = 0; i < GRID_N; i++) {
        const d2 = (chunkCentreX(i) - x) ** 2 + dz2, n = j * GRID_N + i;
        if (!this.inside[n]) { if (d2 < ld2) { this.inside[n] = 1; this.n++; onEnter(i, j, d2); } }
        else if (d2 > ud2) { this.inside[n] = 0; this.n--; onLeave(i, j, d2); }
      }
    }
  }
}
