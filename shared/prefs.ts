/**
 * User preferences behind the settings panel. Pure (no DOM) so node:test covers parsing and defaults; the runtime
 * keeps them in localStorage (`src/ui/Prefs.ts`) and URL parameters override them for one session without saving.
 */
export type Quality = 'auto' | 'low' | 'medium' | 'high';
export type PixelRatio = 'auto' | 0.5 | 0.75 | 1 | 1.5 | 2;

export interface Prefs {
  v: 1;
  quality: Quality;
  shadows: boolean;
  reflection: boolean;
  ao: boolean;
  pixelRatio: PixelRatio;
  /** multiplier on the base mouse / touch look sensitivity */
  sensitivity: number;
  /** vertical field of view (degrees) */
  fov: number;
  headBob: boolean;
  /** master volume 0..1 (mute is a separate switch, `paris.audio.muted`) */
  volume: number;
  minimap: boolean;
  compass: boolean;
  /** floating landmark name tags */
  labels: boolean;
  /** the moving city (people, cars, boats, trains); applied at the next start */
  life: boolean;
  /** FPS panel + status readout */
  diagnostics: boolean;
}

export const PREFS_VERSION = 1;
export const PIXEL_RATIOS: readonly PixelRatio[] = ['auto', 0.5, 0.75, 1, 1.5, 2];
export const QUALITIES: readonly Quality[] = ['auto', 'low', 'medium', 'high'];
export const PREFS_RANGE = { sensitivity: [0.4, 2.5], fov: [50, 100], volume: [0, 1] } as const;

export const DEFAULT_PREFS: Readonly<Prefs> = {
  v: 1, quality: 'auto', shadows: true, reflection: true, ao: true, pixelRatio: 'auto', sensitivity: 1, fov: 70,
  headBob: true, volume: 1, minimap: false, compass: true, labels: false, life: true, diagnostics: false,
};

/** Defaults for a device: phones lose AO, the planar reflection, the compass and hi-dpi; reduced motion drops the head bob. */
export function defaultPrefs(env: { coarse: boolean; reducedMotion: boolean }): Prefs {
  const p: Prefs = { ...DEFAULT_PREFS };
  if (env.coarse) { p.reflection = false; p.ao = false; p.pixelRatio = 1; p.compass = false; }
  if (env.reducedMotion) p.headBob = false;
  return p;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Parse stored JSON (or any object): unknown keys are dropped, bad values fall back to `base`, numbers are clamped. */
export function parsePrefs(raw: unknown, base: Readonly<Prefs> = DEFAULT_PREFS): Prefs {
  const p: Prefs = { ...base };
  if (!raw || typeof raw !== 'object') return p;
  const o = raw as Record<string, unknown>;
  if (o.v !== PREFS_VERSION) return p;
  const bool = (k: 'shadows' | 'reflection' | 'ao' | 'headBob' | 'minimap' | 'compass' | 'labels' | 'life' | 'diagnostics') => { if (typeof o[k] === 'boolean') p[k] = o[k] as boolean; };
  for (const k of ['shadows', 'reflection', 'ao', 'headBob', 'minimap', 'compass', 'labels', 'life', 'diagnostics'] as const) bool(k);
  if (typeof o.quality === 'string' && (QUALITIES as readonly string[]).includes(o.quality)) p.quality = o.quality as Quality;
  if (o.pixelRatio === 'auto' || (typeof o.pixelRatio === 'number' && (PIXEL_RATIOS as readonly unknown[]).includes(o.pixelRatio))) p.pixelRatio = o.pixelRatio as PixelRatio;
  for (const k of ['sensitivity', 'fov', 'volume'] as const) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) p[k] = clamp(v, PREFS_RANGE[k][0], PREFS_RANGE[k][1]);
  }
  return p;
}

export function serializePrefs(p: Prefs): string { return JSON.stringify({ ...p, v: PREFS_VERSION }); }

/** Keys whose value differs between two preference sets (so only those get re-applied). */
export function diffPrefs(a: Prefs, b: Prefs): (keyof Prefs)[] {
  return (Object.keys(b) as (keyof Prefs)[]).filter(k => a[k] !== b[k]);
}
