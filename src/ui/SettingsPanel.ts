import { Modal } from './Menu';
import { DEFAULT_PREFS, PIXEL_RATIOS, PREFS_RANGE, QUALITIES, type PixelRatio, type Prefs, type Quality } from '../../shared/prefs';
import { S } from './strings';

const QUALITY_LABEL: Record<Quality, string> = S.settings.quality;

/** labels and notes come from `S.settings.rows` / `S.settings.notes` by key */
type Row = { key: keyof Prefs } & (
  { kind: 'bool' } | { kind: 'range'; min: number; max: number; step: number; fmt: (v: number) => string } | { kind: 'select'; options: { value: string; label: string }[] });

const ROWS: Row[] = [
  { key: 'quality', kind: 'select', options: QUALITIES.map(q => ({ value: q, label: QUALITY_LABEL[q] })) },
  { key: 'shadows', kind: 'bool' },
  { key: 'reflection', kind: 'bool' },
  { key: 'ao', kind: 'bool' },
  { key: 'pixelRatio', kind: 'select', options: PIXEL_RATIOS.map(r => ({ value: String(r), label: r === 'auto' ? S.settings.auto : `${r}×` })) },
  { key: 'sensitivity', kind: 'range', min: PREFS_RANGE.sensitivity[0], max: PREFS_RANGE.sensitivity[1], step: 0.1, fmt: v => `${v.toFixed(1)}×` },
  { key: 'fov', kind: 'range', min: PREFS_RANGE.fov[0], max: PREFS_RANGE.fov[1], step: 1, fmt: v => `${v.toFixed(0)}°` },
  { key: 'headBob', kind: 'bool' },
  { key: 'volume', kind: 'range', min: 0, max: 1, step: 0.05, fmt: v => `${Math.round(v * 100)} %` },
  { key: 'minimap', kind: 'bool' },
  { key: 'compass', kind: 'bool' },
  { key: 'labels', kind: 'bool' },
  { key: 'life', kind: 'bool' },
  { key: 'diagnostics', kind: 'bool' },
];
// Partial: Prefs also carries keys with no row (the version stamp, the V-key mute)
const LABELS: Partial<Record<keyof Prefs, string>> = S.settings.rows;
const NOTES: Partial<Record<keyof Prefs, string>> = S.settings.notes;

/** Settings modal: every row applies immediately through `onChange` and is saved by the caller. */
export class SettingsPanel extends Modal {
  private prefs: Prefs = { ...DEFAULT_PREFS };
  private readonly inputs = new Map<keyof Prefs, HTMLInputElement | HTMLSelectElement>();
  private readonly values = new Map<keyof Prefs, HTMLSpanElement>();

  constructor(parent: HTMLElement, onClose: () => void, private readonly onChange: (p: Prefs, key: keyof Prefs) => void, private readonly onReset: () => void) {
    super(parent, 'settings', S.settings.title, S.settings.hint, onClose);
    for (const r of ROWS) {
      const row = document.createElement('label'); row.className = 'srow';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = LABELS[r.key] ?? r.key;
      const note = NOTES[r.key];
      if (note) { const n = document.createElement('small'); n.textContent = note; name.appendChild(n); }
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
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'close'; reset.textContent = S.settings.reset;
    reset.addEventListener('click', () => this.onReset());
    const note = document.createElement('span'); note.textContent = S.settings.urlNote;
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
