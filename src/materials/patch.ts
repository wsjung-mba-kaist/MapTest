/**
 * Guard for the `onBeforeCompile` patches: every material in this project splices GLSL in at three.js `#include`
 * anchors with plain `String.replace`. A three upgrade that renames or drops an anchor makes the replace a silent
 * no-op, and the result is a shader compile error (or a quietly unlit material) far from the cause. Call this at the
 * top of a patch with the anchors it relies on: in development it throws naming the material and the anchor, in
 * production it logs once and lets the material render as best it can.
 */
const reported = new Set<string>();

export function assertAnchors(where: string, vertexShader: string, fragmentShader: string, vertex: readonly string[], fragment: readonly string[]) {
  const missing: string[] = [];
  for (const a of vertex) if (!vertexShader.includes(`#include <${a}>`)) missing.push(`vertex #include <${a}>`);
  for (const a of fragment) if (!fragmentShader.includes(`#include <${a}>`)) missing.push(`fragment #include <${a}>`);
  if (!missing.length) return;
  const msg = `${where}: shader anchor(s) missing from three's template — the patch will not apply: ${missing.join(', ')}`;
  if (import.meta.env.DEV) throw new Error(msg);
  if (!reported.has(where)) { reported.add(where); console.error(msg); }
}

/** WebGL2 guarantees 16 fragment samplers; the ground shader sits at 15 (CLAUDE.md). Count after patching, in dev. */
export function checkSamplerBudget(where: string, fragmentShader: string, limit = 16) {
  if (!import.meta.env.DEV) return;
  let n = 0;
  for (const m of fragmentShader.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?sampler(?:2D|Cube|2DArray|3D|2DShadow)\s+([^;]+);/g)) n += m[1].split(',').length;
  if (n >= limit) console.error(`${where}: ${n} samplers declared (limit ${limit}) — the material will not link on ordinary GPUs`);
  else if (n >= limit - 1) console.warn(`${where}: ${n}/${limit} samplers — no room for another texture`);
}
