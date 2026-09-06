import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extrudeBuilding, type ChunkBuilders } from './extrude.ts';
import { GeomBuilder } from './binmesh.ts';
import { insetRing, orient, signedArea } from './polygons.ts';
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
  roof: 'mansard', style: 0, tint: [220, 210, 190], roofMat: 'zinc', levels: 6, floorH: 3.1, seed: 1, source: 'default', isPart: false, isPlinth: false, ...over,
});

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
