import type { Weather } from '../render/Environment';
import { required } from './dom';
import { S, fmt } from './strings';

/** re-exported from the catalogue: App builds the clock chip and weather toasts from it */
export const WEATHER_LABEL: Record<Weather, string> = S.time.weather;
/** Season presets: a representative day each (leaves: mid-April budding, mid-October colour, mid-January bare). */
export const SEASONS: { label: string; month: number; day: number }[] = [
  { label: S.time.seasons.spring, month: 4, day: 20 }, { label: S.time.seasons.summer, month: 7, day: 15 }, { label: S.time.seasons.autumn, month: 10, day: 20 }, { label: S.time.seasons.winter, month: 1, day: 15 },
];
export const PLAY_RATES = [60, 600] as const;

/**
 * The extra rows of the time panel (Hud keeps the slider and the hour presets): sunrise / sunset ticks under the
 * slider, "now", time-lapse playback, weather and season buttons. Every change goes back to App through callbacks.
 */
export class TimePanel {
  private readonly ticks = document.createElement('div');
  private readonly playBtns: HTMLButtonElement[] = [];
  private readonly weatherBtns = new Map<Weather, HTMLButtonElement>();
  private readonly seasonBtns: HTMLButtonElement[] = [];
  private readonly todayBtn: HTMLButtonElement;
  rate = 0;
  onNow: () => void = () => {};
  onPlay: (rate: number) => void = () => {};
  onWeather: (w: Weather) => void = () => {};
  /** null = today */
  onSeason: (s: { label: string; month: number; day: number } | null) => void = () => {};

  constructor(panel: HTMLElement) {
    this.ticks.className = 'ticks';
    required<HTMLInputElement>('timeslider').after(this.ticks);
    const presets = panel.querySelector('.presets');
    const row = (cls: string, ...kids: HTMLElement[]) => { const d = document.createElement('div'); d.className = cls; d.append(...kids); return d; };
    const btn = (label: string, title: string, on: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.addEventListener('click', () => { on(); b.blur(); }); return b; };
    const now = btn(S.time.now, S.time.nowTitle, () => this.onNow());
    for (const r of PLAY_RATES) { const b = btn(fmt(S.time.play, { rate: r }), fmt(S.time.playTitle, { scale: S.time.playScale[r] }), () => this.play(this.rate === r ? 0 : r)); this.playBtns.push(b); }
    const flow = row('presets flow', now, ...this.playBtns);
    const weather = row('presets weather');
    for (const w of Object.keys(WEATHER_LABEL) as Weather[]) { const b = btn(WEATHER_LABEL[w], fmt(S.time.weatherTitle, { label: WEATHER_LABEL[w] }), () => this.onWeather(w)); this.weatherBtns.set(w, b); weather.appendChild(b); }
    const season = row('presets season');
    for (const s of SEASONS) { const b = btn(s.label, fmt(S.time.seasonTitle, s), () => this.onSeason(s)); this.seasonBtns.push(b); season.appendChild(b); }
    this.todayBtn = btn(S.time.today, S.time.todayTitle, () => this.onSeason(null)); season.appendChild(this.todayBtn);
    const lbl = (t: string) => { const s = document.createElement('span'); s.className = 'lbl'; s.textContent = t; return s; };
    (presets ?? panel).after(flow, row('row sub', lbl(S.time.weatherRow), weather), row('row sub', lbl(S.time.seasonRow), season));
  }

  /** sunrise / sunset marks under the 0-24 h slider */
  setSun(sunrise: number, sunset: number) {
    this.ticks.replaceChildren();
    for (const [h, t] of [[sunrise, S.time.sunrise], [sunset, S.time.sunset]] as [number, string][]) {
      const m = document.createElement('i'); m.style.left = `${(h / 24) * 100}%`; m.title = `${t} ${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`; this.ticks.appendChild(m);
    }
  }
  setWeather(w: Weather) { for (const [k, b] of this.weatherBtns) b.classList.toggle('on', k === w); }
  /** highlight the season whose day is set (or "today") */
  setDate(month: number, day: number, isToday: boolean) {
    this.seasonBtns.forEach((b, i) => b.classList.toggle('on', !isToday && SEASONS[i].month === month && SEASONS[i].day === day));
    this.todayBtn.classList.toggle('on', isToday);
  }
  play(rate: number) {
    this.rate = rate;
    this.playBtns.forEach((b, i) => b.classList.toggle('on', PLAY_RATES[i] === rate));
    this.onPlay(rate);
  }
  /** any manual time change stops the playback */
  stop() { if (this.rate) this.play(0); }
}
