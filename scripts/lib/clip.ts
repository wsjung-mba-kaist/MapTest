import ClipperLib from 'clipper-lib';
import type { Poly, Pt, Ring } from './polygons.ts';

/**
 * Robust polygon set operations on top of Clipper (integer Vatti clipping, millimetre grid). polygon-clipping's
 * floating-point sweep line throws or hangs on the heavily overlapping road buffers the street bake produces;
 * Clipper handles them, and its offsetter gives proper round-ended buffers for polylines.
 */

const SCALE = 1000; // 1 mm

const toPath = (r: Ring): ClipperLib.Path => r.map(p => ({ X: Math.round(p[0] * SCALE), Y: Math.round(p[1] * SCALE) }));
const fromPath = (p: ClipperLib.Path): Ring => p.map(q => [q.X / SCALE, q.Y / SCALE] as Pt);
const toPaths = (polys: Poly[]): ClipperLib.Paths => polys.flatMap(poly => poly.map(toPath));

/** PolyTree -> nested polygons [outer, ...holes][] (holes' children become new outers). */
function fromTree(tree: ClipperLib.PolyTree): Poly[] {
  const out: Poly[] = [];
  const visit = (node: ClipperLib.PolyNode) => {
    for (const outer of node.Childs()) {
      if (outer.IsHole()) { visit(outer); continue; }
      const poly: Poly = [fromPath(outer.Contour())];
      for (const hole of outer.Childs()) {
        poly.push(fromPath(hole.Contour()));
        visit(hole);       // islands inside the hole
      }
      out.push(poly);
    }
  };
  visit(tree);
  return out;
}

function execute(type: ClipperLib.ClipType, subject: Poly[], clip: Poly[] = []): Poly[] {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  if (subject.length) c.AddPaths(toPaths(subject), ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(toPaths(clip), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(type, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return fromTree(tree);
}

export const unionPolys = (polys: Poly[]): Poly[] => polys.length ? execute(ClipperLib.ClipType.ctUnion, polys) : [];
export const differencePolys = (subject: Poly[], clip: Poly[]): Poly[] => clip.length ? execute(ClipperLib.ClipType.ctDifference, subject, clip) : unionPolys(subject);
export const intersectPolys = (subject: Poly[], clip: Poly[]): Poly[] => execute(ClipperLib.ClipType.ctIntersection, subject, clip);

/** Buffer an open polyline by width (round joins and caps). */
export function offsetLine(pts: Pt[], width: number): Poly[] {
  if (pts.length < 2 || width <= 0) return [];
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  co.AddPath(toPath(pts), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, (width / 2) * SCALE);
  return fromTree(tree);
}

/** Grow (delta > 0) or shrink (delta < 0) polygons; shrinking drops parts thinner than 2|delta|. */
export function offsetPolys(polys: Poly[], delta: number): Poly[] {
  if (!polys.length) return [];
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  // Clipper wants outers positive and holes negative in its (Y-up) orientation convention; normalise via a union first
  const norm = toPaths(unionPolys(polys));
  co.AddPaths(norm, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, delta * SCALE);
  return fromTree(tree);
}

export const polyArea = (r: Ring) => Math.abs(ClipperLib.Clipper.Area(toPath(r))) / (SCALE * SCALE);
