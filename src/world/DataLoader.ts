import * as THREE from 'three';
import { parseBinMesh, type BinMeshHeader } from '../../shared/binmesh';
import { Heightmap } from '../../shared/heightmap';
import type { Manifest } from '../../shared/layout';

export const DATA_URL = '/data';

export async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
export async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

export async function loadManifest(): Promise<Manifest & { chunks?: Record<string, { buildings: number; bytes: number; tris: number }> }> {
  return fetchJson(`${DATA_URL}/manifest.json`);
}

export async function loadHeightmap(): Promise<Heightmap> {
  const [meta, buf] = await Promise.all([
    fetchJson<{ n: number; step: number; origin: number }>(`${DATA_URL}/terrain.json`),
    fetchBuffer(`${DATA_URL}/terrain.bin`),
  ]);
  return Heightmap.fromBuffer(buf, meta);
}

export interface LoadedSection { name: string; geometry: THREE.BufferGeometry; meta?: Record<string, unknown> }
export interface LoadedBinMesh { header: BinMeshHeader; sections: Map<string, LoadedSection> }

/** Turn a PBM1 buffer into BufferGeometries (one per section). Empty sections and the names in `skip` are left out. */
export function binMeshToGeometries(buf: ArrayBuffer, skip?: ReadonlySet<string>): LoadedBinMesh {
  const { header, arrays } = parseBinMesh(buf);
  const sections = new Map<string, LoadedSection>();
  for (const s of header.sections) {
    if (!s.vertexCount || !s.indexCount || skip?.has(s.name)) continue;
    const a = arrays.get(s.name)!;
    const g = new THREE.BufferGeometry();
    for (const spec of s.attrs) {
      const view = a.attrs.get(spec.name)!;
      // Copy so the geometry owns compact buffers (the source buffer holds every section).
      const copy = (view as any).slice() as THREE.TypedArray;
      g.setAttribute(spec.name, new THREE.BufferAttribute(copy, spec.size, !!spec.normalized));
    }
    g.setIndex(new THREE.BufferAttribute(a.indices.slice(), 1));
    // Quads never share vertices, so per-vertex normals are exact flat normals (no derivative noise in the shaders).
    if (!g.attributes.normal) g.computeVertexNormals();
    // Shared-vertex sections (the LiDAR roof caps) can leave a zero normal where opposite faces cancel; normalize(0)
    // is NaN in the lighting and the bloom smears one such pixel over the whole frame. Point those straight up.
    if (s.name === 'dsm') {
      const n = g.attributes.normal as THREE.BufferAttribute;
      const arr = n.array as Float32Array;
      let fixed = 0;
      for (let i = 0; i < arr.length; i += 3) if (arr[i] * arr[i] + arr[i + 1] * arr[i + 1] + arr[i + 2] * arr[i + 2] < 1e-12) { arr[i] = 0; arr[i + 1] = 1; arr[i + 2] = 0; fixed++; }
      if (fixed) n.needsUpdate = true;
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    sections.set(s.name, { name: s.name, geometry: g, meta: s.meta });
  }
  return { header, sections };
}

export async function loadBinMesh(url: string, skip?: ReadonlySet<string>): Promise<LoadedBinMesh> {
  return binMeshToGeometries(await fetchBuffer(url), skip);
}

const texLoader = new THREE.TextureLoader();
export function loadTexture(url: string, srgb = true): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    texLoader.load(url, t => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 16;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      resolve(t);
    }, undefined, reject);
  });
}

/** Simple priority queue that runs async jobs nearest-first with limited concurrency. */
export class PriorityLoader {
  private queue: { key: string; prio: () => number; job: () => Promise<void> }[] = [];
  private active = 0;
  private done = new Set<string>();
  constructor(private readonly concurrency = 4) {}
  add(key: string, prio: () => number, job: () => Promise<void>) {
    if (this.done.has(key) || this.queue.some(q => q.key === key)) return;
    this.queue.push({ key, prio, job });
    this.pump();
  }
  has(key: string) { return this.done.has(key) || this.queue.some(q => q.key === key); }
  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      this.queue.sort((a, b) => a.prio() - b.prio());
      const next = this.queue.shift()!;
      this.active++;
      next.job().catch(e => console.warn(`load ${next.key} failed`, e)).finally(() => { this.active--; this.done.add(next.key); this.pump(); });
    }
  }
  get pending() { return this.queue.length + this.active; }
}
