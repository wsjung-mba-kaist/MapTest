import { Modal } from './Menu';
import { DEFAULT_PREFS, PIXEL_RATIOS, PREFS_RANGE, QUALITIES, type PixelRatio, type Prefs, type Quality } from '../../shared/prefs';

const QUALITY_LABEL: Record<Quality, string> = { auto: '자동', low: '낮음', medium: '보통', high: '높음' };

type Row = { key: keyof Prefs; label: string; note?: string } & (
  { kind: 'bool' } | { kind: 'range'; min: number; max: number; step: number; fmt: (v: number) => string } | { kind: 'select'; options: { value: string; label: string }[] });

const ROWS: Row[] = [
  { key: 'quality', label: '품질', kind: 'select', options: QUALITIES.map(q => ({ value: q, label: QUALITY_LABEL[q] })), note: '자동: 느리면 한 단계 낮춤' },
  { key: 'shadows', label: '그림자', kind: 'bool' },
  { key: 'reflection', label: '센강 반사', kind: 'bool' },
  { key: 'ao', label: '주변광 차폐 (AO)', kind: 'bool' },
  { key: 'pixelRatio', label: '해상도 배율', kind: 'select', options: PIXEL_RATIOS.map(r => ({ value: String(r), label: r === 'auto' ? '자동' : `${r}×` })) },
  { key: 'sensitivity', label: '시점 감도', kind: 'range', min: PREFS_RANGE.sensitivity[0], max: PREFS_RANGE.sensitivity[1], step: 0.1, fmt: v => `${v.toFixed(1)}×` },
  { key: 'fov', label: '시야각', kind: 'range', min: PREFS_RANGE.fov[0], max: PREFS_RANGE.fov[1], step: 1, fmt: v => `${v.toFixed(0)}°` },
  { key: 'headBob', label: '걸을 때 머리 흔들림', kind: 'bool' },
  { key: 'volume', label: '소리 크기', kind: 'range', min: 0, max: 1, step: 0.05, fmt: v => `${Math.round(v * 100)} %` },
  { key: 'minimap', label: '미니맵 켜고 시작', kind: 'bool' },
  { key: 'compass', label: '나침반 띠', kind: 'bool' },
  { key: 'labels', label: '명소 이름표 (공중)', kind: 'bool' },
  { key: 'life', label: '움직이는 도시', kind: 'bool', note: '다음 시작부터' },
  { key: 'diagnostics', label: '진단 정보 (FPS · 좌표)', kind: 'bool' },
];

/** Settings modal: every row applies immediately through `onChange` and is saved by the caller. */
export class SettingsPanel extends Modal {
  private prefs: Prefs = { ...DEFAULT_PREFS };
  private readonly inputs = new Map<keyof Prefs, HTMLInputElement | HTMLSelectElement>();
  private readonly values = new Map<keyof Prefs, HTMLSpanElement>();

  constructor(parent: HTMLElement, onClose: () => void, private readonly onChange: (p: Prefs, key: keyof Prefs) => void, private readonly onReset: () => void) {
    super(parent, 'settings', '설정', '바로 적용 · 이 브라우저에 저장', onClose);
    for (const r of ROWS) {
      const row = document.createElement('label'); row.className = 'srow';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = r.label;
      if (r.note) { const n = document.createElement('small'); n.textContent = r.note; name.appendChild(n); }
      let ctl: HTMLInputElement | HTMLSelectElement;
      if (r.kind === 'bool') { ctl = document.createElement('input'); ctl.type = 'checkbox'; }
      else if (r.kind === 'range') { ctl = document.createElement('input'); ctl.type = 'range'; ctl.min = String(r.min); ctl.max = String(r.max); ctl.step = String(r.step); }
      else { ctl = document.createElement('select'); for (const o of r.options) { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; ctl.appendChild(op); } }
      ctl.addEventListener(r.kind === 'range' ? 'input' : 'change', () => this.read(r));
      row.append(name, ctl);
      if (r.kind === 'range') { const v = document.createElement('span'); v.className = 'val'; row.appendChild(v); this.values.set(r.key, v); }
      this.inputs.set(r.key, ctl);
      this.body.appendChild(row);
    }
    const foot = document.createElement('div'); foot.className = 'sfoot';
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'close'; reset.textContent = '기본값으로';
    reset.addEventListener('click', () => this.onReset());
    const note = document.createElement('span'); note.textContent = 'URL 파라미터(?quality= 등)가 있으면 그 세션에서는 그것이 우선합니다.';
    foot.append(reset, note);
    this.body.appendChild(foot);
  }

  /** Reflect `p` in the controls (initial load, reset, auto-quality). */
  set(p: Prefs) {
    this.prefs = { ...p };
    for (const r of ROWS) {
      const ctl = this.inputs.get(r.key)!;
      const v = p[r.key];
      if (r.kind === 'bool') (ctl as HTMLInputElement).checked = !!v;
      else if (r.kind === 'range') { ctl.value = String(v); this.values.get(r.key)!.textContent = r.fmt(Number(v)); }
      else ctl.value = String(v);
    }
  }

  private read(r: Row) {
    const ctl = this.inputs.get(r.key)!;
    const p = this.prefs as unknown as Record<string, unknown>;
    if (r.kind === 'bool') p[r.key] = (ctl as HTMLInputElement).checked;
    else if (r.kind === 'range') { const v = Number(ctl.value); p[r.key] = v; this.values.get(r.key)!.textContent = r.fmt(v); }
    else if (r.key === 'pixelRatio') p.pixelRatio = (ctl.value === 'auto' ? 'auto' : Number(ctl.value)) as PixelRatio;
    else p[r.key] = ctl.value;
    this.onChange({ ...this.prefs }, r.key);
  }
}
