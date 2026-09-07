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
  /** file name in public/models, or a URL to download */
  source: string;
  fit:
    | { kind: 'eiffel' }
    | { kind: 'footprint-rect'; axis?: 'long' | 'short'; yawDeg?: number }
    | { kind: 'height'; height: number; yawDeg: number }
    | { kind: 'scale'; scale: number; yawDeg: number };
  crop?: { clean?: boolean; radius?: number; dropBelowM?: number };
  credits: { title: string; author?: string; license: string; url: string };
  runtime?: { floodlit?: boolean; paint?: [number, number, number]; lodAtM?: number };
  targetTris?: number;
  textureSize?: number;
}

export const LANDMARK_MODELS: LandmarkModel[] = [
  {
    id: 'eiffel', osm: [{ type: 'way', id: EIFFEL_OSM_WAY_ID }], source: EIFFEL_SOURCE_GLB, fit: { kind: 'eiffel' },
    credits: { title: 'Eiffel Tower model 3D with best quality', author: 'shatlykxfree', license: 'CC-BY-4.0', url: 'https://sketchfab.com/3d-models/eiffel-tower-model-3d-with-best-quality' },
    runtime: { floodlit: true },
  },
];

const NONFREE = /\bNC\b|\bND\b|non-?commercial|unknown|all rights/i;
/** true when the licence allows redistribution here (or the bake was told to ignore that). */
export function licenseAllowed(license: string): boolean {
  return process.env.ALLOW_NONFREE === '1' || !NONFREE.test(license);
}
