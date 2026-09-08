import fs from 'node:fs';
import { parseBinMesh } from './shared/binmesh.ts';
import { chunkIndexOf, chunkKey, chunkOrigin } from './shared/layout.ts';
import { loadBuildings } from './scripts/lib/bdtopo.ts';
import { loadTheme } from './scripts/lib/overpass.ts';
import { buildSpecs } from './scripts/lib/buildings.ts';
import { loadHeightmap } from './scripts/lib/build.ts';
import { DsmProvider, dsmPartTops } from './scripts/lib/dsmroof.ts';
import { pointInPoly } from './scripts/lib/polygons.ts';

const G = process.argv[2] ?? 'way/83863766';
const hm = await loadHeightmap(true);
const { specs } = buildSpecs(await loadTheme('buildings'), await loadBuildings(), hm);
const dsm = (await DsmProvider.load())!; dsm.noteGroupHeights(specs);
const grp = specs.filter(s => (s.group ?? s.id) === G);
const out = grp.find(s => s.id === G)!;
console.log(`group ${G}: ${grp.length} members, outline area ${out.area.toFixed(0)} plinth ${out.isPlinth} eave ${out.eave.toFixed(1)} ridge ${out.ridge.toFixed(1)} groundY ${out.groundY.toFixed(1)} rings ${out.rings.map(r => r.length).join('/')} groupRidge ${dsm.groupRidge(G)}`);
for (const s of grp.sort((a, b) => b.area - a.area)) {
  const f = s.id === G ? null : dsmPartTops(s, dsm);
  const ys = f ? s.rings.flat().map(f).sort((a, b) => a - b) : [];
  console.log(`  ${s.id.padEnd(20)} area ${s.area.toFixed(0).padStart(5)} minH ${s.minH.toFixed(0)} eave ${s.eave.toFixed(1).padStart(5)} ridge ${s.ridge.toFixed(1).padStart(5)} rings ${s.rings.map(r => r.length).join('/')}` +
    (f ? `  fit ${ys[0].toFixed(1)}..${ys[ys.length - 1].toFixed(1)} p50 ${ys[ys.length >> 1].toFixed(1)}` : s.id === G ? '  <== OUTLINE' : '  (no fit)'));
}
// chunk geometry inside the outline
const { i, j } = chunkIndexOf(out.centroid[0], out.centroid[1]);
const buf = fs.readFileSync(`public/data/chunks/${chunkKey(i, j)}.bin`);
const { arrays } = parseBinMesh(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const o = chunkOrigin(i, j);
console.log(`chunk ${chunkKey(i, j)}`);
for (const name of ['dsm', 'roofs', 'tops']) {
  const S = arrays.get(name); if (!S) { console.log(`  ${name}: absent`); continue; }
  const P = S.attrs.get('position') as Float32Array, I = S.indices;
  let n = 0, steep = 0, area = 0, steepArea = 0;
  for (let t = 0; t < I.length; t += 3) {
    const p = [0, 1, 2].map(q => I[t + q] * 3);
    const A = [P[p[0]] + o.x, P[p[0] + 1], P[p[0] + 2] + o.z], B = [P[p[1]] + o.x, P[p[1] + 1], P[p[1] + 2] + o.z], C = [P[p[2]] + o.x, P[p[2] + 1], P[p[2] + 2] + o.z];
    if (!pointInPoly((A[0] + B[0] + C[0]) / 3, (A[2] + B[2] + C[2]) / 3, out.rings)) continue;
    n++;
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const nv = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const L = Math.hypot(nv[0], nv[1], nv[2]); area += L / 2;
    if (L > 1e-12 && Math.abs(nv[1]) / L < 0.25) { steep++; steepArea += L / 2; }
  }
  console.log(`  ${name.padEnd(6)} ${n} tris inside, ${steep} near-vertical, area ${area.toFixed(0)} m2 (steep ${steepArea.toFixed(0)})`);
}
const W = arrays.get('walls')!, P = W.attrs.get('position') as Float32Array;
let quads = 0, spiky = 0, worst = 0;
for (let q = 0; q * 12 + 11 < P.length; q++) {
  const k = q * 12;
  const ax = P[k] + o.x, az = P[k + 2] + o.z, bx = P[k + 3] + o.x, bz = P[k + 5] + o.z;
  if (!pointInPoly((ax + bx) / 2, (az + bz) / 2, out.rings)) continue;
  quads++;
  const d = Math.abs(P[k + 10] - P[k + 7]);
  if (d > 3) { spiky++; worst = Math.max(worst, d); }
}
console.log(`  walls  ${quads} quads inside, ${spiky} with a top that changes >3 m (worst ${worst.toFixed(1)} m)`);
