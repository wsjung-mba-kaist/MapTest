import { buildShareQuery, type ShareState } from '../../shared/urlparams';

/** URL that reproduces the current view (walk or fly), time of day and tower choice (the query is built and parsed by shared/urlparams.ts). */
export function shareUrl(state: ShareState): string { return `${location.origin}${location.pathname}?${buildShareQuery(state)}`; }

/** Clipboard write with a textarea fallback for non-secure contexts (plain http on a LAN). */
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Save the canvas as PNG. Must run in the same task as the render, so the drawing buffer is still intact. */
export function saveCanvas(canvas: HTMLCanvasElement, name: string) {
  canvas.toBlob(blob => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}
