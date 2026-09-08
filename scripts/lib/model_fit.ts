import fs from 'node:fs/promises';
import sharp from 'sharp';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { clearNodeTransform, dedup, dequantize, flatten, join, meshopt, prune, quantize, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { log } from './log.ts';
import { writeJson } from './http.ts';
import type { LandmarkModel } from '../landmarks_models.ts';
import type { MinRect } from './polygons.ts';

/**
 * Fit an arbitrary landmark glTF onto its OSM footprint (the general case of eiffel_scan.ts, whose tower-specific
 * heuristics stay there): bake node transforms, find the base level and the horizontal centre from the geometry,
 * scale by the footprint rectangle / a known height / an explicit factor, rotate by the footprint angle, crop stray
 * geometry outside a radius, then compress (quantize + meshopt, textures to JPEG). Also writes a coarse LOD.
 */
export interface FitInput { rect: MinRect; centre: [number, number]; radius: number }
export interface ModelResult { tris: number; height: number; scale: number; yawDeg: number; top: number; textured: boolean; author?: string; license?: string; source?: string; title?: string; centre: [number, number]; radius: number; kind: 'model' | 'scan' }

const percentile = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export async function processModel(src: string, entry: LandmarkModel, fit: FitInput, out: string, lodOut: string, metaOut: string): Promise<ModelResult> {
  await MeshoptEncoder.ready; await MeshoptDecoder.ready; await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(new Uint8Array(await fs.readFile(src)));
  const root = doc.getRoot();
  const clean = entry.crop?.clean ?? root.listTextures().length === 0;
  const extras = (root.getAsset().extras ?? {}) as Record<string, string>;
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  // ---- 1. bake transforms, flatten under one node
  //
  // This used to walk the nodes by hand and skip any POSITION accessor whose (name, count, mesh name) triple had
  // been seen before. Unnamed accessors of equal length collide under that key, so parts of a model silently kept
  // their parent transform while the node that carried it was reset to identity — the Liberty scan came out with
  // its arm floating beside the figure and its crown scattered into fragments. glTF-Transform's own `flatten`
  // does this correctly, cloning a mesh that several nodes share before baking each node's transform into it.
  await doc.transform(dequantize(), flatten());
  const holder = doc.createNode(`${entry.id}_model`);
  const meshNodes = root.listNodes().filter(n => n.getMesh());
  for (const node of meshNodes) {
    clearNodeTransform(node);
    const parent = node.getParentNode();
    if (parent) parent.removeChild(node); else scene.removeChild(node);
    holder.addChild(node);
  }
  for (const child of scene.listChildren()) scene.removeChild(child);
  scene.addChild(holder);

  // ---- 2. statistics: base level, centre, horizontal extents
  const { min, max } = getBounds(holder);
  const samples: number[][] = [];
  for (const node of meshNodes) for (const prim of node.getMesh()!.listPrimitives()) {
    const arr = prim.getAttribute('POSITION')!.getArray() as Float32Array;
    const step = Math.max(1, Math.floor(arr.length / 3 / 20000)) * 3;
    for (let i = 0; i < arr.length; i += step) samples.push([arr[i], arr[i + 1], arr[i + 2]]);
  }
  const y0 = percentile(samples.map(p => p[1]), clean ? 0.003 : 0.03);
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const sx = max[0] - min[0], sz = max[2] - min[2], sy = max[1] - y0;

  // ---- 3. scale and yaw
  let scale: number, yaw: number;
  const f = entry.fit;
  if (f.kind === 'height') { scale = f.height / sy; yaw = (f.yawDeg * Math.PI) / 180; }
  else if (f.kind === 'scale') { scale = f.scale; yaw = (f.yawDeg * Math.PI) / 180; }
  else {
    // footprint-rect: the model's horizontal box onto the footprint's minimum-area rectangle. The model's long side
    // goes along the rect's long side (axis 'long', default); a 180° ambiguity remains, resolved by yawDeg.
    const rectLong = Math.max(fit.rect.w, fit.rect.h), rectShort = Math.min(fit.rect.w, fit.rect.h);
    const modelLong = Math.max(sx, sz), modelShort = Math.min(sx, sz);
    scale = (rectLong / modelLong + rectShort / Math.max(1e-6, modelShort)) / 2;
    const wAlongX = fit.rect.w >= fit.rect.h;             // rect long side runs along its angle
    const modelLongAlongX = sx >= sz;
    const angleLong = wAlongX ? fit.rect.angle : fit.rect.angle + Math.PI / 2;
    // +Y rotation by θ turns +x toward -z; the footprint angle is measured from +x toward +z
    yaw = -(angleLong - (modelLongAlongX ? 0 : Math.PI / 2));
    if ((f.kind === 'footprint-rect' && f.axis === 'short')) yaw += Math.PI / 2;
    if (f.kind === 'footprint-rect' && f.yawDeg != null) yaw += (f.yawDeg * Math.PI) / 180;
    else log.warn(`models: ${entry.id}: footprint fit leaves a 180° ambiguity; set fit.yawDeg (0 or 180) after checking in the app`);
    log.info(`models: ${entry.id}: model ${modelLong.toFixed(1)} x ${modelShort.toFixed(1)} -> rect ${rectLong.toFixed(1)} x ${rectShort.toFixed(1)} m, scale ${scale.toFixed(3)}`);
  }
  const height = sy * scale;

  // ---- 4. crop: everything outside the footprint radius (+ margin) or below the base is scan garbage
  const keepR = (entry.crop?.radius ?? fit.radius * 1.15 + 5) / scale;
  const dropBelow = (entry.crop?.dropBelowM ?? 1.5) / scale;
  let kept = 0, dropped = 0;
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  for (const node of meshNodes) {
    const mesh = node.getMesh()!;
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION')!.getArray() as Float32Array;
      const I = prim.getIndices()?.getArray() as ArrayLike<number> | undefined;
      const triCount = (I ? I.length : P.length / 3) / 3;
      const keptIdx: number[] = [];
      for (let t = 0; t < triCount; t++) {
        const a = I ? I[t * 3] : t * 3, b = I ? I[t * 3 + 1] : t * 3 + 1, c = I ? I[t * 3 + 2] : t * 3 + 2;
        const x = (P[a * 3] + P[b * 3] + P[c * 3]) / 3 - cx, y = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3 - y0, z = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3 - cz;
        if (y < -dropBelow || Math.hypot(x, z) > keepR) { dropped++; continue; }
        keptIdx.push(a, b, c); kept++;
      }
      if (!keptIdx.length) { prim.dispose(); continue; }
      if (keptIdx.length === triCount * 3) continue;
      const remap = new Map<number, number>(); const order: number[] = [];
      for (const v of keptIdx) if (!remap.has(v)) { remap.set(v, order.length); order.push(v); }
      for (const sem of prim.listSemantics()) {
        const acc = prim.getAttribute(sem)!;
        const srcArr = acc.getArray()!; const n = acc.getElementSize();
        const Ctor = srcArr.constructor as new (len: number) => typeof srcArr;
        const dst = new Ctor(order.length * n);
        for (let i = 0; i < order.length; i++) for (let k = 0; k < n; k++) (dst as unknown as number[])[i * n + k] = (srcArr as unknown as number[])[order[i] * n + k];
        prim.setAttribute(sem, doc.createAccessor(acc.getName()).setType(acc.getType()).setArray(dst).setBuffer(buffer).setNormalized(acc.getNormalized()));
      }
      const newIdx = new Uint32Array(keptIdx.length);
      for (let i = 0; i < keptIdx.length; i++) newIdx[i] = remap.get(keptIdx[i])!;
      prim.setIndices(doc.createAccessor('idx').setType('SCALAR').setArray(newIdx).setBuffer(buffer));
    }
    if (!mesh.listPrimitives().length) mesh.dispose();
  }
  log.info(`models: ${entry.id}: kept ${kept} tris, dropped ${dropped}; height ${height.toFixed(1)} m`);

  // ---- 5. place: centre on the footprint, base at y = 0 (the runtime lifts it to the terrain)
  const inner = doc.createNode(`${entry.id}_center`).setTranslation([-cx, -y0, -cz]);
  for (const child of holder.listChildren()) { holder.removeChild(child); inner.addChild(child); }
  holder.addChild(inner);
  holder.setScale([scale, scale, scale]);
  holder.setRotation([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
  holder.setTranslation([fit.centre[0], 0, fit.centre[1]]);

  // ---- 6. compress and write; the LOD is the same document decimated hard with 1K textures
  await doc.transform(prune({ keepLeaves: false }), dedup(), weld());
  if (clean) await doc.transform(join({ keepNamed: false, keepMeshes: false }), prune({ keepLeaves: false }));
  const target = entry.targetTris ?? 600_000;
  let tris = countTris(doc);
  if (tris > target) { await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: target / tris, error: 0.001 })); tris = countTris(doc); }
  const textured = root.listTextures().length > 0;
  if (textured) await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'jpeg', quality: 84, resize: [entry.textureSize ?? 4096, entry.textureSize ?? 4096] }));
  await doc.transform(quantize({ quantizePosition: 14, quantizeTexcoord: 12, quantizeNormal: 8 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await fs.writeFile(out, await io.writeBinary(doc));
  // the LOD continues from the written full model: decimated hard, textures down to 1K
  const lod = await io.readBinary(new Uint8Array(await fs.readFile(out)));
  await lod.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.08, error: 0.01 }));
  if (textured) await lod.transform(textureCompress({ encoder: sharp, targetFormat: 'jpeg', quality: 75, resize: [1024, 1024] }));
  await lod.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await fs.writeFile(lodOut, await io.writeBinary(lod));

  const result: ModelResult = {
    tris, height, scale, yawDeg: (yaw * 180) / Math.PI, top: height, textured, kind: clean ? 'model' : 'scan',
    author: extras.author ?? entry.credits.author, license: extras.license ?? entry.credits.license, source: extras.source ?? entry.credits.url, title: extras.title ?? entry.credits.title,
    centre: fit.centre, radius: fit.radius,
  };
  await writeJson(metaOut, { ...result, id: entry.id, src, credits: entry.credits, runtime: entry.runtime ?? {}, lod: `${entry.id}_lod.glb` });
  return result;
}

function countTris(doc: import('@gltf-transform/core').Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices(); n += (idx ? idx.getCount() : prim.getAttribute('POSITION')?.getCount() ?? 0) / 3;
  }
  return n;
}
