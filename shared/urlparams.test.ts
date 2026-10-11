import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL_PARAM_NAMES, UrlParams, buildShareQuery, parseShareState, type ShareState } from './urlparams.ts';

test('every URL parameter the runtime reads is documented in the README', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const missing = URL_PARAM_NAMES.filter(n => !new RegExp(`\`${n}=|\`${n}\`|[?&]${n}=`).test(readme));
  assert.deepEqual(missing, [], `undocumented URL parameters: ${missing.join(', ')}`);
});

test('every parameter App reads is in the registry (no ad-hoc names)', () => {
  const app = readFileSync(new URL('../src/core/App.ts', import.meta.url), 'utf8');
  const used = new Set<string>();
  for (const m of app.matchAll(/\b(?:q|p|params|this\.params)\.(?:get|has|on|off|oneOf|list|num|hasNum|date)\('([a-z]+)'/g)) used.add(m[1]);
  const known = new Set<string>(URL_PARAM_NAMES);
  const unknown = [...used].filter(n => !known.has(n));
  assert.deepEqual(unknown, [], `App reads parameters missing from URL_PARAM_NAMES: ${unknown.join(', ')}`);
  assert.doesNotMatch(app, /new URLSearchParams\(location\.search\)/, 'App parses location.search itself');
});

test('numbers are clamped and malformed values fall back (the black-frame NaN bug)', () => {
  const p = new UrlParams('?hour=&x=abc&y=1e9&fov=200&yaw=-30');
  assert.equal(p.num('hour', 12, 0, 24), 12);
  assert.equal(p.hasNum('hour'), false);
  assert.equal(p.num('x', 7), 7);
  assert.equal(p.num('y', 0, -100, 3000), 3000);
  assert.equal(p.num('fov', 70, 20, 130), 130);
  assert.equal(p.num('yaw', 0), -30);
  assert.equal(p.date('date'), null);
  assert.deepEqual(new UrlParams('?date=2026-12-21').date('date'), [2026, 12, 21]);
  assert.equal(new UrlParams('?date=2026-13-01').date('date'), null);
  assert.deepEqual(new UrlParams('?hide=trees,,furniture').list('hide'), ['trees', 'furniture']);
  assert.equal(new UrlParams('?weather=snow').oneOf('weather', ['clear', 'rain']), null);
});

test('unknown parameters are collected for the boot warning', () => {
  const p = new UrlParams('?lifes=0&hour=19.5&foo=1&foo=2');
  assert.deepEqual(p.unknown, ['lifes', 'foo']);
});

test('a share link round-trips through the parser', () => {
  const s: ShareState = { flying: false, x: -480.26, y: 28.1, z: -409, yawDeg: 130.4, pitchDeg: 2, hour: 19.5, date: [2026, 12, 21], tower: 'lattice', weather: 'rain', at: 'invalides' };
  const back = parseShareState(new UrlParams('?' + buildShareQuery(s)))!;
  assert.equal(back.flying, false);
  assert.ok(Math.abs(back.x - s.x) < 0.06 && Math.abs(back.y - s.y) < 0.06 && Math.abs(back.z - s.z) < 0.06);
  assert.equal(back.yawDeg, 130); assert.equal(back.pitchDeg, 2); assert.equal(back.hour, 19.5);
  assert.deepEqual(back.date, [2026, 12, 21]); assert.equal(back.tower, 'lattice'); assert.equal(back.weather, 'rain'); assert.equal(back.at, 'invalides');
  const fly = parseShareState(new UrlParams('?' + buildShareQuery({ flying: true, x: 1, y: 2, z: 3, yawDeg: -10, pitchDeg: 0, hour: 12 })))!;
  assert.equal(fly.flying, true); assert.equal(fly.yawDeg, 350); assert.equal(fly.weather, undefined);
  assert.equal(parseShareState(new UrlParams('?hour=3')), null);
});
