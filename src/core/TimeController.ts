import type { Environment, Weather } from '../render/Environment';
import { localHour, todayParis } from '../render/Environment';
import type { Hud } from '../ui/Hud';
import { formatHour } from '../ui/Hud';
import type { TimePanel } from '../ui/TimePanel';
import { WEATHER_LABEL } from '../ui/TimePanel';
import { setWet } from '../materials/GroundMaterial';
import type { AudioEngine } from '../audio/Audio';
import type { Rain } from '../render/Rain';
import type { World } from '../world/World';
import { S, fmt } from '../ui/strings';

/** What the controller needs from the rest of the app; everything optional is created after the world has loaded. */
export interface TimeContext {
  env: Environment;
  hud: Hud;
  timePanel: TimePanel;
  world: World;
  audio: () => AudioEngine | undefined;
  rain: () => Rain | undefined;
}

export const WEATHER_ORDER: readonly Weather[] = ['clear', 'overcast', 'rain', 'fog'];

/**
 * Time of day, calendar day, weather and the time-lapse playback: the clock chip, the time panel (slider, presets,
 * season and weather buttons), the `N` / `R` / `,` / `.` shortcuts and the per-frame time-lapse tick all go through
 * here. Environment owns the sun and sky; this owns the user-facing state (weather, wet roads flag, playback rate)
 * and keeps the HUD in step with it.
 */
export class TimeController {
  weather: Weather = 'clear';
  /** `?wet=1`: wet streets regardless of the weather */
  wetFlag = false;
  /** time-lapse rate (sim seconds per real second), 0 = off */
  timeRate = 0;

  constructor(private readonly c: TimeContext) {
    const { timePanel, hud, env } = c;
    timePanel.onNow = () => { const t = todayParis(); timePanel.stop(); env.setDate(t); this.applyDayPresets(); this.setHour(localHour(new Date(), t)); hud.toast(fmt(S.app.nowToast, { time: formatHour(env.hour) }), 1500); };
    timePanel.onPlay = rate => { this.timeRate = rate; const a = c.audio(); if (a) a.chime = rate === 0; };
    timePanel.onWeather = w => this.setWeather(w);
    timePanel.onSeason = s => { const t = todayParis(); env.setDate(s ? [t[0], s.month, s.day] : t); this.applyDayPresets(); hud.toast(s ? fmt(S.app.seasonToast, { label: s.label, month: s.month, day: s.day }) : S.time.today, 1500); };
    hud.onTimeChange = h => { timePanel.stop(); env.setHour(h); this.refreshClock(); };
  }

  setHour(h: number) { this.c.env.setHour(h); this.c.hud.setTimeDisplay(this.c.env.hour); this.refreshClock(); }
  /** `,` / `.`: step by `dh` hours and stop the playback. */
  stepTime(dh: number) { this.c.timePanel.stop(); this.setHour(this.c.env.hour + dh); }

  /** N: jump to the next preset after the current time (dawn, noon, afternoon, sunset, night, late night). */
  cycleTime() {
    const sorted = [...this.c.hud.presets].sort((a, b) => a.hour - b.hour);
    const h = this.c.env.hour;
    const next = sorted.find(p => p.hour > h + 0.05) ?? sorted[0];
    this.c.timePanel.stop();
    this.setHour(next.hour);
    this.c.hud.toast(`${next.label} · ${formatHour(next.hour)}`, 1500);
  }

  /** Preset hours follow the day's real sunrise / sunset (a June sunset is 21:58, a December one 16:56). */
  applyDayPresets() {
    const { env, hud } = this.c;
    const { sunrise, sunset } = env.sunTimes();
    const r = (h: number) => Math.round(h * 4) / 4;
    hud.setPresets([
      { label: S.time.presets.dawn, hour: r(sunrise - 0.25) }, { label: S.time.presets.day, hour: 13 }, { label: S.time.presets.afternoon, hour: r(Math.max(14, sunset - 3.2)) },
      { label: S.time.presets.sunset, hour: r(sunset - 0.35) }, { label: S.time.presets.night, hour: Math.ceil(sunset + 1.4) % 24 + 0.02 }, { label: S.time.presets.lateNight, hour: 1 },
    ]);
    hud.setDateLabel(fmt(S.app.dateParis, { date: env.dateLabel() }));
    this.refreshClock();
    this.refreshTimePanel();
  }

  /** the top-right chip: time · weather (· date when it is not today) */
  refreshClock() {
    const { env, hud } = this.c;
    const [y, m, d] = env.ymd, t = todayParis();
    const today = y === t[0] && m === t[1] && d === t[2];
    hud.setClock(`${formatHour(env.hour)} · ${WEATHER_LABEL[this.weather]}${today ? '' : ` · ${env.dateLabel()}`}`);
  }
  /** sunrise / sunset ticks, the highlighted weather and season buttons */
  private refreshTimePanel() {
    const { env, timePanel } = this.c;
    const { sunrise, sunset } = env.sunTimes();
    timePanel.setSun(sunrise, sunset);
    timePanel.setWeather(this.weather);
    const [y, m, d] = env.ymd, t = todayParis();
    timePanel.setDate(m, d, y === t[0] && m === t[1] && d === t[2]);
  }

  /** Weather: sky/sun/fog in Environment, plus wet streets, rain particles, wind and the rain sound here. */
  applyWeather(toast = true) {
    const w = this.weather, { env, hud, world, timePanel } = this.c;
    env.setWeather(w);
    setWet(w === 'rain' || this.wetFlag ? 1 : 0);
    world.trees?.setWind(w === 'rain' ? 1.6 : w === 'overcast' ? 1.1 : 0.7);
    const rain = this.c.rain(); if (rain) rain.on = w === 'rain';
    this.c.audio()?.setRain(w === 'rain' ? 1 : 0);
    if (toast) hud.toast(WEATHER_LABEL[w]);
    this.refreshClock();
    timePanel.setWeather(w);
  }
  setWeather(w: Weather, toast = true) { this.weather = w; this.applyWeather(toast); }
  cycleWeather() { this.setWeather(WEATHER_ORDER[(WEATHER_ORDER.indexOf(this.weather) + 1) % WEATHER_ORDER.length]); }

  /** Per frame: advance the clock while the time-lapse plays. */
  tick(dt: number) {
    if (!this.timeRate) return;
    const { env, hud } = this.c;
    env.setHour((env.hour + this.timeRate * dt / 3600) % 24);
    hud.setTimeDisplay(env.hour);
    this.refreshClock();
  }
}
