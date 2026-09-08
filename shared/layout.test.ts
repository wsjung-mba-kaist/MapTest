import test from 'node:test';
import assert from 'node:assert/strict';
import { FurnitureKind, packStyleSeed, unpackSeed, unpackStyle, STYLE_SCALE } from './layout.ts';

/**
 * meta.w carries the facade style and the per-building seed in one float. A rounding decode (`+ 0.5`) used to
 * promote every building whose seed was >= 128 to the next style, so half the city wore the wrong facade:
 * monuments lost their ashlar and pilasters, and plain stone blocks gained them.
 */
test('style survives every seed, including the upper half that rounding used to promote', () => {
  for (let style = 0; style <= 4; style++) {
    for (let seed = 0; seed < STYLE_SCALE; seed++) {
      const w = packStyleSeed(style, seed);
      assert.equal(unpackStyle(w), style, `style ${style} seed ${seed} decoded as ${unpackStyle(w)}`);
      assert.equal(unpackSeed(w), seed, `seed ${seed} decoded as ${unpackSeed(w)}`);
    }
  }
});

test('the packed value is exact in float32, so the shader reads the same number', () => {
  const buf = new Float32Array(1);
  for (const [style, seed] of [[0, 0], [2, 127], [2, 128], [4, 255]] as const) {
    buf[0] = packStyleSeed(style, seed);
    assert.equal(unpackStyle(buf[0]), style);
    assert.equal(unpackSeed(buf[0]), seed);
  }
});

test('the shader decode matches the TypeScript decode', () => {
  // facade.glsl: style = floor(meta.w / 256.0), seed = mod(meta.w, 256.0)
  const glslStyle = (w: number) => Math.floor(w / 256.0);
  const glslSeed = (w: number) => w % 256.0;
  for (let style = 0; style <= 4; style++) for (const seed of [0, 1, 127, 128, 200, 255]) {
    const w = packStyleSeed(style, seed);
    assert.equal(glslStyle(w), unpackStyle(w));
    assert.equal(glslSeed(w), unpackSeed(w));
  }
});

/**
 * `Car` and `Person` are bases for runs of consecutive kinds (one per model variant), so any single kind placed
 * inside those runs is silently read back as a car or a person. `Statue = 11` did exactly that and 927 parked
 * hatchbacks came back as statues.
 */
test('no single furniture kind falls inside the car or person variant runs', () => {
  const CAR_VARIANTS = 8, PERSON_VARIANTS = 4;
  const carRun = { lo: FurnitureKind.Car, hi: FurnitureKind.Car + CAR_VARIANTS - 1 };
  const personRun = { lo: FurnitureKind.Person, hi: FurnitureKind.Person + PERSON_VARIANTS - 1 };
  assert.ok(carRun.hi < personRun.lo, 'the car run runs into the person run');
  const singles = Object.entries(FurnitureKind)
    .filter(([k, v]) => typeof v === 'number' && k !== 'Car' && k !== 'Person') as [string, number][];
  for (const [name, v] of singles) {
    assert.ok(!(v >= carRun.lo && v <= carRun.hi), `${name} = ${v} sits inside the car variants ${carRun.lo}..${carRun.hi}`);
    assert.ok(!(v >= personRun.lo && v <= personRun.hi), `${name} = ${v} sits inside the person variants ${personRun.lo}..${personRun.hi}`);
  }
  assert.equal(new Set(singles.map(([, v]) => v)).size, singles.length, 'two furniture kinds share a value');
});
