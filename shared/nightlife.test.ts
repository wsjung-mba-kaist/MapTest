import { test } from 'node:test';
import assert from 'node:assert/strict';
import { litProbability, shopOpen, towerLit, towerSparkle } from './nightlife.ts';

test('window lighting follows the evening: peak around 21-22h, decaying through the night', () => {
  for (let h = 0; h < 24; h += 0.25) { const p = litProbability(h); assert.ok(p >= 0 && p <= 1, `p(${h}) in range`); }
  assert.ok(litProbability(21) > litProbability(1));
  assert.ok(litProbability(1) > litProbability(3));
  assert.ok(litProbability(23.5) > litProbability(0.5));
  assert.ok(litProbability(12) < 0.1, 'daytime is dark');
  assert.ok(Math.abs(litProbability(24) - litProbability(0)) < 1e-9, 'cyclic');
});

test('shops close at 20h, restaurants at 01h, the tower goes dark at 23:45 and sparkles on the hour', () => {
  assert.equal(shopOpen(19, false), 1);
  assert.equal(shopOpen(21, false), 0.15);
  assert.equal(shopOpen(23, true), 1);
  assert.equal(shopOpen(2, true), 0.15);
  assert.equal(towerLit(22, 20.3, 7.2), 1);
  assert.equal(towerLit(23.8, 20.3, 7.2), 0);
  assert.equal(towerLit(23.8, 20.3, 7.2, true), 1);
  assert.equal(towerSparkle(23.02, 20.3), 1);
  assert.equal(towerSparkle(23.2, 20.3), 0);
  assert.equal(towerSparkle(15.02, 20.3), 0);
});
