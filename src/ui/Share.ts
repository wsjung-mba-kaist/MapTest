import * as THREE from 'three';
import { todayParis } from '../render/Environment';
import type { App } from '../core/App';

/** URL that reproduces the current view (walk or fly), time of day and tower choice. */
export function shareUrl(app: App): string {
  const p = app.flying ? app.camera.position : app.player.position;
  const deg = (r: number) => ((THREE.MathUtils.radToDeg(r) % 360) + 360) % 360;
  const q = new URLSearchParams();
  q.set(app.flying ? 'fly' : 'walk', '1');
  q.set('x', p.x.toFixed(1)); q.set('y', p.y.toFixed(1)); q.set('z', p.z.toFixed(1));
  q.set('yaw', deg(app.input.yaw).toFixed(0));
  q.set('pitch', THREE.MathUtils.radToDeg(app.input.pitch).toFixed(0));
  q.set('hour', app.env.hour.toFixed(2));
  { const [y, m, d] = app.env.ymd, t = todayParis(); if (y !== t[0] || m !== t[1] || d !== t[2]) q.set('date', `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`); }
  if (app.world.towerKind === 'lattice') q.set('tower', 'lattice');
  if (app.currentLandmark) q.set('at', app.currentLandmark.id);   // re-opens the landmark card (position params still win)
  return `${location.origin}${location.pathname}?${q.toString()}`;
}

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
