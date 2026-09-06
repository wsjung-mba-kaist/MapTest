import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { CHUNK_SIZE, chunkIndexOf, chunkKey, chunkOrigin } from '../../shared/layout';

interface Collider { bvh: MeshBVH; origin: THREE.Vector3; box: THREE.Box3 }

const tmpBox = new THREE.Box3();
const tmpSeg = new THREE.Line3();
const triPoint = new THREE.Vector3();
const capPoint = new THREE.Vector3();
const tmpVec = new THREE.Vector3();

/**
 * Capsule-vs-world collision using per-chunk BVHs (built lazily for chunks near the player).
 * Chunk geometries are in chunk-local coordinates; the chunk origin is applied on the fly.
 */
export class Collision {
  private readonly colliders = new Map<string, Collider>();
  private readonly walkables = new Map<string, Collider>();
  private readonly pendingGeom = new Map<string, { geom: THREE.BufferGeometry; origin: THREE.Vector3 }>();
  private readonly pendingWalk = new Map<string, { geom: THREE.BufferGeometry; origin: THREE.Vector3 }>();
  buildRadius = 1; // chunks around the player that get BVHs

  /** Register a chunk's blocking geometry (walls). BVH is built when the player gets close. */
  registerChunk(i: number, j: number, geom: THREE.BufferGeometry) {
    const o = chunkOrigin(i, j);
    this.pendingGeom.set(chunkKey(i, j), { geom, origin: new THREE.Vector3(o.x, 0, o.z) });
  }
  /** Register always-on blocking geometry in world coordinates (bridge parapets, tower base). */
  registerStatic(key: string, geom: THREE.BufferGeometry, origin = new THREE.Vector3()) {
    this.pendingGeom.set(`static:${key}`, { geom, origin });
  }
  /** Register a walkable surface (bridge decks, platforms) in world coordinates. */
  registerWalkable(key: string, geom: THREE.BufferGeometry, origin = new THREE.Vector3()) {
    this.pendingWalk.set(key, { geom, origin });
  }
  /** Build every pending walkable now (decks the player may be placed on before the first frames run). */
  flushWalkables() { for (const key of [...this.pendingWalk.keys()]) this.ensure(key, this.pendingWalk, this.walkables); }
  /** Drop a walkable surface again (streamed sidewalk slabs). */
  unregisterWalkable(key: string) { this.pendingWalk.delete(key); this.walkables.delete(key); }

  private ensure(key: string, from: Map<string, { geom: THREE.BufferGeometry; origin: THREE.Vector3 }>, into: Map<string, Collider>) {
    if (into.has(key)) return;
    const p = from.get(key);
    if (!p) return;
    from.delete(key);
    const bvh = new MeshBVH(p.geom, { maxLeafTris: 8 });
    const box = new THREE.Box3();
    bvh.getBoundingBox(box);
    box.translate(p.origin);
    into.set(key, { bvh, origin: p.origin, box });
  }

  /** Build BVHs for chunks around x/z; call every frame (cheap when nothing is pending). */
  update(x: number, z: number) {
    // at most one blocking BVH and one walkable BVH per frame (walkables are small: slab tops, decks)
    if (this.pendingGeom.size) {
      let built = false;
      for (const key of this.pendingGeom.keys()) if (key.startsWith("static:")) { this.ensure(key, this.pendingGeom, this.colliders); built = true; break; }
      if (!built) {
        const { i, j } = chunkIndexOf(x, z);
        outer: for (let dj = -this.buildRadius; dj <= this.buildRadius; dj++) for (let di = -this.buildRadius; di <= this.buildRadius; di++) {
          const key = chunkKey(i + di, j + dj);
          if (this.pendingGeom.has(key)) { this.ensure(key, this.pendingGeom, this.colliders); break outer; }
        }
      }
    }
    if (this.pendingWalk.size) {
      const key = this.pendingWalk.keys().next().value as string;
      this.ensure(key, this.pendingWalk, this.walkables);
    }
  }

  /**
   * Push a capsule (segment start->end, radius) out of nearby colliders.
   * Returns the accumulated correction applied to `start`/`end` (world space).
   */
  resolveCapsule(start: THREE.Vector3, end: THREE.Vector3, radius: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    tmpBox.makeEmpty(); tmpBox.expandByPoint(start); tmpBox.expandByPoint(end); tmpBox.expandByScalar(radius + CHUNK_SIZE * 0);
    for (const c of this.colliders.values()) {
      if (!c.box.intersectsBox(tmpBox)) continue;
      tmpSeg.start.copy(start).sub(c.origin);
      tmpSeg.end.copy(end).sub(c.origin);
      const localBox = tmpBox.clone().translate(tmpVec.copy(c.origin).negate());
      c.bvh.shapecast({
        intersectsBounds: box => box.intersectsBox(localBox),
        intersectsTriangle: tri => {
          const dist = tri.closestPointToSegment(tmpSeg, triPoint, capPoint);
          if (dist < radius) {
            const depth = radius - dist;
            const dir = capPoint.sub(triPoint).normalize();
            tmpSeg.start.addScaledVector(dir, depth);
            tmpSeg.end.addScaledVector(dir, depth);
          }
          return false;
        },
      });
      const dx = tmpSeg.start.x + c.origin.x - start.x, dy = tmpSeg.start.y + c.origin.y - start.y, dz = tmpSeg.start.z + c.origin.z - start.z;
      start.add(tmpVec.set(dx, dy, dz)); end.add(tmpVec);
      out.add(tmpVec);
    }
    return out;
  }

  /** Highest walkable surface below (x, y+probeUp, z) within maxDrop; NaN when none. */
  walkableY(x: number, y: number, z: number, probeUp = 1.0, maxDrop = 3.0): number {
    let best = NaN;
    const ray = new THREE.Ray(new THREE.Vector3(x, y + probeUp, z), new THREE.Vector3(0, -1, 0));
    for (const c of this.walkables.values()) {
      if (x < c.box.min.x - 1 || x > c.box.max.x + 1 || z < c.box.min.z - 1 || z > c.box.max.z + 1) continue;
      ray.origin.set(x - c.origin.x, y + probeUp - c.origin.y, z - c.origin.z);
      const hit = c.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance <= probeUp + maxDrop) {
        const hy = hit.point.y + c.origin.y;
        if (!(hy <= best)) best = hy;
      }
    }
    return best;
  }

  get colliderCount() { return this.colliders.size; }
  get walkableCount() { return this.walkables.size; }
  get pendingWalkCount() { return this.pendingWalk.size; }
}
