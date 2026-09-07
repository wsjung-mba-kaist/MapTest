import * as THREE from 'three';
import { REFLECT_LAYER } from '../render/WaterReflection';
import { DATA_URL, loadBinMesh } from './DataLoader';
import { createRoofTopMaterial, createWallMaterial } from '../materials/FacadeMaterial';
import { chunkIndexOf, chunkKey, chunkOrigin } from '../../shared/layout';

/** Bridge decks (ortho-projected per chunk, so they get the 21 cm tile like the terrain), stone sides/piers and parapets. */
export class Bridges {
  readonly group = new THREE.Group();
  parapet?: THREE.Mesh;
  stone?: THREE.Mesh;
  readonly decks = new Map<string, { mesh: THREE.Mesh; mat: ReturnType<typeof createRoofTopMaterial> }>();
  readonly stoneMaterial = createWallMaterial();
  count = 0;

  constructor() { this.group.name = 'bridges'; }

  async load() {
    const bm = await loadBinMesh(`${DATA_URL}/bridges.bin`);
    this.count = (bm.header.meta?.count as number) ?? 0;
    const mk = (name: string, mat: THREE.Material, geom?: THREE.BufferGeometry) => {
      const g = geom ?? bm.sections.get(name)?.geometry;
      if (!g) return undefined;
      const m = new THREE.Mesh(g, mat);
      m.layers.enable(REFLECT_LAYER);
      m.name = `bridge_${name}`;
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    const deck = bm.sections.get('deck');
    if (deck) for (const [key, geom] of splitByChunk(deck.geometry)) {
      const [i, j] = key.split('_').map(Number);
      const o = chunkOrigin(i, j);
      const mat = createRoofTopMaterial({ x: o.x, z: o.z }, null, null);
      const mesh = mk(`deck_${key}`, mat, geom)!;
      this.decks.set(key, { mesh, mat });
    }
    this.stone = mk('stone', this.stoneMaterial);
    this.parapet = mk('parapet', this.stoneMaterial);
  }

  setOverview(tex: THREE.Texture | null) { for (const d of this.decks.values()) d.mat.setOverview(tex); }
  setTile(i: number, j: number, tex: THREE.Texture | null) { this.decks.get(chunkKey(i, j))?.mat.setTile(tex); }
  /** Bind the tiles that streamed in before the bridges loaded. */
  primeTiles(textureOf: (i: number, j: number) => THREE.Texture | null) {
    for (const key of this.decks.keys()) { const [i, j] = key.split('_').map(Number); const t = textureOf(i, j); if (t) this.setTile(i, j, t); }
  }
}

/** Split a (possibly indexed) triangle geometry into one non-indexed geometry per chunk of the triangle centroid. */
function splitByChunk(src: THREE.BufferGeometry): Map<string, THREE.BufferGeometry> {
  const g = src.index ? src.toNonIndexed() : src;
  const names = Object.keys(g.attributes);
  const pos = g.attributes.position;
  const buckets = new Map<string, number[]>();
  for (let t = 0; t < pos.count / 3; t++) {
    const x = (pos.getX(t * 3) + pos.getX(t * 3 + 1) + pos.getX(t * 3 + 2)) / 3, z = (pos.getZ(t * 3) + pos.getZ(t * 3 + 1) + pos.getZ(t * 3 + 2)) / 3;
    const c = chunkIndexOf(x, z);
    const key = chunkKey(c.i, c.j);
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(t);
  }
  const out = new Map<string, THREE.BufferGeometry>();
  for (const [key, tris] of buckets) {
    const geom = new THREE.BufferGeometry();
    for (const name of names) {
      const a = g.attributes[name] as THREE.BufferAttribute;
      const n = a.itemSize;
      const arr = new (a.array.constructor as new (len: number) => typeof a.array)(tris.length * 3 * n);
      tris.forEach((t, k) => { for (let v = 0; v < 3; v++) for (let c = 0; c < n; c++) (arr as unknown as number[])[(k * 3 + v) * n + c] = (a.array as unknown as number[])[(t * 3 + v) * n + c]; });
      geom.setAttribute(name, new THREE.BufferAttribute(arr, n, a.normalized));
    }
    out.set(key, geom);
  }
  return out;
}
