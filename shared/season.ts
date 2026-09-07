/**
 * Foliage of Paris' street trees (plane, lime, horse chestnut) over the year, from the day of year:
 * bud burst around mid-April, full leaf by mid-May, colouring from early October, leaf fall through November,
 * bare December to March. Drives the leaf-card coverage and tint in src/world/Trees.ts.
 */
export interface Season {
  /** share of leaf cards kept (1 = full canopy, 0 = bare) */
  coverage: number;
  /** 0 = summer green, 1 = fully turned (gold / rust) */
  autumn: number;
  /** 0..1 fresh light spring green */
  fresh: number;
}

const ramp = (a: number, b: number, x: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));

export function dayOfYear(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

export function seasonState(doy: number): Season {
  const coverage = doy < 100 ? 0 : doy < 135 ? ramp(100, 135, doy) : doy < 290 ? 1 : doy < 335 ? 1 - ramp(290, 335, doy) : 0;
  const autumn = doy < 270 ? 0 : ramp(270, 300, doy);
  const fresh = doy < 100 ? 0 : doy < 135 ? 1 : 1 - ramp(135, 170, doy);
  return { coverage, autumn, fresh };
}
