import * as THREE from 'three';
import { CHUNK_SIZE, GRID_N, chunkKey, chunkOrigin } from '../../shared/layout';
import { DATA_URL, loadBinMesh, PriorityLoader } from './DataLoader';
import { createGroundMaterial, type GroundMaterial } from '../materials/GroundMaterial';
import { REFLECT_LAYER } from '../render/WaterReflection';
import type { Terrain } from './Terrain';

interface StreetChunk { mesh: THREE.Mesh; mat: GroundMaterial; walk: THREE.BufferGeometry; i: number; j: number; tile: THREE.Texture | null; mask: THREE.Texture | null; overview: THREE.Texture | null; walkReg: boolean }

export interface WalkableSink { register(key: string, geom: THREE.BufferGeometry, origin: THREE.Vector3): void; unregister(key: string): void }

/**
 * Sidewalk slabs streamed per chunk (streets/{i}_{j}.bin): raised KERB_H above the terrain with kerb skirts, shaded
 * by the ground material (same ortho tile / mask / overview as the terrain chunk) in its slab variant. Slab tops are
 * handed to the collision system as walkable surfaces so the player steps up the kerb.
 */
export class Streets {
  readonly group = new THREE.Group();
  private readonly loader = new PriorityLoader(2);
  private readonly chunks = new Map<string, StreetChunk | null>();
  private readonly requested = new Set<string>();
  private playerX = 0; private playerZ = 0;
  loadDistance = 620;
  unloadDistance = 900;
  walkDistance = 330;
  walkables: WalkableSink | null = null;
  count = 0;

  /** `debug` (?streetsdebug=1) draws the slabs with a normal material: tops green, kerb faces by facing. */
  constructor(private readonly terrain: Terrain, private readonly debug = false) { this.group.name = 'streets'; }

  update(x: number, z: number) {
    this.playerX = x; this.playerZ = z;
    const ld2 = this.loadDistance ** 2, ud2 = this.unloadDistance ** 2, wd2 = this.walkDistance ** 2, wu2 = (this.walkDistance + 120) ** 2;
    for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
      const k = chunkKey(i, j);
      const o = chunkOrigin(i, j);
      const d2 = (o.x + CHUNK_SIZE / 2 - x) ** 2 + (o.z + CHUNK_SIZE / 2 - z) ** 2;
      if (d2 < ld2 && !this.requested.has(k)) {
        this.requested.add(k);
        this.loader.add(k, () => (o.x + CHUNK_SIZE / 2 - this.playerX) ** 2 + (o.z + CHUNK_SIZE / 2 - this.playerZ) ** 2, async () => {
          try {
            const bm = await loadBinMesh(`${DATA_URL}/streets/${k}.bin`);
            if (!this.requested.has(k)) return;   // unloaded while the fetch was in flight: drop it
            const s = bm.sections.get('slab');
            if (!s) { this.chunks.set(k, null); return; }
            const mat = createGroundMaterial({ street: true });
            const mesh = new THREE.Mesh(s.geometry, this.debug ? new THREE.MeshNormalMaterial() : mat);
            mesh.position.set(o.x, 0, o.z); mesh.matrixAutoUpdate = false; mesh.updateMatrix();
            mesh.receiveShadow = true; mesh.castShadow = true; mesh.renderOrder = 1;   // kerbs throw their own 14 cm shadow
            mesh.layers.enable(REFLECT_LAYER);
            mesh.name = `streets_${k}`;
            this.group.add(mesh);
            this.chunks.set(k, { mesh, mat, walk: topOnly(s.geometry), i, j, tile: null, mask: null, overview: null, walkReg: false });
            this.count++;
          } catch (e) { console.warn('streets load failed', k, e); this.chunks.set(k, null); }
        });
      }
      const c = this.chunks.get(k);
      if (!c) {
        // Nothing built yet: if it went out of range while still queued, take the request back.
        if (d2 > ud2 && this.requested.has(k)) { this.loader.cancel(k); this.requested.delete(k); }
        continue;
      }
      if (d2 > ud2) {
        this.group.remove(c.mesh);
        if (c.walkReg) this.walkables?.unregister(`street:${k}`);
        c.mesh.geometry.dispose(); c.mat.dispose(); (c.mesh.material as THREE.Material).dispose(); c.walk.dispose();
        this.chunks.delete(k); this.requested.delete(k); this.count--;
        continue;
      }
      // share the terrain chunk's textures
      const tile = this.terrain.textureOf(i, j), mask = this.terrain.maskOf(i, j), ov = this.terrain.overview;
      if (tile !== c.tile) { c.tile = tile; c.mat.setTile(tile); }
      if (mask !== c.mask) { c.mask = mask; c.mat.setMask(mask); }
      if (ov !== c.overview) { c.overview = ov; c.mat.setOverview(ov); }
      // walkable registration near the player only
      if (!c.walkReg && d2 < wd2 && this.walkables) { this.walkables.register(`street:${k}`, c.walk, new THREE.Vector3(o.x, 0, o.z)); c.walkReg = true; }
      else if (c.walkReg && d2 > wu2) { this.walkables?.unregister(`street:${k}`); c.walkReg = false; }
    }
  }
}

/** Slab top triangles only (kerb faces excluded), sharing the position buffer. */
function topOnly(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const flag = geom.getAttribute('sflag') as THREE.BufferAttribute | undefined;
  const index = geom.index!;
  const out: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    if (!flag || flag.getX(a) + flag.getX(b) + flag.getX(c) === 0) out.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geom.getAttribute('position'));
  g.setIndex(out);
  return g;
}
