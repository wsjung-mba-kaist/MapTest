import * as THREE from 'three';
import { REFLECT_LAYER } from '../render/WaterReflection';
import type { Heightmap } from '../../shared/heightmap';
import { CHUNK_SIZE, GRID_N, ORTHO_MARGIN, ORTHO_TILE_M, TERRAIN_MESH_SEGMENTS, chunkIndexOf, chunkKey, chunkOrigin } from '../../shared/layout';
import { DATA_URL, loadTexture, PriorityLoader } from './DataLoader';
import { createGroundMaterial, loadGroundDetail, setGroundWaterLevel, type GroundMaterial } from '../materials/GroundMaterial';

interface ChunkTile {
  mesh: THREE.Mesh<THREE.BufferGeometry, GroundMaterial>;
  mask?: THREE.Texture;
  i: number; j: number;
  small?: THREE.Texture;
  full?: THREE.Texture;
  fullRequested: boolean;
}

/**
 * Ground: one heightmap mesh per chunk textured with its ortho tile.
 * Near chunks get the 1536² tile, everything else the 512² version.
 */
export class Terrain {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, ChunkTile>();
  private readonly loader = new PriorityLoader(6);
  private playerX = 0; private playerZ = 0;
  fullRadius = 1;      // chunks around the player that get full-res tiles
  segments = TERRAIN_MESH_SEGMENTS;
  overview: THREE.Texture | null = null;
  onTileChanged: (i: number, j: number, tex: THREE.Texture) => void = () => {};
  onOverview: (tex: THREE.Texture) => void = () => {};

  constructor(readonly heightmap: Heightmap) {
    this.group.name = 'terrain';
  }

  build() {
    for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
      const o = chunkOrigin(i, j);
      const g = this.chunkGeometry(o.x, o.z);
      const m = createGroundMaterial();
      const mesh = new THREE.Mesh(g, m);
      mesh.layers.enable(REFLECT_LAYER);
      mesh.position.set(o.x, 0, o.z);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = `ground_${chunkKey(i, j)}`;
      this.group.add(mesh);
      this.tiles.set(chunkKey(i, j), { mesh, i, j, fullRequested: false });
    }
    // Overview first, then small textures for every chunk, nearest first.
    this.loader.add('overview', () => -2e9, async () => {
      const tex = await loadTexture(`${DATA_URL}/ground/overview.jpg`);
      tex.anisotropy = 16;
      this.overview = tex;
      for (const t of this.tiles.values()) t.mesh.material.setOverview(tex);
      this.onOverview(tex);
    });
    void loadGroundDetail();
    for (const t of this.tiles.values()) { this.queueSmall(t); this.queueMask(t); }
  }

  /** Current texture bound to a chunk (full-res when streamed in, else the small one). */
  textureOf(i: number, j: number): THREE.Texture | null {
    const t = this.tiles.get(chunkKey(i, j));
    return t?.full ?? t?.small ?? null;
  }
  /** Surface mask of a chunk once streamed in (sidewalk slabs share it). */
  maskOf(i: number, j: number): THREE.Texture | null { return this.tiles.get(chunkKey(i, j))?.mask ?? null; }

  private chunkGeometry(ox: number, oz: number): THREE.BufferGeometry {
    const n = this.segments;
    const verts = (n + 1) * (n + 1);
    const pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const uvOv = new Float32Array(verts * 2);
    let k = 0;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const lx = (i / n) * CHUNK_SIZE, lz = (j / n) * CHUNK_SIZE;
      const wx = ox + lx, wz = oz + lz;
      pos[k * 3] = lx; pos[k * 3 + 1] = this.heightmap.sample(wx, wz); pos[k * 3 + 2] = lz;
      uv[k * 2] = (lx + ORTHO_MARGIN) / ORTHO_TILE_M; uv[k * 2 + 1] = 1 - (lz + ORTHO_MARGIN) / ORTHO_TILE_M;
      uvOv[k * 2] = (wx + 1536) / 3072; uvOv[k * 2 + 1] = 1 - (wz + 1536) / 3072;
      k++;
    }
    const idx = new Uint32Array(n * n * 6);
    let q = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('uvOv', new THREE.BufferAttribute(uvOv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  private dist2(t: ChunkTile) {
    const o = chunkOrigin(t.i, t.j);
    const cx = o.x + CHUNK_SIZE / 2, cz = o.z + CHUNK_SIZE / 2;
    return (cx - this.playerX) ** 2 + (cz - this.playerZ) ** 2;
  }

  private queueSmall(t: ChunkTile) {
    const key = `s_${t.i}_${t.j}`;
    this.loader.add(key, () => this.dist2(t), async () => {
      const tex = await loadTexture(`${DATA_URL}/ground/tiles/${chunkKey(t.i, t.j)}_s.jpg`);
      t.small = tex;
      if (!t.full) this.apply(t, tex);
    });
  }

  private queueMask(t: ChunkTile) {
    this.loader.add(`m_${t.i}_${t.j}`, () => this.dist2(t) + 1e6, async () => {
      const tex = await loadTexture(`${DATA_URL}/ground/mask/${chunkKey(t.i, t.j)}.png`, false);
      tex.anisotropy = 4;
      t.mask = tex;
      t.mesh.material.setMask(tex);
    });
  }

  private queueFull(t: ChunkTile) {
    if (t.fullRequested) return;
    t.fullRequested = true;
    const key = `f_${t.i}_${t.j}`;
    this.loader.add(key, () => this.dist2(t) - 1e9, async () => {
      const tex = await loadTexture(`${DATA_URL}/ground/tiles/${chunkKey(t.i, t.j)}.jpg`);
      // The player may have walked out of range while this loaded; keeping it would strand a 1536² texture that
      // the unload branch no longer looks at.
      if (!t.fullRequested) { tex.dispose(); return; }
      tex.anisotropy = 16;
      t.full = tex;
      this.apply(t, tex);
    });
  }

  private apply(t: ChunkTile, tex: THREE.Texture) {
    t.mesh.material.setTile(tex);
    t.mesh.material.color.set(0xffffff);
    this.onTileChanged(t.i, t.j, tex);
  }

  setWaterLevel(y: number) { setGroundWaterLevel(y); }

  /** Call every frame with the player position; streams full-res tiles around it. */
  update(x: number, z: number) {
    this.playerX = x; this.playerZ = z;
    const { i: ci, j: cj } = chunkIndexOf(x, z);
    for (const t of this.tiles.values()) {
      const near = Math.abs(t.i - ci) <= this.fullRadius && Math.abs(t.j - cj) <= this.fullRadius;
      if (near) this.queueFull(t);
      else if (t.fullRequested && (Math.abs(t.i - ci) > this.fullRadius + 1 || Math.abs(t.j - cj) > this.fullRadius + 1)) {
        // Clear the flag whether or not the texture ever landed: a request that was still queued when the player
        // walked away used to leave fullRequested stuck true, and the chunk kept its 512² tile for good.
        if (t.full) { t.full.dispose(); t.full = undefined; if (t.small) this.apply(t, t.small); }
        else this.loader.cancel(`f_${t.i}_${t.j}`);
        t.fullRequested = false;
      }
    }
  }

  get pending() { return this.loader.pending; }
  get materials(): GroundMaterial[] { return [...this.tiles.values()].map(t => t.mesh.material); }
}
