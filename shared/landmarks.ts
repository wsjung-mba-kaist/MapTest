/** Pure helpers for the landmark system (bake + runtime, no DOM): bearings, proximity, glide timing. */
import type { Landmark } from './layout.ts';

const RAD = 180 / Math.PI;

/** Bearing (deg, 0 = north / -z, clockwise) from (fx,fz) to (tx,tz); same convention as App.yawTo. */
export function bearingDeg(fx: number, fz: number, tx: number, tz: number): number {
  return ((Math.atan2(tx - fx, -(tz - fz)) * RAD) % 360 + 360) % 360;
}

const DIRS = ['앞', '오른쪽 앞', '오른쪽', '오른쪽 뒤', '뒤', '왼쪽 뒤', '왼쪽', '왼쪽 앞'];
/** Where a bearing lies relative to the viewer's yaw (radians), in 8 buckets of 45°. */
export function relativeDir(yawRad: number, bearing: number): string {
  const rel = ((bearing - yawRad * RAD) % 360 + 360) % 360;
  return DIRS[Math.round(rel / 45) % 8];
}

export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / (m < 100 ? 1 : 5)) * (m < 100 ? 1 : 5)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** The landmark whose radius contains (x,z); of several, the smallest site wins (a museum inside a palace). */
export function landmarkAt(list: Landmark[], x: number, z: number): Landmark | null {
  let best: Landmark | null = null;
  for (const l of list) {
    if (l.hidden || l.radius <= 0) continue;
    if (Math.hypot(l.x - x, l.z - z) >= l.radius) continue;
    if (!best || l.radius < best.radius) best = l;
  }
  return best;
}

export function nearestLandmark(list: Landmark[], x: number, z: number): { landmark: Landmark; dist: number } | null {
  let best: Landmark | null = null, bd = Infinity;
  for (const l of list) {
    if (l.hidden) continue;
    const d = Math.hypot(l.x - x, l.z - z);
    if (d < bd) { bd = d; best = l; }
  }
  return best ? { landmark: best, dist: bd } : null;
}

export function sortByDistance(list: Landmark[], x: number, z: number): { landmark: Landmark; dist: number }[] {
  return list.map(l => ({ landmark: l, dist: Math.hypot(l.x - x, l.z - z) })).sort((a, b) => a.dist - b.dist);
}

/** Glide duration for a jump of `dist` metres: 1.2 s nearby, 2.6 s across the square. */
export function glideSeconds(dist: number): number { return Math.max(1.2, Math.min(2.6, 1.2 + dist / 400)); }

export function easeInOut(u: number): number { const t = Math.max(0, Math.min(1, u)); return t * t * (3 - 2 * t); }

/** Shortest signed rotation (radians) from yaw a to yaw b. */
export function shortestYaw(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const CATEGORY_LABEL: Record<string, string> = {
  monument: '기념물', museum: '박물관', palace: '궁전', bridge: '다리', church: '교회', park: '공원', square: '광장', military: '군사시설', theatre: '극장', institution: '기관',
};
