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

/** Pause-menu entries (Esc after the start); App maps each action to the same code the shortcut runs. */
export type MenuAction = 'continue' | 'places' | 'time' | 'night' | 'settings' | 'share' | 'shot' | 'help' | 'info';
const MENU: { action: MenuAction; label: string; key: string; sep?: boolean }[] = [
  { action: 'continue', label: '계속 걷기', key: 'Esc' },
  { action: 'places', label: '명소 목록', key: 'L' },
  { action: 'time', label: '시간 · 날씨', key: 'T' },
  { action: 'night', label: '시간대 순환', key: 'N' },
  { action: 'settings', label: '설정', key: '' },
  { action: 'share', label: '링크 복사', key: 'P', sep: true },
  { action: 'shot', label: '스크린샷 저장', key: 'O' },
  { action: 'help', label: '도움말', key: 'H', sep: true },
  { action: 'info', label: '정보 · 출처', key: '' },
];

/**
 * The fixed HUD: start screen / pause menu (#overlay), clock chip + time panel, hint bar, diagnostics readout, toast,
 * lift prompt and the chunk-streaming counter. The overlay has two modes: the dark start screen (loading stages,
 * controls, a start button) and, after the first start, a translucent pause menu over the visible scene.
 */
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
  private clock = document.getElementById('clock') as HTMLDivElement | null;
  private stream = document.getElementById('stream') as HTMLDivElement | null;
  private menuButtons = new Map<MenuAction, HTMLButtonElement>();
  private toastTimer = 0;
  private streamTimer = 0;
  private hintTimer = 0;
  onTimeChange: (hour: number) => void = () => {};
  onStart: () => void = () => {};
  onMenu: (action: MenuAction) => void = () => {};
  onClock: () => void = () => {};
  /** diagnostics (FPS panel + status readout) toggled: App creates the stats panel lazily */
  onDiagnostics: (on: boolean) => void = () => {};
  private ready = false;
  private readyText = '';
  private pauseText = '화면을 클릭하면 계속 걷습니다';
  /** the first start happened: from now on the overlay is the pause menu */
  started = false;
  /** credit lines (model / data licences) shown in the info panel */
  readonly credits: string[] = [];
  onCredit: (text: string) => void = () => {};

  constructor() {
    this.overlay.addEventListener('click', () => { if (this.ready) this.onStart(); });
    const start = document.getElementById('startbtn');
    start?.addEventListener('click', e => { e.stopPropagation(); if (this.ready) this.onStart(); });
    const retry = this.overlay.querySelector('.retry');
    retry?.addEventListener('click', e => { e.stopPropagation(); location.reload(); });
    const menu = this.overlay.querySelector('.menu');
    if (menu) for (const m of MENU) {
      if (m.sep) { const s = document.createElement('div'); s.className = 'sep'; menu.appendChild(s); }
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.append(m.label); if (m.key) { const k = document.createElement('kbd'); k.textContent = m.key; b.appendChild(k); }
      b.addEventListener('click', e => { e.stopPropagation(); this.onMenu(m.action); });
      if (m.action === 'settings' || m.action === 'night') b.hidden = true;   // settings: once its panel exists; night: touch only
      menu.appendChild(b); this.menuButtons.set(m.action, b);
    }
    this.clock?.addEventListener('click', e => { e.stopPropagation(); this.onClock(); });
    this.timeSlider?.addEventListener('input', () => this.applyTime(parseFloat(this.timeSlider.value)));
    this.setPresets(TIME_PRESETS);
  }

  /** show / hide a pause-menu entry (settings appears once its panel exists) */
  enableMenu(action: MenuAction, on: boolean) { const b = this.menuButtons.get(action); if (b) b.hidden = !on; }

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
  /** the always-visible top-right chip: "17:30 · 맑음" (+ date when not today) */
  setClock(text: string) { if (this.clock && this.clock.textContent !== text) this.clock.textContent = text; }

  private applyTime(hour: number) { this.setTimeDisplay(hour); this.onTimeChange(hour); }

  get timePanelOpen() { return !this.timePanel.hidden; }
  /** a modal (landmark list, help, info, settings) is open: the pause overlay peeks like it does for the time panel */
  modalOpen = false;
  private modalHint = '';
  get panelOpen() { return this.timePanelOpen || this.modalOpen; }

  /** Show/hide the time panel. While it is open the pause overlay shrinks to a hint so the slider stays reachable. */
  toggleTimePanel(open = this.timePanel.hidden) {
    this.timePanel.hidden = !open;
    this.overlay.classList.toggle('peek', this.panelOpen && !this.overlay.classList.contains('hidden'));
    this.updateOverlayText();
  }
  setModal(open: boolean, hint = '') {
    this.modalOpen = open; this.modalHint = hint;
    this.overlay.classList.toggle('peek', this.panelOpen && !this.overlay.classList.contains('hidden'));
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
  setReady(text = '마우스 잠금 · Esc 메뉴') {
    this.ready = true;
    this.readyText = text;
    this.overlay.classList.add('ready');
    this.progress(1, text);
  }
  /** Fatal error on the start screen; `retry` adds a reload button (data missing, WebGL context lost). */
  fail(text: string, retry = false) {
    this.msg.textContent = text;
    this.bar.style.background = '#e06060';
    this.overlay.classList.toggle('failed', retry);
    this.overlay.classList.remove('hidden', 'peek', 'pause');
    this.ready = false;
  }
  /** The first start: the overlay becomes the pause menu from now on; the hint bar fades after 20 s. */
  markStarted(pauseText?: string) {
    this.started = true;
    if (pauseText) this.pauseText = pauseText;
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.help.classList.add('faded'), 20000);
  }
  showOverlay(show: boolean) {
    this.overlay.classList.toggle('hidden', !show);
    this.overlay.classList.toggle('pause', show && this.started);
    this.overlay.classList.toggle('peek', show && this.panelOpen);
    this.crosshair.hidden = show;
    if (!show) this.timeSlider?.blur();
    this.updateOverlayText();
  }
  private updateOverlayText() {
    if (!this.ready) return;
    this.msg.textContent = this.modalOpen ? this.modalHint
      : this.timePanelOpen ? '시간을 맞춘 뒤 화면을 클릭하면 계속 걷습니다 · T 패널 닫기'
      : this.started ? this.pauseText : this.readyText;
  }
  /** Diagnostics: FPS panel + the status readout (?status=1, H twice, settings). */
  get diagnostics() { return document.documentElement.classList.contains('debug'); }
  setDiagnostics(on: boolean) {
    document.documentElement.classList.toggle('debug', on);
    this.onDiagnostics(on);
  }
  setStatus(text: string) { this.status.textContent = text; }
  /** Short confirmation message at the bottom of the screen. */
  toast(text: string, ms = 2200) {
    if (!this.toastEl) return;
    this.toastEl.textContent = text; this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { if (this.toastEl) this.toastEl.hidden = true; }, ms);
  }
  /** Building chunks still arriving after the start ("거리 불러오는 중 37/144"); hides itself a second after the last one. */
  streaming(loaded: number, total: number) {
    if (!this.stream) return;
    if (loaded < total) { this.stream.textContent = `거리 불러오는 중 ${loaded}/${total}`; this.stream.hidden = false; clearTimeout(this.streamTimer); this.streamTimer = 0; }
    else if (!this.stream.hidden && !this.streamTimer) this.streamTimer = window.setTimeout(() => { if (this.stream) this.stream.hidden = true; }, 1000);
  }
  /** the bottom-left hint bar (touch devices never show it) */
  showHint(show: boolean) { this.help.classList.toggle('faded', !show); }
  private promptEl = document.getElementById('prompt') as HTMLDivElement | null;
  private promptText = '';
  /** Persistent interaction hint ("E · 1층으로"); null hides it. */
  prompt(text: string | null) {
    if (!this.promptEl || text === this.promptText) return;
    this.promptText = text ?? '';
    this.promptEl.hidden = !text;
    if (text) this.promptEl.innerHTML = text.replace(/^E/, '<kbd>E</kbd>');
  }
  addCredit(text: string) { this.credits.push(text); this.onCredit(text); }
}
