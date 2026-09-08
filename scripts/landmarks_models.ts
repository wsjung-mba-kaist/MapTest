import { EIFFEL_OSM_WAY_ID, EIFFEL_SOURCE_GLB } from './config.ts';

/**
 * Hero models: real 3D models that replace the extruded footprint of a landmark. The bake (npm run bake:models)
 * fits each source glTF onto its OSM footprint, crops and compresses it, and writes public/models/{id}.glb + .json;
 * the footprints listed here are dropped from the building extrusion, inpainted in the orthophoto and used as
 * shadow casters. Only the Eiffel Tower ships by default: free, licence-clean models of the other landmarks are
 * rare. Add an entry (and drop the glb into public/models) when one turns up.
 *
 * Licence guard: entries whose licence is non-commercial / no-derivatives / unknown are refused unless
 * ALLOW_NONFREE=1 is set for the bake.
 */
export interface LandmarkModel {
  id: string;
  /** OSM footprints the model replaces */
  osm: { type: 'way' | 'relation'; id: number }[];
  /**
   * Explicit placement for a landmark that has no building footprint to fit onto — a statue or a memorial, which
   * OSM maps as a node. Used only when `osm` yields nothing; `radius` bounds the crop and the shadow.
   */
  place?: { lon: number; lat: number; radius: number };
  /** file name in public/models, or a URL to download */
  source: string;
  fit:
    | { kind: 'eiffel' }
    | { kind: 'footprint-rect'; axis?: 'long' | 'short'; yawDeg?: number }
    | { kind: 'height'; height: number; yawDeg: number }
    | { kind: 'scale'; scale: number; yawDeg: number };
  crop?: { clean?: boolean; radius?: number; dropBelowM?: number };
  credits: { title: string; author?: string; license: string; url: string };
  /** `metalness` / `roughness` override a source material that is implausible for the real subject. */
  runtime?: {
    floodlit?: boolean; paint?: [number, number, number]; lodAtM?: number; metalness?: number; roughness?: number;
    /** Multiplies a scan's base colour (values may exceed 1): photogrammetry textures often bake in shadow. */
    tint?: [number, number, number];
    /** Draw both faces — scans frequently have inconsistent winding, which reads as holes punched in the surface. */
    doubleSided?: boolean;
    /** Masonry pedestal built under the model at runtime; the model is raised to stand on it. */
    pedestal?: { height: number; baseW: number; topW: number; stepH?: number; stepW?: number; colour?: [number, number, number] };
  };
  targetTris?: number;
  textureSize?: number;
}

export const LANDMARK_MODELS: LandmarkModel[] = [
  {
    id: 'eiffel', osm: [{ type: 'way', id: EIFFEL_OSM_WAY_ID }], source: EIFFEL_SOURCE_GLB, fit: { kind: 'eiffel' },
    credits: { title: 'Eiffel Tower model 3D with best quality', author: 'shatlykxfree', license: 'CC-BY-4.0', url: 'https://sketchfab.com/3d-models/eiffel-tower-model-3d-with-best-quality' },
    runtime: { floodlit: true },
  },
  {
    // The 1889 quarter-scale replica at the downstream tip of the Ile aux Cygnes, facing west toward New York.
    // Mapped in OSM as node/465294103, so there is no footprint to fit: the placement is explicit.
    id: 'statue-liberte', osm: [], place: { lon: 2.279701, lat: 48.850024, radius: 9 },
    source: 'statue_of_liberty.glb',
    fit: { kind: 'height', height: 11.5, yawDeg: 270 },
    crop: { clean: true, dropBelowM: 0.5 },
    credits: { title: 'The Statue of Liberty, designed by Frédéric Auguste Bartholdi', author: 'Maurice Svay', license: 'CC-BY-4.0', url: 'https://sketchfab.com/3d-models/statue-of-liberty-c461ed8724424ad99500fd058a0ab082' },
    runtime: {
      metalness: 0.0, roughness: 0.8,   // oxidised copper reads as a dielectric, not a mirror
      // The scan's texture averages RGB 61, a flat grey; lift it and push it toward the copper patina of the real statue.
      tint: [1.9, 2.6, 2.3], doubleSided: true,
      floodlit: true,                   // uplit from the platform after dark
      // Tapered limestone block on a low step platform, measured off photographs against the people at its foot.
      pedestal: { height: 7.4, baseW: 5.2, topW: 4.2, stepH: 0.4, stepW: 8.0, colour: [214, 206, 190] },
    },
    targetTris: 220_000,
    textureSize: 2048,
  },
];

const NONFREE = /\bNC\b|\bND\b|non-?commercial|unknown|all rights/i;
/** true when the licence allows redistribution here (or the bake was told to ignore that). */
export function licenseAllowed(license: string): boolean {
  return process.env.ALLOW_NONFREE === '1' || !NONFREE.test(license);
}
