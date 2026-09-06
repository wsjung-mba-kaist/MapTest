import { DATA_URL, fetchBuffer } from '../DataLoader';
import { parseBinMesh } from '../../../shared/binmesh';
import { EdgeFlag, NodeFlag, laneOffset, rightNormal, type PathsMeta } from '../../../shared/paths';

/** A point on the network: position, unit heading (x/z) and the segment index used as a search hint. */
export interface EdgePoint { x: number; y: number; z: number; ux: number; uz: number; seg: number }

/**
 * Runtime view of paths.bin: typed-array columns, CSR adjacency, a 64 m grid of edge bounding boxes and the
 * helpers agents need (position along an edge with a lateral offset, next-edge choice at a node).
 */
export class PathGraph {
  meta!: PathsMeta;
  nodePos!: Float32Array; adjStart!: Uint32Array; adjCount!: Uint8Array; nodeFlags!: Uint8Array; adj!: Uint32Array;
  eA!: Uint32Array; eB!: Uint32Array; eV0!: Uint32Array; eNv!: Uint16Array; eFlags!: Uint16Array; eWidth!: Float32Array;
  eLanes!: Uint8Array; eSpeed!: Uint8Array; eSide!: Float32Array; eLen!: Float32Array; eCls!: Uint8Array; ePark!: Uint8Array; eLane!: Float32Array;
  vPos!: Float32Array; vYs!: Float32Array; vS!: Float32Array;
  river!: Float32Array;
  readonly cell = 64;
  private grid = new Map<number, number[]>();
  private eBox!: Float32Array;

  get edgeCount() { return this.eA.length; }
  get nodeCount() { return this.adjStart.length; }

  async load() {
    const { header, arrays } = parseBinMesh(await fetchBuffer(`${DATA_URL}/paths.bin`));
    this.meta = header.meta as unknown as PathsMeta;
    const g = (sec: string, attr: string) => arrays.get(sec)!.attrs.get(attr)!;
    this.nodePos = g('nodes', 'pos') as Float32Array; this.adjStart = g('nodes', 'adjStart') as Uint32Array; this.adjCount = g('nodes', 'adjCount') as Uint8Array; this.nodeFlags = g('nodes', 'flags') as Uint8Array;
    this.adj = g('adj', 'edge') as Uint32Array;
    this.eA = g('edges', 'a') as Uint32Array; this.eB = g('edges', 'b') as Uint32Array; this.eV0 = g('edges', 'v0') as Uint32Array; this.eNv = g('edges', 'nv') as Uint16Array;
    this.eFlags = g('edges', 'flags') as Uint16Array; this.eWidth = g('edges', 'width') as Float32Array; this.eLanes = g('edges', 'lanes') as Uint8Array; this.eSpeed = g('edges', 'speed') as Uint8Array;
    this.eSide = g('edges', 'side') as Float32Array; this.eLen = g('edges', 'length') as Float32Array; this.eCls = g('edges', 'cls') as Uint8Array; this.ePark = g('edges', 'park') as Uint8Array; this.eLane = g('edges', 'lane') as Float32Array;
    this.vPos = g('verts', 'pos') as Float32Array; this.vYs = g('verts', 'ys') as Float32Array; this.vS = g('verts', 's') as Float32Array;
    this.river = arrays.get('river')?.attrs.get('pos') as Float32Array ?? new Float32Array(0);
    this.buildGrid();
  }

