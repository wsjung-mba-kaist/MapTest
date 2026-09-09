import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFS, defaultPrefs, diffPrefs, parsePrefs, serializePrefs } from './prefs.ts';

test('round trip', () => {
  const p = { ...DEFAULT_PREFS, quality: 'low' as const, fov: 85, sensitivity: 1.5, minimap: true };
  assert.deepEqual(parsePrefs(JSON.parse(serializePrefs(p))), p);
});

test('bad input falls back to the defaults', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('nonsense'), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs({ v: 99, quality: 'low' }), DEFAULT_PREFS);   // other version: ignored wholesale
  assert.deepEqual(parsePrefs({ v: 1, quality: 'ultra', pixelRatio: 3, shadows: 'yes', bogus: 1 }), DEFAULT_PREFS);
});

test('numbers are clamped, unknown keys dropped', () => {
  const p = parsePrefs({ v: 1, fov: 500, sensitivity: -2, volume: 1.7, extra: true });
  assert.equal(p.fov, 100); assert.equal(p.sensitivity, 0.4); assert.equal(p.volume, 1);
  assert.ok(!('extra' in p));
  assert.equal(parsePrefs({ v: 1, fov: NaN }).fov, DEFAULT_PREFS.fov);
});

test('device defaults: phones drop AO / reflection / compass and pin 1x, reduced motion drops the head bob', () => {
  const phone = defaultPrefs({ coarse: true, reducedMotion: false });
  assert.equal(phone.ao, false); assert.equal(phone.reflection, false); assert.equal(phone.pixelRatio, 1); assert.equal(phone.compass, false);
  assert.equal(phone.headBob, true);
  const rm = defaultPrefs({ coarse: false, reducedMotion: true });
  assert.equal(rm.headBob, false); assert.equal(rm.ao, true);
  // a stored value wins over the device default it is parsed against
  assert.equal(parsePrefs({ v: 1, ao: true }, phone).ao, true);
  assert.equal(parsePrefs({ v: 1 }, phone).ao, false);
});

test('diff lists only the changed keys', () => {
  const a = { ...DEFAULT_PREFS }, b = { ...DEFAULT_PREFS, fov: 80, labels: true };
  assert.deepEqual(diffPrefs(a, b).sort(), ['fov', 'labels']);
  assert.deepEqual(diffPrefs(a, a), []);
});
