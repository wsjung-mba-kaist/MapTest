/**
 * Keyboard + pointer-lock mouse look, a gamepad (polled in update()) and the touch controls, merged into one set of
 * movement axes shared by the walking and flying controllers.
 *   gamepad: left stick move, right stick look, RT sprint, A interact (E), Y fly (F), Back map (M), Start time (T), X night (N)
 */
export class Input {
  readonly keys = new Set<string>();
  yaw = 0;    // radians, 0 = looking toward -z (north); positive turns right
  pitch = 0;  // radians, positive looks up
  sensitivity = 0.0022;
  locked = false;
  /** touch UI in charge (no pointer lock on phones) */
  touchMode = false;
  gamepadActive = false;
  // contributions from the gamepad and the touch joystick
  private gpF = 0; private gpS = 0; private gpSprint = false;
  touchF = 0; touchS = 0; touchV = 0; touchSprint = false;
  private readonly gpPrev = new Map<number, boolean>();
  private readonly onKeyHandlers: ((code: string, e: KeyboardEvent) => void)[] = [];

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', e => {
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA');
      if (!inField) this.keys.add(e.code); // a focused slider/button keeps its arrow keys; shortcuts still fire
      for (const h of this.onKeyHandlers) h(e.code, e);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.keys.clear();
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.look(e.movementX * this.sensitivity, e.movementY * this.sensitivity);
    });
  }

  /** whether the game should react to movement input (pointer locked, touch UI, or a live gamepad) */
  get active() { return this.locked || this.touchMode || this.gamepadActive; }

  onKey(h: (code: string, e: KeyboardEvent) => void) { this.onKeyHandlers.push(h); }
  /** synthetic key press (gamepad buttons, touch buttons) */
  emitKey(code: string, shift = false) { for (const h of this.onKeyHandlers) h(code, { shiftKey: shift, code } as KeyboardEvent); }
  down(code: string) { return this.keys.has(code); }
  look(dyaw: number, dpitch: number) {
    this.yaw += dyaw;
    this.pitch -= dpitch;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }
  lock() {
    // Newer browsers return a promise that rejects when the gesture is refused (e.g. right after Esc);
    // the pause overlay then stays up and the next click retries.
    try { (this.el.requestPointerLock?.() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* ignore */ }
  }
  unlock() { document.exitPointerLock?.(); }

  /** Poll the first connected gamepad (call once per frame). */
  update(dt: number) {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) { this.gpF = this.gpS = 0; this.gpSprint = false; return; }
    const dz = (v: number) => { const a = Math.abs(v); if (a < 0.15) return 0; const n = (a - 0.15) / 0.85; return Math.sign(v) * n * n; };
    const lx = dz(gp.axes[0] ?? 0), ly = dz(gp.axes[1] ?? 0), rx = dz(gp.axes[2] ?? 0), ry = dz(gp.axes[3] ?? 0);
    this.gpF = -ly; this.gpS = lx;
    if (rx || ry) this.look(rx * 2.6 * dt, ry * 1.8 * dt);
    this.gpSprint = (gp.buttons[7]?.value ?? 0) > 0.4 || !!gp.buttons[10]?.pressed;
    const map: Record<number, string> = { 0: 'KeyE', 3: 'KeyF', 8: 'KeyM', 9: 'KeyT', 2: 'KeyN', 1: 'KeyH' };
    for (const [idxS, code] of Object.entries(map)) {
      const idx = Number(idxS);
      const now = !!gp.buttons[idx]?.pressed;
      if (now && !this.gpPrev.get(idx)) this.emitKey(code);
      this.gpPrev.set(idx, now);
    }
    if (lx || ly || rx || ry || this.gpSprint) this.gamepadActive = true;
  }

  /** Movement axes: forward (+1 = forward), strafe (+1 = right), vertical (+1 = up). */
  axes() {
    const kf = (this.down('KeyW') || this.down('ArrowUp') ? 1 : 0) - (this.down('KeyS') || this.down('ArrowDown') ? 1 : 0);
    const ks = (this.down('KeyD') || this.down('ArrowRight') ? 1 : 0) - (this.down('KeyA') || this.down('ArrowLeft') ? 1 : 0);
    const kv = (this.down('KeyE') || this.down('Space') ? 1 : 0) - (this.down('KeyQ') || this.down('KeyC') ? 1 : 0);
    const clamp = (x: number) => Math.max(-1, Math.min(1, x));
    return {
      f: clamp(kf + this.gpF + this.touchF), s: clamp(ks + this.gpS + this.touchS), v: clamp(kv + this.touchV),
      sprint: this.down('ShiftLeft') || this.down('ShiftRight') || this.gpSprint || this.touchSprint,
    };
  }
}
