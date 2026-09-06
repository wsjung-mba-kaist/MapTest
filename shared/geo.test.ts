import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frame, ORIGIN, lonLatToTile, tileToLonLat, metersPerPixel, EnuFrame } from './geo.ts';

test('origin maps to (0,0)', () => {
  const p = frame.toWorld(ORIGIN.lon, ORIGIN.lat);
  assert.ok(Math.abs(p.x) < 1e-6 && Math.abs(p.z) < 1e-6);
});

test('Trocadéro esplanade is ~480 m west and ~409 m north of the tower', () => {
  const p = frame.toWorld(2.28793, 48.86205);
  assert.ok(Math.abs(p.x - -480) < 3, `x=${p.x}`);
  assert.ok(Math.abs(p.z - -409) < 3, `z=${p.z}`);
});

test('east/north axes are oriented correctly', () => {
  const e = frame.toWorld(ORIGIN.lon + 0.001, ORIGIN.lat);
  const n = frame.toWorld(ORIGIN.lon, ORIGIN.lat + 0.001);
  assert.ok(e.x > 70 && Math.abs(e.z) < 0.5);
  assert.ok(n.z < -110 && Math.abs(n.x) < 0.5);
});

test('world -> lonlat -> world round trip within 1 mm across 2 km', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 50; i++) {
    const x = (rnd() - 0.5) * 4000, z = (rnd() - 0.5) * 4000;
    const ll = frame.fromWorld(x, z);
    const back = frame.toWorld(ll.lon, ll.lat);
    assert.ok(Math.hypot(back.x - x, back.z - z) < 1e-3, `drift ${Math.hypot(back.x - x, back.z - z)}`);
  }
});

test('ENU u of a distant ground point shows earth curvature (sanity)', () => {
  const f = new EnuFrame(ORIGIN);
  const ll = f.fromWorld(1500, 0);
  const enu = f.toEnu(ll.lon, ll.lat, 0);
  assert.ok(enu.u < -0.15 && enu.u > -0.2, `u=${enu.u}`);
});

test('Mercator tile math: tower at z19 is col 265485 / row ~180366; inverse round-trips', () => {
  const t = lonLatToTile(ORIGIN.lon, ORIGIN.lat, 19);
  assert.equal(Math.floor(t.x), 265485);
  assert.ok(Math.abs(t.y - 180366.5) < 2, `row=${t.y}`);
  const back = tileToLonLat(t.x, t.y, 19);
  assert.ok(Math.abs(back.lon - ORIGIN.lon) < 1e-9 && Math.abs(back.lat - ORIGIN.lat) < 1e-9);
  const top = tileToLonLat(0, 0, 0);
  assert.ok(Math.abs(top.lon + 180) < 1e-9 && Math.abs(top.lat - 85.0511287798) < 1e-6);
});

test('z19 ground resolution near Paris is ~0.196 m/px', () => {
  const m = metersPerPixel(ORIGIN.lat, 19);
  assert.ok(Math.abs(m - 0.196) < 0.003, `${m}`);
});
