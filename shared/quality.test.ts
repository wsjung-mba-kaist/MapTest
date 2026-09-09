import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, pickQuality } from './quality.ts';

const frames = (ms: number, n = 120, jitter = 0) => Array.from({ length: n }, (_, i) => ms + jitter * Math.sin(i));

test('percentile', () => {
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test('fast machines keep their preset', () => {
  const d = pickQuality(frames(16.7, 120, 3), 'high');
  assert.equal(d.changed, false); assert.equal(d.quality, 'high');
});

test('a slow median steps down one level, never up', () => {
  assert.equal(pickQuality(frames(55), 'high').quality, 'medium');
  assert.equal(pickQuality(frames(55), 'medium').quality, 'low');
  const low = pickQuality(frames(55), 'low');
  assert.equal(low.quality, 'low'); assert.equal(low.pixelRatio, 0.75); assert.equal(low.changed, true);
  assert.equal(pickQuality(frames(10), 'low').changed, false);
});

test('a few slow frames (shader compiles, chunk uploads) do not trigger it', () => {
  const mixed = [...frames(16, 100), ...frames(200, 15)];
  assert.equal(pickQuality(mixed, 'high').changed, false);
  assert.equal(pickQuality(frames(55, 30), 'high').changed, false);   // too few samples
});
