import { ROAD_CLASSES, type RoadClass } from '../../shared/paths.ts';

/**
 * Single source of truth for how an OSM highway way is read: carriageway width, lanes, speed, one-way,
 * parking room and whether cars / walkers may use it. Used by the path bake (and progressively by
 * masks/furniture/bridges so every layer agrees on the same widths).
 */
export interface RoadSpec {
  cls: RoadClass;
  clsId: number;
  /** cars may drive on it */
  drive: boolean;
  /** walkers may use the centreline (footways, paths, pedestrian streets, steps, living streets) */
  walkCentre: boolean;
  /** carriageway width in metres (same rule as masks.ts so painted roads and lanes agree) */
  width: number;
  lanesF: number;
  lanesB: number;
  /** width of one moving lane */
  laneW: number;
  /** lateral offset of the moving band's centre (right positive): shifted left when parking sits on the right only */
  bandCenter: number;
  /** cruise speed m/s */
  speed: number;
  oneway: boolean;
  /** oneway=-1: the way must be reversed so that forward = a -> b */
  reverse: boolean;
  steps: boolean;
  tunnel: boolean;
  bridge: boolean;
  /** 0 none, 1 right side only, 2 both sides */
  parkingSides: 0 | 1 | 2;
  /** whether a synthetic sidewalk may exist on each side (tags permitting; mapped sidewalks are checked later) */
  sideL: boolean;
  sideR: boolean;
}

const DRIVE = new Set<RoadClass>(['trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service']);
const WALK_CENTRE = new Set<RoadClass>(['footway', 'path', 'pedestrian', 'steps', 'living_street']);
const SPEED_CAP: Record<RoadClass, number> = { trunk: 12, primary: 9, secondary: 8.5, tertiary: 7.5, residential: 6, unclassified: 6, living_street: 3, service: 4, pedestrian: 0, footway: 0, path: 0, steps: 0, cycleway: 0, other: 0 };
const SPEED_DEFAULT: Record<RoadClass, number> = { trunk: 11, primary: 8.3, secondary: 8.3, tertiary: 7, residential: 6, unclassified: 6, living_street: 3, service: 4, pedestrian: 0, footway: 0, path: 0, steps: 0, cycleway: 0, other: 0 };

/** Carriageway width, identical to the rule in masks.ts so painted roads and simulated lanes coincide. */
export function carriagewayWidth(t: Record<string, string>): number {
  const w = parseFloat(t.width ?? ''); if (w > 1) return w;
  const lanes = parseFloat(t.lanes ?? ''); if (lanes > 0) return lanes * 3.2;
  switch (t.highway) {
    case 'motorway': case 'trunk': return 14; case 'primary': return 12; case 'secondary': return 10; case 'tertiary': return 8;
    case 'residential': case 'unclassified': return 6.5; case 'living_street': return 5; case 'service': return 4;
    case 'pedestrian': return 6; case 'footway': case 'path': case 'cycleway': case 'bridleway': return 2.6; case 'steps': return 2.2;
    default: return 5;
  }
}

function classOf(hw: string): RoadClass | null {
  switch (hw) {
    case 'motorway': case 'motorway_link': case 'trunk': case 'trunk_link': return 'trunk';
    case 'primary': case 'primary_link': return 'primary';
    case 'secondary': case 'secondary_link': return 'secondary';
    case 'tertiary': case 'tertiary_link': return 'tertiary';
    case 'residential': return 'residential';
    case 'unclassified': return 'unclassified';
    case 'living_street': return 'living_street';
    case 'service': return 'service';
    case 'pedestrian': return 'pedestrian';
    case 'footway': return 'footway';
    case 'path': case 'track': case 'bridleway': return 'path';
    case 'steps': return 'steps';
    case 'cycleway': return 'cycleway';
    default: return null; // corridor, elevator, proposed, construction, raceway, bus_guideway, platform...
  }
}

function parseSpeed(v: string | undefined): number | null {
  if (!v) return null;
  const m = /([\d.]+)\s*(mph)?/.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] ? n * 0.44704 : n / 3.6;
}

const yes = (v: string | undefined) => v === 'yes' || v === '1' || v === 'true';

