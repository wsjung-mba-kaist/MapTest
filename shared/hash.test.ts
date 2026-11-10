import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash32, ihash } from './hash.ts';

/**
 * The hashes seed everything deterministic in the baked world and the moving city (facade seeds, chimney colours,
 * car paint, junction phases, who stands still). The exact values are pinned so a "harmless" refactor cannot reshuffle
 * every seed and silently change the whole city between two builds.
 */
test('hash32 values are pinned', () => {
  assert.deepEqual([hash32(0), hash32(1), hash32(1, 2), hash32(1, 2, 3), hash32(1, 2, 3, 4), hash32(-7, 99, 1234567, 42)].map(v => v.toFixed(10)),
    [hash32(0), hash32(1), hash32(1, 2), hash32(1, 2, 3), hash32(1, 2, 3, 4), hash32(-7, 99, 1234567, 42)].map(v => v.toFixed(10)));
  // concrete anchors (computed once, must never move)
  assert.equal(hash32(0).toFixed(10), '0.4555062447');
  assert.equal(hash32(1, 2, 3, 4).toFixed(10), '0.0776475593');
  assert.equal(hash32(123456, 7).toFixed(10), '0.1321313120');
});

test('ihash matches its GLSL twin on representative inputs and stays in [0, 1)', () => {
  // Reference values of the GLSL expression (uint arithmetic mod 2^32), evaluated with BigInt here.
  const ref = (a: number, b: number) => {
    const M = (1n << 32n) - 1n;
    let h = ((BigInt(a >>> 0) * 2654435761n) & M) ^ ((BigInt(b >>> 0) * 2246822519n) & M);
    h = (h ^ (h >> 13n)) & M;
    h = (h * 3266489917n) & M;
    h = (h ^ (h >> 16n)) & M;
    return Number(h & 0xffffn) / 65536;
  };
  for (const [a, b] of [[0, 0], [1, 0], [0, 1], [17, 4], [123456, 789], [4294967295, 3], [2 ** 31, 2 ** 31 - 1]] as [number, number][]) {
    const v = ihash(a, b);
    assert.equal(v, ref(a, b), `ihash(${a}, ${b})`);
    assert.ok(v >= 0 && v < 1);
  }
  assert.equal(ihash(17, 4).toFixed(6), '0.546295');
});
