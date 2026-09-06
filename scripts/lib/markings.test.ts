import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkBuilder } from './markings.ts';
import { MarkKind } from '../../shared/layout.ts';

function triNormalY(pos: number[], a: number, b: number, c: number): number {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const bx = pos[b * 3] - ax, by = pos[b * 3 + 1] - ay, bz = pos[b * 3 + 2] - az;
  const cx = pos[c * 3] - ax, cy = pos[c * 3 + 1] - ay, cz = pos[c * 3 + 2] - az;
  return bz * cx - bx * cz; // y component of cross(b - a, c - a)
}

test('marking strips face up (front face seen from above) and follow the ground height', () => {
  const b = new MarkBuilder(100, 200, (x, z) => 0.1 * x + 0.05 * z);
  b.strip({ pts: [[110, 210], [116, 210], [116, 215]], width: 0.5, kind: MarkKind.Zebra });
  assert.ok(b.idx.length >= 6 * 4, 'strips are subdivided along their length');
  for (let t = 0; t < b.idx.length; t += 3) {
    assert.ok(triNormalY(b.pos, b.idx[t], b.idx[t + 1], b.idx[t + 2]) > 0, `triangle ${t / 3} faces up`);
  }
  // positions are chunk-local, heights come from the callback plus a small lift
  for (let v = 0; v < b.vertexCount; v++) {
    const x = b.pos[v * 3] + 100, z = b.pos[v * 3 + 2] + 200;
    assert.ok(Math.abs(b.pos[v * 3 + 1] - (0.1 * x + 0.05 * z)) < 0.02);
    assert.ok(Math.abs(b.muv[v * 2]) === 1);
    assert.equal(b.kind[v], MarkKind.Zebra);
  }
  // the along coordinate is continuous across the corner: last vertex pair sits at the total length (6 + 5)
  assert.ok(Math.abs(b.muv[(b.vertexCount - 1) * 2 + 1] - 11) < 1e-6);
});
