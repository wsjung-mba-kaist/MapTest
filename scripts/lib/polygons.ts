import polygonClipping from 'polygon-clipping';

export type Pt = [number, number];      // [x, z] world metres
export type Ring = Pt[];                // closed or open; functions tolerate a repeated last point
export type Poly = Ring[];              // [outer, ...holes]

export function closeRing(r: Ring): Ring {
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) return [...r, r[0]];
  return r;
}
export function openRing(r: Ring): Ring {
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) return r.slice(0, -1);
  return r;
}

/** Shoelace signed area in the (x, z) plane. Positive = counter-clockwise when x is right and z is up on paper. */
export function signedArea(r: Ring): number {
  const o = openRing(r);
  let a = 0;
  for (let i = 0, n = o.length; i < n; i++) { const p = o[i], q = o[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
export const area = (r: Ring) => Math.abs(signedArea(r));

/** Orient so that signedArea has the requested sign. */
export function orient(r: Ring, positive: boolean): Ring {
  const o = openRing(r);
  return (signedArea(o) >= 0) === positive ? o : o.slice().reverse();
}

export function centroid(r: Ring): Pt {
  const o = openRing(r);
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = o.length; i < n; i++) {
    const p = o[i], q = o[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cz += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) { const n = o.length; return [o.reduce((s, p) => s + p[0], 0) / n, o.reduce((s, p) => s + p[1], 0) / n]; }
  return [cx / (3 * a), cz / (3 * a)];
}

export function bboxOf(rings: Ring[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rings) for (const [x, z] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [x0, z0, x1, z1];
}

export function pointInRing(x: number, z: number, r: Ring): boolean {
  const o = openRing(r);
  let inside = false;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const [xi, zi] = o[i], [xj, zj] = o[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInPoly(x: number, z: number, p: Poly): boolean {
  if (!pointInRing(x, z, p[0])) return false;
  for (let i = 1; i < p.length; i++) if (pointInRing(x, z, p[i])) return false;
  return true;
}

export function distToSegment(x: number, z: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
}
export function distToRing(x: number, z: number, r: Ring): number {
  const o = openRing(r);
  let d = Infinity;
  for (let i = 0, n = o.length; i < n; i++) d = Math.min(d, distToSegment(x, z, o[i], o[(i + 1) % n]));
  return d;
}

export function perimeter(r: Ring): number {
  const o = openRing(r);
  let s = 0;
  for (let i = 0, n = o.length; i < n; i++) s += Math.hypot(o[(i + 1) % n][0] - o[i][0], o[(i + 1) % n][1] - o[i][1]);
  return s;
}

/** Remove consecutive duplicate / near-duplicate vertices and collinear spikes. */
export function cleanRing(r: Ring, eps = 0.02): Ring {
  const o = openRing(r);
  const out: Ring = [];
  for (const p of o) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}

function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) !== 0 && o(a, b, d) !== 0;
}

export function isSimple(r: Ring): boolean {
  const o = openRing(r), n = o.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segmentsIntersect(o[i], o[(i + 1) % n], o[j], o[(j + 1) % n])) return false;
  }
  return true;
}

/**
 * Inset (positive d shrinks) a simple ring by moving each vertex along its angle bisector.
 * Returns null when the result is degenerate (self-intersecting, too small, or the offset exceeds the edge lengths).
 */
export function insetRing(ring: Ring, d: number, minAreaFrac = 0.4): Ring | null {
  const o = cleanRing(ring);
  const n = o.length;
  if (n < 3) return null;
  const inward = signedArea(o) > 0 ? 1 : -1; // left-hand normal points inward for positive area
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const p = o[(i + n - 1) % n], c = o[i], q = o[(i + 1) % n];
    const e1 = [c[0] - p[0], c[1] - p[1]], e2 = [q[0] - c[0], q[1] - c[1]];
    const l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1]);
    if (l1 < 1e-6 || l2 < 1e-6) return null;
    const n1 = [(-e1[1] / l1) * inward, (e1[0] / l1) * inward];
    const n2 = [(-e2[1] / l2) * inward, (e2[0] / l2) * inward];
    let bx = n1[0] + n2[0], bz = n1[1] + n2[1];
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-6) { bx = n1[0]; bz = n1[1]; } else { bx /= bl; bz /= bl; }
    const cosHalf = bx * n1[0] + bz * n1[1];
    let k = d / Math.max(cosHalf, 0.25);
    const maxK = 0.45 * Math.min(l1, l2) / Math.max(1e-6, Math.sqrt(1 - Math.min(0.999, cosHalf * cosHalf)) || 1);
    if (k > maxK) return null;
    out.push([c[0] + bx * k, c[1] + bz * k]);
  }
  const a0 = area(o), a1 = area(out);
  if (a1 < a0 * minAreaFrac || signedArea(out) * signedArea(o) <= 0) return null;
  if (!isSimple(out)) return null;
  return out;
}

