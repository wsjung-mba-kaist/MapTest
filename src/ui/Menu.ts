import { kbdNodes } from './dom';
import { S } from './strings';

/**
 * Centred modal panels opened from the pause menu / shortcuts: the help (full shortcut table) and the info panel
 * (what this is, data sources, model and photo credits). Same pointer-lock contract as the landmark list: App
 * releases the pointer while one is open and grabs it back on close. One modal at a time (App.openModal).
 */
export class Modal {
  readonly root = document.createElement('div');
  readonly body = document.createElement('div');
  open = false;

  /** `hint` is in the `[key]` notation of strings.ts (kbdNodes), not HTML */
  constructor(parent: HTMLElement, id: string, title: string, hint: string, private readonly onClose: () => void, wide = false) {
    const r = this.root;
    r.id = id; r.className = wide ? 'modal wide' : 'modal'; r.hidden = true;
    r.setAttribute('role', 'dialog'); r.setAttribute('aria-modal', 'true'); r.setAttribute('aria-label', title);
    const head = document.createElement('div'); head.className = 'head';
    const b = document.createElement('b'); b.textContent = title;
    const h = document.createElement('span'); h.className = 'hint'; h.append(...kbdNodes(hint));
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '✕'; close.className = 'close'; close.setAttribute('aria-label', S.modal.close);
    close.addEventListener('click', () => this.onClose());
    head.append(b, h, close);
    this.body.className = 'body';
    r.append(head, this.body);
    r.addEventListener('pointerdown', e => e.stopPropagation());
    parent.appendChild(r);
  }

  show() { this.root.hidden = false; this.open = true; (this.root.querySelector('.close') as HTMLElement | null)?.focus(); }
  hide() { this.root.hidden = true; this.open = false; }
}

/** The shortcut table (H), built from the key legend in strings.ts, which the bottom-left hint bar is also drawn from. */
export class HelpPanel extends Modal {
  constructor(parent: HTMLElement, onClose: () => void, touch: boolean) {
    super(parent, 'helppanel', S.help.title, S.help.hint, onClose, true);
    const table = document.createElement('table');
    const heading = (group: string) => { const th = document.createElement('tr'); const h = document.createElement('th'); h.colSpan = 2; h.textContent = group; th.appendChild(h); return th; };
    const line = (keys: string, what: string, boxed = true) => {
      const tr = document.createElement('tr'); const k = document.createElement('td'); const w = document.createElement('td');
      if (boxed) for (const key of keys.split(' · ')) { const kbd = document.createElement('kbd'); kbd.textContent = key; k.appendChild(kbd); k.append(' '); }
      else k.textContent = keys;
      w.textContent = what; tr.append(k, w); return tr;
    };
    for (const { group, rows } of S.help.groups) {
      table.appendChild(heading(group));
      for (const r of rows) table.appendChild(line(r.keys, r.what));
    }
    if (touch) table.prepend(heading(S.help.touch.group), line(S.help.touch.keys, S.help.touch.what, false));   // "화면" is not a key cap
    const foot = document.createElement('div'); foot.className = 'foot';
    foot.textContent = S.help.foot;
    this.body.append(table, foot);
  }
}

export class InfoPanel extends Modal {
  private readonly creditsEl = document.createElement('div');
  constructor(parent: HTMLElement, onClose: () => void) {
    super(parent, 'infopanel', S.info.title, '', onClose, true);
    const p = document.createElement('p');
    p.textContent = S.info.intro;
    const ul = document.createElement('ul');
    for (const t of S.info.sources) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
    this.creditsEl.className = 'credits';
    const foot = document.createElement('div'); foot.className = 'foot';
    foot.textContent = S.info.foot;
    this.body.append(p, ul, this.creditsEl, foot);
  }
  addCredit(text: string) { const d = document.createElement('div'); d.textContent = text; this.creditsEl.appendChild(d); }
}
