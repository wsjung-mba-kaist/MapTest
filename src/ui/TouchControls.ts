import type { Input } from '../player/Input';

/**
 * Touch UI for coarse pointers: a virtual joystick anywhere on the left 40 % of the screen (pushed to the rim = run),
 * drag-to-look on the rest, and a short button row - fly, landmarks, map, and "..." for the pause menu (time,
 * weather, settings, help, share). Climb / descend buttons appear only while flying; the lift prompt itself is the
 * tap target for `E`. Enabled automatically on (pointer: coarse) or with ?touch=1; pointer capture keeps a drag
 * alive when the finger leaves the canvas.
 */
export class TouchControls {
  readonly enabled: boolean;
  private readonly root = document.createElement('div');
  private readonly base = document.createElement('div');
  private readonly knob = document.createElement('div');
  private stickId: number | null = null; private stickX = 0; private stickY = 0;
  private lookId: number | null = null; private lookX = 0; private lookY = 0;
  private readonly flyOnly: HTMLButtonElement[] = [];

  constructor(private readonly input: Input, parent: HTMLElement, force = false) {
    this.enabled = force || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    if (!this.enabled) return;
    document.documentElement.classList.add('touch');
    this.root.id = 'touch';
    this.base.className = 'stick-base'; this.knob.className = 'stick-knob';
    this.base.appendChild(this.knob); this.root.appendChild(this.base);
    const row = document.createElement('div'); row.className = 'touch-row';
    const btn = (label: string, on: () => void, opts: { hold?: (down: boolean) => void; title?: string } = {}) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (opts.title) { b.title = opts.title; b.setAttribute('aria-label', opts.title); }
      b.addEventListener('pointerdown', e => {
        e.stopPropagation(); e.preventDefault();
        if (opts.hold) { opts.hold(true); b.classList.add('on'); b.setPointerCapture(e.pointerId); return; }
        on();
      });
      if (opts.hold) { const up = () => { opts.hold!(false); b.classList.remove('on'); }; b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up); }
      row.appendChild(b); return b;
    };
    this.flyOnly.push(btn('▲', () => {}, { hold: d => { this.input.touchV = d ? 1 : 0; }, title: '상승 (비행 중)' }));
    this.flyOnly.push(btn('▼', () => {}, { hold: d => { this.input.touchV = d ? -1 : 0; }, title: '하강 (비행 중)' }));
    btn('비행', () => this.input.emitKey('KeyF'), { title: '비행 모드 (F)' });
    btn('명소', () => this.input.emitKey('KeyL'), { title: '명소 목록 (L)' });
    btn('지도', () => this.input.emitKey('KeyM'), { title: '미니맵 (M)' });
    btn('⋯', () => this.input.emitKey('Menu'), { title: '메뉴: 시간 · 날씨 · 설정 · 도움말' });
    this.root.appendChild(row);
    parent.appendChild(this.root);
    this.setFlying(false);
    this.hideStick();
    // the lift prompt ("E · 1층으로") doubles as the E button
    const prompt = document.getElementById('prompt');
    if (prompt) { prompt.style.pointerEvents = 'auto'; prompt.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); this.input.emitKey('KeyE'); }); }

    const surface = document.getElementById('app') as HTMLCanvasElement;
    surface.style.touchAction = 'none';
    surface.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      if (e.clientX < window.innerWidth * 0.4 && this.stickId === null) {
        this.stickId = e.pointerId; this.stickX = e.clientX; this.stickY = e.clientY;
        this.base.style.left = `${e.clientX - 60}px`; this.base.style.top = `${e.clientY - 60}px`; this.base.hidden = false;
        this.knob.style.transform = 'translate(0px, 0px)';
      } else if (this.lookId === null) { this.lookId = e.pointerId; this.lookX = e.clientX; this.lookY = e.clientY; }
      try { surface.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    });
    surface.addEventListener('pointermove', e => {
      if (e.pointerId === this.stickId) {
        const dx = e.clientX - this.stickX, dy = e.clientY - this.stickY;
        const r = Math.min(1, Math.hypot(dx, dy) / 50);
        const a = Math.atan2(dy, dx);
        this.knob.style.transform = `translate(${Math.cos(a) * r * 50}px, ${Math.sin(a) * r * 50}px)`;
        const dead = r < 0.12 ? 0 : (r - 0.12) / 0.88;
        this.input.touchS = Math.cos(a) * dead; this.input.touchF = -Math.sin(a) * dead;
        this.input.touchSprint = r > 0.92;   // stick on the rim = run
        this.base.classList.toggle('run', this.input.touchSprint);
      } else if (e.pointerId === this.lookId) {
        const dx = e.clientX - this.lookX, dy = e.clientY - this.lookY;
        this.lookX = e.clientX; this.lookY = e.clientY;
        this.input.look(dx * 0.0045 * this.input.lookScale, dy * 0.0045 * this.input.lookScale);
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.stickId) { this.stickId = null; this.input.touchF = this.input.touchS = 0; this.input.touchSprint = false; this.hideStick(); }
      if (e.pointerId === this.lookId) this.lookId = null;
    };
    surface.addEventListener('pointerup', end); surface.addEventListener('pointercancel', end);
    // a lost capture (system gesture, incoming call) must not leave the stick engaged
    surface.addEventListener('lostpointercapture', end);
  }

  /** climb / descend only make sense in the air */
  setFlying(on: boolean) { for (const b of this.flyOnly) b.hidden = !on; if (!on) this.input.touchV = 0; }

  private hideStick() { this.base.hidden = true; this.base.classList.remove('run'); }
}
