import fs from 'node:fs/promises';
import sharp from 'sharp';
import { NodeIO, type Accessor, type Node, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, join, meshopt, prune, quantize, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { log } from './log.ts';
import { writeJson } from './http.ts';

/**
 * Turn a photogrammetry scan of the tower (e.g. Sketchfab "Eiffel Tower, Paris, France" by Brian Trepanier, CC-BY 4.0)
 * into a fitted hero asset:
 *   1. bake node transforms into vertices,
 *   2. locate the tower axis, base level and scale from the geometry itself,
 *   3. crop away the surrounding ground/buildings (we render our own city),
 *   4. rotate so the scanned Seine side faces the real Seine, place on the OSM footprint,
 *   5. shrink the texture to 4K and compress the mesh (quantization + meshopt).
 */

export interface ScanFit { angleFootprint: number; cx: number; cz: number }
export interface ScanResult { tris: number; height: number; scale: number; yawDeg: number; top: number; textured: boolean; author?: string; license?: string; source?: string; title?: string }

const LEG_CORNER_RADIUS = 88.0;   // metres from the axis to a pillar's outer corner
const TOWER_HEIGHT = 330.0;       // metres to the antenna tip
const SEINE_DIR = [-481.3, -421.1]; // world xz direction from the tower to the Trocadéro / Seine side

function worldTransform(node: Node) {
  const M = node.getWorldMatrix();
  const mulP = (v: number[]) => [M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12], M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13], M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14]];
  const mulN = (v: number[]) => { const n = [M[0] * v[0] + M[4] * v[1] + M[8] * v[2], M[1] * v[0] + M[5] * v[1] + M[9] * v[2], M[2] * v[0] + M[6] * v[1] + M[10] * v[2]]; const l = Math.hypot(...n) || 1; return [n[0] / l, n[1] / l, n[2] / l]; };
  return { mulP, mulN };
}

