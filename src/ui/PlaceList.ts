import type { Landmark } from '../../shared/layout';
import { bearingDeg, fmtDistance } from '../../shared/landmarks';
import { CATEGORY_COLOR } from './PlacePanel';

/** L: the landmark list (#places), nearest first, with hotkey chips and a heading arrow; click a row to glide there. */
export class PlaceList {
  private readonly root = document.createElement('div');
  private readonly rows = document.createElement('div');
  open = false;

  constructor(parent: HTMLElement, private readonly onPick: (lm: Landmark) => void, private readonly onClose: () => void) {
    this.root.id = 'places'; this.root.hidden = true;
    const head = document.createElement('div'); head.className = 'head';
    head.innerHTML = '<b>명소</b><span class="hint"><kbd>1</kbd>–<kbd>8</kbd> 바로 이동 · <kbd>L</kbd> 닫기</span>';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '✕'; close.className = 'close';
    close.addEventListener('click', () => this.onClose());
    head.appendChild(close);
    this.rows.className = 'rows';
    this.root.append(head, this.rows);
    this.root.addEventListener('pointerdown', e => e.stopPropagation());
    parent.appendChild(this.root);
  }

  show(list: { landmark: Landmark; dist: number }[], x: number, z: number, yaw: number) {
    this.rows.replaceChildren();
    for (const { landmark: lm, dist } of list) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'row';
      const key = document.createElement('span'); key.className = 'key'; key.textContent = lm.hotkey ? String(lm.hotkey) : '';
      const dot = document.createElement('i'); dot.style.background = CATEGORY_COLOR[lm.category] ?? '#e8c27a';
      const name = document.createElement('span'); name.className = 'name';
      name.innerHTML = `<b></b><small></small>`;
      (name.firstChild as HTMLElement).textContent = lm.short;
      (name.lastChild as HTMLElement).textContent = lm.name.fr !== lm.short ? lm.name.fr : '';
      const d = document.createElement('span'); d.className = 'dist'; d.textContent = fmtDistance(dist);
      const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '➤';
      const rel = bearingDeg(x, z, lm.x, lm.z) - (yaw * 180) / Math.PI - 90;   // the glyph points right at 0°
      arrow.style.transform = `rotate(${rel}deg)`;
      row.append(key, dot, name, d, arrow);
      row.addEventListener('click', () => this.onPick(lm));
      this.rows.appendChild(row);
    }
    this.root.hidden = false; this.open = true;
  }

  hide() { this.root.hidden = true; this.open = false; }
}
