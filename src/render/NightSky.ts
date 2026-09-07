import * as THREE from 'three';
import * as SunCalc from 'suncalc';
import { ORIGIN } from '../../shared/geo';

/**
 * Night sky add-ons for the analytic Sky shader: a seeded star field in equatorial coordinates (rotating with
 * sidereal time), the moon with its phase, and the city's light-pollution glow near the horizon.
 */

/** GLSL uniform declarations injected next to `uniform float uDim;`. */
export const NIGHT_SKY_DECL = /* glsl */`
uniform sampler2D uStars; uniform mat3 uStarMat; uniform float uLST; uniform vec3 uMoonDir; uniform float uMoonOn; uniform float uMoonLit; uniform float uStarsOn; uniform float uTimeSky; uniform vec3 uGlow;`;

/** GLSL computing `vec3 nightExtra` from `direction`, `vSunDirection`, `uDim`; inserted before the final colour. */
export const NIGHT_SKY_BODY = /* glsl */`
vec3 nightExtra = vec3(0.0);
{
  float nightAmt = clamp(1.0 - uDim, 0.0, 1.0);
  if (nightAmt > 0.01) {
    // stars: world -> equatorial, hour angle -> right ascension via the local sidereal time
    vec3 e = uStarMat * direction;
    float ha = atan(e.y, e.x);
    float ra = uLST - ha;
    vec2 suv = vec2(fract(ra / 6.2831853), acos(clamp(e.z, -1.0, 1.0)) / 3.14159265);
    // city skyglow: a broad warm-grey dome plus a brighter horizon band, stronger toward central Paris (east-north-east);
    // below the horizon (only the environment cubemap sees it) it stands in for lamp-lit ground bounce
    vec2 hz = normalize(direction.xz + vec2(1e-5, 0.0));
    float toward = 1.0 + 0.5 * max(0.0, dot(hz, normalize(vec2(0.9, -0.45))));
    float yy = max(direction.y, 0.0);
    float sg = (0.22 * exp(-3.0 * yy) + 0.55 * exp(-12.0 * yy)) * mix(0.5, 1.0, smoothstep(-0.25, 0.0, direction.y));
    nightExtra += uGlow * sg * toward * nightAmt;
    // stars: only the bright ones survive the glow, and none near the horizon
    float horizonFade = smoothstep(0.10, 0.35, direction.y) * (1.0 - clamp(sg * 0.9, 0.0, 1.0));
    vec3 stars = texture2D(uStars, suv).rgb;
    float twinkle = 0.85 + 0.15 * sin(uTimeSky * 3.0 + suv.x * 400.0 + suv.y * 230.0);
    nightExtra += stars * (0.4 * nightAmt * horizonFade * uStarsOn * twinkle);
  }
  // moon disc with phase (lit side toward the sun) and a soft halo
  float cosM = dot(direction, uMoonDir);
  float ang = acos(clamp(cosM, -1.0, 1.0));
  const float R = 0.0047;
  if (ang < R * 8.0 && uMoonOn > 0.5) {
    float t = clamp(ang / R, 0.0, 1.0);
    vec3 tang = normalize(direction - uMoonDir * cosM + vec3(1e-6));
    vec3 sphereN = normalize(-uMoonDir * sqrt(max(0.0, 1.0 - t * t)) + tang * t);
    float lit = smoothstep(-0.08, 0.12, dot(sphereN, vSunDirection));
    float disc = 1.0 - smoothstep(R * 0.92, R * 1.05, ang);
    vec3 moonCol = vec3(1.0, 0.98, 0.9) * (0.75 * lit + 0.02);
    nightExtra += moonCol * disc * mix(0.15, 1.0, 1.0 - uDim);
    float halo = 0.02 * exp(-ang / 0.02) * (1.0 - uDim) * (0.3 + 0.7 * uMoonLit);
    nightExtra += vec3(0.9, 0.92, 1.0) * halo * (1.0 - disc);
  }
}`;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Equirectangular star map (u = right ascension, v = 0 at the north celestial pole). */
export function starTexture(): THREE.CanvasTexture {
  // 4096 px over 360 degrees = 0.09 degrees per texel: stars stay point-like (the moon is 0.5 degrees wide).
  const W = 4096, H = 2048;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const rnd = mulberry32(20260906);
  ctx.globalCompositeOperation = 'lighter';
  // Over Paris the light pollution hides the Milky Way and all but ~200 stars (mag < 3): keep only the bright tail
  // of the same seeded distribution so the pattern is stable, brightness mostly in alpha, radius ~1 texel
  for (let i = 0; i < 3600; i++) {
    const u = rnd(), v = Math.acos(1 - 2 * rnd()) / Math.PI;
    const m = Math.pow(rnd(), 2.6);
    const temp0 = rnd();   // keep the sequence identical, then skip the faint majority
    if (m < 0.86) continue;
    void temp0;
    const temp = rnd();
    const col = temp < 0.2 ? [200, 215, 255] : temp < 0.7 ? [255, 250, 240] : [255, 225, 180];
    const r = 0.55 + 0.75 * m, a = 0.25 + 0.75 * m;
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
    ctx.beginPath(); ctx.arc(u * W, v * H, r, 0, Math.PI * 2); ctx.fill();
    if (m > 0.93) { // a handful of first-magnitude stars get a tiny soft halo
      const grd = ctx.createRadialGradient(u * W, v * H, 0, u * W, v * H, 2.6);
      grd.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},0.3)`); grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(u * W, v * H, 2.6, 0, Math.PI * 2); ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  return t;
}

/**
 * World (x east, y up, z south) -> local equatorial frame at latitude φ: rows = (Q toward the celestial equator
 * on the meridian, -E so the hour angle grows westward, P the celestial pole).
 */
export function starMatrix(latDeg: number): THREE.Matrix3 {
  const p = THREE.MathUtils.degToRad(latDeg), c = Math.cos(p), s = Math.sin(p);
  return new THREE.Matrix3().set(
    0, c, s,
    -1, 0, 0,
    0, s, -c,
  );
}

/** Local sidereal time in radians. */
export function localSiderealTime(date: Date, lonDeg: number): number {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  const gmstHours = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const lst = ((gmstHours + lonDeg / 15) % 24 + 24) % 24;
  return (lst / 24) * Math.PI * 2;
}

/** Moon direction in the world frame (same convention as the sun) with altitude (deg) and illuminated fraction. */
export function moonDirection(date: Date, out: THREE.Vector3): { alt: number; fraction: number } {
  const m = SunCalc.getMoonPosition(date, ORIGIN.lat, ORIGIN.lon);
  const alt = THREE.MathUtils.degToRad(m.altitude), az = THREE.MathUtils.degToRad(m.azimuth); // suncalc 2.x: degrees, north-based
  out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)).normalize();
  return { alt: m.altitude, fraction: SunCalc.getMoonIllumination(date).fraction };
}
