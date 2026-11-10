/**
 * How Paris lights up over the evening: the share of windows lit and whether shops are open, as functions of the
 * local hour. Shared by the facade shader (same table transcribed in facade.glsl `litProbability`) and the runtime
 * (shop-front lights, tests). Piecewise linear between the anchors below, cyclic over 24 h.
 */
export const LIT_ANCHORS: [number, number][] = [
  [0, 0.20], [1, 0.15], [2, 0.10], [3, 0.07], [4, 0.06], [5, 0.08], [6, 0.12], [7, 0.10], [8, 0.05],
  [17, 0.05], [18, 0.09], [19, 0.15], [20, 0.28], [21, 0.40], [22, 0.40], [23, 0.35], [24, 0.20],
];

/** Relative traffic / pedestrian volume over the day (1 = daytime peak), cyclic over 24 h. */
export const CAR_ANCHORS: [number, number][] = [[0, 0.25], [2, 0.12], [4, 0.08], [5, 0.15], [6, 0.45], [7, 0.8], [8, 1.0], [10, 0.85], [12, 0.9], [17, 1.0], [19, 0.9], [21, 0.6], [23, 0.4], [24, 0.25]];
export const WALK_ANCHORS: [number, number][] = [[0, 0.15], [2, 0.05], [5, 0.03], [6, 0.1], [7, 0.35], [9, 0.7], [11, 1.0], [14, 1.0], [18, 1.0], [20, 0.8], [22, 0.5], [23, 0.3], [24, 0.15]];

function interp(table: [number, number][], hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i + 1 < table.length; i++) {
    const [h0, p0] = table[i], [h1, p1] = table[i + 1];
    if (h >= h0 && h <= h1) return h1 > h0 ? p0 + (p1 - p0) * (h - h0) / (h1 - h0) : p0;
  }
  return table[0][1];
}

export function activity(hour: number, kind: 'car' | 'walk'): number { return interp(kind === 'car' ? CAR_ANCHORS : WALK_ANCHORS, hour); }

/** Fraction of windows lit at a local hour (0..24). */
export function litProbability(hour: number): number { return interp(LIT_ANCHORS, hour); }

/**
 * The same table as a GLSL function `float <name>(float h)` (piecewise linear, cyclic over 24 h, result × `scale`),
 * so the facade, dormer and far-ring shaders are generated from LIT_ANCHORS instead of carrying transcribed copies.
 */
export function litProbabilityGlsl(name = 'litProbability', scale = 1): string {
  const n = LIT_ANCHORS.length;
  const hs = LIT_ANCHORS.map(([h]) => h.toFixed(1)).join(','), ps = LIT_ANCHORS.map(([, p]) => p.toFixed(3)).join(',');
  return `float ${name}(float h) {
  h = mod(h, 24.0);
  float hs[${n}] = float[${n}](${hs});
  float ps[${n}] = float[${n}](${ps});
  for (int i = 0; i < ${n - 1}; i++) if (h >= hs[i] && h <= hs[i + 1]) return ${scale.toFixed(3)} * mix(ps[i], ps[i + 1], (h - hs[i]) / max(hs[i + 1] - hs[i], 1e-3));
  return ${(scale * LIT_ANCHORS[0][1]).toFixed(3)};
}`;
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
export function towerSparkle(hour: number, sunset: number, sunrise: number, alwaysOn = false): number {
  // same window as towerLit: with `alwaysOn` the lights stay on past midnight, so the sparkle must too
  if (!towerLit(hour, sunset, sunrise, alwaysOn)) return 0;
  const h = ((hour % 24) + 24) % 24;
  const minute = (h % 1) * 60;
  return minute < 5 ? 1 : 0;
}
