/**
 * Shared geodesy for the bake pipeline and the runtime.
 *
 * World frame (three.js): origin at the Eiffel Tower centre, metres,
 *   x = east, y = up, z = south  (north = -z).
 * Horizontal positions come from an exact WGS84 ECEF -> ENU transform.
 * Vertical positions come from NGF altitudes shifted by DATUM_ALT
 * (tower base ~ y = 0, Seine ~ y = -7).
 */

export const ORIGIN = { lon: 2.294481, lat: 48.85837 } as const;
/** NGF-IGN69 altitude (m) that maps to world y = 0. */
export const DATUM_ALT = 33.8;

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface LonLat { lon: number; lat: number }
export interface Enu { e: number; n: number; u: number }
export interface WorldXZ { x: number; z: number }

export function geodeticToEcef(lon: number, lat: number, h = 0): [number, number, number] {
  const φ = lat * DEG, λ = lon * DEG;
  const sφ = Math.sin(φ), cφ = Math.cos(φ);
  const N = A / Math.sqrt(1 - E2 * sφ * sφ);
  return [(N + h) * cφ * Math.cos(λ), (N + h) * cφ * Math.sin(λ), (N * (1 - E2) + h) * sφ];
}

export function ecefToGeodetic(X: number, Y: number, Z: number): { lon: number; lat: number; h: number } {
  const λ = Math.atan2(Y, X);
  const p = Math.hypot(X, Y);
  let φ = Math.atan2(Z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const sφ = Math.sin(φ);
    const N = A / Math.sqrt(1 - E2 * sφ * sφ);
    h = p / Math.cos(φ) - N;
    φ = Math.atan2(Z, p * (1 - E2 * N / (N + h)));
  }
  return { lon: λ * RAD, lat: φ * RAD, h };
}

export class EnuFrame {
  private readonly sλ: number; private readonly cλ: number;
  private readonly sφ: number; private readonly cφ: number;
  private readonly o: [number, number, number];

  constructor(public readonly origin: LonLat, public readonly originH = 0) {
    const λ = origin.lon * DEG, φ = origin.lat * DEG;
    this.sλ = Math.sin(λ); this.cλ = Math.cos(λ);
    this.sφ = Math.sin(φ); this.cφ = Math.cos(φ);
    this.o = geodeticToEcef(origin.lon, origin.lat, originH);
  }

  toEnu(lon: number, lat: number, h = 0): Enu {
    const [X, Y, Z] = geodeticToEcef(lon, lat, h);
    const dx = X - this.o[0], dy = Y - this.o[1], dz = Z - this.o[2];
    const { sλ, cλ, sφ, cφ } = this;
    return {
      e: -sλ * dx + cλ * dy,
      n: -sφ * cλ * dx - sφ * sλ * dy + cφ * dz,
      u: cφ * cλ * dx + cφ * sλ * dy + sφ * dz,
    };
  }

  fromEnu(e: number, n: number, u = 0): { lon: number; lat: number; h: number } {
    const { sλ, cλ, sφ, cφ } = this;
    const dx = -sλ * e - sφ * cλ * n + cφ * cλ * u;
    const dy = cλ * e - sφ * sλ * n + cφ * sλ * u;
    const dz = cφ * n + sφ * u;
    return ecefToGeodetic(this.o[0] + dx, this.o[1] + dy, this.o[2] + dz);
  }

  /** lon/lat -> world x (east) / z (south). Vertical is handled separately via altitudes. */
  toWorld(lon: number, lat: number): WorldXZ {
    const { e, n } = this.toEnu(lon, lat, 0);
    return { x: e, z: -n };
  }

  /** world x/z -> lon/lat (u is solved so the point sits on the local tangent-plane-ish surface). */
  fromWorld(x: number, z: number): LonLat {
    // Compensate earth curvature so the returned point lies near ellipsoid height originH.
    const r2 = x * x + z * z;
    const u = -r2 / (2 * A);
    const { lon, lat } = this.fromEnu(x, -z, u);
    return { lon, lat };
  }
}

export const frame = new EnuFrame(ORIGIN);

export const altToY = (alt: number): number => alt - DATUM_ALT;
export const yToAlt = (y: number): number => y + DATUM_ALT;

/** Bearing (deg, clockwise from north) -> world-space yaw handling helper: unit direction in xz. */
export function bearingToDir(bearingDeg: number): WorldXZ {
  const b = bearingDeg * DEG;
  return { x: Math.sin(b), z: -Math.cos(b) };
}

// ---------------------------------------------------------------- WebMercator (EPSG:3857 tiles)

export const TILE_SIZE = 256;

/** Fractional tile coordinates at zoom z. */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const φ = lat * DEG;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n,
  };
}

export function tileToLonLat(x: number, y: number, z: number): LonLat {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * RAD;
  return { lon, lat };
}

/** Ground metres per pixel of a Mercator tile at this latitude. */
export function metersPerPixel(lat: number, z: number): number {
  return (2 * Math.PI * A * Math.cos(lat * DEG)) / (TILE_SIZE * 2 ** z);
}

/** Axis-aligned lon/lat bbox of a square world region [cx±half, cz±half] (metres). */
export function worldBoxToLonLatBox(f: EnuFrame, cx: number, cz: number, half: number) {
  const corners = [
    f.fromWorld(cx - half, cz - half), f.fromWorld(cx + half, cz - half),
    f.fromWorld(cx - half, cz + half), f.fromWorld(cx + half, cz + half),
  ];
  return {
    west: Math.min(...corners.map(c => c.lon)), east: Math.max(...corners.map(c => c.lon)),
    south: Math.min(...corners.map(c => c.lat)), north: Math.max(...corners.map(c => c.lat)),
  };
}

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
