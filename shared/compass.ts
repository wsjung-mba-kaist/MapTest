/**
 * Pure geometry for the compass strip at the top of the screen: which bearings fall inside the visible arc around
 * the viewer's heading and where they land across the strip (x in -1..1). Same bearing convention as
 * `bearingDeg` (0 = north / -z, clockwise).
 */
export interface CompassTick { x: number; deg: number; label?: string }
export interface CompassMark<T> { x: number; rel: number; item: T }

const CARDINAL: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

/** Signed angle from `heading` to `bearing`, in (-180, 180]. */
export function relBearing(headingDeg: number, bearingDeg: number): number {
  let d = (bearingDeg - headingDeg) % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** Strip position of a bearing, or null when it lies outside the +/- halfSpan arc. */
export function stripX(headingDeg: number, bearingDeg: number, halfSpanDeg: number): number | null {
  const r = relBearing(headingDeg, bearingDeg);
  return Math.abs(r) <= halfSpanDeg ? r / halfSpanDeg : null;
}

/** Degree ticks every `step` inside the arc, cardinal ones labelled. */
export function compassTicks(headingDeg: number, halfSpanDeg: number, step = 15): CompassTick[] {
  const out: CompassTick[] = [];
  const lo = Math.ceil((headingDeg - halfSpanDeg) / step) * step, hi = Math.floor((headingDeg + halfSpanDeg) / step) * step;
  for (let d = lo; d <= hi; d += step) {
    const deg = ((d % 360) + 360) % 360;
    const x = stripX(headingDeg, deg, halfSpanDeg);
    if (x !== null) out.push({ x, deg, label: CARDINAL[deg] });
  }
  return out;
}

/** Items inside the arc with their strip position, nearest to the centre first. */
export function compassMarks<T>(headingDeg: number, halfSpanDeg: number, items: { bearing: number; item: T }[]): CompassMark<T>[] {
  const out: CompassMark<T>[] = [];
  for (const it of items) {
    const rel = relBearing(headingDeg, it.bearing);
    if (Math.abs(rel) <= halfSpanDeg) out.push({ x: rel / halfSpanDeg, rel, item: it.item });
  }
  return out.sort((a, b) => Math.abs(a.rel) - Math.abs(b.rel));
}
