import { defaultPrefs, parsePrefs, serializePrefs, type Prefs } from '../../shared/prefs';
import { STORAGE_KEYS, storageClearAll, storageGet, storageRemove, storageSet } from './storage';

const KEY = STORAGE_KEYS.prefs;

/** Device defaults for this browser (touch preset, reduced motion). */
export function devicePrefs(coarse: boolean): Prefs {
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return defaultPrefs({ coarse, reducedMotion });
}

/** Stored preferences on top of the device defaults; a missing / corrupt store yields the defaults. */
export function loadPrefs(coarse: boolean): Prefs {
  const base = devicePrefs(coarse);
  // prefs v1 kept the mute switch under its own key: hand it to the migration, then retire it
  const legacyMuted = storageGet(STORAGE_KEYS.mutedLegacy);
  const legacy = legacyMuted === null ? {} : { muted: legacyMuted === '1' };
  let p: Prefs;
  try { const raw = storageGet(KEY); p = raw ? parsePrefs(JSON.parse(raw), base, legacy) : base; } catch { p = base; }
  if (legacyMuted !== null) { if (!p.muted && legacyMuted === '1' && !storageGet(KEY)) p = { ...p, muted: true }; storageRemove(STORAGE_KEYS.mutedLegacy); savePrefs(p); }
  return p;
}

export function savePrefs(p: Prefs) { storageSet(KEY, serializePrefs(p)); }

/** "기본값으로": every key the app stores goes, not only the settings object. */
export function clearPrefs() { storageClearAll(); }
