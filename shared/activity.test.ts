import test from 'node:test';
import assert from 'node:assert/strict';
import { activity } from './nightlife.js';

test('traffic and pedestrians follow the day', () => {
  for (const kind of ['car', 'walk'] as const) {
    for (let h = 0; h < 24; h += 0.5) { const a = activity(h, kind); assert.ok(a >= 0 && a <= 1, `${kind} ${h} -> ${a}`); }
    assert.ok(activity(3, kind) < activity(8, kind));
    assert.ok(activity(23, kind) < activity(18, kind));
  }
  assert.equal(activity(12, 'walk'), 1);
  assert.ok(activity(4, 'walk') < activity(4, 'car'));     // a few cars still move when the streets are empty
  assert.equal(activity(24, 'car'), activity(0, 'car'));   // cyclic
});
