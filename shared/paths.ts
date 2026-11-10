/**
 * Street/path network shared by the bake (scripts/lib/paths.ts) and the runtime crowd/traffic simulation.
 * paths.bin (PBM1) sections:
 *   nodes : pos f32x3 | adjStart u32 | adjCount u8 | flags u8
 *   adj   : edge u32                       (CSR adjacency; the edge's a/b tells the direction)
 *   edges : a u32 | b u32 | v0 u32 | nv u16 | flags u16 | width f32 | lanes u8x2 (forward, backward) | speed u8 (dm/s)
 *           | side f32x2 (left offset, right offset; 0 = no sidewalk on that side) | length f32 | wayId u32 | cls u8 | park u8
 *           | lane f32x2 (lane width, moving-band centre offset; right of the way direction is positive)
 *   verts : pos f32x3 (x, centre y, z) | ys f32x2 (left y, right y) | s f32 (arc length from the edge start)
 *   river : pos f32x3 (closed boat loops back to back; header.meta.riverLoops describes them)
 */

export const PATHS_VERSION = 1;

export const EdgeFlag = {
  DRIVE: 1,       // cars may use it
  WALK: 2,        // walkers may use the centreline (footways, paths, pedestrian streets, steps)
  SIDE_L: 4,      // synthetic sidewalk on the left of the way direction
  SIDE_R: 8,      // synthetic sidewalk on the right
  ONEWAY: 16,     // cars only a -> b
  BRIDGE: 32,
  STEPS: 64,
  CROSSING: 128,  // footway=crossing (walkers cross the carriageway here)
  PARK: 256,      // inside a park/garden polygon (strolling density, slower)
} as const;

export const NodeFlag = {
  SIGNAL: 1,      // 3+ drivable arms: candidate for traffic signals
  CAR_SINK: 2,    // cars vanish here (tunnel portal, world boundary)
  CAR_SOURCE: 4,  // cars may appear here
} as const;

/** Road classes in cls order (u8 in the file). */
export const ROAD_CLASSES = ['trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service', 'pedestrian', 'footway', 'path', 'steps', 'cycleway', 'other'] as const;
export type RoadClass = typeof ROAD_CLASSES[number];

export interface RiverLoopMeta { start: number; count: number; length: number; kind: 'mouche' | 'barge'; boats: number }
export interface PathsMeta { version: number; nodes: number; edges: number; verts: number; riverLoops: RiverLoopMeta[]; waterY: number }

/** The edge arrays the heading helper needs (PathGraph and the crossings' CrossingGraph both satisfy it). */
export interface EdgeGeom { eA: ArrayLike<number>; eB: ArrayLike<number>; eV0: ArrayLike<number>; eNv: ArrayLike<number>; vPos: ArrayLike<number> }
/**
 * Unit direction of travel along edge `e` at the moment of arriving at `node` (its last segment, pointing at the
 * node). Traffic signals, the car signal table, junction turn choice and the crossings table all key their phases
 * on this vector — one implementation, so they cannot drift apart. Edges with fewer than 2 vertices give (0, 0).
 */
export function edgeHeadingInto(g: EdgeGeom, e: number, node: number, out: { x: number; z: number }): { x: number; z: number } {
  const v0 = g.eV0[e], nv = g.eNv[e];
  if (nv < 2) { out.x = 0; out.z = 0; return out; }
  const atEnd = g.eB[e] === node;
  const i = atEnd ? v0 + nv - 2 : v0 + 1, j = atEnd ? v0 + nv - 1 : v0;
  const dx = g.vPos[j * 3] - g.vPos[i * 3], dz = g.vPos[j * 3 + 2] - g.vPos[i * 3 + 2], l = Math.hypot(dx, dz) || 1;
  out.x = dx / l; out.z = dz / l;
  return out;
}

/** Right-hand unit normal of a direction (x east, z south): the right side of someone walking along (ux, uz). */
export function rightNormal(ux: number, uz: number): [number, number] { return [-uz, ux]; }

/**
 * Lateral offset (metres, right of the way direction positive) of moving lane `k` (0 = kerb-most on its side).
 * dir +1 = travelling a -> b, -1 = b -> a. Two-way roads keep forward lanes on the right (France drives on the right).
 */
export function laneOffset(lanesF: number, lanesB: number, laneW: number, bandCenter: number, oneway: boolean, k: number, dir: 1 | -1): number {
  if (oneway) { const n = Math.max(1, lanesF); return bandCenter + (Math.min(k, n - 1) + 0.5 - n / 2) * laneW; }
  if (dir > 0) return bandCenter + (Math.min(k, Math.max(1, lanesF) - 1) + 0.5) * laneW;
  return bandCenter - (Math.min(k, Math.max(1, lanesB) - 1) + 0.5) * laneW;
}
