import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightmap } from './heightmap.ts';

// 9 x 9 samples at 2 m -> 4 x 4 render cells of 4 m; heights = x + 3z (cm) so planes are easy to check, plus a bump
function synthetic(): Heightmap {
  const n = 9, data = new Int16Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) data[j * n + i] = Math.round((i * 2 + 3 * j * 2) * 100);
  data[4 * n + 4] += 250; // bump at the centre node (x=8, z=8)
  return new Heightmap(data, n, 2, 0);
}

test('meshY equals the rendered terrain triangle (anti-diagonal split, 4 m cells)', () => {
  const hm = synthetic();
  // inside the first triangle (fx + fz <= 1) of the cell whose corner node carries the bump (cell x 8..12, z 8..12)
  const ya = hm.at(4, 4), yb = hm.at(6, 4), yc = hm.at(4, 6), yd = hm.at(6, 6);
  const fx = 0.25, fz = 0.25;
  assert.ok(Math.abs(hm.meshY(8 + fx * 4, 8 + fz * 4) - (ya + fx * (yb - ya) + fz * (yc - ya))) < 1e-9);
  // second triangle (fx + fz > 1)
  const gx = 0.75, gz = 0.75;
  assert.ok(Math.abs(hm.meshY(8 + gx * 4, 8 + gz * 4) - (yd + (1 - gx) * (yc - yd) + (1 - gz) * (yb - yd))) < 1e-9);
  // far from the bump the surface is the plane x + 3z (metres), which bilinear sampling also reproduces
  assert.ok(Math.abs(hm.meshY(2.5, 1.5) - (2.5 + 3 * 1.5)) < 1e-9);
  assert.ok(Math.abs(hm.sample(2.5, 1.5) - (2.5 + 3 * 1.5)) < 1e-9);
  // near the bump the 2 m bilinear sample and the 4 m mesh differ: mesh weight of node (4,4) at (9,9) is 0.5, bilinear 0.25
  assert.ok(Math.abs(hm.meshY(9, 9) - hm.sample(9, 9) - 2.5 * 0.25) < 1e-9);
});
