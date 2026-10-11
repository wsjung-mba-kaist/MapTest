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
