import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extrudeBuilding, resampleRing, type ChunkBuilders } from './extrude.ts';
import { GeomBuilder } from './binmesh.ts';
import { distToRing, insetRing, minAreaRect, orient, signedArea } from './polygons.ts';
import type { BuildingSpec } from './buildings.ts';
import { SurfaceFlag } from '../../shared/layout.ts';

function normalsOf(gb: GeomBuilder) {
  const out: { n: [number, number, number]; c: [number, number, number]; flag: number }[] = [];
  const p = gb.positions;
  for (let t = 0; t < gb.indices.length; t += 3) {
    const [a, b, c] = [gb.indices[t], gb.indices[t + 1], gb.indices[t + 2]];
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(...n) || 1;
    out.push({ n: [n[0] / l, n[1] / l, n[2] / l], c: [(ax + p[b * 3] + p[c * 3]) / 3, (ay + p[b * 3 + 1] + p[c * 3 + 1]) / 3, (az + p[b * 3 + 2] + p[c * 3 + 2]) / 3], flag: gb.colors[a * 4 + 3] });
  }
  return out;
}

function square(cx: number, cz: number, half: number, positive: boolean) {
  return orient([[cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half]], positive);
}

const spec = (over: Partial<BuildingSpec>): BuildingSpec => ({
  id: 'test', rings: [square(0, 0, 10, false)], centroid: [0, 0], area: 400, minH: 0, eave: 18, ridge: 24, groundY: 5,
  roof: 'mansard', style: 0, tint: [220, 210, 190], roofMat: 'zinc', roofMatId: 0, roofTint: [128, 134, 140], roofDir: null, roofOrient: null,
  rect: minAreaRect((over.rings ?? [square(0, 0, 10, false)])[0]), levels: 6, floorH: 3.1, seed: 1, source: 'default', isPart: false, isPlinth: false, landmark: false, ...over,
} as BuildingSpec);

const builders = (): ChunkBuilders => ({ walls: new GeomBuilder(), roofs: new GeomBuilder(), tops: new GeomBuilder(), lod: new GeomBuilder() });

test('outer ring is oriented negative, holes positive', () => {
  assert.ok(signedArea(square(0, 0, 1, false)) < 0);
  assert.ok(signedArea(square(0, 0, 1, true)) > 0);
});

test('walls face outward and roof tops face up (square with courtyard)', () => {
  const cb = builders();
  extrudeBuilding(spec({ rings: [square(0, 0, 10, false), square(0, 0, 4, true)], roof: 'flat', ridge: 18 }), cb, 0, 0);
  for (const t of normalsOf(cb.walls)) {
    assert.ok(Math.abs(t.n[1]) < 1e-6, 'wall normals are horizontal');
    const r = Math.hypot(t.c[0], t.c[2]);
    const outward = (t.n[0] * t.c[0] + t.n[2] * t.c[2]) / r; // + means pointing away from the centre
    if (r > 7) assert.ok(outward > 0.9, `outer wall should face outward, got ${outward}`);
    else assert.ok(outward < -0.9, `courtyard wall should face the courtyard, got ${outward}`);
  }
  const tops = normalsOf(cb.tops);
  assert.ok(tops.length > 0);
  for (const t of tops) { assert.ok(t.n[1] > 0.999, `top normal up, got ${t.n}`); assert.equal(t.flag, SurfaceFlag.RoofTop); }
  // Cap must not cover the courtyard.
  assert.ok(!tops.some(t => Math.hypot(t.c[0], t.c[2]) < 3), 'courtyard is open');
});

test('mansard produces outward+up slopes and a smaller top', () => {
  const cb = builders();
  extrudeBuilding(spec({}), cb, 0, 0);
  const slopes = normalsOf(cb.roofs);
  assert.ok(slopes.length >= 8, `expected two slope stages, got ${slopes.length / 2} quads`);
  for (const t of slopes) {
    assert.ok(t.n[1] > 0.2, `slope normal has up component ${t.n[1]}`);
    const r = Math.hypot(t.c[0], t.c[2]);
    assert.ok((t.n[0] * t.c[0] + t.n[2] * t.c[2]) / r > 0.3, 'slope faces outward');
  }
  const tops = normalsOf(cb.tops);
  assert.ok(tops.every(t => Math.abs(t.c[1] - (5 + 24)) < 1e-6), 'top sits at the ridge');
  assert.ok(tops.every(t => Math.hypot(t.c[0], t.c[2]) < 9), 'top is inset');
});

