import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frame, worldBoxToLonLatBox } from '../shared/geo.ts';
import { WORLD_HALF } from '../shared/layout.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const CACHE_DIR = path.join(ROOT, 'cache');
export const OUT_DIR = path.join(ROOT, 'public', 'data');
export const MODELS_DIR = path.join(ROOT, 'public', 'models');
export const TEXTURES_DIR = path.join(ROOT, 'public', 'textures');

export interface LonLatBox { west: number; east: number; south: number; north: number }

/** Exact lon/lat bbox of the baked square. */
export const BBOX: LonLatBox = worldBoxToLonLatBox(frame, 0, 0, WORLD_HALF);
/** Padded bbox for vector fetches so edge features arrive whole. */
export const FETCH_PAD_M = 150;
export const BBOX_PADDED: LonLatBox = worldBoxToLonLatBox(frame, 0, 0, WORLD_HALF + FETCH_PAD_M);
/** Far skyline ring (flat LOD1 extrusions), fetched from BD TOPO only. */
export const FAR_HALF_M = 5000;
export const BBOX_FAR: LonLatBox = worldBoxToLonLatBox(frame, 0, 0, FAR_HALF_M);

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const WMTS_ORTHO = (z: number, x: number, y: number) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`;
export const ORTHO_ZOOM = 19;
export const ORTHO_OVERVIEW_ZOOM = 17;

export const WMS_ELEVATION = (b: LonLatBox, w: number, h: number) =>
  `https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLES=&FORMAT=image/x-bil;bits=32&CRS=EPSG:4326&BBOX=${b.south},${b.west},${b.north},${b.east}&WIDTH=${w}&HEIGHT=${h}`;

/**
 * IGN LiDAR HD surface model (MNS, 50 cm): the true roof surface of every building, from the same keyless WMS-R
 * endpoint as the DTM. First layer that the capabilities list wins; the second is the older RGE ALTI surface model.
 */
export const WMS_DSM_LAYERS = ['IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G', 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS'];
export const WMS_DSM = (layer: string, b: LonLatBox, w: number, h: number) =>
  `https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&STYLES=&FORMAT=image/x-bil;bits=32&CRS=EPSG:4326&BBOX=${b.south},${b.west},${b.north},${b.east}&WIDTH=${w}&HEIGHT=${h}`;
export const WMS_CAPABILITIES = 'https://data.geopf.fr/wms-r/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0';
export const DSM_STEP_M = 0.5;
export const DSM_MAX_PX = 2048;
/** margin around a landmark footprint (m) so edge samples and the wall-top probes have data */
export const DSM_PAD_M = 6;

export const WFS_BDTOPO = (typename: string, b: LonLatBox, count: number, start: number, cql?: string) =>
  `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${typename}&OUTPUTFORMAT=application/json&COUNT=${count}&STARTINDEX=${start}&${cql ? `CQL_FILTER=${encodeURIComponent(`${cql} AND BBOX(geometrie,${b.south},${b.west},${b.north},${b.east},'urn:ogc:def:crs:EPSG::4326')`)}` : `BBOX=${b.south},${b.west},${b.north},${b.east},urn:ogc:def:crs:EPSG::4326`}`;
/** Outer skyline ring: only buildings this tall are fetched between FAR_HALF_M and FAR_TALL_HALF_M (La Défense, Sacré-Cœur, Montparnasse). */
export const FAR_TALL_HALF_M = 6500;
export const FAR_TALL_MIN_H = 22;
export const BBOX_FAR_TALL: LonLatBox = worldBoxToLonLatBox(frame, 0, 0, FAR_TALL_HALF_M);

export const PARIS_TREES = (lon: number, lat: number, radiusM: number) => {
  const where = `within_distance(geo_point_2d, geom'POINT(${lon} ${lat})', ${radiusM}m)`;
  return `https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/les-arbres/exports/geojson?where=${encodeURIComponent(where)}&limit=-1`;
};

export const EIFFEL_3DMR_URL = 'https://3dmr.eu/api/model/4';
export const EIFFEL_OSM_WAY_ID = 5013364;
/** Preferred tower model in public/models (user's choice; Sketchfab CC-BY, credited in the HUD). Override with EIFFEL_SOURCE=. */
export const EIFFEL_SOURCE_GLB = 'eiffel_tower_model_3d_with_best_quality.glb';

const sunAz = parseFloat(process.env.ORTHO_SUN_AZ ?? ''), sunEl = parseFloat(process.env.ORTHO_SUN_ELEV ?? '');
/**
 * Every environment switch the bake reads, parsed once so a typo shows up here and not as a silently ignored string
 * three modules deep. CLAUDE.md "Env knobs" lists the same names; keep the two in step.
 */
export const ENV = {
  /** DSM=0: no LiDAR roof caps — bake:dsm is skipped and build extrudes analytic roofs everywhere */
  dsm: process.env.DSM !== '0',
  /** DSM_IDS=way/1,relation/2: extra OSM ids that get a LiDAR cap on top of the landmark registry */
  dsmIds: (process.env.DSM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  /** DESHADOW=0: leave the shadows baked into the orthophoto alone */
  deshadow: process.env.DESHADOW !== '0',
  /** ORTHO_SUN_AZ + ORTHO_SUN_ELEV (degrees, both required): the capture-time sun when the detector and the default are both wrong */
  orthoSun: Number.isFinite(sunAz) && Number.isFinite(sunEl) ? { azDeg: sunAz, elevDeg: sunEl } : undefined,
  /** ORTHO_SUN_AUTO=1: trust the tower-shadow detector over the configured default sun */
  orthoSunAuto: process.env.ORTHO_SUN_AUTO === '1',
  /** EIFFEL_SOURCE=<glb in public/models>: the tower model to fit instead of EIFFEL_SOURCE_GLB */
  eiffelSource: process.env.EIFFEL_SOURCE ?? EIFFEL_SOURCE_GLB,
  /** EIFFEL_TEXTURE=<px>: texture size the tower scan is resampled to (default 4096) */
  eiffelTexture: Number(process.env.EIFFEL_TEXTURE ?? 4096),
  /** ALLOW_NONFREE=1: let bake:models process a hero model whose licence is not free for redistribution */
  allowNonfree: process.env.ALLOW_NONFREE === '1',
  /** PATHS_DEBUG=1: bake:paths logs the bridge pier boxes the boat lanes are routed around */
  pathsDebug: !!process.env.PATHS_DEBUG,
};

/**
 * Roof fixes for buildings whose OSM tags miss what everyone can see (keyed by OSM id): the gilded dome of the
 * Invalides, for example. `shape` / `material` / `colour` replace the roof:* tags.
 */
export const ROOF_OVERRIDES: Record<string, { shape?: string; material?: string; colour?: string }> = {
  'way/227662013': { material: 'gold' },      // Dôme des Invalides: gilded lead dome
  'way/227662012': { material: 'gold' },      // its lantern (way/227662030 no longer exists in OSM)
  'way/1462542858': { material: 'gold' },     // the cone above the drum
};

/** Paris building defaults (metres). */
/**
 * Hard cap on LiDAR roof-cap triangles across all chunks (a CLAUDE.md hard constraint): bake:build throws past it.
 * Lower the grid step / raise the simplification error in dsmroof.ts rather than raising this casually.
 */
export const DSM_BUDGET = 1_200_000;

export const HAUSSMANN = {
  groundFloor: 4.3,
  floor: 3.1,
  defaultEave: 18.5,
  defaultRidge: 24.0,
  mansardInset1: 1.3,
  mansardRise1Max: 4.0,
  mansardInset2Max: 4.0,
  minMansardDelta: 2.5,
};

export const ASSETS = {
  polyhaven: {
    textures: ['plastered_stone_wall', 'concrete_wall_008', 'metal_plate_02', 'roof_slates_02', 'aerial_asphalt_01', 'cobblestone_floor_08', 'plaster_grey_04', 'large_sandstone_blocks'],
    hdris: ['kloofendal_48d_partly_cloudy_puresky', 'qwantani_puresky'],
  },
  ambientcg: ['Facade001', 'Facade018A', 'PavingStones138', 'Grass004', 'Gravel043', 'Bark014', 'Asphalt033'],
};

/**
 * Monument statues placed by hand (lon, lat, height in metres, and the bearing the figure faces).
 *
 * OSM does carry these as `tourism=artwork` / `man_made=statue` nodes and the `points` theme now asks for them,
 * but the curated list is what guarantees the landmarks the app advertises actually stand there: a landmark card
 * with nothing under it is worse than no card. Anything the OSM themes bring in within 12 m of one of these is
 * dropped so the two sources cannot double up.
 */
export const STATUES: { id: string; lon: number; lat: number; height: number; facing: number; kind?: 'statue' | 'flame' | 'peacewall' }[] = [
  // The 1889 quarter-scale replica at the downstream tip of the Ile aux Cygnes, facing west toward New York.
  { id: 'statue-liberte', lon: 2.279701, lat: 48.850024, height: 11.5, facing: 270 },
  // Flamme de la Liberte: a full-size gilded copy of the torch the Liberty statue holds, on a stone plinth
  // above the Alma tunnel. Not a figure, so it gets its own shape.
  { id: 'flamme-liberte', lon: 2.301389, lat: 48.864167, height: 4.3, facing: 200, kind: 'flame' },
  // Mur pour la Paix (Clara Halter and Jean-Michel Wilmotte, 2000): two glass walls under a canopy on the
  // Champ de Mars axis, which runs south-east from the tower, so the passage through it faces 135 degrees.
  { id: 'mur-paix', lon: 2.30199, lat: 48.8534, height: 9, facing: 135, kind: 'peacewall' },
];
