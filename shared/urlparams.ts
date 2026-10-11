/**
 * The one place that knows which URL parameters the runtime understands. `UrlParams` wraps the query string with
 * typed, clamped accessors (a malformed share link or `?hour=` with no value used to put NaN into the camera, the sun
 * and the sky shader and the whole frame went black with nothing in the console), and `URL_PARAM_NAMES` is the
 * registry a test checks against the README, so a flag cannot be added without being documented. Unknown names in a
 * URL are reported once (`?lifes=0` is a typo, not a feature).
 */
export const URL_PARAM_NAMES = [
  // world / layers
  'tower', 'skyenv', 'life', 'lifedebug', 'marks', 'marksdebug', 'streets', 'streetsdebug', 'signs', 'signsdebug', 'dsm', 'hide', 'details', 'labels', 'facadetex',
  // moving city
  'signals', 'fartraffic', 'crossings', 'metro', 'cyclists', 'carlights', 'headlights', 'shoplights', 'sim', 'simt',
  // light, weather, time
  'date', 'hour', 'weather', 'wet', 'glow', 'stars', 'clouds', 'lamps', 'lampsdebug', 'noenv', 'noshadow', 'skydim', 'clear',
  // rendering
  'quality', 'post', 'ao', 'refl', 'refldbg', 'fov', 'gpu', 'xr',
  // placement / navigation
  'walk', 'fly', 'x', 'y', 'z', 'yaw', 'pitch', 'at', 'glide',
  // ui / input / diagnostics
  'auto', 'timepanel', 'minimap', 'status', 'audio', 'touch', 'drive',
] as const;
export type UrlParamName = typeof URL_PARAM_NAMES[number];

export class UrlParams {
  private readonly q: URLSearchParams;
  /** names present in the query that no module reads (reported by App at boot) */
  readonly unknown: string[] = [];
  constructor(search: string) {
    this.q = new URLSearchParams(search);
    const known = new Set<string>(URL_PARAM_NAMES);
    for (const k of this.q.keys()) if (!known.has(k) && !this.unknown.includes(k)) this.unknown.push(k);
  }
  get(name: UrlParamName): string | null { return this.q.get(name); }
  has(name: UrlParamName): boolean { return this.q.has(name); }
  /** `?name=1` */
  on(name: UrlParamName): boolean { return this.q.get(name) === '1'; }
  /** `?name=0` */
  off(name: UrlParamName): boolean { return this.q.get(name) === '0'; }
  /** The value when it is one of `allowed`, else null (`?weather=rain`). */
  oneOf<T extends string>(name: UrlParamName, allowed: readonly T[]): T | null { const v = this.q.get(name); return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : null; }
  /** Comma-separated list (`?hide=trees,furniture`); empty when absent. */
  list(name: UrlParamName): string[] { return (this.q.get(name) ?? '').split(',').filter(Boolean); }
  /** A finite number clamped to [min, max]; `fallback` when missing, empty or not a number. */
  num(name: UrlParamName, fallback: number, min = -Infinity, max = Infinity): number {
    const raw = this.q.get(name);
    if (raw === null || raw.trim() === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  }
  /** True when the query carries a usable number for `name` (present, non-empty and finite). */
  hasNum(name: UrlParamName): boolean { const raw = this.q.get(name); return raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw)); }
  /** `?date=YYYY-MM-DD` as [y, m, d], or null. */
  date(name: UrlParamName): [number, number, number] | null {
    const s = this.q.get(name);
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? [y, m, d] : null;
  }
}

/** What a share link (`P`) carries: the view, the time and the few world choices that change what is seen. */
export interface ShareState {
  flying: boolean; x: number; y: number; z: number;
  /** degrees, 0 = north, clockwise */ yawDeg: number; pitchDeg: number;
  hour: number;
  /** calendar day when it is not today */ date?: [number, number, number];
  tower?: 'scan' | 'lattice';
  weather?: 'clear' | 'overcast' | 'rain' | 'fog';
  /** landmark id whose card re-opens */ at?: string;
}

/** The query string of a share link; `parseShareState` reads it back (round-trip pinned by a test). */
export function buildShareQuery(s: ShareState): string {
  const q = new URLSearchParams();
  q.set(s.flying ? 'fly' : 'walk', '1');
  q.set('x', s.x.toFixed(1)); q.set('y', s.y.toFixed(1)); q.set('z', s.z.toFixed(1));
  q.set('yaw', (((s.yawDeg % 360) + 360) % 360).toFixed(0));
  q.set('pitch', s.pitchDeg.toFixed(0));
  q.set('hour', s.hour.toFixed(2));
  if (s.date) q.set('date', `${s.date[0]}-${String(s.date[1]).padStart(2, '0')}-${String(s.date[2]).padStart(2, '0')}`);
  if (s.tower === 'lattice') q.set('tower', 'lattice');
  if (s.weather && s.weather !== 'clear') q.set('weather', s.weather);
  if (s.at) q.set('at', s.at);
  return q.toString();
}

export function parseShareState(p: UrlParams): ShareState | null {
  if (!p.hasNum('x') && !p.has('fly') && !p.on('walk')) return null;
  const flying = !(p.on('walk') && p.hasNum('x'));
  return {
    flying, x: p.num('x', 0), y: p.num('y', 0), z: p.num('z', 0),
    yawDeg: p.num('yaw', 0), pitchDeg: p.num('pitch', 0), hour: p.num('hour', 12, 0, 24),
    date: p.date('date') ?? undefined, tower: p.oneOf('tower', ['scan', 'lattice'] as const) ?? undefined,
    weather: p.oneOf('weather', ['clear', 'overcast', 'rain', 'fog'] as const) ?? undefined, at: p.get('at') ?? undefined,
  };
}