export function classify(t: Record<string, string>): RoadSpec | null {
  if (!t.highway) return null;
  const cls = classOf(t.highway);
  if (!cls || cls === 'cycleway') return null;
  const clsId = ROAD_CLASSES.indexOf(cls);
  let drive = DRIVE.has(cls);
  if (cls === 'service' && (t.access === 'private' || t.access === 'no' || /driveway|parking_aisle|emergency_access|drive-through/.test(t.service ?? ''))) drive = false;
  const walkCentre = WALK_CENTRE.has(cls);
  if (!drive && !walkCentre) return null;
  const width = carriagewayWidth(t);
  const tunnel = (!!t.tunnel && t.tunnel !== 'no') || parseFloat(t.layer ?? '0') < 0;
  const bridge = !!t.bridge && t.bridge !== 'no';
  const reverse = t.oneway === '-1';
  let oneway = yes(t.oneway) || reverse || t.junction === 'roundabout' || t.junction === 'circular';
  // Narrow two-way service alleys cannot hold two cars side by side: treat them as one-way in the way direction.
  if (drive && !oneway && width < 5.5) oneway = true;

  // ---- lanes
  let lanesF = 0, lanesB = 0;
  const lf = parseInt(t['lanes:forward'] ?? ''), lb = parseInt(t['lanes:backward'] ?? ''), ln = parseInt(t.lanes ?? '');
  if (drive) {
    if (oneway) {
      lanesF = ln > 0 ? ln : lf > 0 ? lf : ({ trunk: 3, primary: 3, secondary: 2, tertiary: width >= 7 ? 2 : 1 } as Record<string, number>)[cls] ?? 1;
      lanesB = 0;
    } else if (lf > 0 || lb > 0) {
      lanesF = lf > 0 ? lf : 1; lanesB = lb > 0 ? lb : 1;
    } else if (ln > 0) {
      lanesF = Math.ceil(ln / 2); lanesB = Math.floor(ln / 2) || 1;
    } else {
      const d = ({ trunk: [2, 2], primary: [2, 2], secondary: width >= 12 ? [2, 2] : [1, 1] } as Record<string, number[]>)[cls] ?? [1, 1];
      lanesF = d[0]; lanesB = d[1];
    }
    if (reverse) { const tmp = lanesF; lanesF = lanesB || tmp; lanesB = 0; }
  }
  const n = Math.max(1, lanesF + lanesB);

  // ---- parking room and lane width (2.9 m typical Paris lane; parking lanes 2.0 m)
  let laneW = 2.9;
  const explicit = parseFloat(t.width ?? '') > 1 && ln > 0;
  if (explicit) laneW = Math.max(2.6, Math.min(3.4, width / ln));
  if (n * laneW > width) laneW = Math.max(2.4, width / n);
  let parkingSides: 0 | 1 | 2 = 0;
  if (drive && cls !== 'service' && cls !== 'living_street' && cls !== 'trunk') {
    const residual = width - n * laneW;
    parkingSides = residual >= 4.0 ? 2 : residual >= 2.0 ? 1 : 0;
    const pb = t['parking:both'] ?? t['parking:lane:both'];
    if (pb === 'no' || pb === 'no_parking' || pb === 'no_stopping') parkingSides = 0;
  }
  const moving = Math.max(n * 2.4, width - parkingSides * 2.0);
  laneW = Math.max(2.4, Math.min(3.4, moving / n));
  const bandCenter = parkingSides === 1 ? -1.0 : 0;

  // ---- speed
  const cap = SPEED_CAP[cls];
  const tagged = parseSpeed(t.maxspeed);
  const speed = drive ? Math.min(cap, tagged ?? SPEED_DEFAULT[cls]) : cls === 'steps' ? 0.5 : 1.3;

  // ---- sidewalks permitted by tags (streets only; service alleys and trunks have none)
  const swTag = t.sidewalk ?? '';
  const both = t['sidewalk:both'], left = t['sidewalk:left'], right = t['sidewalk:right'];
  const no = (v: string | undefined) => v === 'no' || v === 'none' || v === 'separate';
  let sideL = drive && cls !== 'service' && cls !== 'trunk';
  let sideR = sideL;
  if (swTag === 'no' || swTag === 'none' || swTag === 'separate') { sideL = false; sideR = false; }
  else if (swTag === 'left') sideR = false;
  else if (swTag === 'right') sideL = false;
  if (no(both)) { sideL = false; sideR = false; }
  if (no(left)) sideL = false;
  if (no(right)) sideR = false;
  if (reverse) { const tmp = sideL; sideL = sideR; sideR = tmp; }

  return { cls, clsId, drive, walkCentre, width, lanesF, lanesB, laneW, bandCenter, speed, oneway, reverse, steps: cls === 'steps', tunnel, bridge, parkingSides, sideL, sideR };
}
