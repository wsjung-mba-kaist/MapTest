import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANDMARKS } from './landmarks_registry.ts';
import { commonsFileFromUrl, firstSentences, parseWikidataYear, stripHtml, freeLicense } from './landmarks.ts';
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
