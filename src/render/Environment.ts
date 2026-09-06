import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import * as SunCalc from 'suncalc';
import { ORIGIN } from '../../shared/geo';

/** Paris skyglow (linear radiance at the horizon): the one constant the night sky, haze and fill light derive from. */
export const SKY_GLOW = new THREE.Vector3(0.16, 0.11, 0.075);
import { buildingUniforms } from '../materials/FacadeMaterial';
import { NIGHT_SKY_BODY, NIGHT_SKY_DECL, localSiderealTime, moonDirection, starMatrix, starTexture } from './NightSky';
import { REFLECT_LAYER } from './WaterReflection';

/**
 * Sky, sun, ambient light, fog and image-based lighting driven by a date/time in Paris.
 * The HDRI supplies soft ambient/reflections; the analytic Sky supplies the visible background.
 */
export class Environment {
  readonly sky = new Sky();
  readonly sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
  readonly hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b5a48, 0.9);
  readonly fog = new THREE.FogExp2(0xb7c9dc, 0.00030);
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  /** 0 = day, 1 = night. */
  night = 0;
  /** calendar day in Paris: today by default, ?date=YYYY-MM-DD overrides (sun path, day length, presets follow it) */
  ymd: [number, number, number] = todayParis();
  date = localDate(this.ymd, 17.5); // 17:30 local time on that day
  private pmrem: THREE.PMREMGenerator;
  private envMap: THREE.Texture | null = null;
  private envScene = new THREE.Scene();
  private envSky = new Sky();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastEnvHour = NaN;
  private envMode: 'hdri' | 'sky' | 'none' = 'none';
  private sunElev = 0;   // solar elevation in degrees (kept separately: sunDir is reused for the moon at night)
  /** Image-based lighting source: the static HDRI (default) or the analytic sky re-rendered per time of day (?skyenv=1). */
  useHdri = true;
  shadowRadius = 320;
  disableHdri = false;
  private envScale = 1;
  readonly moonDir = new THREE.Vector3(0, 1, 0);
  moonAlt = -90;
  moonFraction = 0;

  constructor(private readonly scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sky.scale.setScalar(9000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3.5; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
    // Night dimming: the analytic sky keeps glowing below the horizon, so scale it down after dusk.
    const mat = this.sky.material as THREE.ShaderMaterial;
    mat.uniforms.uDim = { value: 1 };
    Object.assign(mat.uniforms, {
      uStars: { value: starTexture() }, uStarMat: { value: starMatrix(ORIGIN.lat) }, uLST: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonOn: { value: 0 }, uMoonLit: { value: 0 }, uStarsOn: { value: 1 }, uTimeSky: { value: 0 },
      uGlow: { value: SKY_GLOW.clone() },
    });
    if (!mat.fragmentShader.includes('gl_FragColor = vec4( texColor, 1.0 );')) console.warn('Sky shader changed: night sky patch not applied');
    mat.fragmentShader = mat.fragmentShader
      .replace('uniform float mieDirectionalG;', 'uniform float mieDirectionalG; uniform float uDim;' + NIGHT_SKY_DECL)
      // clamp: the raw sun disc overflows half-float targets and poisons bloom with NaN; then stars, moon and city glow
      .replace('gl_FragColor = vec4( texColor, 1.0 );', NIGHT_SKY_BODY + '\ngl_FragColor = vec4( min(texColor, vec3(24.0)) * uDim + vec3(0.006, 0.006, 0.009) * (1.0 - uDim) + nightExtra, 1.0 );');
    mat.needsUpdate = true;
    this.sky.layers.enable(REFLECT_LAYER);
    scene.add(this.sky);
    scene.fog = this.fog;
    this.envSky.scale.setScalar(100);
    this.envSky.material = this.sky.material; // same patched shader and uniforms
    this.envScene.add(this.envSky);

    const s = this.sun;
    s.castShadow = true;
    s.shadow.mapSize.set(4096, 4096);
    s.shadow.camera.near = 50; s.shadow.camera.far = 3000;
    s.shadow.bias = -0.0002; s.shadow.normalBias = 1.2;
    this.setShadowRadius(this.shadowRadius);
    s.layers.enable(REFLECT_LAYER); this.hemi.layers.enable(REFLECT_LAYER);
    scene.add(s, s.target, this.hemi);
    this.setTime(this.date);
  }

  setShadowRadius(r: number) {
    this.shadowRadius = r;
    const c = this.sun.shadow.camera;
    c.left = -r; c.right = r; c.top = r; c.bottom = -r;
    c.updateProjectionMatrix();
  }

  async loadHdri(url: string) {
    if (!this.useHdri) { this.refreshSkyEnv(true); return; }
    try {
      // Load as float and clamp: the sun in the HDRI exceeds the half-float range, which turns into NaN
      // texels inside the PMREM and shows up as sparkling noise on every smooth (glass, paint) surface.
      const hdr = await new RGBELoader().setDataType(THREE.FloatType).loadAsync(url);
      const px = hdr.image.data as Float32Array;
      for (let i = 0; i < px.length; i++) if (px[i] > 40) px[i] = 40;
      hdr.needsUpdate = true;
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      this.envMap = this.pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
      this.applyNight();
      this.refreshSkyEnv(true);
    } catch (e) { console.warn('HDRI missing', e); }
  }

  /** Hours since local midnight (Europe/Paris, DST-aware) on the current calendar day. */
  setHour(hour: number) { this.setTime(localDate(this.ymd, hour)); }
  get hour(): number { return localHour(this.date, this.ymd); }
  /** Change the calendar day, keeping the local hour. */
  setDate(ymd: [number, number, number]) { const h = this.hour; this.ymd = ymd; this.setHour(h); }
  dateLabel(): string { return `${this.ymd[1]}월 ${this.ymd[2]}일`; }
  /** Sunrise / sunset as local hours for the current day (suncalc). */
  sunTimes(): { sunrise: number; sunset: number } {
    const t = SunCalc.getTimes(localDate(this.ymd, 12), ORIGIN.lat, ORIGIN.lon);
    return { sunrise: localHour(t.sunrise ?? localDate(this.ymd, 6), this.ymd), sunset: localHour(t.sunset ?? localDate(this.ymd, 20), this.ymd) };
  }

  setTime(date: Date) {
    this.date = date;
    // suncalc 2.x returns DEGREES with a north-based clockwise azimuth (0 = N, 90 = E, 180 = S).
    // World frame: x east, z south, so north is -z.
    const pos = SunCalc.getPosition(date, ORIGIN.lat, ORIGIN.lon);
    const alt = THREE.MathUtils.degToRad(pos.altitude), az = THREE.MathUtils.degToRad(pos.azimuth);
    this.sunDir.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)).normalize();
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const elev = pos.altitude;
    this.sunElev = elev;
    this.night = 1 - THREE.MathUtils.smoothstep(elev, -8, 2);
    const moon = moonDirection(date, this.moonDir);
    this.moonAlt = moon.alt; this.moonFraction = moon.fraction;
    const su = (this.sky.material as THREE.ShaderMaterial).uniforms;
    su.uMoonDir.value.copy(this.moonDir); su.uMoonOn.value = moon.alt > -1 ? 1 : 0; su.uMoonLit.value = moon.fraction;
    su.uLST.value = localSiderealTime(date, ORIGIN.lon);
    this.applyNight();
    this.refreshSkyEnv();
  }

  /** Re-render the sky into the environment cubemap when the time of day moved noticeably. */
  refreshSkyEnv(force = false) {
    // by day the HDRI is the environment; after dusk the analytic sky (skyglow, moon) is baked instead so glass, car
    // paint and wet stone pick up the warm city glow rather than a dimmed daylight sky
    const wantSky = !this.useHdri || this.night > 0.6;
    if (wantSky) {
      const thr = Math.abs(this.sunElev) < 10 ? 0.05 : 0.15;   // dusk changes fastest
      if (force || this.envMode !== 'sky' || !this.envTarget || Math.abs(this.hour - this.lastEnvHour) >= thr) {
        this.lastEnvHour = this.hour;
        const old = this.envTarget;
        this.envTarget = this.pmrem.fromScene(this.envScene, 0.03);
        old?.dispose();
      }
      this.scene.environment = this.disableHdri ? null : this.envTarget.texture;
      this.envMode = 'sky';
    } else if (this.envMap) {
      this.scene.environment = this.disableHdri ? null : this.envMap;
      this.envMode = 'hdri';
    }
    this.applyEnvIntensity();
  }

  /** Environment strength: the analytic sky is ~3.5x brighter than the HDRI by day; at night it is the only fill light. */
  private applyEnvIntensity() {
    const n = this.night;
    this.scene.environmentIntensity = this.envMode === 'sky' ? THREE.MathUtils.lerp(0.4 * 0.28, 0.9, n) : THREE.MathUtils.lerp(0.4, 0.04, n);
  }

  /** ?glow=0: no city skyglow (astronomical night sky, for comparison). */
  setGlow(on: boolean) { (this.sky.material as THREE.ShaderMaterial).uniforms.uGlow.value.copy(on ? SKY_GLOW : new THREE.Vector3()); this.refreshSkyEnv(true); }

  private applyNight() {
    const n = this.night;
    const elev = Math.asin(this.sunDir.y);
    (this.sky.material as THREE.ShaderMaterial).uniforms.uDim.value = THREE.MathUtils.lerp(1, 0.02, n);
    const warm = THREE.MathUtils.smoothstep(THREE.MathUtils.radToDeg(elev), 0, 25); // 0 near horizon
    this.sun.color.setRGB(1.0, THREE.MathUtils.lerp(0.62, 0.95, warm), THREE.MathUtils.lerp(0.35, 0.88, warm));
    this.sun.intensity = (1 - n) * THREE.MathUtils.lerp(1.1, 2.4, warm) * THREE.MathUtils.smoothstep(THREE.MathUtils.radToDeg(elev), -2, 6);
    if (n > 0.6) { // moonlight from the real moon when it is up, else a faint sky light
      if (this.moonAlt > 2) {
        // full moon is a percent or two of the street lighting; keep it a cool accent, the skyglow does the filling
        this.sunDir.copy(this.moonDir);
        this.sun.color.setRGB(0.62, 0.72, 1.0);
        this.sun.intensity = 0.035 * n * (0.25 + 0.75 * this.moonFraction) * THREE.MathUtils.smoothstep(this.moonAlt, 2, 12);
      } else {
        this.sunDir.set(0.35, 0.75, -0.55).normalize();
        this.sun.color.setRGB(0.5, 0.6, 0.9);
        this.sun.intensity = 0.015 * n;
      }
    }
    this.sun.visible = this.sun.intensity > 0.01;
    // night fill = the city's own skyglow: warm grey from above, lamp-lit ground bounce from below
    this.hemi.intensity = THREE.MathUtils.lerp(0.55, 0.20, n);
    this.hemi.color.setRGB(THREE.MathUtils.lerp(0.81, 0.40, n), THREE.MathUtils.lerp(0.89, 0.34, n), THREE.MathUtils.lerp(1.0, 0.30, n));
    this.hemi.groundColor.setRGB(THREE.MathUtils.lerp(0.42, 0.28, n), THREE.MathUtils.lerp(0.35, 0.20, n), THREE.MathUtils.lerp(0.28, 0.14, n));
    const dusk = THREE.MathUtils.smoothstep(THREE.MathUtils.radToDeg(elev), -4, 12);
    // haze: daylight blue-grey -> dusk peach -> the skyglow colour itself (so the far ring dissolves into the sky, no seam)
    const fogDay = new THREE.Color(0xb7c9dc), fogDusk = new THREE.Color(0xd9a98a), fogNight = new THREE.Color(SKY_GLOW.x * 0.8, SKY_GLOW.y * 0.8, SKY_GLOW.z * 0.8);
    this.fog.color.copy(fogDay).lerp(fogDusk, 1 - dusk).lerp(fogNight, n);
    this.fog.density = THREE.MathUtils.lerp(0.00030, 0.00030, n);   // city haze at night is real, but the lights must punch through it
    buildingUniforms.uNight.value = n;
  }

  /** Per-frame: star twinkle clock. */
  tick(time: number) { (this.sky.material as THREE.ShaderMaterial).uniforms.uTimeSky.value = time; }

  /** Keep the shadow frustum centred on the viewer. */
  follow(p: THREE.Vector3) {
    this.sun.target.position.set(p.x, 0, p.z);
    this.sun.position.copy(p).setY(0).addScaledVector(this.sunDir, 1200);
    this.sun.target.updateMatrixWorld();
  }
}

