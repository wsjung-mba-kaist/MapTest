/**
 * The browser-side keys this app keeps in localStorage, in one place so "reset to defaults" can clear all of them
 * and nothing else reads `localStorage` directly (an ESLint rule keeps it that way). Every access is guarded: private
 * windows and blocked storage throw, and the app must work without it.
 */
export const STORAGE_KEYS = {
  prefs: 'paris.prefs',
  /** legacy (prefs v1 kept mute outside the prefs object); read once by loadPrefs and removed */
  mutedLegacy: 'paris.audio.muted',
  gpuPanelNever: 'paris.gpuPanel.never',
  touchHint: 'paris.touchHint',
} as const;
export type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];

export function storageGet(key: StorageKey): string | null { try { return localStorage.getItem(key); } catch { return null; } }
export function storageSet(key: StorageKey, value: string) { try { localStorage.setItem(key, value); } catch { /* private mode / quota */ } }
export function storageRemove(key: StorageKey) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
/** Everything the app stored (the settings panel's "기본값으로"). */
export function storageClearAll() { for (const k of Object.values(STORAGE_KEYS)) storageRemove(k); }
