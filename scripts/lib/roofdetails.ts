import { ihash } from '../../shared/hash.ts';
import { DETAIL_STRIDE, RoofDetailKind } from '../../shared/layout.ts';
import { pointInRing, type Ring } from './polygons.ts';

/**
 * Roof furniture rows for the mansard stage of a building: dormer boxes on the steep brisis (one per painted
 * dormer bay, same integer hash as the roof shader) and chimney stacks along the terrasson edge and at the
 * party-wall corners. Rows: x, y, z (world), yaw, kind, sx, sy, sz, seed (DETAIL_STRIDE floats).
 * Outer and inner rings may have different vertex counts (the inner ring is a robust erosion).
 */
export const DORMER_BAY = 3.2;
export const DORMER_THRESHOLD = 0.35;

/** Painted-dormer rule shared with facade.glsl: bay index along the ring perimeter, integer hash against the seed. */
export function hasDormer(bay: number, seed: number): boolean { return ihash(bay, seed) > DORMER_THRESHOLD; }

export interface RoofStage { outer: Ring; inner: Ring; yEave: number; yBreak: number; insetD: number; seed: number; style: number }

/** Unit normal of edge (a->b) that points to the inside of `ring` (tested at the edge midpoint). */
function inwardNormal(ring: Ring, a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  const nx = -dz / l, nz = dx / l;
  const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
  return pointInRing(mx + nx * 0.3, mz + nz * 0.3, ring) ? [nx, nz] : [-nx, -nz];
}

export function placeRoofDetails(st: RoofStage, out: number[]) {
  const { outer, inner, yEave, yBreak, insetD, seed, style } = st;
  if (outer.length < 3 || inner.length < 3) return;
  const rise = yBreak - yEave;
  const slopeLen = Math.hypot(rise, insetD) || 1;
  // ---- dormers along the outer (eave) ring, 1.25 m up the slope; styles 1/2 (modern/industrial) never get them
  if (style !== 1 && style !== 2 && rise > 2.2) {
    let u0 = 0;
    const n = outer.length;
    for (let i = 0; i < n; i++) {
      const a = outer[i], b = outer[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 2.4) { u0 += len; continue; }
      const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
      const [inx, inz] = inwardNormal(outer, a, b);
      const yaw = Math.atan2(dx, dz); // box local +z along the edge, +x outward = -inward
      const s = Math.min(0.75, 1.25 / slopeLen);
      const k0 = Math.floor(Math.fround(u0) / DORMER_BAY), k1 = Math.floor(Math.fround(u0 + len) / DORMER_BAY);
      for (let k = k0; k <= k1; k++) {
        const t = (k + 0.5) * DORMER_BAY - u0;
        if (t < 0.7 || t > len - 0.7) continue;
        if (!hasDormer(k, seed)) continue;
        const px = a[0] + dx * t + inx * insetD * s, pz = a[1] + dz * t + inz * insetD * s;
        // the outward-facing local +x must point away from the building: yaw above puts +x on the left-hand side of the edge;
        // flip when that side is the inside
        const flip = (-dz) * inx + dx * inz > 0 ? Math.PI : 0;
        out.push(px - inx * 0.42, yEave + rise * s + 0.05, pz - inz * 0.42, yaw + flip, RoofDetailKind.Dormer, 1.35, 1.75, 1.05, seed);
      }
      u0 += len;
    }
  }
  // ---- chimney stacks along the break line (inner ring), set back onto the terrasson
  if (style !== 1) {
    const m = inner.length;
    for (let i = 0; i < m; i++) {
      const a = inner[i], b = inner[(i + 1) % m];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 4) continue;
      const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
      const [inx, inz] = inwardNormal(inner, a, b);
      const yaw = Math.atan2(dx, dz);
      const cnt = Math.max(1, Math.round(len / (6.5 + 2.5 * ihash(i + 17, seed))));
      for (let k = 0; k < cnt; k++) {
        const t = (k + 0.5) * len / cnt + (ihash(k + 101, seed + i) - 0.5) * 1.2;
        if (t < 0.9 || t > len - 0.9) continue;
        const px = a[0] + dx * t + inx * 0.5, pz = a[1] + dz * t + inz * 0.5;
        const h = 1.5 + 0.9 * ihash(k + 7 * i, seed + 3);
        const pots = 2 + Math.floor(ihash(k + 3, seed + i) * 3);
        out.push(px, yBreak - 0.35, pz, yaw, RoofDetailKind.Chimney2 + (pots - 2), 1.15, h, 0.6, seed + k);
      }
    }
    // corner stacks (party walls): sharp convex corners of the inner ring
    for (let i = 0; i < m; i++) {
      const p = inner[i], q = inner[(i + 1) % m], r = inner[(i + m - 1) % m];
      const ax = p[0] - r[0], az = p[1] - r[1], bx = q[0] - p[0], bz = q[1] - p[1];
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      if (la < 2 || lb < 2) continue;
      const ang = Math.atan2(Math.abs(ax * bz - az * bx), ax * bx + az * bz);
      if (ang < 0.9 || ang > 2.2) continue;
      if (ihash(i + 900, seed) < 0.45) continue;
      let bix = -ax / la + bx / lb, biz = -az / la + bz / lb;
      const bl = Math.hypot(bix, biz) || 1; bix /= bl; biz /= bl;
      if (!pointInRing(p[0] + bix * 1.2, p[1] + biz * 1.2, inner)) { bix = -bix; biz = -biz; }
      out.push(p[0] + bix * 0.9, yBreak - 0.35, p[1] + biz * 0.9, Math.atan2(bx / lb, bz / lb), RoofDetailKind.Chimney4, 1.6, 2.1 + 0.4 * ihash(i, seed + 5), 0.7, seed + i);
    }
  }
}

export const ROOF_DETAIL_STRIDE = DETAIL_STRIDE;
