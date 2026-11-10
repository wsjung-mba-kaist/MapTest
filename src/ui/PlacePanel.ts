import type { Landmark } from '../../shared/layout';
import { CATEGORY_LABEL, bearingDeg, fmtDistance, relativeDir } from '../../shared/landmarks';
import { DATA_URL } from '../world/DataLoader';
import { kbdNodes } from './dom';
import { S, fmt } from './strings';

export const CATEGORY_COLOR: Record<string, string> = {
  monument: '#ffd27a', palace: '#ffd27a', museum: '#8fd3ff', bridge: '#a7f0c4', church: '#e0b3ff', park: '#9ee07a', square: '#9ee07a',
  military: '#f0b48a', theatre: '#ff9ec4', institution: '#c9c9d6',
};

/** one-line hints for places with something to do there (strings.ts), keyed by landmark id */
const TIPS: Record<string, string> = S.place.tips;

/**
 * Landmark card (#place): photo, Korean + French name, facts, a two-sentence description and where the place is
 * relative to the player. Shown on arrival, then folds into a one-line chip ("현재 위치 · 앵발리드"); `I` toggles.
 * Display-only while the pointer is locked; after Esc the pause overlay sits under it, so the Wikipedia link works.
 */
export class PlacePanel {
  private readonly root = document.createElement('div');
  private readonly chip = document.createElement('div');
  private readonly card = document.createElement('div');
  private readonly img = document.createElement('img');
  private readonly cap = document.createElement('div');
  private readonly cat = document.createElement('span');
  private readonly ko = document.createElement('b');
  private readonly fr = document.createElement('span');
  private readonly facts = document.createElement('div');
  private readonly desc = document.createElement('p');
  private readonly pos = document.createElement('div');
  private readonly wiki = document.createElement('a');
  private readonly hint = document.createElement('button');
  private readonly tip = document.createElement('div');
  private readonly go = document.createElement('button');
  /** '여기로 이동' on a card for a place the player is not standing in */
  onGo: (lm: Landmark) => void = () => {};
  private current: Landmark | null = null;
  private timer = 0;
  private manual = false;
  private chipText = '';

  constructor(parent: HTMLElement, private readonly touch: boolean) {
    const r = this.root;
    r.id = 'place'; r.hidden = true; r.dataset.mode = 'card';
    this.chip.className = 'chip';
    this.card.className = 'card';
    this.img.alt = ''; this.img.loading = 'lazy'; this.img.decoding = 'async';
    this.cap.className = 'cap';
    const head = document.createElement('div'); head.className = 'head';
    this.cat.className = 'cat'; this.ko.className = 'ko'; this.fr.className = 'fr';
    head.append(this.cat, this.ko, this.fr);
    this.facts.className = 'facts'; this.desc.className = 'desc'; this.pos.className = 'pos'; this.tip.className = 'tip';
    const foot = document.createElement('div'); foot.className = 'foot';
    this.wiki.className = 'wiki'; this.wiki.target = '_blank'; this.wiki.rel = 'noopener'; this.wiki.textContent = S.place.wiki;
    this.wiki.addEventListener('click', e => e.stopPropagation());
    // the fold control is a real button: with the pointer free (Esc) it is clickable, and I still works while walking
    this.hint.type = 'button'; this.hint.className = 'hint'; this.hint.append(...kbdNodes(touch ? S.place.foldTouch : S.place.fold)); this.hint.setAttribute('aria-label', S.place.foldAria);
    this.hint.addEventListener('click', e => { e.stopPropagation(); this.setMode('chip', true); });
    this.hint.addEventListener('pointerdown', e => e.stopPropagation());
    this.go.type = 'button'; this.go.className = 'go'; this.go.textContent = S.place.go; this.go.hidden = true;
    this.go.addEventListener('click', e => { e.stopPropagation(); if (this.current) this.onGo(this.current); });
    this.go.addEventListener('pointerdown', e => e.stopPropagation());
    foot.append(this.wiki, this.go, this.hint);
    this.card.append(this.img, this.cap, head, this.facts, this.desc, this.tip, this.pos, foot);
    r.append(this.chip, this.card);
    // touch: the chip expands to the card and the card (outside the link) folds back
    this.chip.addEventListener('pointerdown', e => { e.stopPropagation(); this.setMode('card', true); });
    this.card.addEventListener('pointerdown', e => { if ((e.target as HTMLElement).closest('a')) return; e.stopPropagation(); if (touch) this.setMode('chip', true); });
    parent.appendChild(r);
  }

  get landmark() { return this.current; }
  get open() { return !this.root.hidden && this.root.dataset.mode === 'card'; }