// ---- Europe/Paris calendar helpers (Intl-based, DST-aware; fall back to CEST when Intl has no time zones)
export function todayParis(): [number, number, number] {
  try {
    const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const [y, m, d] = s.split('-').map(Number);
    if (y && m && d) return [y, m, d];
  } catch { /* no Intl time zones */ }
  const n = new Date(); return [n.getFullYear(), n.getMonth() + 1, n.getDate()];
}
/** UTC offset (hours) of Europe/Paris at noon on that day: 1 in winter, 2 in summer. */
export function parisOffset(ymd: [number, number, number]): number {
  try {
    const probe = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2], 12));
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' }).formatToParts(probe);
    const h = Number(parts.find(p => p.type === 'hour')?.value);
    if (Number.isFinite(h)) return h - 12;
  } catch { /* fall through */ }
  return 2;
}
/** Date for a local (Paris) hour on a calendar day. */
export function localDate(ymd: [number, number, number], hour: number): Date {
  const h = ((hour % 24) + 24) % 24;
  return new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2]) + Math.round((h - parisOffset(ymd)) * 60) * 60000);
}
/** Local (Paris) hour of a Date, 0..24. */
export function localHour(date: Date, ymd: [number, number, number]): number {
  const h = date.getUTCHours() + parisOffset(ymd) + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  return ((h % 24) + 24) % 24;
}
