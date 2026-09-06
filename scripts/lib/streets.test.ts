import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlabMesh, chunkSidewalks, SIDEWALK_W, type StreetInput } from './streets.ts';
import { bufferLine, pointInPoly, type Pt } from './polygons.ts';
import { KERB_H, StreetFlag } from '../../shared/layout.ts';

// chunk square 0..256 in both axes; a 7 m wide street along x through z = 100 and one along z through x = 100
const OX = 0, OZ = 0;
const W = 7;
const ew: Pt[] = [[-20, 100], [300, 100]];
const ns: Pt[] = [[100, -20], [100, 300]];

function input(): StreetInput {
  return {
    carriage: [...bufferLine(ew, W), ...bufferLine(ns, W)],
    paved: [...bufferLine(ew, W + 2 * SIDEWALK_W), ...bufferLine(ns, W + 2 * SIDEWALK_W)],
    blocked: [], grass: [],
  };
}

test('sidewalks hug the carriageway on both sides and stop at the chunk border', () => {
  const slabs = chunkSidewalks(input(), OX, OZ);
  assert.ok(slabs.length >= 4, `four corner pieces expected, got ${slabs.length}`);
  const inside = (x: number, z: number) => slabs.some(p => pointInPoly(x, z, p));
  assert.ok(!inside(50, 100), 'no slab on the carriageway centre');
  assert.ok(!inside(50, 100 + W / 2 - 0.3), 'no slab at the carriageway edge');
  assert.ok(inside(50, 100 + W / 2 + 1.0), 'slab 1 m past the kerb (south side)');
  assert.ok(inside(50, 100 - W / 2 - 1.0), 'slab 1 m past the kerb (north side)');
  assert.ok(!inside(50, 100 + W / 2 + SIDEWALK_W + 0.5), 'no slab beyond the sidewalk width');
  assert.ok(!inside(100, 100 + W / 2 + 1.0), 'the crossing street cuts the slab');
  // the chunk box overlaps its neighbours by 5 mm on purpose (see chunkSidewalks)
  for (const p of slabs) for (const r of p) for (const [x, z] of r) { assert.ok(x >= -0.01 && x <= 256.01 && z >= -0.01 && z <= 256.01, 'clipped to the chunk'); }
});

test('slab mesh sits KERB_H above the ground, faces up, and has kerb skirts except on chunk borders', () => {
  const slabs = chunkSidewalks(input(), OX, OZ);
  const ground = (x: number, z: number) => 0.01 * x + 0.02 * z;
  const m = buildSlabMesh(slabs, OX, OZ, ground);
  assert.ok(m.tris > 0 && m.kerbs > 0);
  for (let t = 0; t < m.idx.length; t += 3) {
    const [a, b, c] = [m.idx[t], m.idx[t + 1], m.idx[t + 2]];
    const flagSum = m.flag[a] + m.flag[b] + m.flag[c];
    if (flagSum === 0) {
      // top triangle: +y normal
      const ax = m.pos[a * 3], az = m.pos[a * 3 + 2], bx = m.pos[b * 3], bz = m.pos[b * 3 + 2], cx = m.pos[c * 3], cz = m.pos[c * 3 + 2];
      assert.ok((bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0, 'top triangles face up');
      for (const v of [a, b, c]) assert.ok(Math.abs(m.pos[v * 3 + 1] - (ground(m.pos[v * 3] + OX, m.pos[v * 3 + 2] + OZ) + KERB_H)) < 1e-6);
    } else {
      assert.equal(flagSum, 3 * StreetFlag.Kerb, 'kerb triangles use only kerb vertices');
      // no kerb face lies flat on a chunk border (the paved band continues into the neighbour chunk)
      const xs = [a, b, c].map(v => m.pos[v * 3]), zs = [a, b, c].map(v => m.pos[v * 3 + 2]);
      for (const border of [0, 256]) {
        assert.ok(!xs.every(x => Math.abs(x - border) < 0.02), `no skirt along x = ${border}`);
        assert.ok(!zs.every(z => Math.abs(z - border) < 0.02), `no skirt along z = ${border}`);
      }
    }
  }
});
