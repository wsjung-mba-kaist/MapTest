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
