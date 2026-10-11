/**
 * Typed lookups for the fixed HUD elements declared in index.html. `required` throws at boot naming the id, so a
 * renamed or deleted element fails on the first frame with a readable message instead of as a null dereference
 * somewhere in a later event handler; `optional` is for elements a page may legitimately be without.
 */
export function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html: #${id} is missing`);
  return el as T;
}
export function optional<T extends HTMLElement>(id: string): T | null { return document.getElementById(id) as T | null; }

/** The controls Tab would visit inside `root`: enabled form controls and links that are not under a `hidden` ancestor (hidden list rows, menu entries). */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
export function focusables(root: HTMLElement): HTMLElement[] { return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => !el.closest('[hidden]')); }

/** Modal focus trap: Tab / Shift+Tab wrap around the panel's own controls instead of wandering into the HUD or the browser chrome. */
export function trapTab(root: HTMLElement, e: KeyboardEvent) {
  if (e.key !== 'Tab') return;
  const list = focusables(root);
  if (!list.length) { e.preventDefault(); return; }
  const i = list.indexOf(document.activeElement as HTMLElement);   // -1: focus is outside the panel (body) → enter it at the matching end
  if (e.shiftKey ? i <= 0 : i < 0 || i === list.length - 1) { e.preventDefault(); list[e.shiftKey ? list.length - 1 : 0].focus(); }
}

/** After a modal closes: back to the element that opened it; if that is gone or no longer rendered (a pause-menu entry once the overlay hid), the canvas. */
export function restoreFocus(el: Element | null) {
  if (el instanceof HTMLElement && el.isConnected) { el.focus(); if (document.activeElement === el) return; }
  optional<HTMLCanvasElement>('app')?.focus();
}

/** `'[Esc] 메뉴 · [1]–[8] 명소'` → text with every `[X]` as a <kbd>: the key-cap notation of strings.ts, so copy never becomes innerHTML. */
export function kbdNodes(spec: string): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = []; let last = 0;
  for (const m of spec.matchAll(/\[([^\]]+)\]/g)) {
    if (m.index > last) out.push(spec.slice(last, m.index));
    const k = document.createElement('kbd'); k.textContent = m[1]; out.push(k); last = m.index + m[0].length;
  }
  if (last < spec.length) out.push(spec.slice(last));
  return out;
}
