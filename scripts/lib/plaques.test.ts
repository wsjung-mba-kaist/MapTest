import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrondissementOf, buildPlaquesFromLines } from './plaques.ts';
import type { Pt } from './polygons.ts';

const river: Pt[][] = [[[1000, -300], [-1000, -300]]]; // flows west; north (z < -300) is the right bank

test('a crossroads of two named streets yields one arm per name and direction', () => {
  const lines = [
    { name: 'Rue A', pts: [[-50, 0], [0, 0], [50, 0]] as Pt[] },
    { name: 'Rue B', pts: [[0, -50], [0, 0], [0, 50]] as Pt[] },
    { name: 'Rue A', pts: [[50, 0], [100, 0]] as Pt[] },            // a way split of the same street: not a junction
  ];
  const d = buildPlaquesFromLines(lines, river);
  assert.deepEqual(d.names, ['Rue A', 'Rue B']);
  const at0 = d.arms.filter(a => a[0] === 0 && a[1] === 0);
  assert.equal(at0.length, 4);
  assert.equal(d.arms.length, 4, 'the split point (50,0) has one name only');
  for (const a of at0) {
    assert.ok(Math.abs(Math.hypot(a[2], a[3]) - 1) < 1e-3);
    assert.equal(a[5], 7);                                             // left bank, east of avenue de Suffren line
  }
  const ruesA = at0.filter(a => a[4] === 0).map(a => a[2]).sort();
  assert.deepEqual(ruesA, [-1, 1]);
  const ruesB = at0.filter(a => a[4] === 1).map(a => a[3]).sort();
  assert.deepEqual(ruesB, [-1, 1]);
});

test('arrondissement heuristic: right bank 16e/8e, left bank 7e/15e', () => {
  assert.equal(arrondissementOf(0, -600, river), 16);
  assert.equal(arrondissementOf(900, -600, river), 8);
  assert.equal(arrondissementOf(300, 100, river), 7);
  assert.equal(arrondissementOf(-300, 400, river), 15);
});
