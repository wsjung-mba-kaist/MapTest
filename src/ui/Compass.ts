import type { Landmark } from '../../shared/layout';
import { bearingDeg, fmtDistance } from '../../shared/landmarks';
import { compassMarks, compassTicks } from '../../shared/compass';

const HALF_SPAN = 60;   // degrees either side of the heading
const REACH = 600;      // metres: landmarks farther away are not marked

/**
 * Compass strip at the top of the screen (#compass): a 120° arc around the heading with cardinal letters and 15°
 * ticks, category-coloured dots for the landmarks within 600 m (hotkey numbers inside), and the names of the two
 * nearest. The site the player is standing in is left out. Redrawn at 10 Hz on a 2x canvas like the minimap.
 */
export class Compass {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private last = 0;
  visible = true;
  colors: Record<string, string> = {};
  readonly w = 380; readonly h = 44;

  constructor(parent: HTMLElement, private readonly list: Landmark[]) {
    this.canvas.id = 'compass';
    this.canvas.width = this.w * 2; this.canvas.height = this.h * 2;
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  setVisible(v: boolean) { this.visible = v; this.canvas.hidden = !v; this.last = 0; }

  update(px: number, pz: number, yawRad: number, currentId: string | null, now: number) {
    if (!this.visible || now - this.last < 100) return;
    this.last = now;
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height, cx = W / 2;
    const heading = ((yawRad * 180 / Math.PI) % 360 + 360) % 360;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(8,10,16,0.55)'; c.beginPath(); c.roundRect(0, 0, W, H, 14); c.fill();
    const toX = (x: number) => cx + x * (W / 2 - 24);
    // ticks and cardinals
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const t of compassTicks(heading, HALF_SPAN, 15)) {
      const x = toX(t.x), edge = 1 - Math.abs(t.x) * 0.55;
      if (t.label) { c.fillStyle = `rgba(255,255,255,${edge})`; c.font = 'bold 22px system-ui, sans-serif'; c.fillText(t.label, x, H / 2 + 1); }
      else { c.fillStyle = `rgba(255,255,255,${0.45 * edge})`; c.fillRect(x - 1, H / 2 - (t.deg % 45 === 0 ? 9 : 5), 2, t.deg % 45 === 0 ? 18 : 10); }
    }
    // landmarks within reach, the two nearest named
    const items = this.list.filter(l => !l.hidden && l.id !== currentId).map(l => ({ l, d: Math.hypot(l.x - px, l.z - pz) })).filter(e => e.d < REACH)
      .map(e => ({ bearing: bearingDeg(px, pz, e.l.x, e.l.z), item: e }));
    const marks = compassMarks(heading, HALF_SPAN, items);
    const named = [...marks].sort((a, b) => a.item.d - b.item.d).slice(0, 2);
    for (const m of marks) {
      const x = toX(m.x), col = this.colors[m.item.l.category] ?? '#ffd27a';
      c.fillStyle = 'rgba(0,0,0,0.6)'; c.beginPath(); c.arc(x, H / 2, 10, 0, Math.PI * 2); c.fill();
      c.fillStyle = col; c.beginPath(); c.arc(x, H / 2, 7, 0, Math.PI * 2); c.fill();
      if (m.item.l.hotkey) { c.fillStyle = '#14171c'; c.font = 'bold 11px system-ui, sans-serif'; c.fillText(String(m.item.l.hotkey), x, H / 2 + 0.5); }
    }
    let side = -1;
    for (const m of named) {
      const x = toX(m.x), text = `${m.item.l.short} ${fmtDistance(m.item.d)}`;
      c.font = 'bold 14px system-ui, sans-serif';
      const tw = c.measureText(text).width + 12, tx = Math.max(tw / 2 + 4, Math.min(W - tw / 2 - 4, x));
      const ty = side < 0 ? 13 : H - 13;
      c.fillStyle = 'rgba(8,10,16,0.85)'; c.beginPath(); c.roundRect(tx - tw / 2, ty - 10, tw, 20, 6); c.fill();
      c.fillStyle = '#f4f1ea'; c.fillText(text, tx, ty + 1);
      side = -side;
    }
    // heading marker
    c.fillStyle = '#8fd3ff'; c.beginPath(); c.moveTo(cx - 6, 0); c.lineTo(cx + 6, 0); c.lineTo(cx, 7); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(cx - 6, H); c.lineTo(cx + 6, H); c.lineTo(cx, H - 7); c.closePath(); c.fill();
  }
}