  private buildGrid() {
    const E = this.edgeCount;
    this.eBox = new Float32Array(E * 4);
    for (let e = 0; e < E; e++) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      const v0 = this.eV0[e], nv = this.eNv[e];
      for (let k = 0; k < nv; k++) { const x = this.vPos[(v0 + k) * 3], z = this.vPos[(v0 + k) * 3 + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      const pad = this.eWidth[e] / 2 + 3;
      this.eBox.set([x0 - pad, z0 - pad, x1 + pad, z1 + pad], e * 4);
      const i0 = Math.floor((x0 - pad) / this.cell), i1 = Math.floor((x1 + pad) / this.cell), j0 = Math.floor((z0 - pad) / this.cell), j1 = Math.floor((z1 + pad) / this.cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = this.cellKey(i, j); const arr = this.grid.get(k); if (arr) arr.push(e); else this.grid.set(k, [e]); }
    }
  }
  private cellKey(i: number, j: number) { return (i + 4096) * 8192 + (j + 4096); }

  /** Edges whose bounding box intersects the disc (x,z,r). */
  edgesNear(x: number, z: number, r: number, out: number[] = []): number[] {
    out.length = 0;
    const seen = new Set<number>();
    const i0 = Math.floor((x - r) / this.cell), i1 = Math.floor((x + r) / this.cell), j0 = Math.floor((z - r) / this.cell), j1 = Math.floor((z + r) / this.cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (const e of this.grid.get(this.cellKey(i, j)) ?? []) {
        if (seen.has(e)) continue; seen.add(e);
        const b = e * 4;
        const cx = Math.max(this.eBox[b], Math.min(this.eBox[b + 2], x)), cz = Math.max(this.eBox[b + 1], Math.min(this.eBox[b + 3], z));
        if ((cx - x) * (cx - x) + (cz - z) * (cz - z) <= r * r) out.push(e);
      }
    }
    return out;
  }

  edgeFlags(e: number) { return this.eFlags[e]; }
  isOneway(e: number) { return (this.eFlags[e] & EdgeFlag.ONEWAY) !== 0; }
  drivable(e: number) { return (this.eFlags[e] & EdgeFlag.DRIVE) !== 0; }
  walkable(e: number) { return (this.eFlags[e] & (EdgeFlag.WALK | EdgeFlag.SIDE_L | EdgeFlag.SIDE_R)) !== 0; }
  speed(e: number) { return this.eSpeed[e] / 10; }
  lanes(e: number, dir: 1 | -1) { return this.isOneway(e) ? this.eLanes[e * 2] : dir > 0 ? this.eLanes[e * 2] : this.eLanes[e * 2 + 1]; }
  /** Lateral offset (right of a->b positive) of moving lane k when travelling in `dir`. */
  laneLat(e: number, k: number, dir: 1 | -1) { return laneOffset(this.eLanes[e * 2], this.eLanes[e * 2 + 1], this.eLane[e * 2], this.eLane[e * 2 + 1], this.isOneway(e), k, dir); }
  /** Sidewalk lateral offset for a side (-1 left, +1 right) or 0 when that side has none. */
  sideLat(e: number, side: -1 | 1) { const v = this.eSide[e * 2 + (side < 0 ? 0 : 1)]; return v ? side * v : 0; }
  nodeOf(e: number, dir: 1 | -1, end: boolean) { return (dir > 0) === end ? this.eB[e] : this.eA[e]; }
  nodeX(n: number) { return this.nodePos[n * 3]; }
  nodeY(n: number) { return this.nodePos[n * 3 + 1]; }
  nodeZ(n: number) { return this.nodePos[n * 3 + 2]; }
  nodeFlag(n: number, f: number) { return (this.nodeFlags[n] & f) !== 0; }
  /** Incident edges of a node. */
  incident(n: number, out: number[] = []): number[] {
    out.length = 0;
    const s = this.adjStart[n], c = this.adjCount[n];
    for (let k = 0; k < c; k++) out.push(this.adj[s + k]);
    return out;
  }

  /**
   * Position at arc length `s` (metres from a, regardless of travel direction) with lateral offset `lat`
   * (right of a->b positive). `hint` is the last segment index for this agent (search starts there).
   */
  edgePoint(e: number, s: number, lat: number, hint: number, out: EdgePoint): EdgePoint {
    const v0 = this.eV0[e], nv = this.eNv[e];
    const last = nv - 2;
    let seg = Math.max(0, Math.min(last, hint));
    while (seg > 0 && this.vS[v0 + seg] > s) seg--;
    while (seg < last && this.vS[v0 + seg + 1] < s) seg++;
    const i = v0 + seg, j = i + 1;
    const s0 = this.vS[i], s1 = this.vS[j];
    const t = s1 > s0 ? Math.max(0, Math.min(1, (s - s0) / (s1 - s0))) : 0;
    const x0 = this.vPos[i * 3], z0 = this.vPos[i * 3 + 2], x1 = this.vPos[j * 3], z1 = this.vPos[j * 3 + 2];
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1;
    const ux = dx / l, uz = dz / l;
    const [nx, nz] = rightNormal(ux, uz);
    const yC = this.vPos[i * 3 + 1] + (this.vPos[j * 3 + 1] - this.vPos[i * 3 + 1]) * t;
    const off = this.eWidth[e] / 2 + 1.3;
    const f = Math.min(1, Math.abs(lat) / off);
    const ySide = lat < 0 ? this.vYs[i * 2] + (this.vYs[j * 2] - this.vYs[i * 2]) * t : this.vYs[i * 2 + 1] + (this.vYs[j * 2 + 1] - this.vYs[i * 2 + 1]) * t;
    out.x = x0 + dx * t + nx * lat; out.z = z0 + dz * t + nz * lat;
    out.y = yC + (ySide - yC) * f;
    out.ux = ux; out.uz = uz; out.seg = seg;
    return out;
  }

  /**
   * Choose the next edge at `node` arriving from `fromEdge`. `allowed(e, dir)` filters candidates; `rnd` in [0,1).
   * Straight-ahead continuation is preferred by `straightBias`. Returns null at a dead end.
   */
  pickNext(node: number, fromEdge: number, ux: number, uz: number, allowed: (e: number, dir: 1 | -1) => boolean, rnd: number, straightBias = 0.5): { e: number; dir: 1 | -1 } | null {
    const s = this.adjStart[node], c = this.adjCount[node];
    let total = 0;
    const cand: { e: number; dir: 1 | -1; w: number }[] = [];
    for (let k = 0; k < c; k++) {
      const e = this.adj[s + k];
      if (e === fromEdge) continue;
      const dir: 1 | -1 = this.eA[e] === node ? 1 : -1;
      if (dir < 0 && this.isOneway(e) && allowed === this.driveAllowed) continue;
      if (!allowed(e, dir)) continue;
      // heading of the candidate's first segment
      const v0 = this.eV0[e], nv = this.eNv[e];
      const i = dir > 0 ? v0 : v0 + nv - 1, j = dir > 0 ? v0 + 1 : v0 + nv - 2;
      const dx = this.vPos[j * 3] - this.vPos[i * 3], dz = this.vPos[j * 3 + 2] - this.vPos[i * 3 + 2], l = Math.hypot(dx, dz) || 1;
      const cos = (dx * ux + dz * uz) / l;
      const w = 0.15 + Math.max(0, cos) * straightBias + (cos > 0.9 ? 0.3 : 0);
      cand.push({ e, dir, w }); total += w;
    }
    if (!cand.length) return null;
    let r = rnd * total;
    for (const cnd of cand) { r -= cnd.w; if (r <= 0) return { e: cnd.e, dir: cnd.dir }; }
    return { e: cand[cand.length - 1].e, dir: cand[cand.length - 1].dir };
  }
  readonly driveAllowed = (e: number, dir: 1 | -1) => this.drivable(e) && !(dir < 0 && this.isOneway(e));
  readonly walkAllowed = (e: number, _dir: 1 | -1) => this.walkable(e);
  readonly flags = EdgeFlag;
  readonly nflags = NodeFlag;
}
