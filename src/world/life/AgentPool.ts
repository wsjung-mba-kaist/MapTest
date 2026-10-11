import * as THREE from 'three';
import { RADII } from '../radii';

/** one per-agent column of the structure-of-arrays state */
export type Column = Float32Array | Int32Array | Int8Array | Uint8Array | Uint16Array | Uint32Array;

/**
 * Base of the structure-of-arrays agent sets (Crowd, Cyclists, Traffic): a fixed capacity of rows, each column a typed
 * array the subclass registers in its constructor, removal by swapping the last row into the hole. Keeping the column
 * list in one place is the point — Crowd.remove once listed four late-added columns by hand, and a column left out of
 * that list is silently inherited by whichever agent is moved into the slot. Also here: the `ident` strings and the
 * `alive` set the deterministic conveyor uses to avoid spawning the same agent twice, the `seeded` edge set, the
 * despawn ring (`radius + RADII.lifeDespawn`) and the camera-cone spawn veto.
 */
export abstract class AgentPool {
  count = 0;
  protected readonly ident: string[];
  protected readonly alive = new Set<string>();
  protected readonly seeded = new Set<number>();
  protected readonly camDir = new THREE.Vector3(0, 0, -1);
  private readonly cols: Column[] = [];
  private readonly strided: { arr: Column; stride: number }[] = [];
  /** world x/z of every agent (the despawn test reads them) */
  protected abstract readonly px: Float32Array;
  protected abstract readonly pz: Float32Array;

  /** `noSpawnNear`: never appear this close to the camera; `noSpawnView`: ...or within view in front of it closer than this. */
  constructor(cap: number, private readonly noSpawnNear: number, private readonly noSpawnView: number) { this.ident = new Array<string>(cap); }

  /** one value per agent */
  protected columns(...cols: Column[]) { this.cols.push(...cols); }
  /** `stride` consecutive values per agent (a vec3 per row, say) */
  protected stridedColumns(stride: number, ...arrs: Column[]) { for (const arr of arrs) this.strided.push({ arr, stride }); }

  /** Swap-remove row `i`: the last row's columns move into it, `count` drops by one. Subclasses with GPU instance attributes override `swapInstance`. */
  protected remove(i: number) {
    const last = this.count - 1;
    this.alive.delete(this.ident[i]);
    if (i !== last) {
      for (const a of this.cols) a[i] = a[last];
      for (const { arr, stride } of this.strided) for (let k = 0; k < stride; k++) arr[i * stride + k] = arr[last * stride + k];
      this.ident[i] = this.ident[last];
      this.swapInstance(i, last);
    }
    this.count = last;
  }
  /** Move the per-instance GPU attributes (matrix, colour, animation) of row `last` into `i`; the typed columns are already done. */
  protected swapInstance(_i: number, _last: number) {}

  /** Despawn every agent farther than `radius + lifeDespawn` from (x, z), highest index first so the swap never skips a row. */
  protected despawnFar(x: number, z: number, radius: number) {
    const far2 = (radius + RADII.lifeDespawn) ** 2;
    for (let i = this.count - 1; i >= 0; i--) { const dx = this.px[i] - x, dz = this.pz[i] - z; if (dx * dx + dz * dz > far2) this.remove(i); }
  }

  /** Forget the edges that left the active set, then populate the newly active ones (the conveyor is deterministic per edge and time). */
  protected seedNew(next: Set<number>, seedEdge: (e: number) => void) {
    for (const e of this.seeded) if (!next.has(e)) this.seeded.delete(e);
    for (const e of next) if (!this.seeded.has(e)) { seedEdge(e); this.seeded.add(e); }
  }

  /** True when a spawn at (x, z) would pop into view: closer than noSpawnNear, or ahead of the camera (cos > 0.55) within noSpawnView. */
  protected vetoSpawn(x: number, z: number, camX: number, camZ: number): boolean {
    const dx = x - camX, dz = z - camZ, d2 = dx * dx + dz * dz;
    if (d2 < this.noSpawnNear * this.noSpawnNear) return true;
    if (d2 < this.noSpawnView * this.noSpawnView) { const d = Math.sqrt(d2); return (dx / d) * this.camDir.x + (dz / d) * this.camDir.z > 0.55; }
    return false;
  }
}
