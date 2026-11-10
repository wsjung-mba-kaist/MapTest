import type { Input } from '../player/Input';

export type ModalKind = 'places' | 'help' | 'info' | 'settings' | 'time' | 'gpu';

export interface ModalPanel {
  show(): void;
  hide(): void;
  /** hint line under the HUD while this panel is open (centred modals only) */
  hint?: string;
  /** the time panel and the GPU panel are not centred modals: they do not dim the scene or set the modal hint */
  light?: boolean;
}

/**
 * One panel at a time, one pointer-lock contract: opening a panel releases the pointer (the panel needs the mouse),
 * closing it grabs the pointer back unless another panel took over, the touch UI is in charge (phones never hold
 * the pointer) or the caller says not to. The time panel and the GPU panel used to bypass this and could stack on
 * top of a modal, leaving the pointer in a state neither panel expected.
 */
export class ModalManager {
  private readonly panels = new Map<ModalKind, ModalPanel>();
  private current: ModalKind | null = null;
  /** HUD hook: dim + hint for a centred modal (`light` panels pass false) */
  onModal: (open: boolean, hint: string) => void = () => {};
  /** the overlay has been started at least once (before that there is no pointer to re-grab) */
  started: () => boolean = () => true;

  constructor(private readonly input: Input, private readonly canvas: HTMLElement) {}

  register(kind: ModalKind, panel: ModalPanel) { this.panels.set(kind, panel); }
  get open(): ModalKind | null { return this.current; }
  /** the centred modal that is open (what App.modal used to report), null for the light panels */
  get modal(): Exclude<ModalKind, 'time' | 'gpu'> | null { return this.current && !this.panels.get(this.current)?.light ? this.current as Exclude<ModalKind, 'time' | 'gpu'> : null; }
  is(kind: ModalKind) { return this.current === kind; }

  show(kind: ModalKind) {
    if (this.current && this.current !== kind) this.hide(false);
    const p = this.panels.get(kind);
    if (!p) throw new Error(`modal '${kind}' is not registered`);
    p.show();
    this.current = kind;
    if (!p.light) this.onModal(true, p.hint ?? '');
    this.input.unlock();
  }

  /** close the open panel; `relock` grabs the pointer back (false when another panel or the menu takes over) */
  hide(relock = true) {
    if (!this.current) return;
    const p = this.panels.get(this.current)!;
    p.hide();
    const wasLight = !!p.light;
    this.current = null;
    if (!wasLight) this.onModal(false, '');
    if (wasLight) this.canvas.focus();   // the centred modals restore the opener's focus themselves (dom.ts restoreFocus)
    if (relock && this.started() && !this.input.locked && !this.input.touchMode) this.input.lock();
  }

  /** L / H / T / G / menu: open while walking or closed, close when it is the open one */
  toggle(kind: ModalKind) { if (this.current === kind && !this.input.locked) this.hide(); else this.show(kind); }

  /** Esc: close whatever is on top without re-locking (the pause overlay is about to show). */
  closeTop() { if (this.current) this.hide(false); }
}
