/**
 * Minimap (M): a north-up crop of the baked ground overview around the player, with the tower, the named viewpoints
 * and a heading wedge. Redrawn at 10 Hz from a plain <img>, so it costs nothing on the GPU side.
 */
export interface MapMarker { x: number; z: number; name: string }

const WORLD = 3072;          // metres covered by overview.jpg
const HALF = WORLD / 2;

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private img: HTMLImageElement | null = null;
  private last = 0;
  visible = false;
  spanM = 320;
  readonly size = 200;

  constructor(parent: HTMLElement, private readonly markers: MapMarker[], overviewUrl = '/data/ground/overview.jpg') {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap';
    this.canvas.width = this.canvas.height = this.size * 2;   // 2x for crisp text on hi-dpi screens
    this.canvas.hidden = true;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const img = new Image();
    img.onload = () => { this.img = img; this.last = 0; };
    img.src = overviewUrl;
  }

  toggle(v = !this.visible) { this.visible = v; this.canvas.hidden = !v; this.last = 0; }

  update(x: number, z: number, yaw: number, now: number) {
    if (!this.visible || now - this.last < 100) return;
    this.last = now;
    const c = this.ctx, S = this.canvas.width, k = S / this.spanM;   // px per metre
    c.save();
    c.clearRect(0, 0, S, S);
    c.beginPath(); c.roundRect(0, 0, S, S, 16); c.clip();
    c.fillStyle = '#1a1d22'; c.fillRect(0, 0, S, S);
    if (this.img) {
      const w = this.img.width, h = this.img.height;
      const px = (x + HALF) / WORLD * w, pz = (z + HALF) / WORLD * h;
      const src = this.spanM / WORLD * w;
      c.drawImage(this.img, px - src / 2, pz - src / 2, src, src, 0, 0, S, S);
      c.fillStyle = 'rgba(10, 14, 20, 0.18)'; c.fillRect(0, 0, S, S);
    }
    const toPx = (wx: number, wz: number) => [S / 2 + (wx - x) * k, S / 2 + (wz - z) * k] as const;
    // the tower (at the world origin) and the named viewpoints
    c.font = 'bold 22px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const m of this.markers) {
      const [mx, mz] = toPx(m.x, m.z);
      if (mx < -20 || mz < -20 || mx > S + 20 || mz > S + 20) continue;
      c.fillStyle = 'rgba(0,0,0,0.55)'; c.beginPath(); c.arc(mx, mz, 9, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#ffd27a'; c.beginPath(); c.arc(mx, mz, 6, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fff'; c.fillText(m.name.slice(0, 1), mx, mz - 20);
    }
    {
      const [tx, tz] = toPx(0, 0);
      if (tx > -40 && tz > -40 && tx < S + 40 && tz < S + 40) {
        c.strokeStyle = '#ffb14a'; c.lineWidth = 4;
        c.beginPath(); c.moveTo(tx - 14, tz + 14); c.lineTo(tx, tz - 18); c.lineTo(tx + 14, tz + 14); c.moveTo(tx - 8, tz + 2); c.lineTo(tx + 8, tz + 2); c.stroke();
      }
    }
    // heading wedge: yaw 0 faces north (screen up), positive turns clockwise
    const hx = Math.sin(yaw), hz = -Math.cos(yaw);
    const a = Math.atan2(hz, hx);
    c.fillStyle = 'rgba(120, 200, 255, 0.35)';
    c.beginPath(); c.moveTo(S / 2, S / 2); c.arc(S / 2, S / 2, 60, a - 0.5, a + 0.5); c.closePath(); c.fill();
    c.fillStyle = '#8fd3ff'; c.strokeStyle = '#04263a'; c.lineWidth = 3;
    c.beginPath(); c.arc(S / 2, S / 2, 8, 0, Math.PI * 2); c.fill(); c.stroke();
    // north mark and a 50 m scale bar
    c.fillStyle = '#fff'; c.font = 'bold 24px system-ui, sans-serif'; c.fillText('N', S - 26, 26);
    c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.moveTo(20, S - 22); c.lineTo(20 + 50 * k, S - 22); c.stroke();
    c.font = '20px system-ui, sans-serif'; c.textAlign = 'left'; c.fillText('50 m', 22, S - 40);
    c.restore();
  }
}
