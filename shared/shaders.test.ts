import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { litProbabilityGlsl, LIT_ANCHORS, litProbability } from './nightlife.ts';
import { STYLE_SCALE, Style, SurfaceFlag, packStyleSeed, unpackSeed, unpackStyle } from './layout.ts';

const facade = readFileSync(new URL('../src/materials/shaders/facade.glsl', import.meta.url), 'utf8');
const facadeMat = readFileSync(new URL('../src/materials/FacadeMaterial.ts', import.meta.url), 'utf8');

/**
 * The shader cannot import shared/layout.ts, so FacadeMaterial prepends `#define`s and a generated function.
 * These tests read the GLSL sources and fail when a literal creeps back in — the old test re-implemented the shader's
 * arithmetic in TypeScript and could not notice an edit to the .glsl file at all.
 */
test('facade.glsl decodes meta.w and the surface flags only through the shared defines', () => {
  assert.doesNotMatch(facade, /256\.0/, 'STYLE_SCALE literal in facade.glsl');
  assert.doesNotMatch(facade, /style == \d/, 'style id literal in facade.glsl');
  assert.doesNotMatch(facade, /flag [<>] \d/, 'SurfaceFlag literal in facade.glsl');
  assert.match(facade, /mod\(meta\.w, STYLE_SCALE\)/);
  assert.match(facade, /floor\(meta\.w \/ STYLE_SCALE\)/);
  assert.doesNotMatch(facade, /float hs\[/, 'LIT_ANCHORS transcription in facade.glsl (it is generated now)');
  for (const name of ['STYLE_SCALE', 'STYLE_HAUSSMANN', 'STYLE_MODERN', 'STYLE_STONE', 'STYLE_INDUSTRIAL', 'STYLE_MONUMENT', 'FLAG_PLINTH', 'FLAG_ROOF_CURVED']) {
    assert.match(facadeMat, new RegExp(`#define ${name} `), `FacadeMaterial defines ${name}`);
  }
  // the defines are produced from the enums, so the ids the bake writes are the ones the shader compares against
  assert.match(facadeMat, /#define STYLE_MONUMENT \$\{Style\.Monument\.toFixed\(1\)\}/);
  assert.match(facadeMat, /#define FLAG_PLINTH \$\{SurfaceFlag\.Plinth\.toFixed\(1\)\}/);
  assert.equal(Style.Monument, 4); assert.equal(SurfaceFlag.Plinth, 3); assert.equal(SurfaceFlag.RoofCurved, 5); assert.equal(STYLE_SCALE, 256);
});

test('no runtime shader carries a transcribed LIT_ANCHORS table', () => {
  for (const f of ['../src/world/RoofDetails.ts', '../src/world/FarRing.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /float hs\[\d+\] = float\[/, `${f} transcribes LIT_ANCHORS`);
    assert.match(src, /litProbabilityGlsl\(/, `${f} uses the generated table`);
  }
});

test('the generated GLSL table is the TS table', () => {
  const glsl = litProbabilityGlsl('litProbability');
  assert.match(glsl, /^float litProbability\(float h\)/);
  const hs = /float hs\[(\d+)\] = float\[\d+\]\(([^)]*)\)/.exec(glsl)!, ps = /float ps\[(\d+)\] = float\[\d+\]\(([^)]*)\)/.exec(glsl)!;
  assert.equal(Number(hs[1]), LIT_ANCHORS.length);
  assert.deepEqual(hs[2].split(',').map(Number), LIT_ANCHORS.map(a => a[0]));
  assert.deepEqual(ps[2].split(',').map(Number), LIT_ANCHORS.map(a => a[1]));
  // same interpolation as litProbability (checked at the anchors and between them)
  const evalGlsl = (h: number) => { const H = LIT_ANCHORS.map(a => a[0]), P = LIT_ANCHORS.map(a => a[1]); h = ((h % 24) + 24) % 24; for (let i = 0; i + 1 < H.length; i++) if (h >= H[i] && h <= H[i + 1]) return P[i] + (P[i + 1] - P[i]) * (h - H[i]) / Math.max(H[i + 1] - H[i], 1e-3); return P[0]; };
  for (const h of [0, 3.5, 8, 12.25, 17, 19.5, 21, 23.9]) assert.ok(Math.abs(evalGlsl(h) - litProbability(h)) < 1e-9, `hour ${h}`);
  const scaled = litProbabilityGlsl('dormerLitP', 0.6);
  assert.match(scaled, /float dormerLitP\(float h\)/); assert.match(scaled, /return 0\.600 \* mix/);
});

test('style/seed packing survives float32 and never rounds the quotient', () => {
  for (const style of [Style.Haussmann, Style.Modern, Style.Stone, Style.Industrial, Style.Monument]) {
    for (const seed of [0, 1, 127, 128, 200, 255]) {
      const w = Math.fround(packStyleSeed(style, seed));
      assert.equal(unpackStyle(w), style); assert.equal(unpackSeed(w), seed);
      // the GLSL does floor(w / STYLE_SCALE) and mod(w, STYLE_SCALE): identical by construction
      assert.equal(Math.floor(w / STYLE_SCALE), style); assert.equal(w % STYLE_SCALE, seed);
    }
  }
});
