/**
 * Minimap (M): a north-up crop of the baked ground overview around the player, with the tower, the landmarks
 * (category-coloured dots, short Korean labels, hotkey numbers) and a heading wedge. M (or the wheel over it)
 * cycles hidden -> 320 m -> 800 m -> 1.5 km -> hidden; a click while the pointer is free flies the player there.
 * Redrawn at 10 Hz from a plain <img>, so it costs nothing on the GPU side.
 */
export interface MapMarker { x: number; z: number; name: string; short?: string; category?: string; hotkey?: number; /** site radius (m): bigger sites get their label first */ weight?: number }

const WORLD = 3072;          // metres covered by overview.jpg
const HALF = WORLD / 2;
const SPANS = [320, 800, 1500];

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private img: HTMLImageElement | null = null;
  private last = 0;
  visible = false;
  spanM = SPANS[0];
  readonly size = 200;
  /** category -> dot colour (set by App from the landmark palette) */
  colors: Record<string, string> = {};
  /** click on the map (pointer free): fly to that world point */
  onPick: ((x: number, z: number) => void) | null = null;
  private centre = { x: 0, z: 0 };

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
    this.canvas.style.pointerEvents = 'auto'; this.canvas.style.cursor = 'crosshair';
    this.canvas.title = '클릭: 그곳으로 이동 · 휠: 축척';
    this.canvas.addEventListener('pointerdown', e => e.stopPropagation());
    this.canvas.addEventListener('click', e => {
      if (!this.onPick) return;
      const r = this.canvas.getBoundingClientRect(), k = this.spanM / r.width;
      this.onPick(this.centre.x + (e.clientX - r.left - r.width / 2) * k, this.centre.z + (e.clientY - r.top - r.height / 2) * k);
    });
    this.canvas.addEventListener('wheel', e => { e.preventDefault(); this.cycleSpan(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  }

  /** next / previous span, wrapping */
  cycleSpan(dir = 1) { const i = SPANS.indexOf(this.spanM); this.spanM = SPANS[(i + dir + SPANS.length) % SPANS.length]; this.last = 0; }

  /** M: hidden -> 320 m -> 800 m -> 1.5 km -> hidden; toggle(true) shows the 320 m map, toggle(false) hides. */
  toggle(v?: boolean) {
    if (v === true) { this.visible = true; this.spanM = SPANS[0]; }
    else if (v === false) this.visible = false;
    else if (!this.visible) { this.visible = true; this.spanM = SPANS[0]; }
    else { const i = SPANS.indexOf(this.spanM); if (i < SPANS.length - 1) this.spanM = SPANS[i + 1]; else this.visible = false; }
    this.canvas.hidden = !this.visible; this.last = 0;
  }

  update(x: number, z: number, yaw: number, now: number) {
    if (!this.visible || now - this.last < 100) return;
    this.last = now;
    this.centre.x = x; this.centre.z = z;
    const c = this.ctx, S = this.canvas.width, k = S / this.spanM;   // px per metre
    const wide = this.spanM > 800;
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
    // landmarks: dots for every site on the map; labels for the important ones first (hotkeys, then the biggest
    // sites), each measured so it never overprints another - the Trocadero's four museums used to pile up in one blot
    const r = wide ? 5 : 7;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const onMap = this.markers.map(m => { const [mx, mz] = toPx(m.x, m.z); return { m, mx, mz, d: Math.hypot(m.x - x, m.z - z) }; })
      .filter(e => e.mx > -20 && e.mz > -20 && e.mx < S + 20 && e.mz < S + 20);
    for (const { m, mx, mz } of onMap) {
      const col = this.colors[m.category ?? ''] ?? '#ffd27a';
      c.fillStyle = 'rgba(0,0,0,0.55)'; c.beginPath(); c.arc(mx, mz, r + 3, 0, Math.PI * 2); c.fill();
      c.fillStyle = col; c.beginPath(); c.arc(mx, mz, r, 0, Math.PI * 2); c.fill();
      if (m.hotkey) { c.fillStyle = '#14171c'; c.font = `bold ${wide ? 9 : 11}px system-ui, sans-serif`; c.fillText(String(m.hotkey), mx, mz + 0.5); }
    }
    const placed: { x: number; z: number; w: number }[] = [];
    const maxLabels = wide ? 8 : 6;
    c.font = `bold ${wide ? 17 : 20}px system-ui, sans-serif`;
    c.lineWidth = 4; c.strokeStyle = 'rgba(0,0,0,0.8)'; c.lineJoin = 'round';
    onMap.sort((a, b) => (b.m.hotkey ? 1 : 0) - (a.m.hotkey ? 1 : 0) || (b.m.weight ?? 0) - (a.m.weight ?? 0) || a.d - b.d);
    for (const { m, mx, mz } of onMap) {
      if (placed.length >= maxLabels) break;
      if (wide && !m.hotkey) continue;
      const label = m.short ?? m.name, w = c.measureText(label).width + 10;
      if (placed.some(p => Math.abs(p.x - mx) < (p.w + w) / 2 && Math.abs(p.z - mz) < 28)) continue;
      placed.push({ x: mx, z: mz, w });
      c.strokeText(label, mx, mz - 22); c.fillStyle = '#fff'; c.fillText(label, mx, mz - 22);
    }
    {
      const [tx, tz] = toPx(0, 0);
      if (tx > -40 && tz > -40 && tx < S + 40 && tz < S + 40) {
        const s = wide ? 0.6 : 1;
        c.strokeStyle = '#ffb14a'; c.lineWidth = 4 * s;
        c.beginPath(); c.moveTo(tx - 14 * s, tz + 14 * s); c.lineTo(tx, tz - 18 * s); c.lineTo(tx + 14 * s, tz + 14 * s); c.moveTo(tx - 8 * s, tz + 2 * s); c.lineTo(tx + 8 * s, tz + 2 * s); c.stroke();
      }
    }
    // heading wedge: yaw 0 faces north (screen up), positive turns clockwise
    const hx = Math.sin(yaw), hz = -Math.cos(yaw);
    const a = Math.atan2(hz, hx);
    c.fillStyle = 'rgba(120, 200, 255, 0.35)';
    c.beginPath(); c.moveTo(S / 2, S / 2); c.arc(S / 2, S / 2, wide ? 40 : 60, a - 0.5, a + 0.5); c.closePath(); c.fill();
    c.fillStyle = '#8fd3ff'; c.strokeStyle = '#04263a'; c.lineWidth = 3;
    c.beginPath(); c.arc(S / 2, S / 2, 8, 0, Math.PI * 2); c.fill(); c.stroke();
    // north mark and a scale bar
    const bar = wide ? 500 : this.spanM > 500 ? 200 : 50;
    c.fillStyle = '#fff'; c.font = 'bold 24px system-ui, sans-serif'; c.textAlign = 'center'; c.fillText('N', S - 26, 26);
    c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.moveTo(20, S - 22); c.lineTo(20 + bar * k, S - 22); c.stroke();
    c.font = '20px system-ui, sans-serif'; c.textAlign = 'left'; c.fillText(`${bar} m`, 22, S - 40);
    c.restore();
  }
}