test('uv0 on walls runs in metres along the ring and up from ground', () => {
  const cb = builders();
  extrudeBuilding(spec({ roof: 'flat', ridge: 18 }), cb, 0, 0);
  const uv = cb.walls.uvs;
  const maxU = Math.max(...uv.filter((_, i) => i % 2 === 0));
  const vs = uv.filter((_, i) => i % 2 === 1);
  assert.ok(Math.abs(maxU - 80) < 1e-6, `perimeter 80 m, got ${maxU}`);
  assert.ok(Math.min(...vs) === -1 && Math.max(...vs) === 18, `v range -1..18, got ${Math.min(...vs)}..${Math.max(...vs)}`);
});

test('insetRing shrinks a rectangle and rejects over-inset', () => {
  const r = square(0, 0, 10, false);
  const i1 = insetRing(r, 2)!;
  assert.ok(i1 && Math.abs(Math.abs(signedArea(i1)) - 16 * 16) < 1e-6);
  assert.equal(insetRing(r, 11), null);
});

import { erodeRing } from './polygons.ts';
test('erodeRing shrinks a rectangle and survives short jogs where the bisector inset fails', () => {
  const rect: [number, number][] = [[0, 0], [20, 0], [20, 10], [0, 10]];
  const e = erodeRing(rect, 2)!;
  assert.ok(e, 'rectangle erodes');
  const areaOf = (r: [number, number][]) => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  assert.ok(Math.abs(areaOf(e) - 96) < 5, 'area about 16 x 6 minus rounded corners: ' + areaOf(e).toFixed(1));
  // a Haussmann-like footprint with a 0.6 m jog: insetRing gives up, erodeRing must not
  const jog: [number, number][] = [[0, 0], [12, 0], [12, 0.6], [12.6, 0.6], [12.6, 9], [0, 9]];
  assert.equal(insetRing(jog, 1.3, 0.3), null);
  const e2 = erodeRing(jog, 1.3, 0.3);
  assert.ok(e2 && e2.length >= 4, 'jog footprint erodes');
});

function polygon(cx: number, cz: number, r: number, n: number): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ring.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
  return orient(ring, false);
}

test('dome seals to the footprint, peaks at the ridge, faces outward and up, no flat top', () => {
  const cb = builders();
  const ring = polygon(0, 0, 10, 16);
  extrudeBuilding(spec({ rings: [ring], roof: 'dome', eave: 20, ridge: 28, groundY: 0 }), cb, 0, 0);
  const p = cb.roofs.positions;
  let maxY = -Infinity, baseOnRing = 0, baseCount = 0;
  for (let i = 0; i < p.length; i += 3) {
    maxY = Math.max(maxY, p[i + 1]);
    if (Math.abs(p[i + 1] - 20) < 1e-6) { baseCount++; if (distToRing(p[i], p[i + 2], ring) < 1e-3) baseOnRing++; }
  }
  assert.ok(Math.abs(maxY - 28) < 1e-6, 'apex at the ridge');
  assert.ok(baseCount > 0 && baseOnRing === baseCount, 'base parallel is the footprint');
  const tris = normalsOf(cb.roofs);
  assert.ok(tris.length >= 16 * 5, 'enough parallels');
  for (const t of tris) {
    assert.ok(t.n[1] > 0.05, 'dome triangles face up: ' + t.n);
    const r = Math.hypot(t.c[0], t.c[2]);
    if (r > 1) assert.ok((t.n[0] * t.c[0] + t.n[2] * t.c[2]) / r > 0, 'dome faces outward');
    assert.equal(t.flag, SurfaceFlag.RoofCurved);
  }
  assert.equal(cb.tops.indices.length, 0, 'no flat top on a dome');
  assert.ok(cb.lod.indices.length > 0 && Math.max(...cb.lod.positions.filter((_, i) => i % 3 === 1)) <= 28 + 1e-6, 'LOD dome stays under the ridge');
});

