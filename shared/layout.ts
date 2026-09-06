/** Data layout shared by the bake pipeline and the runtime. All units metres, world frame (see geo.ts). */

export const WORLD_HALF = 1536;          // baked square covers x,z in [-1536, +1536]
export const CHUNK_SIZE = 256;
export const GRID_N = (WORLD_HALF * 2) / CHUNK_SIZE; // 12
export const GRID_ORIGIN = -WORLD_HALF;  // world coordinate of chunk (0,0) corner

export const ORTHO_TILE_PX = 1536;       // per-chunk ground texture
export const ORTHO_MARGIN = 32;          // metres of margin on each side of a chunk
export const ORTHO_TILE_M = CHUNK_SIZE + 2 * ORTHO_MARGIN; // 320 m
export const OVERVIEW_PX = 4096;         // far-field ground texture over the whole square
export const MASK_PX = 512;

export const TERRAIN_STEP = 2;           // heightmap sample spacing
export const TERRAIN_MESH_SEGMENTS = 64; // rendered ground mesh: 64 cells of 4 m per chunk (every other heightmap sample)
export const TERRAIN_N = (WORLD_HALF * 2) / TERRAIN_STEP + 1; // 1537 samples per side

export function chunkIndexOf(x: number, z: number): { i: number; j: number } {
  return {
    i: Math.floor((x - GRID_ORIGIN) / CHUNK_SIZE),
    j: Math.floor((z - GRID_ORIGIN) / CHUNK_SIZE),
  };
}
export function chunkOrigin(i: number, j: number): { x: number; z: number } {
  return { x: GRID_ORIGIN + i * CHUNK_SIZE, z: GRID_ORIGIN + j * CHUNK_SIZE };
}
export function chunkKey(i: number, j: number): string { return `${i}_${j}`; }
export function inGrid(i: number, j: number): boolean { return i >= 0 && j >= 0 && i < GRID_N && j < GRID_N; }

export interface Manifest {
  version: number;
  generated: string;
  origin: { lon: number; lat: number };
  datumAlt: number;
  worldHalf: number;
  chunkSize: number;
  gridN: number;
  waterLevelY: number;
  osmTimestamp?: string;
  counts: Record<string, number>;
  heightSources?: Record<string, number>;
  files: Record<string, string>;
}

/** Row layout of trees.bin (Float32): x, y, z, height, trunkRadius, species, seed */
export const TREE_STRIDE = 7;
/** Row layout of furniture.bin (Float32): x, y, z, yaw, kind, scale */
export const FURNITURE_STRIDE = 6;

export enum TreeSpecies { Platanus = 0, Tilia = 1, Aesculus = 2, Sophora = 3, Acer = 4, Celtis = 5, Other = 6 }
export enum FurnitureKind { StreetLamp = 0, Bench = 1, Bollard = 2, MorrisColumn = 3, Fountain = 4, Car = 10, Person = 20 }

/** Roof furniture rows in details/{i}_{j}.bin (Float32): x, y, z (world), yaw, kind, sx, sy, sz, seed */
export const DETAIL_STRIDE = 9;
export enum RoofDetailKind { Chimney2 = 0, Chimney3 = 1, Chimney4 = 2, Dormer = 3 }
/** Sidewalk slabs (streets/{i}_{j}.bin): kerb height above the rendered terrain, vertex flag = top or kerb face. */
export const KERB_H = 0.14;
export enum StreetFlag { Top = 0, Kerb = 1 }
/** Surface class grid (surface.bin, u8 per 2 m cell, row-major from the north-west corner). */
export const SURFACE_STEP = 2;
export const SURFACE_N = (WORLD_HALF * 2) / SURFACE_STEP; // 1536
export enum SurfaceClass { None = 0, Road = 1, Sidewalk = 2, Grass = 3, Gravel = 4, Paved = 5, Water = 6 }
/** Street-name plaque anchors (plaques.json): rows [x, z, ux, uz, nameIdx, arrondissement], one per junction arm. */
export interface PlaquesData { names: string[]; arms: number[][] }
/** Road marking strip kinds (marks/{i}_{j}.bin mkind). */
export enum MarkKind { Zebra = 0, LaneDash = 1, CentreDash = 2, StopLine = 3 }

/** COLOR_0 alpha flags packed into building vertices (stored as alpha*255). */
export enum SurfaceFlag { Wall = 0, RoofSlope = 1, RoofTop = 2, Plinth = 3, RoofTopOverview = 4 }
