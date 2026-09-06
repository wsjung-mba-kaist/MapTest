import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeIO, getBounds, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, unpartition } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { BakeContext } from '../bake.ts';
import { log } from './log.ts';
import { EIFFEL_3DMR_URL, EIFFEL_OSM_WAY_ID, EIFFEL_SOURCE_GLB, MODELS_DIR } from '../config.ts';
import { cachedBytes, ensureDir, exists, writeJson } from './http.ts';
import { loadTheme } from './overpass.ts';
import { frame } from '../../shared/geo.ts';
import { openRing, type Pt, type Ring } from './polygons.ts';

const LEG_SPREAD = 124.9;   // metres between opposite pillar outer edges
const TARGET_TRIS = 600_000;

function convexHull(pts: Pt[]): Ring {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = []; for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: Pt[] = []; for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Minimum-area bounding rectangle: returns edge angle (rad, in the x/z plane) and side lengths. */
function minAreaRect(ring: Ring): { angle: number; w: number; h: number; cx: number; cz: number } {
  const hull = convexHull(openRing(ring));
  let best = { angle: 0, w: Infinity, h: Infinity, cx: 0, cz: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of hull) { const x = p[0] * c - p[1] * s, z = p[0] * s + p[1] * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    if ((x1 - x0) * (z1 - z0) < best.w * best.h) {
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      const cc = Math.cos(ang), ss = Math.sin(ang);
      best = { angle: ang, w: x1 - x0, h: z1 - z0, cx: mx * cc - mz * ss, cz: mx * ss + mz * cc };
    }
  }
  return best;
}

function countTris(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices(); n += (idx ? idx.getCount() : prim.getAttribute('POSITION')?.getCount() ?? 0) / 3;
  }
  return n;
}

export async function run(ctx: BakeContext) {
  await ensureDir(MODELS_DIR);
  const out = path.join(MODELS_DIR, 'eiffel.glb');
  const metaOut = path.join(MODELS_DIR, 'eiffel.json');
  if (!ctx.force && await exists(out) && await exists(metaOut)) { log.info('eiffel: cached'); return; }

  // Footprint orientation from OSM.
  let rect = { angle: 0, w: LEG_SPREAD, h: LEG_SPREAD, cx: 0, cz: 0 };
  try {
    const fc = await loadTheme('buildings');
    const f = fc.features.find(f => f.properties.type === 'way' && f.properties.id === EIFFEL_OSM_WAY_ID);
    if (f && f.geometry.type === 'Polygon') {
      const ring: Ring = f.geometry.coordinates[0].map(([lon, lat]) => { const w = frame.toWorld(lon, lat); return [w.x, w.z]; });
      rect = minAreaRect(ring);
      log.info(`eiffel: footprint rect ${rect.w.toFixed(1)} x ${rect.h.toFixed(1)} m, angle ${(rect.angle * 180 / Math.PI).toFixed(2)}°, centre ${rect.cx.toFixed(1)},${rect.cz.toFixed(1)}`);
    }
  } catch { log.warn('eiffel: footprint unavailable, assuming axis-aligned at origin'); }

  // A user-supplied scan (any other .glb in public/models) takes precedence over the CC0 3DMR model.
  // Source priority: EIFFEL_SOURCE env / config (the chosen glb) > any other supplied .glb > the CC0 3DMR model.
  const preferred = process.env.EIFFEL_SOURCE ?? EIFFEL_SOURCE_GLB;
  const others = (await fs.readdir(MODELS_DIR)).filter(f => f.endsWith('.glb') && f !== 'eiffel.glb' && f !== preferred).sort((a, b) => (a.startsWith('eiffel_src') ? -1 : 0) - (b.startsWith('eiffel_src') ? -1 : 0));
  const candidates = (await exists(path.join(MODELS_DIR, preferred))) ? [preferred, ...others] : others;
  if (candidates.length) {
    const src = path.join(MODELS_DIR, candidates[0]);
    log.info(`eiffel: using supplied model ${candidates[0]}`);
    const { processScan } = await import('./eiffel_scan.ts');
    const textureSize = Number(process.env.EIFFEL_TEXTURE ?? 4096);
    await processScan(src, { angleFootprint: rect.angle, cx: rect.cx, cz: rect.cz }, out, metaOut, textureSize);
    return;
  }

  const glb = await cachedBytes(EIFFEL_3DMR_URL, 'models/3dmr_eiffel_4.glb', { timeoutMs: 300_000 });
  log.info(`eiffel: 3DMR model ${(glb.length / 1e6).toFixed(1)} MB`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(new Uint8Array(glb));
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  let { min, max } = getBounds(scene);
  log.info(`eiffel: raw bounds min ${min.map(v => v.toFixed(1))} max ${max.map(v => v.toFixed(1))}, ${countTris(doc)} tris`);

  await doc.transform(unpartition(), dedup(), weld(), prune());
  const tris = countTris(doc);
  if (tris > TARGET_TRIS) {
    await MeshoptSimplifier.ready;
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: TARGET_TRIS / tris, error: 0.001 }));
    log.info(`eiffel: simplified ${tris} -> ${countTris(doc)} tris`);
  }

  // Fit: uniform scale so the widest horizontal extent equals the leg spread, base at y = 0, rotate to the footprint.
  ({ min, max } = getBounds(scene));
  const sx = max[0] - min[0], sz = max[2] - min[2], sy = max[1] - min[1];
  const widest = Math.max(sx, sz);
  const scale = LEG_SPREAD / widest;
  const height = sy * scale;
  log.info(`eiffel: model extents ${sx.toFixed(1)} x ${sy.toFixed(1)} x ${sz.toFixed(1)} -> scale ${scale.toFixed(4)}, height ${height.toFixed(1)} m`);
  if (height < 250 || height > 360) log.warn('eiffel: height after fit looks wrong; check the model orientation');

  // Wrap scene roots in a fitted parent node. World frame: x east, z south; model assumed z-forward/y-up.
  const root = doc.createNode('eiffel_fit');
  for (const child of scene.listChildren()) { scene.removeChild(child); root.addChild(child); }
  scene.addChild(root);
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  // Rotate the model's axis-aligned square onto the footprint rectangle. A +Y rotation by θ turns +x toward -z,
  // while the footprint angle is measured from +x toward +z, hence the sign flip.
  const yaw = -rect.angle;
  const c = Math.cos(yaw / 2), s = Math.sin(yaw / 2);
  // Translate model centre to origin (applied before rotation via a child node), then rotate+scale on the parent.
  const inner = doc.createNode('eiffel_center');
  for (const child of root.listChildren()) { root.removeChild(child); inner.addChild(child); }
  inner.setTranslation([-cx, -min[1], -cz]);
  root.addChild(inner);
  root.setScale([scale, scale, scale]);
  root.setRotation([0, s, 0, c]);   // quaternion about +Y (note: three.js rotation.y = -yaw for our z-south frame)
  root.setTranslation([rect.cx, 0, rect.cz]);

  const bin = await io.writeBinary(doc);
  await fs.writeFile(out, bin);
  await writeJson(metaOut, { source: EIFFEL_3DMR_URL, license: 'CC0', scale, yawRad: yaw, height, legSpread: LEG_SPREAD, centre: [rect.cx, rect.cz], tris: countTris(doc) });
  log.info(`eiffel: wrote ${(bin.byteLength / 1e6).toFixed(1)} MB -> public/models/eiffel.glb`);
}
