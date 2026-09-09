import type { Landmark } from '../../shared/layout';
import { CATEGORY_LABEL, bearingDeg, fmtDistance } from '../../shared/landmarks';
import { CATEGORY_COLOR } from './PlacePanel';
import { DATA_URL } from '../world/DataLoader';

/**
 * L: the landmark list (#places), nearest first, with a search box, category chips, thumbnails, hotkey chips and a
 * heading arrow; click a row to glide there. While it is open App calls `update` so distances and arrows follow
 * the player; the order stays as it was on opening so rows do not move under the cursor.
 */
export class PlaceList {
  private readonly root = document.createElement('div');
  private readonly rows = document.createElement('div');
  private readonly search = document.createElement('input');
  private readonly chips = document.createElement('div');
  private list: { landmark: Landmark; dist: number }[] = [];
  private items: { lm: Landmark; row: HTMLButtonElement; dist: HTMLSpanElement; arrow: HTMLSpanElement }[] = [];
  private category: string | null = null;
  private currentId: string | null = null;
  open = false;

  constructor(parent: HTMLElement, private readonly onPick: (lm: Landmark) => void, private readonly onClose: () => void) {
    this.root.id = 'places'; this.root.className = 'modal'; this.root.hidden = true;
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-label', '명소 목록');
    const head = document.createElement('div'); head.className = 'head';
    head.innerHTML = '<b>명소</b><span class="hint"><kbd>1</kbd>–<kbd>8</kbd> 바로 이동 · <kbd>↑</kbd><kbd>↓</kbd> <kbd>Enter</kbd> · <kbd>L</kbd> 닫기</span>';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '✕'; close.className = 'close'; close.setAttribute('aria-label', '닫기');
    close.addEventListener('click', () => this.onClose());
    head.appendChild(close);
    const tools = document.createElement('div'); tools.className = 'tools';
    this.search.type = 'search'; this.search.placeholder = '이름 검색 (한 · 불 · 영)'; this.search.setAttribute('aria-label', '명소 검색');
    this.search.addEventListener('input', () => this.rebuild());
    this.chips.className = 'chips';
    tools.append(this.search, this.chips);
    this.rows.className = 'rows';
    this.root.append(head, tools, this.rows);
    this.root.addEventListener('pointerdown', e => e.stopPropagation());
    this.root.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const btns = this.items.map(i => i.row).filter(b => !b.hidden);
        if (!btns.length) return;
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus();
        e.preventDefault();
      } else if (e.key === 'Escape') { this.onClose(); e.stopPropagation(); }
    });
    parent.appendChild(this.root);
  }

  show(list: { landmark: Landmark; dist: number }[], x: number, z: number, yaw: number, currentId: string | null = null) {
    this.list = list; this.currentId = currentId;
    this.buildChips();
    this.rebuild();
    this.update(x, z, yaw);
    this.root.hidden = false; this.open = true;
    (this.items.find(i => !i.row.hidden)?.row ?? this.search).focus();
  }

  hide() { this.root.hidden = true; this.open = false; }

  /** 4 Hz while open: distances and arrows follow the player */
  update(x: number, z: number, yaw: number) {
    for (const it of this.items) {
      if (it.row.hidden) continue;
      it.dist.textContent = fmtDistance(Math.hypot(it.lm.x - x, it.lm.z - z));
      const rel = bearingDeg(x, z, it.lm.x, it.lm.z) - (yaw * 180) / Math.PI - 90;   // the glyph points right at 0°
      it.arrow.style.transform = `rotate(${rel}deg)`;
    }
  }

  private buildChips() {
    this.chips.replaceChildren();
    const cats = [...new Set(this.list.map(e => e.landmark.category))];
    const chip = (label: string, cat: string | null, color?: string) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
      if (color) { const i = document.createElement('i'); i.style.background = color; b.appendChild(i); }
      b.append(label);
      b.classList.toggle('on', this.category === cat);
      b.addEventListener('click', () => { this.category = cat; for (const c of this.chips.children) c.classList.remove('on'); b.classList.add('on'); this.rebuild(); });
      this.chips.appendChild(b);
    };
    chip('전체', null);
    for (const c of cats) chip(CATEGORY_LABEL[c] ?? c, c, CATEGORY_COLOR[c]);
  }

  private rebuild() {
    const q = this.search.value.trim().toLowerCase();
    const match = (lm: Landmark) => (!this.category || lm.category === this.category)
      && (!q || [lm.short, lm.name.ko, lm.name.fr, lm.name.en].some(n => n?.toLowerCase().includes(q)));
    this.rows.replaceChildren(); this.items = [];
    for (const { landmark: lm } of this.list) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'row';
      row.classList.toggle('here', lm.id === this.currentId);
      const key = document.createElement('span'); key.className = 'key'; key.textContent = lm.hotkey ? String(lm.hotkey) : '';
      const dot = document.createElement('i'); dot.style.background = CATEGORY_COLOR[lm.category] ?? '#e8c27a';
      const thumb = document.createElement('span'); thumb.className = 'thumb';
      if (lm.image) { const img = document.createElement('img'); img.src = `${DATA_URL}/${lm.image.file}`; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; thumb.appendChild(img); }
      const name = document.createElement('span'); name.className = 'name';
      name.innerHTML = `<b></b><small></small>`;
      (name.firstChild as HTMLElement).textContent = lm.short;
      (name.lastChild as HTMLElement).textContent = lm.name.fr !== lm.short ? lm.name.fr : '';
      const d = document.createElement('span'); d.className = 'dist';
      const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '➤';
      row.append(key, dot, thumb, name, d, arrow);
      row.hidden = !match(lm);
      row.addEventListener('click', () => this.onPick(lm));
      this.rows.appendChild(row);
      this.items.push({ lm, row, dist: d, arrow });
    }
  }
}