  /** Fill the card for `lm` and show it (arrival: 8 s, enter: 5 s, manual: stays). */
  show(lm: Landmark, reason: 'arrival' | 'enter' | 'manual') {
    if (lm !== this.current) {
      this.current = lm;
      const c = CATEGORY_COLOR[lm.category] ?? '#e8c27a';
      this.cat.textContent = CATEGORY_LABEL[lm.category] ?? lm.category; this.cat.style.color = c; this.cat.style.borderColor = c;
      this.ko.textContent = lm.short;
      this.fr.textContent = lm.name.fr && lm.name.fr !== lm.short ? lm.name.fr : (lm.name.en !== lm.short ? lm.name.en : '');
      const f: string[] = [];
      if (lm.facts?.architect?.length) f.push(fmt(S.place.architect, { names: lm.facts.architect.join(', ') }));
      if (lm.facts?.year) f.push(fmt(S.place.year, { year: lm.facts.year }));
      if (lm.facts?.height) f.push(fmt(S.place.height, { height: lm.facts.height }));
      this.facts.textContent = f.join(' · '); this.facts.hidden = !f.length;
      const lines: string[] = [];
      if (lm.blurb) lines.push(lm.blurb);
      if (lm.desc && lm.desc.text !== lm.blurb) lines.push(lm.desc.lang === 'ko' ? lm.desc.text : `${lm.desc.text} (${lm.desc.lang === 'fr' ? S.place.lang.fr : S.place.lang.en})`);
      this.desc.textContent = lines.join(' '); this.desc.hidden = !lines.length;
      if (lm.image) {
        this.img.src = `${DATA_URL}/${lm.image.file}`; this.img.hidden = false;
        this.cap.textContent = `${fmt(S.place.photo, { artist: lm.image.artist ?? S.place.photoDefault })}${lm.image.license ? ` · ${lm.image.license}` : ''}`; this.cap.hidden = false;
      } else { this.img.removeAttribute('src'); this.img.hidden = true; this.cap.hidden = true; }
      // only http(s): the URL comes from Wikidata sitelinks via the bake, and an anchor href is a script sink otherwise
      if (lm.links.wiki && /^https?:\/\//i.test(lm.links.wiki.url)) { this.wiki.href = lm.links.wiki.url; this.wiki.hidden = false; } else this.wiki.hidden = true;
      const tip = TIPS[lm.id]; this.tip.textContent = tip ?? ''; this.tip.hidden = !tip;
    }
    this.root.hidden = false;
    this.manual = reason === 'manual';
    if (reason === 'enter' && this.touch) { this.setMode('chip'); return; }
    this.setMode('card');
    clearTimeout(this.timer);
    if (!this.manual) this.timer = window.setTimeout(() => this.setMode('chip'), reason === 'arrival' ? 8000 : 5000);
  }

  /** Throttled position line from the player at (px,pz) facing `yaw`: the site being stood in, or the nearest one. */
  setLive(lm: Landmark | null, inside: boolean, px: number, pz: number, yaw: number) {
    if (!lm) { if (!this.current) this.root.hidden = true; return; }
    const dist = Math.hypot(lm.x - px, lm.z - pz), dir = relativeDir(yaw, bearingDeg(px, pz, lm.x, lm.z));
    const text = inside ? fmt(S.place.here, { name: lm.short }) : fmt(S.place.near, { name: lm.short, dist: fmtDistance(dist), dir });
    if (text !== this.chipText) { this.chipText = text; this.chip.textContent = text; }
    if (this.current) {
      const cd = this.current === lm ? dist : Math.hypot(this.current.x - px, this.current.z - pz);
      const cdir = this.current === lm ? dir : relativeDir(yaw, bearingDeg(px, pz, this.current.x, this.current.z));
      this.pos.textContent = inside && this.current === lm && cd < 25 ? S.place.standing : fmt(S.place.from, { dist: fmtDistance(cd), dir: cdir });
      this.go.hidden = inside && this.current === lm;
    }
    if (this.root.hidden) { this.root.hidden = false; this.setMode('chip'); }
    // while folded, the chip follows the live landmark; an open card keeps what was opened
    if (this.root.dataset.mode === 'chip' && this.current !== lm && !this.manual) { this.show(lm, 'enter'); this.setMode('chip'); }
  }

  /** fold to the chip (a bottom sheet on phones must give way to the time panel) */
  fold() { if (!this.root.hidden) this.setMode('chip', true); }
  /** I: card <-> chip (manual card stays until toggled again) */
  toggle() {
    if (!this.current) return;
    if (this.root.hidden || this.root.dataset.mode === 'chip') this.setMode('card', true); else this.setMode('chip', true);
  }

  private setMode(mode: 'card' | 'chip', manual = false) {
    this.root.dataset.mode = mode;
    if (manual) { this.manual = mode === 'card'; clearTimeout(this.timer); }
  }
}
