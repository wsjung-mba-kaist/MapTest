/** Default time-of-day presets (local hours); App replaces them with sunrise / sunset based ones for the current day. */
export const TIME_PRESETS: { label: string; hour: number }[] = [
  { label: '새벽', hour: 5.75 },
  { label: '낮', hour: 12 },
  { label: '오후', hour: 17.5 },
  { label: '노을', hour: 21.25 },
  { label: '야경', hour: 22.75 },
  { label: '심야', hour: 1 },
];

export function formatHour(hour: number): string {
  let hh = Math.floor(hour), mm = Math.round((hour - hh) * 60);
  if (mm === 60) { hh = (hh + 1) % 24; mm = 0; }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export class Hud {
  private overlay = document.getElementById('overlay') as HTMLDivElement;
  private msg = document.getElementById('overlay-msg') as HTMLParagraphElement;
  private bar = document.querySelector('#progress > i') as HTMLElement;
  private status = document.getElementById('status') as HTMLDivElement;
  private help = document.getElementById('help') as HTMLDivElement;
  private crosshair = document.getElementById('crosshair') as HTMLDivElement;
  private timePanel = document.getElementById('timepanel') as HTMLDivElement;
  private timeSlider = document.getElementById('timeslider') as HTMLInputElement;
  private timeVal = document.getElementById('timeval') as HTMLSpanElement;
  private toastEl = document.getElementById('toast') as HTMLDivElement | null;
  private toastTimer = 0;
  onTimeChange: (hour: number) => void = () => {};
  private ready = false;
  private readyText = '';
  onStart: () => void = () => {};

  constructor() {
    this.overlay.addEventListener('click', () => { if (this.ready) this.onStart(); });
    this.timeSlider?.addEventListener('input', () => this.applyTime(parseFloat(this.timeSlider.value)));
    this.setPresets(TIME_PRESETS);
  }

  /** current preset list (rebuilt per calendar day from sunrise / sunset) */
  presets: { label: string; hour: number }[] = TIME_PRESETS;
  setPresets(list: { label: string; hour: number }[]) {
    this.presets = list;
    const presets = this.timePanel?.querySelector('.presets');
    if (!presets) return;
    presets.replaceChildren();
    for (const p of list) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = p.label; b.title = formatHour(p.hour);
      b.addEventListener('click', () => { this.applyTime(p.hour); b.blur(); });
      presets.appendChild(b);
    }
  }
  setDateLabel(text: string) { const el = document.getElementById('datelabel'); if (el) el.textContent = text; }

  private applyTime(hour: number) { this.setTimeDisplay(hour); this.onTimeChange(hour); }

  get timePanelOpen() { return !this.timePanel.hidden; }

  /** Show/hide the time panel. While it is open the pause overlay shrinks to a hint so the slider stays reachable. */
  toggleTimePanel(open = this.timePanel.hidden) {
    this.timePanel.hidden = !open;
    this.overlay.classList.toggle('peek', open && !this.overlay.classList.contains('hidden'));
    this.updateOverlayText();
  }

  setTimeDisplay(hour: number) {
    this.timeVal.textContent = formatHour(hour);
    if (this.timeSlider && Math.abs(parseFloat(this.timeSlider.value) - hour) > 0.01) this.timeSlider.value = String(hour);
  }

  progress(frac: number, text?: string) {
    this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    if (text) this.msg.textContent = text;
  }
  setReady(text = '클릭하면 시작합니다 (마우스 잠금 · Esc로 해제)') {
    this.ready = true;
    this.readyText = text;
    this.progress(1, text);
  }
  fail(text: string) {
    this.msg.textContent = `Error: ${text}`;
    this.bar.style.background = '#e06060';
  }
  showOverlay(show: boolean) {
    this.overlay.classList.toggle('hidden', !show);
    this.overlay.classList.toggle('peek', show && this.timePanelOpen);
    this.crosshair.hidden = show;
    if (!show) this.timeSlider?.blur();
    this.updateOverlayText();
  }
  private updateOverlayText() {
    if (!this.ready) return;
    this.msg.textContent = this.timePanelOpen ? '시간을 맞춘 뒤 화면을 클릭하면 계속 걷습니다 · T 패널 닫기' : this.readyText;
  }
  setStatus(text: string) { this.status.textContent = text; }
  /** Short confirmation message at the bottom of the screen. */
  toast(text: string, ms = 2200) {
    if (!this.toastEl) return;
    this.toastEl.textContent = text; this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { if (this.toastEl) this.toastEl.hidden = true; }, ms);
  }
  toggleHelp() {
    // on touch devices the help starts hidden (CSS) and the ? button shows it as a compact top-left card
    if (document.documentElement.classList.contains('touch')) { this.help.hidden = false; this.help.classList.toggle('shown'); return; }
    this.help.hidden = !this.help.hidden;
  }
  private promptEl = document.getElementById('prompt') as HTMLDivElement | null;
  private promptText = '';
  /** Persistent interaction hint ("E · 1층으로"); null hides it. */
  prompt(text: string | null) {
    if (!this.promptEl || text === this.promptText) return;
    this.promptText = text ?? '';
    this.promptEl.hidden = !text;
    if (text) this.promptEl.innerHTML = text.replace(/^E/, '<kbd>E</kbd>');
  }
  addCredit(text: string) {
    const el = document.createElement('div');
    el.style.cssText = 'margin-top:6px;opacity:.6;font-size:11px';
    el.textContent = text;
    this.help.appendChild(el);
  }
}
