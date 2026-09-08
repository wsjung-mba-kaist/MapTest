import { loadBuildings } from './scripts/lib/bdtopo.ts';
import { loadTheme } from './scripts/lib/overpass.ts';
import { buildSpecs } from './scripts/lib/buildings.ts';
import { loadHeightmap } from './scripts/lib/build.ts';
const hm = await loadHeightmap(true);
const { specs } = buildSpecs(await loadTheme('buildings'), await loadBuildings(), hm);
// camera at (-1070.5, 562.9), yaw 69 deg -> dir (sin, -cos)
const cx = -1070.5, cz = 562.9, yaw = 69 * Math.PI / 180;
const dx = Math.sin(yaw), dz = -Math.cos(yaw);
const N = ['Haussmann', 'Modern', 'Stone', 'Industrial', 'Monument'];
const seen = new Set<string>();
const rows: string[] = [];
for (const s of specs) {
  const px = s.centroid[0] - cx, pz = s.centroid[1] - cz;
  const along = px * dx + pz * dz, side = Math.abs(px * dz - pz * dx);
  if (along < 10 || along > 400 || side > 90) continue;
  const k = `${s.id}|${s.centroid.map(v => v.toFixed(0))}`;
  if (seen.has(k)) continue; seen.add(k);
  rows.push(`${along.toFixed(0).padStart(4)} m  side ${side.toFixed(0).padStart(3)}  ${s.id.padEnd(20)} area ${s.area.toFixed(0).padStart(6)} lm ${s.landmark ? 'Y' : 'n'} grp ${(s.group ?? '-').padEnd(20)} ${N[s.style].padEnd(10)} eave ${s.eave.toFixed(1)} ridge ${s.ridge.toFixed(1)} ${(s.name ?? '').slice(0, 30)}`);
}
rows.sort((a, b) => parseFloat(a) - parseFloat(b));
console.log(rows.join('\n'));
