import { defaultPrefs, parsePrefs, serializePrefs, type Prefs } from '../../shared/prefs';

const KEY = 'paris.prefs';

/** Device defaults for this browser (touch preset, reduced motion). */
export function devicePrefs(coarse: boolean): Prefs {
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return defaultPrefs({ coarse, reducedMotion });
}

/** Stored preferences on top of the device defaults; a missing / corrupt store yields the defaults. */
export function loadPrefs(coarse: boolean): Prefs {
  const base = devicePrefs(coarse);
  try { const raw = localStorage.getItem(KEY); return raw ? parsePrefs(JSON.parse(raw), base) : base; } catch { return base; }
}

export function savePrefs(p: Prefs) {
  try { localStorage.setItem(KEY, serializePrefs(p)); } catch { /* private mode / quota */ }
}

export function clearPrefs() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
