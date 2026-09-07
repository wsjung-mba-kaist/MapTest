import test from 'node:test';
import assert from 'node:assert/strict';
import { dayOfYear, seasonState } from './season.js';

test('day of year', () => {
  assert.equal(dayOfYear(2026, 1, 1), 1);
  assert.equal(dayOfYear(2026, 12, 31), 365);
  assert.equal(dayOfYear(2024, 12, 31), 366);
});

test('bare in winter, green in summer, turning in October, falling in November', () => {
  const jan = seasonState(dayOfYear(2026, 1, 15)), jul = seasonState(dayOfYear(2026, 7, 15));
  const oct = seasonState(dayOfYear(2026, 10, 15)), nov = seasonState(dayOfYear(2026, 11, 25)), may = seasonState(dayOfYear(2026, 5, 1));
  assert.equal(jan.coverage, 0);
  assert.equal(jul.coverage, 1); assert.equal(jul.autumn, 0); assert.equal(jul.fresh, 0);
  assert.ok(oct.coverage > 0.6 && oct.autumn > 0.5);
  assert.ok(nov.coverage < 0.3 && nov.autumn === 1);
  assert.ok(may.coverage > 0 && may.coverage < 1 && may.fresh === 1);
  for (let d = 1; d <= 366; d++) { const s = seasonState(d); for (const v of [s.coverage, s.autumn, s.fresh]) assert.ok(v >= 0 && v <= 1); }
});
