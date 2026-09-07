import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearingDeg, relativeDir, fmtDistance, landmarkAt, nearestLandmark, glideSeconds, shortestYaw } from './landmarks.ts';
import type { Landmark } from './layout.ts';

const lm = (id: string, x: number, z: number, radius: number, hidden = false): Landmark => ({
  id, category: 'museum', x, z, lon: 0, lat: 0, radius, hidden, view: { x, z, yaw: 0 }, name: { ko: id, fr: id, en: id }, short: id, links: {},
});

test('bearing: north 0, east 90, west 270, south 180', () => {
  assert.equal(bearingDeg(0, 0, 0, -100), 0);
  assert.equal(bearingDeg(0, 0, 100, 0), 90);
  assert.equal(bearingDeg(0, 0, -100, 0), 270);
  assert.equal(bearingDeg(0, 0, 0, 100), 180);
});

test('relativeDir follows the viewer yaw', () => {
  assert.equal(relativeDir(0, 0), '앞');
  assert.equal(relativeDir(0, 90), '오른쪽');
  assert.equal(relativeDir(Math.PI / 2, 90), '앞');
  assert.equal(relativeDir(0, 180), '뒤');
  assert.equal(relativeDir(0, 315), '왼쪽 앞');
});

test('fmtDistance', () => {
  assert.equal(fmtDistance(42.4), '42 m');
  assert.equal(fmtDistance(322), '320 m');
  assert.equal(fmtDistance(1234), '1.2 km');
});

test('landmarkAt prefers the nested small site and ignores hidden ones', () => {
  const big = lm('big', 0, 0, 200), small = lm('small', 20, 0, 40), hid = lm('hid', 20, 0, 40, true);
  assert.equal(landmarkAt([big, small, hid], 25, 0)?.id, 'small');
  assert.equal(landmarkAt([big, small], 150, 0)?.id, 'big');
  assert.equal(landmarkAt([big, small], 500, 0), null);
});

test('nearestLandmark', () => {
  const r = nearestLandmark([lm('a', 0, 0, 10), lm('b', 100, 0, 10)], 80, 0)!;
  assert.equal(r.landmark.id, 'b'); assert.ok(Math.abs(r.dist - 20) < 1e-9);
});

test('glideSeconds clamps', () => {
  assert.equal(glideSeconds(0), 1.2);
  assert.equal(glideSeconds(5000), 2.6);
  assert.ok(Math.abs(glideSeconds(200) - 1.7) < 1e-9);
});

test('shortestYaw wraps', () => {
  assert.ok(Math.abs(shortestYaw(0.1, Math.PI * 2 - 0.1) - -0.2) < 1e-9);
  assert.ok(Math.abs(shortestYaw(-3, 3) - -(Math.PI * 2 - 6)) < 1e-9);
});
