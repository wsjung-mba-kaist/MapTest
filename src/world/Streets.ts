import * as THREE from 'three';
import { RADII } from './radii';
import { ChunkRadius } from './ChunkRadius';
import { StreetFlag, chunkCentreX, chunkCentreZ, chunkKey, chunkOrigin } from '../../shared/layout';
import { DATA_URL, loadBinMesh, PriorityLoader } from './DataLoader';
import { createGroundMaterial, type GroundMaterial } from '../materials/GroundMaterial';
import { REFLECT_LAYER } from '../render/WaterReflection';
import type { Terrain } from './Terrain';

interface StreetChunk { mesh: THREE.Mesh; mat: GroundMaterial; walk: THREE.BufferGeometry; i: number; j: number; walkReg: boolean }

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
  /** the chunks requested so far: inside = a fetch is queued, in flight or landed */
  readonly radius = new ChunkRadius(RADII.streetsLoad, RADII.streetsUnload);
  private playerX = 0; private playerZ = 0;
  walkDistance: number = RADII.streetsWalk;
  walkables: WalkableSink | null = null;
  count = 0;

  /** `debug` (?streetsdebug=1) draws the slabs with a normal material: tops green, kerb faces by facing. */
  constructor(private readonly terrain: Terrain, private readonly debug = false) {
    this.group.name = 'streets';
    // the slabs are shaded from the terrain chunk's own ortho tile / mask / overview: follow the terrain's texture events
    // (a slab that lands later is primed from the current state in `request`)
    terrain.onTileChanged.add((i, j, tex) => this.chunks.get(chunkKey(i, j))?.mat.setTile(tex));
    terrain.onMask.add((i, j, tex) => this.chunks.get(chunkKey(i, j))?.mat.setMask(tex));
    terrain.onOverview.add(tex => { for (const c of this.chunks.values()) c?.mat.setOverview(tex); });
  }

  update(x: number, z: number) {
    this.playerX = x; this.playerZ = z;
    this.loader.reprioritise();
    this.radius.update(x, z, (i, j) => this.request(i, j), (i, j) => this.drop(i, j));
    // The walkable band (330 / 450 m) is re-tested every frame over the landed slabs rather than as a second
    // ChunkRadius: a slab lands, and App wires `walkables`, after the band may already have been entered.
    const wd2 = this.walkDistance ** 2, wu2 = (this.walkDistance + (RADII.streetsWalkUnload - RADII.streetsWalk)) ** 2;
    for (const c of this.chunks.values()) {
      if (!c) continue;
      const k = chunkKey(c.i, c.j), d2 = (chunkCentreX(c.i) - x) ** 2 + (chunkCentreZ(c.j) - z) ** 2;
      if (!c.walkReg && d2 < wd2 && this.walkables) { this.walkables.register(`street:${k}`, c.walk, new THREE.Vector3(c.mesh.position.x, 0, c.mesh.position.z)); c.walkReg = true; }
      else if (c.walkReg && d2 > wu2) { this.walkables?.unregister(`street:${k}`); c.walkReg = false; }
    }
  }

  private request(i: number, j: number) {
    const k = chunkKey(i, j), o = chunkOrigin(i, j), cx = chunkCentreX(i), cz = chunkCentreZ(j);
    this.loader.add(k, () => (cx - this.playerX) ** 2 + (cz - this.playerZ) ** 2, async () => {
      try {
        const bm = await loadBinMesh(`${DATA_URL}/streets/${k}.bin`);
        if (!this.radius.has(i, j)) return;   // unloaded while the fetch was in flight: drop it
        const s = bm.sections.get('slab');
        if (!s) { this.chunks.set(k, null); return; }
        const mat = createGroundMaterial({ street: true });
        // textures the terrain already holds (setTile(null) would only force a needless program update on the fresh material)
        const tile = this.terrain.textureOf(i, j), mask = this.terrain.maskOf(i, j), ov = this.terrain.overview;
        if (tile) mat.setTile(tile); if (mask) mat.setMask(mask); if (ov) mat.setOverview(ov);
        const mesh = new THREE.Mesh(s.geometry, this.debug ? new THREE.MeshNormalMaterial() : mat);
        mesh.position.set(o.x, 0, o.z); mesh.matrixAutoUpdate = false; mesh.updateMatrix();
        mesh.receiveShadow = true; mesh.castShadow = true; mesh.renderOrder = 1;   // kerbs throw their own 14 cm shadow
        mesh.layers.enable(REFLECT_LAYER);
        mesh.name = `streets_${k}`;
        this.group.add(mesh);
        this.chunks.set(k, { mesh, mat, walk: topOnly(s.geometry), i, j, walkReg: false });
        this.count++;
      } catch (e) { console.warn('streets load failed', k, e); this.chunks.set(k, null); }
    });
  }

  private drop(i: number, j: number) {
    const k = chunkKey(i, j), c = this.chunks.get(k);
    // Nothing built yet (still queued, failed, or a chunk without slabs): take a queued request back.
    if (!c) { this.loader.cancel(k); return; }
    this.group.remove(c.mesh);
    if (c.walkReg) this.walkables?.unregister(`street:${k}`);
    c.mesh.geometry.dispose(); c.mat.dispose(); (c.mesh.material as THREE.Material).dispose(); c.walk.dispose();
    this.chunks.delete(k); this.count--;
  }
}

/** Slab top triangles only (kerb faces excluded), sharing the position buffer. */
function topOnly(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const flag = geom.getAttribute('sflag') as THREE.BufferAttribute | undefined;
  const index = geom.index!;
  const out: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    if (!flag || (flag.getX(a) === StreetFlag.Top && flag.getX(b) === StreetFlag.Top && flag.getX(c) === StreetFlag.Top)) out.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geom.getAttribute('position'));
  g.setIndex(out);
  return g;
}
