import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeatureCollection, Geometry, Polygon } from 'geojson';
import { buildSpecs, classify, defaultRise, parseColour, parseDirection, Style } from './buildings.ts';
import type { OsmProps } from './overpass.ts';
import type { BdTopoProps } from './bdtopo.ts';
import { frame } from '../../shared/geo.ts';

/** Flat terrain at y = 0 (only sample() is used by buildSpecs). */
const flat = { sample: () => 0 } as unknown as import('../../shared/heightmap.ts').Heightmap;
const bd: FeatureCollection<Polygon, BdTopoProps> = { type: 'FeatureCollection', features: [] };

/** A square footprint of `side` metres around world (x, z) as an OSM feature with the given tags. */
function feature(id: number, x: number, z: number, side: number, tags: Record<string, string>): import('geojson').Feature<Geometry, OsmProps> {
  const h = side / 2;
  const ll = (dx: number, dz: number) => { const p = frame.fromWorld(x + dx, z + dz); return [p.lon, p.lat]; };
  return { type: 'Feature', properties: { type: 'way', id, tags }, geometry: { type: 'Polygon', coordinates: [[ll(-h, -h), ll(h, -h), ll(h, h), ll(-h, h), ll(-h, -h)]] } };
}
const specsOf = (features: import('geojson').Feature<Geometry, OsmProps>[]) => buildSpecs({ type: 'FeatureCollection', features }, bd, flat).specs;

test('parseDirection: compass points and degrees', () => {
  assert.equal(parseDirection('NE'), 45);
  assert.equal(parseDirection('w'), 270);
  assert.equal(parseDirection('370'), 10);
  assert.equal(parseDirection(undefined), null);
});

test('parseColour knows gold and hex', () => {
  assert.deepEqual(parseColour('#ffcc00'), [255, 204, 0]);
  assert.ok(parseColour('gold')![0] > 200);
  assert.equal(parseColour('mauve'), null);
});

test('a pure dome part keeps its min_height when roof:height fills the whole part', () => {
  const [s] = specsOf([feature(1, 0, 0, 20, { 'building:part': 'yes', height: '72', min_height: '48.1', 'roof:shape': 'dome', 'roof:height': '16.8' })]);
  assert.equal(s.roof, 'dome');
  assert.ok(Math.abs(s.minH - 48.1) < 1e-9, 'minH kept: ' + s.minH);
  assert.ok(Math.abs(s.ridge - 72) < 1e-9);
  assert.ok(Math.abs(s.eave - (72 - 16.8)) < 1e-9, 'eave = ridge - roof:height');
});

test('roof-only parts without walls (the tower arch skirts) are skipped', () => {
  const specs = specsOf([
    feature(1, 0, 0, 20, { 'building:part': 'roof', height: '57.63', min_height: '4', 'roof:shape': 'skillion', 'roof:direction': '224', wall: 'no' }),
    feature(2, 100, 0, 20, { 'building:part': 'yes', height: '20', wall: 'no' }),
    feature(3, 200, 0, 20, { 'building:part': 'yes', height: '20', 'roof:shape': 'skillion', 'roof:direction': '90' }),
  ]);
  assert.deepEqual(specs.map(s => s.id), ['way/3']);
  assert.equal(specs[0].roof, 'skillion');
});

test('roof:colour paints the roof; roof:material sets the id', () => {
  const [a, b, c] = specsOf([
    feature(1, 0, 0, 20, { building: 'yes', height: '20', 'roof:shape': 'gabled', 'roof:colour': '#336699' }),
    feature(2, 100, 0, 20, { building: 'yes', height: '20', 'roof:material': 'copper' }),
    feature(3, 200, 0, 20, { building: 'yes', height: '20', 'roof:shape': 'dome', 'roof:colour': 'gold' }),
  ]);
  assert.equal(a.roofMat, 'painted'); assert.equal(a.roofMatId, 7); assert.deepEqual(a.roofTint, [0x33, 0x66, 0x99]);
  assert.equal(b.roofMat, 'copper'); assert.equal(b.roofMatId, 3);
  assert.equal(c.roofMat, 'gilded'); assert.equal(c.roofMatId, 6);
});

test('defaultRise scales with the short side and never exceeds what is available', () => {
  assert.equal(defaultRise('dome', 20, 100), 10);
  assert.equal(defaultRise('cone', 10, 3), 2.5);
  assert.equal(defaultRise('flat', 10, 10), 0);
});

test('classification: church by building tag, palace by name, listed Haussmann block stays Haussmann', () => {
  const church = classify({ building: 'church' }, '', '', false, 3, 15, 600, 25);
  assert.equal(church.style, Style.Monument); assert.ok(church.landmark);
  const palace = classify({ building: 'yes', name: 'Palais de Chaillot' }, '', '', false, 5, 22, 5000, 30);
  assert.equal(palace.style, Style.Monument); assert.ok(palace.landmark);
  const block = classify({ building: 'apartments', heritage: '2', 'building:levels': '6' }, '', '', false, 6, 18.5, 500, 24);
  assert.equal(block.style, Style.Haussmann); assert.ok(!block.landmark);
  const small = classify({ building: 'chapel' }, '', '', false, 1, 6, 80, 9);
  assert.equal(small.style, Style.Monument); assert.ok(!small.landmark, 'a small chapel is a monument but not a landmark');
  const hospital = classify({ building: 'yes', name: 'EHPAD Grenelle', wikidata: 'Q1' }, '', '', false, 6, 18, 2000, 24);
  assert.equal(hospital.style, Style.Haussmann, 'wikidata alone is not a monument facade'); assert.ok(hospital.landmark, 'but a big wikidata building gets the surface-model roof');
});

test('parts inside a landmark outline inherit the Monument style, name and tint', () => {
  const specs = specsOf([
    feature(10, 0, 0, 100, { building: 'yes', name: 'Hôtel des Invalides', wikidata: 'Q188977', 'building:colour': '#d0c8b0', height: '20' }),
    feature(11, 0, 0, 20, { 'building:part': 'yes', height: '72', min_height: '48', 'roof:shape': 'dome', 'roof:height': '16' }),
    feature(12, 30, 30, 10, { 'building:part': 'yes', height: '30', 'building:colour': '#ffffff' }),
  ]);
  const outline = specs.find(s => s.id === 'way/10')!, dome = specs.find(s => s.id === 'way/11')!, wing = specs.find(s => s.id === 'way/12')!;
  assert.ok(outline.landmark && outline.isPlinth);
  assert.equal(dome.style, Style.Monument); assert.ok(dome.landmark); assert.equal(dome.name, 'Hôtel des Invalides');
  assert.deepEqual(dome.tint, outline.tint, 'part without its own colour takes the outline stone');
  assert.deepEqual(wing.tint, [255, 255, 255], 'a part with building:colour keeps it');
});
