/**
 * How Paris lights up over the evening: the share of windows lit and whether shops are open, as functions of the
 * local hour. Shared by the facade shader (same table transcribed in facade.glsl `litProbability`) and the runtime
 * (shop-front lights, tests). Piecewise linear between the anchors below, cyclic over 24 h.
 */
export const LIT_ANCHORS: [number, number][] = [
  [0, 0.20], [1, 0.15], [2, 0.10], [3, 0.07], [4, 0.06], [5, 0.08], [6, 0.12], [7, 0.10], [8, 0.05],
  [17, 0.05], [18, 0.09], [19, 0.15], [20, 0.28], [21, 0.40], [22, 0.40], [23, 0.35], [24, 0.20],
];

/** Fraction of windows lit at a local hour (0..24). */
export function litProbability(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i + 1 < LIT_ANCHORS.length; i++) {
    const [h0, p0] = LIT_ANCHORS[i], [h1, p1] = LIT_ANCHORS[i + 1];
    if (h >= h0 && h <= h1) return h1 > h0 ? p0 + (p1 - p0) * (h - h0) / (h1 - h0) : p0;
  }
  return LIT_ANCHORS[0][1];
}

/** Shop-front brightness factor: full until 20:00, restaurants (30 %) until 01:00, then a security light. */
export function shopOpen(hour: number, restaurant: boolean): number {
  const h = ((hour % 24) + 24) % 24;
  const close = restaurant ? 25 : 20;          // restaurants close at 01:00 (25 = 1 + 24)
  const hh = h < 6 ? h + 24 : h;               // treat the small hours as a continuation of the evening
  if (hh < 8) return 0.15;
  if (hh < 9.5) return 0.5;
  if (hh < close - 0.5) return 1;
  if (hh < close) return 1 - (hh - (close - 0.5)) / 0.5 * 0.85;
  return 0.15;
}

/** Eiffel Tower floodlights: on from sunset until 23:45 (Paris practice since 2022), sparkle for 5 min at each full hour. */
export function towerLit(hour: number, sunset: number, sunrise: number, alwaysOn = false): number {
  const h = ((hour % 24) + 24) % 24;
  const on = alwaysOn ? (h >= sunset - 0.5 || h < sunrise + 0.3) : (h >= sunset - 0.5 && h < 23.75);
  return on ? 1 : 0;
}
export function towerSparkle(hour: number, sunset: number, alwaysOn = false): number {
  const h = ((hour % 24) + 24) % 24;
  if (!(h >= sunset - 0.5 && (alwaysOn ? true : h < 23.75 + 1e-6))) return 0;
  const minute = (h % 1) * 60;
  return minute < 5 ? 1 : 0;
}
