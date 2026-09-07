import { armPhase, signalState, SIGNAL_RED } from './signals.js';

/**
 * Pedestrian crossings on the path graph. OSM `footway=crossing` ways share a node with the road they cross, and the
 * bake splits ways at shared nodes, so a crossing is one or two CROSSING edges meeting the road at a "road node".
 * For every road node with a crossing we find the signalised junction it belongs to (the crossing node itself, or a
 * SIGNAL node within SEARCH_M along the road) and remember the phase of the car arm it protects: pedestrians walk
 * while that arm is red, cars arriving at the road node brake while the crossing is occupied.
 */
export const CROSSING_FLAG = 128;   // EdgeFlag.CROSSING (shared/paths.ts)
export const SIGNAL_NODE = 1;       // NodeFlag.SIGNAL
const SEARCH_M = 30;

export interface CrossingGraph {
  eLen: ArrayLike<number>; eFlags: ArrayLike<number>; eA: ArrayLike<number>; eB: ArrayLike<number>;
  eV0: ArrayLike<number>; eNv: ArrayLike<number>; vPos: ArrayLike<number>;
  nodeCount: number;
  incident(n: number, out?: number[]): number[];
  nodeFlag(n: number, f: number): boolean;
  drivable(e: number): boolean;
}

export interface CrossingTable {
  /** crossing edge -> road node it touches, -1 for other edges */
  byEdge: Int32Array;
  /** road node -> car-arm phase (0..1), -1 = unsignalled (pedestrian priority), -2 = no crossing here */
  phase: Float32Array;
  /** drivable edge * 2 + (arriving at b ? 1 : 0) -> road node with a crossing at that end, else -1 */
  atEnd: Int32Array;
  count: number;
  signalled: number;
}

/** Direction of travel along e from node `from` toward its other end, as (ux, uz) at the far end. */
function dirInto(g: CrossingGraph, e: number, from: number): [number, number] {
  const v0 = g.eV0[e], nv = g.eNv[e];
  const i = g.eA[e] === from ? v0 + nv - 2 : v0 + 1, j = g.eA[e] === from ? v0 + nv - 1 : v0;
  const dx = g.vPos[j * 3] - g.vPos[i * 3], dz = g.vPos[j * 3 + 2] - g.vPos[i * 3 + 2], l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

export function buildCrossings(g: CrossingGraph): CrossingTable {
  const nE = g.eLen.length;
  const byEdge = new Int32Array(nE).fill(-1);
  const phase = new Float32Array(g.nodeCount).fill(-2);
  const atEnd = new Int32Array(nE * 2).fill(-1);
  const inc: number[] = [], inc2: number[] = [];
  let count = 0, signalled = 0;
  for (let c = 0; c < nE; c++) {
    if (!(g.eFlags[c] & CROSSING_FLAG)) continue;
    // the road node: an endpoint with a drivable edge
    let roadNode = -1;
    for (const n of [g.eA[c], g.eB[c]]) {
      let drive = false;
      for (const e of g.incident(n, inc)) if (g.drivable(e)) { drive = true; break; }
      if (drive) { roadNode = n; break; }
    }
    if (roadNode < 0) continue;
    byEdge[c] = roadNode;
    if (phase[roadNode] > -2) continue;          // second half of the same crossing
    count++;
    // which car arm does it protect? the crossing node itself may be the junction, else look along the road
    let ph = -1;
    const cdir = dirInto(g, c, g.eA[c] === roadNode ? g.eB[c] : g.eA[c]);   // crossing direction (kerb -> road)
    if (g.nodeFlag(roadNode, SIGNAL_NODE)) {
      let best = -1, bestPerp = -1;
      for (const e of g.incident(roadNode, inc)) {
        if (!g.drivable(e)) continue;
        const other = g.eA[e] === roadNode ? g.eB[e] : g.eA[e];
        const [ux, uz] = dirInto(g, e, other);   // into the junction along this arm
        const perp = 1 - Math.abs(ux * cdir[0] + uz * cdir[1]);
        if (perp > bestPerp) { bestPerp = perp; best = e; }
      }
      if (best >= 0) { const other = g.eA[best] === roadNode ? g.eB[best] : g.eA[best]; const [ux, uz] = dirInto(g, best, other); ph = armPhase(roadNode, ux, uz); }
    } else {
      for (const e of g.incident(roadNode, inc)) {
        if (!g.drivable(e) || g.eLen[e] > SEARCH_M) continue;
        const other = g.eA[e] === roadNode ? g.eB[e] : g.eA[e];
        if (!g.nodeFlag(other, SIGNAL_NODE)) continue;
        const [ux, uz] = dirInto(g, e, roadNode);   // travelling from the crossing node into the junction
        ph = armPhase(other, ux, uz);
        break;
      }
    }
    phase[roadNode] = ph;
    if (ph >= 0) signalled++;
    // cars arriving at the road node from any drivable arm pass the crossing
    for (const e of g.incident(roadNode, inc2)) {
      if (!g.drivable(e)) continue;
      atEnd[e * 2 + (g.eB[e] === roadNode ? 1 : 0)] = roadNode;
    }
  }
  return { byEdge, phase, atEnd, count, signalled };
}

/** Pedestrians may step onto a crossing: always at unsignalled ones, otherwise while the car arm is red. */
export function pedestriansMayCross(time: number, phase: number): boolean {
  return phase < 0 || signalState(time, phase) === SIGNAL_RED;
}