/** Intersect polygons (GeoJSON-like [ [outer, holes...], ... ]) with an axis-aligned box. */
export function clipToBox(polys: Poly[], x0: number, z0: number, x1: number, z1: number): Poly[] {
  const box: Poly = [[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]];
  const input = polys.map(p => p.map(r => closeRing(r))) as unknown as polygonClipping.Polygon[];
  try {
    const res = polygonClipping.intersection(input as polygonClipping.MultiPolygon, [box as unknown as polygonClipping.Polygon]);
    return res.map(poly => poly.map(r => openRing(r as Ring)));
  } catch { return []; }
}

export function unionAll(polys: Poly[]): Poly[] {
  if (!polys.length) return [];
  const input = polys.map(p => p.map(r => closeRing(r))) as unknown as polygonClipping.MultiPolygon;
  try { return polygonClipping.union(input).map(poly => poly.map(r => openRing(r as Ring))); } catch { return polys; }
}

/**
 * Robust inset: the ring minus a band of width 2d along its own boundary, keeping the largest piece. Works for
 * footprints with short edges and jogs where the bisector inset self-intersects. The band is subtracted one
 * piece at a time (polygon-clipping's union/difference of many exactly-coincident discs can throw), with disc
 * vertices rotated per vertex so no two discs share exact coordinates. Result keeps the input orientation.
 */
export function erodeRing(ring: Ring, d: number, minAreaFrac = 0.3): Ring | null {
  const o = cleanRing(ring);
  const n = o.length;
  if (n < 3) return null;
  const a0 = area(o);
  if (a0 < 6 * d * d) return null;
  const parts: polygonClipping.Polygon[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, az] = o[i], [bx, bz] = o[(i + 1) % n];
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const nx = (-dz / len) * d, nz = (dx / len) * d;
    parts.push([[[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz], [ax + nx, az + nz]]]);
  }
  for (let i = 0; i < n; i++) {
    const v = o[i], rot = (i * 0.37) % 1 * (Math.PI / 6);
    const disc: [number, number][] = [];
    for (let k = 0; k < 12; k++) { const t = rot + (k / 12) * Math.PI * 2; disc.push([v[0] + Math.cos(t) * d, v[1] + Math.sin(t) * d]); }
    disc.push(disc[0]);
    parts.push([disc]);
  }
  let cur: polygonClipping.MultiPolygon = [[closeRing(o) as unknown as polygonClipping.Ring]];
  try {
    cur = polygonClipping.difference(cur, parts as unknown as polygonClipping.MultiPolygon);
  } catch {
    // fall back to subtracting the pieces one by one, skipping any piece the library chokes on
    cur = [[closeRing(o) as unknown as polygonClipping.Ring]];
    for (const p of parts) { try { cur = polygonClipping.difference(cur, p); } catch { /* skip */ } if (!cur.length) break; }
  }
  let best: Ring | null = null, bestA = 0;
  for (const poly of cur) {
    const r = cleanRing(openRing(poly[0] as unknown as Ring), 0.05);
    const ar = area(r);
    if (ar > bestA) { bestA = ar; best = r; }
  }
  if (!best || best.length < 3 || bestA < a0 * minAreaFrac) return null;
  return orient(best, signedArea(o) > 0);
}

/** Buffer a polyline into polygons of the given width (per-segment quads + joint discs, unioned). */
export function bufferLine(line: Pt[], width: number): Poly[] {
  const h = width / 2;
  const quads: Poly[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1];
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const nx = (-dz / len) * h, nz = (dx / len) * h;
    quads.push([[[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]]]);
    if (i + 2 < line.length) { // joint disc, rotated a little per joint so no two discs share exact coordinates
      const disc: Ring = []; const rot = ((i * 0.37) % 1) * (Math.PI / 6);
      for (let k = 0; k < 12; k++) { const a = rot + (k / 12) * Math.PI * 2; disc.push([bx + Math.cos(a) * h, bz + Math.sin(a) * h]); }
      quads.push([disc]);
    }
  }
  return unionAll(quads);
}
