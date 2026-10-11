import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANDMARKS } from './landmarks_registry.ts';
import { commonsFileFromUrl, firstSentences, parseWikidataYear, stripHtml, freeLicense, isDegradedRun, mergeLandmarks } from './landmarks.ts';
import type { Landmark } from '../../shared/layout.ts';
import { WORLD_HALF } from '../../shared/layout.ts';

test('registry ids and hotkeys are unique, positions inside the square', () => {
  const ids = new Set<string>(), keys = new Set<number>();
  for (const l of LANDMARKS) {
    assert.ok(!ids.has(l.id), `dup id ${l.id}`); ids.add(l.id);
    if (l.hotkey) { assert.ok(!keys.has(l.hotkey), `dup hotkey ${l.hotkey}`); keys.add(l.hotkey); }
    assert.ok(Math.abs(l.approx[0]) <= WORLD_HALF && Math.abs(l.approx[1]) <= WORLD_HALF, `${l.id} outside`);
    if (l.osm) assert.match(l.osm, /^(node|way|relation)\/\d+$/);
    if (l.wikidata) assert.match(l.wikidata, /^Q\d+$/);
    assert.ok(l.osm || l.wikidata, `${l.id} has neither osm nor wikidata`);
  }
  assert.equal(keys.size, 8);
});

test('parseWikidataYear', () => {
  assert.equal(parseWikidataYear('+1889-03-31T00:00:00Z'), 1889);
  assert.equal(parseWikidataYear('+1671-00-00T00:00:00Z'), 1671);
  assert.equal(parseWikidataYear('junk'), undefined);
});

test('commonsFileFromUrl strips thumb prefixes', () => {
  assert.equal(commonsFileFromUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/320px-Tour_Eiffel_Wikimedia_Commons.jpg'), 'Tour_Eiffel_Wikimedia_Commons.jpg');
  assert.equal(commonsFileFromUrl('https://upload.wikimedia.org/wikipedia/commons/a/a8/Les_Invalides%2C_Paris.jpg'), 'Les_Invalides,_Paris.jpg');
});

test('firstSentences caps at two sentences / 220 chars', () => {
  assert.equal(firstSentences('첫째 문장이다. 둘째 문장이다. 셋째 문장이다.'), '첫째 문장이다. 둘째 문장이다.');
  assert.equal(firstSentences('A. B. C.'), 'A. B.');
  const long = 'x'.repeat(300) + '. y.';
  assert.ok(firstSentences(long).length <= 221);
});

test('stripHtml and freeLicense', () => {
  assert.equal(stripHtml('<a href="x">Jean <b>Dupont</b></a>'), 'Jean Dupont');
  assert.ok(freeLicense('CC BY-SA 4.0')); assert.ok(freeLicense('CC0')); assert.ok(freeLicense('Public domain'));
  assert.ok(!freeLicense('CC BY-NC-SA 2.0')); assert.ok(!freeLicense(undefined));
});

const bare = (id: string, extra: Partial<Landmark> = {}): Landmark => ({ id, category: 'monument', x: 0, z: 0, lon: 2.29, lat: 48.86, radius: 50, view: { x: 0, z: 0, yaw: 0 }, name: { ko: id, fr: id, en: id }, short: id, blurb: '', links: {}, ...extra });
const rich = (id: string) => bare(id, { desc: { lang: 'ko', text: '설명' }, image: { file: `landmarks/${id}.jpg`, w: 480, h: 320, license: 'CC0', source: 'x' } });

test('mergeLandmarks: a rich previous entry survives a bare new one, a rich new one replaces it, registry order and ids win', () => {
  const prev = { landmarks: [rich('a'), rich('b'), bare('gone')], credits: ['a: Someone (CC0)', 'b: Else (CC BY 4.0)', 'gone: X (CC0)'] };
  const nextA = bare('a', { x: 5 }), nextB = rich('b'), nextC = bare('c');
  const m = mergeLandmarks(prev, { landmarks: [nextC, nextB, nextA], credits: ['b: Else (CC BY 4.0)'] });
  assert.deepEqual(m.landmarks.map(l => l.id), ['c', 'b', 'a']);
  assert.equal(m.landmarks[2], prev.landmarks[0], 'bare new a -> previous rich a');
  assert.equal(m.landmarks[1], nextB, 'rich new b wins over rich old b');
  assert.equal(m.kept, 1);
  assert.deepEqual(m.credits, ['a: Someone (CC0)', 'b: Else (CC BY 4.0)'], 'credit of the kept photo comes back, the dropped id does not');
});

test('mergeLandmarks without a previous file is the identity', () => {
  const next = { landmarks: [bare('a'), rich('b')], credits: ['b: Else (CC0)'] };
  const m = mergeLandmarks(null, next);
  assert.deepEqual(m.landmarks, next.landmarks); assert.deepEqual(m.credits, next.credits); assert.equal(m.kept, 0);
});

test('isDegradedRun: only an Overpass blackout that resolves fewer entries than the file already holds', () => {
  const prev = { landmarks: [rich('a'), rich('b'), bare('c')], credits: [] };
  assert.ok(isDegradedRun(prev, 0, 0), 'offline forced bake');
  assert.ok(isDegradedRun(prev, 1, 0));
  assert.ok(!isDegradedRun(prev, 2, 0), 'as many ok as before: not degraded');
  assert.ok(!isDegradedRun(prev, 0, 12), 'Overpass answered: a wiki outage is merged, not refused');
  assert.ok(!isDegradedRun(null, 0, 0), 'first bake has nothing to protect');
});