test('onion bulges wider than its drum', () => {
  const cb = builders();
  extrudeBuilding(spec({ rings: [polygon(0, 0, 6, 16)], roof: 'onion', eave: 20, ridge: 31, groundY: 0 }), cb, 0, 0);
  const p = cb.roofs.positions;
  let maxR = 0;
  for (let i = 0; i < p.length; i += 3) maxR = Math.max(maxR, Math.hypot(p[i], p[i + 2]));
  assert.ok(maxR > 6.8 && maxR < 8.5, 'bulge radius ' + maxR.toFixed(2));
});

test('cone is a curved fan; a square drum is resampled into many columns', () => {
  const cb = builders();
  extrudeBuilding(spec({ rings: [square(0, 0, 6, false)], roof: 'cone', eave: 20, ridge: 30, groundY: 0 }), cb, 0, 0);
  const tris = normalsOf(cb.roofs);
  assert.ok(tris.length >= 16, 'resampled columns: ' + tris.length);
  for (const t of tris) { assert.ok(t.n[1] > 0.2); assert.equal(t.flag, SurfaceFlag.RoofCurved); }
  assert.equal(resampleRing(square(0, 0, 6, false), 3).length, 16);
});

test('barrel vault (round) follows a semicircle across the short axis and closes the end walls', () => {
  const cb = builders();
  const rect = orient([[-20, -5], [20, -5], [20, 5], [-20, 5]], false);
  extrudeBuilding(spec({ rings: [rect], roof: 'round', eave: 10, ridge: 15, groundY: 0 }), cb, 0, 0);
  const p = cb.roofs.positions;
  for (let i = 0; i < p.length; i += 3) {
    const expect = 10 + 5 * Math.sqrt(Math.max(0, 1 - (p[i + 2] / 5) ** 2));
    assert.ok(Math.abs(p[i + 1] - expect) < 1e-6, 'vault height at z=' + p[i + 2] + ': ' + p[i + 1] + ' vs ' + expect);
  }
  const w = cb.walls.positions;
  let maxWall = 0; for (let i = 0; i < w.length; i += 3) maxWall = Math.max(maxWall, w[i + 1]);
  assert.ok(maxWall > 14.5, 'end walls rise to the vault: ' + maxWall);
  assert.equal(cb.walls.positions.length / 3 % 4, 0, 'walls stay 4-vertex quads');
});

test('gabled roof honours roof:direction (ridge perpendicular to the gable facing)', () => {
  const cb = builders();
  const rect = orient([[-20, -5], [20, -5], [20, 5], [-20, 5]], false);
  // gable faces east (90°): the ridge runs north-south, so the roof slopes along x
  extrudeBuilding(spec({ rings: [rect], roof: 'gabled', roofDir: 90, eave: 10, ridge: 14, groundY: 0 }), cb, 0, 0);
  const p = cb.roofs.positions;
  const ridgeXs = new Set<number>();
  for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 1] - 14) < 1e-6) ridgeXs.add(Math.round(p[i] * 1000));
  assert.deepEqual([...ridgeXs], [0], 'ridge on x = 0');
  for (let i = 0; i < p.length; i += 3) assert.ok(Math.abs(p[i + 1] - (10 + 4 * (1 - Math.abs(p[i]) / 20))) < 1e-6);
  // without a direction the plain gable keeps the old hip band (no wall above the eave)
  const cb2 = builders();
  extrudeBuilding(spec({ rings: [rect], roof: 'gabled', eave: 10, ridge: 14, groundY: 0 }), cb2, 0, 0);
  let maxWall = 0; for (let i = 0; i < cb2.walls.positions.length; i += 3) maxWall = Math.max(maxWall, cb2.walls.positions[i + 1]);
  assert.ok(Math.abs(maxWall - 10) < 1e-6);
});
