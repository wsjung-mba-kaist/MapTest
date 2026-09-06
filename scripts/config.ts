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

export const WFS_BDTOPO = (typename: string, b: LonLatBox, count: number, start: number) =>
  `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${typename}&OUTPUTFORMAT=application/json&COUNT=${count}&STARTINDEX=${start}&BBOX=${b.south},${b.west},${b.north},${b.east},urn:ogc:def:crs:EPSG::4326`;

export const PARIS_TREES = (lon: number, lat: number, radiusM: number) => {
  const where = `within_distance(geo_point_2d, geom'POINT(${lon} ${lat})', ${radiusM}m)`;
  return `https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/les-arbres/exports/geojson?where=${encodeURIComponent(where)}&limit=-1`;
};

export const EIFFEL_3DMR_URL = 'https://3dmr.eu/api/model/4';
export const EIFFEL_OSM_WAY_ID = 5013364;
/** Preferred tower model in public/models (user's choice; Sketchfab CC-BY, credited in the HUD). Override with EIFFEL_SOURCE=. */
export const EIFFEL_SOURCE_GLB = 'eiffel_tower_model_3d_with_best_quality.glb';

/** Paris building defaults (metres). */
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