function percentile(a: number[], p: number) { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

export async function processScan(src: string, fit: ScanFit, out: string, metaOut: string, textureSize = 4096, opts: { clean?: boolean } = {}): Promise<ScanResult> {
  await MeshoptEncoder.ready; await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(new Uint8Array(await fs.readFile(src)));
  const root = doc.getRoot();
  // Untextured CAD-style models carry no ground/neighbourhood garbage: only the radius/height crop applies.
  const clean = opts.clean ?? root.listTextures().length === 0;
  const extras = (root.getAsset().extras ?? {}) as Record<string, string>;
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  // ---- 1. bake transforms, flatten the hierarchy under one node
  const holder = doc.createNode('eiffel_scan');
  const meshNodes = root.listNodes().filter(n => n.getMesh());
  const seen = new Set<string>();
  for (const node of meshNodes) {
    const mesh = node.getMesh()!;
    const { mulP, mulN } = worldTransform(node);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!;
      if (seen.has(pos.getName() + pos.getCount() + mesh.getName())) continue; // shared accessor guard
      seen.add(pos.getName() + pos.getCount() + mesh.getName());
      const arr = pos.getArray() as Float32Array;
      const v = [0, 0, 0];
      for (let i = 0; i < arr.length; i += 3) { v[0] = arr[i]; v[1] = arr[i + 1]; v[2] = arr[i + 2]; const w = mulP(v); arr[i] = w[0]; arr[i + 1] = w[1]; arr[i + 2] = w[2]; }
      const nrm = prim.getAttribute('NORMAL');
      if (nrm) { const na = nrm.getArray() as Float32Array; for (let i = 0; i < na.length; i += 3) { v[0] = na[i]; v[1] = na[i + 1]; v[2] = na[i + 2]; const w = mulN(v); na[i] = w[0]; na[i + 1] = w[1]; na[i + 2] = w[2]; } }
    }
  }
  for (const node of meshNodes) {
    const parent = node.getParentNode();
    if (parent) parent.removeChild(node); else scene.removeChild(node);
    node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    holder.addChild(node);
  }
  for (const child of scene.listChildren()) scene.removeChild(child);
  scene.addChild(holder);

  // ---- 2. statistics in scan space
  const samples: number[][] = [];
  let ymin = Infinity, ymax = -Infinity;
  for (const node of meshNodes) for (const prim of node.getMesh()!.listPrimitives()) {
    const arr = prim.getAttribute('POSITION')!.getArray() as Float32Array;
    const step = Math.max(1, Math.floor(arr.length / 3 / 8000)) * 3;
    for (let i = 0; i < arr.length; i += step) { samples.push([arr[i], arr[i + 1], arr[i + 2]]); ymin = Math.min(ymin, arr[i + 1]); ymax = Math.max(ymax, arr[i + 1]); }
  }
  const H0 = ymax - ymin;
  const upper = samples.filter(p => (p[1] - ymin) / H0 > 0.3);
  const cx = upper.reduce((s, p) => s + p[0], 0) / upper.length, cz = upper.reduce((s, p) => s + p[2], 0) / upper.length;
  const near = samples.filter(p => Math.hypot(p[0] - cx, p[2] - cz) < 0.35 * H0);
  const y0 = percentile(near.map(p => p[1]), clean ? 0.005 : 0.04); // plaza level under the tower (a clean model's lowest vertices are its footings)
  const s0 = TOWER_HEIGHT / (ymax - y0);                           // scale if the antenna tip is present
  const legBand = samples.filter(p => { const h = (p[1] - y0) * s0; return h > 1.5 && h < 6 && Math.hypot(p[0] - cx, p[2] - cz) * s0 < 120; });
  const r99 = percentile(legBand.map(p => Math.hypot(p[0] - cx, p[2] - cz)), 0.985);
  const sLegs = LEG_CORNER_RADIUS / r99;
  const scale = Math.abs(sLegs / s0 - 1) < 0.2 ? sLegs : s0;
  log.info(`eiffel-scan: axis (${cx.toFixed(3)}, ${cz.toFixed(3)}), base y ${y0.toFixed(3)}, top ${ymax.toFixed(3)}; scale from height ${s0.toFixed(2)} m/unit, from legs ${sLegs.toFixed(2)} m/unit -> using ${scale.toFixed(2)}`);

  // Seine side: the lowest samples (river surface) tell us which way the scan faces.
  const low = samples.filter(p => (p[1] - y0) * scale < -4);
  let yaw: number;
  const footprintAngles = [0, 1, 2, 3].map(k => -(fit.angleFootprint + (k * Math.PI) / 2));
  if (low.length > 50) {
    const mx = low.reduce((s, p) => s + p[0], 0) / low.length, mz = low.reduce((s, p) => s + p[2], 0) / low.length;
    const phiModel = Math.atan2(mz - cz, mx - cx), phiWorld = Math.atan2(SEINE_DIR[1], SEINE_DIR[0]);
    const theta = phiModel - phiWorld; // rotation about +Y (which turns +x toward -z) that maps the scan's river direction onto the real one
    const norm = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    let best = footprintAngles[0], bestD = Infinity;
    for (const a of footprintAngles) { const d = Math.abs(norm(a - theta)); if (d < bestD) { bestD = d; best = a; } }
    yaw = bestD < (15 * Math.PI) / 180 ? best : theta;
    log.info(`eiffel-scan: river side at ${(phiModel * 180 / Math.PI).toFixed(1)}° in scan space -> yaw ${(theta * 180 / Math.PI).toFixed(1)}°, snapped to footprint ${bestD < 15 * Math.PI / 180 ? 'yes' : 'NO (kept scan yaw)'} (${(yaw * 180 / Math.PI).toFixed(1)}°)`);
  } else {
    yaw = footprintAngles[0];
    log.warn('eiffel-scan: no river samples found; using footprint angle only (orientation may be off by 90° steps)');
  }

  // ---- 3. crop: keep the tower, drop ground and neighbourhood
  let keptTris = 0, droppedTris = 0;
  // Clean models only need the stray objects far outside the tower removed; scans get the tight envelope.
  const radiusKeep = (hm: number) => (clean ? (hm < 62 ? 100 : hm < 120 ? 60 : 40) : (hm < 12 ? 92 : hm < 62 ? 82 : hm < 120 ? 55 : 30)) / scale;
  // Pillar bases in scan space (the scan's square is axis-aligned): 64 m from the axis along +-x / +-z.
  const pillars = [[cx + 64 / scale, cz], [cx - 64 / scale, cz], [cx, cz + 64 / scale], [cx, cz - 64 / scale]];
  const nearPillar = (x: number, z: number, m: number) => pillars.some(p => Math.hypot(x - p[0], z - p[1]) * scale < m);
  const maxEdge = 30 / scale;
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  for (const node of meshNodes) {
    const mesh = node.getMesh()!;
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION')!;
      const P = posAcc.getArray() as Float32Array;
      const idxAcc = prim.getIndices();
      const I = idxAcc ? (idxAcc.getArray() as ArrayLike<number>) : null;
      const triCount = (I ? I.length : P.length / 3) / 3;
      const kept: number[] = [];
      for (let t = 0; t < triCount; t++) {
        const a = I ? I[t * 3] : t * 3, b = I ? I[t * 3 + 1] : t * 3 + 1, c = I ? I[t * 3 + 2] : t * 3 + 2;
        const x = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, y = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3, z = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
        const hm = (y - y0) * scale;
        const r = Math.hypot(x - cx, z - cz);
        if (hm < -1.5 || r > radiusKeep(hm)) { droppedTris++; continue; }
        if (clean) { kept.push(a, b, c); keptTris++; continue; }
        // Scan garbage: over-long triangles spanning to distant vertices.
        const e1 = Math.hypot(P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]);
        const e2 = Math.hypot(P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]);
        if (e1 > maxEdge || e2 > maxEdge) { droppedTris++; continue; }
        // Ground and low clutter (kiosks, trees, glass wall) survive only right at the pillar bases.
        if (hm < 4.0 && !nearPillar(x, z, 14.5)) { droppedTris++; continue; }
        if (hm < 3.0) {
          // ground-like triangle: mostly horizontal
          const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
          const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const l = Math.hypot(nx, ny, nz) || 1;
          if (Math.abs(ny / l) > 0.6) { droppedTris++; continue; }
        }
        kept.push(a, b, c); keptTris++;
      }
      if (!kept.length) { prim.dispose(); continue; }
      // Compact vertices used by the kept triangles.
      const remap = new Map<number, number>();
      const order: number[] = [];
      for (const v of kept) if (!remap.has(v)) { remap.set(v, order.length); order.push(v); }
      for (const sem of prim.listSemantics()) {
        const acc = prim.getAttribute(sem)!;
        const src = acc.getArray()!; const n = acc.getElementSize();
        const Ctor = src.constructor as new (len: number) => typeof src;
        const dst = new Ctor(order.length * n);
        for (let i = 0; i < order.length; i++) for (let k = 0; k < n; k++) (dst as unknown as number[])[i * n + k] = (src as unknown as number[])[order[i] * n + k];
        const na = doc.createAccessor(acc.getName()).setType(acc.getType()).setArray(dst).setBuffer(buffer).setNormalized(acc.getNormalized());
        prim.setAttribute(sem, na);
      }
      const newIdx = new Uint32Array(kept.length);
      for (let i = 0; i < kept.length; i++) newIdx[i] = remap.get(kept[i])!;
      prim.setIndices(doc.createAccessor('idx').setType('SCALAR').setArray(newIdx).setBuffer(buffer));
    }
    if (!mesh.listPrimitives().length) { mesh.dispose(); }
  }
  log.info(`eiffel-scan: kept ${keptTris} tris, dropped ${droppedTris}`);

  // ---- 4. fit transform
  const inner = doc.createNode('eiffel_center').setTranslation([-cx, -y0, -cz]);
  for (const child of holder.listChildren()) { holder.removeChild(child); inner.addChild(child); }
  holder.addChild(inner);
  holder.setScale([scale, scale, scale]);
  holder.setRotation([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
  holder.setTranslation([fit.cx, 0, fit.cz]);

  // ---- 5. texture + mesh compression
  await doc.transform(prune({ keepLeaves: false }), dedup());
  // CAD exports arrive as dozens of small meshes; one mesh per material means a handful of draw calls and sane sparkle sampling.
  if (clean) await doc.transform(join({ keepNamed: false, keepMeshes: false }), prune({ keepLeaves: false }));
  const textured = root.listTextures().length > 0;
  if (textured) {
    await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'jpeg', quality: 84, resize: [textureSize, textureSize] }));
  }
  await MeshoptEncoder.ready;
  await doc.transform(quantize({ quantizePosition: 14, quantizeTexcoord: 12, quantizeNormal: 8 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));

  const bin = await io.writeBinary(doc);
  await fs.writeFile(out, bin);
  const result: ScanResult = {
    tris: keptTris, height: (ymax - y0) * scale, scale, yawDeg: (yaw * 180) / Math.PI, top: (ymax - y0) * scale, textured,
    author: extras.author, license: extras.license, source: extras.source, title: extras.title,
  };
  await writeJson(metaOut, { ...result, kind: clean ? 'model' : 'scan', src, centre: [fit.cx, fit.cz], textureSize });
  log.info(`eiffel-scan: wrote ${(bin.byteLength / 1e6).toFixed(1)} MB -> ${out} (height ${result.height.toFixed(0)} m, ${textured ? 'textured' : 'untextured'})`);
  return result;
}

void (0 as unknown as Accessor); void (0 as unknown as Primitive);
