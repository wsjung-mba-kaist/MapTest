import test from 'node:test';
import assert from 'node:assert/strict';
import { compassMarks, compassTicks, relBearing, stripX } from './compass.ts';

test('relative bearing wraps around north', () => {
  assert.equal(relBearing(350, 10), 20);
  assert.equal(relBearing(10, 350), -20);
  assert.equal(relBearing(0, 180), 180);
  assert.equal(relBearing(90, 90), 0);
  assert.equal(relBearing(-30, 30), 60);   // negative headings (radians converted loosely) still work
});

test('strip position: centre 0, edges +/-1, outside null', () => {
  assert.equal(stripX(0, 0, 60), 0);
  assert.equal(stripX(0, 60, 60), 1);
  assert.equal(stripX(0, 300, 60), -1);
  assert.equal(stripX(0, 90, 60), null);
  assert.equal(stripX(355, 5, 60)!.toFixed(3), (10 / 60).toFixed(3));
});

test('ticks cover the arc and label the cardinals', () => {
  const t = compassTicks(0, 60, 15);
  assert.deepEqual(t.map(k => k.deg), [300, 315, 330, 345, 0, 15, 30, 45, 60]);
  assert.equal(t.find(k => k.deg === 0)!.label, 'N');
  assert.equal(t.find(k => k.deg === 0)!.x, 0);
  const e = compassTicks(90, 45, 45);
  assert.deepEqual(e.map(k => [k.deg, k.label]), [[45, undefined], [90, 'E'], [135, undefined]]);
});

test('marks keep only what is inside the arc, nearest the centre first', () => {
  const m = compassMarks(180, 50, [{ bearing: 200, item: 'a' }, { bearing: 175, item: 'b' }, { bearing: 0, item: 'c' }, { bearing: 131, item: 'd' }]);
  assert.deepEqual(m.map(k => k.item), ['b', 'a', 'd']);
  assert.ok(m[0].x < 0 && m[1].x > 0);
});
