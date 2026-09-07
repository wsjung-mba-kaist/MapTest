import * as THREE from 'three';
import { REFLECT_LAYER } from '../render/WaterReflection';
import { CHUNK_SIZE, GRID_N, chunkKey, chunkOrigin } from '../../shared/layout';
import { DATA_URL, loadBinMesh, PriorityLoader, type LoadedBinMesh } from './DataLoader';
import { buildingUniforms, createRoofSlopeMaterial, createRoofTopMaterial, createWallMaterial } from '../materials/FacadeMaterial';
import { buildDetails, type DetailMeshes } from './BuildingDetails';
import { buildRoofDetails, disposeRoofDetails, type RoofDetailMeshes } from './RoofDetails';
import { fetchBuffer } from './DataLoader';
import { localLights } from '../render/LocalLights';

type RoofTopMaterial = ReturnType<typeof createRoofTopMaterial>;
const SKIP_ALT: ReadonlySet<string> = new Set(['roofs_alt', 'tops_alt']);
const SKIP_DSM: ReadonlySet<string> = new Set(['dsm']);

export interface BuildingChunk {
  i: number; j: number;
  group: THREE.Group;
  lod0: THREE.Group;
  lod1: THREE.Group;
  walls?: THREE.Mesh; roofs?: THREE.Mesh; tops?: THREE.Mesh; lod?: THREE.Mesh;
  /** landmark roofs from the LiDAR surface model, and the analytic roofs shown instead when dsmEnabled is off */
  dsm?: THREE.Mesh; roofsAlt?: THREE.Mesh; topsAlt?: THREE.Mesh;
  topMat?: RoofTopMaterial;
  details?: DetailMeshes | null;
  roof?: RoofDetailMeshes | null;
  roofLoading?: boolean;
  loaded: boolean;
}

/** Loads per-chunk building meshes nearest-first and swaps LOD by distance. */
export class Buildings {
  readonly group = new THREE.Group();
  readonly chunks = new Map<string, BuildingChunk>();
  private readonly loader = new PriorityLoader(4);
  private playerX = 0; private playerZ = 0;
  lodDistance = 800;
  shadowDistance = 600;
  detailDistance = 520;      // balconies / cornices / awnings exist only this close
  onChunkLoaded: (c: BuildingChunk) => void = () => {};
  /** Supplies the current ortho texture for a chunk (set by World). */
  textureProvider: (i: number, j: number) => THREE.Texture | null = () => null;
  private overview: THREE.Texture | null = null;

  readonly wallMaterial = createWallMaterial();
  readonly roofMaterial = createRoofSlopeMaterial();
  /** LiDAR surface-model landmark roofs (?dsm=0 / mobile: the analytic roofs are shown and the section is never uploaded) */
  dsmEnabled = true;
  private dsmTris = 0;

  constructor() { this.group.name = 'buildings'; }

  start() {
    for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
      const o = chunkOrigin(i, j);
      const group = new THREE.Group();
      group.position.set(o.x, 0, o.z);
      group.matrixAutoUpdate = false; group.updateMatrix();
      const lod0 = new THREE.Group(), lod1 = new THREE.Group();
      lod1.visible = false;
      group.add(lod0, lod1);
      this.group.add(group);
      const c: BuildingChunk = { i, j, group, lod0, lod1, loaded: false };
      this.chunks.set(chunkKey(i, j), c);
      this.loader.add(chunkKey(i, j), () => this.dist2(c), async () => {
        const bm = await loadBinMesh(`${DATA_URL}/chunks/${chunkKey(i, j)}.bin`, this.dsmEnabled ? SKIP_ALT : SKIP_DSM);
        this.populate(c, bm);
      });
    }
  }

  private dist2(c: BuildingChunk) {
    const o = chunkOrigin(c.i, c.j);
    return (o.x + CHUNK_SIZE / 2 - this.playerX) ** 2 + (o.z + CHUNK_SIZE / 2 - this.playerZ) ** 2;
  }

  private populate(c: BuildingChunk, bm: LoadedBinMesh) {
    const mk = (name: string, mat: THREE.Material, parent: THREE.Group) => {
      const s = bm.sections.get(name);
      if (!s) return undefined;
      const m = new THREE.Mesh(s.geometry, mat);
      m.layers.enable(REFLECT_LAYER);
      m.name = `${name}_${chunkKey(c.i, c.j)}`;
      m.castShadow = true; m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      parent.add(m);
      return m;
    };
    c.topMat = createRoofTopMaterial(chunkOrigin(c.i, c.j), this.textureProvider(c.i, c.j), this.overview);
    c.walls = mk('walls', this.wallMaterial, c.lod0);
    c.roofs = mk('roofs', this.roofMaterial, c.lod0);
    c.tops = mk('tops', c.topMat, c.lod0);
    c.lod = mk('lod', this.wallMaterial, c.lod1);
    if (bm.sections.has('dsm')) {
      c.dsm = mk('dsm', c.topMat.dsm, c.lod0);
      this.dsmTris += (bm.sections.get('dsm')!.geometry.index?.count ?? 0) / 3;
    } else {
      c.roofsAlt = mk('roofs_alt', this.roofMaterial, c.lod0);
      c.topsAlt = mk('tops_alt', c.topMat, c.lod0);
    }
    c.loaded = true;
    this.onChunkLoaded(c);
  }

  setTile(i: number, j: number, tex: THREE.Texture | null) { this.chunks.get(chunkKey(i, j))?.topMat?.setTile(tex); }
  setOverview(tex: THREE.Texture | null) { this.overview = tex; for (const c of this.chunks.values()) c.topMat?.setOverview(tex); }

  update(x: number, z: number, time = 0) {
    this.playerX = x; this.playerZ = z;
    buildingUniforms.uTime.value = time;
    const lod2 = this.lodDistance ** 2, sh2 = this.shadowDistance ** 2;
    let next: BuildingChunk | null = null, nextD2 = Infinity;
    for (const c of this.chunks.values()) {
      if (!c.loaded) continue;
      const d2 = this.dist2(c);
      const near = d2 < lod2;
      if (c.lod0.visible !== near) { c.lod0.visible = near; c.lod1.visible = !near; }
      const shadows = d2 < sh2;
      for (const m of [c.walls, c.roofs, c.tops, c.dsm, c.roofsAlt, c.topsAlt]) if (m && m.castShadow !== shadows) m.castShadow = shadows;
      // Facade details: build lazily near the viewer (one chunk per frame, nearest first), drop them again far away.
      if (c.details === undefined && d2 < this.detailDistance ** 2 && c.walls) {
        if (d2 < nextD2) { next = c; nextD2 = d2; }
      } else if (c.details && d2 > (this.detailDistance + 350) ** 2) {
        c.lod0.remove(...c.details.meshes);
        c.details.dispose();
        localLights.removeLights(`shop:${chunkKey(c.i, c.j)}`);
        c.details = undefined;
        if (c.roof) { c.lod0.remove(...c.roof.meshes); disposeRoofDetails(c.roof); }
        c.roof = undefined;
      }
    }
    if (next) this.buildChunkDetails(next);
  }

  private buildChunkDetails(c: BuildingChunk) {
    const o = chunkOrigin(c.i, c.j);
    c.details = buildDetails(c.walls!.geometry, new THREE.Vector3(o.x, 0, o.z));
    if (c.details) { c.lod0.add(...c.details.meshes); if (c.details.lights.length) localLights.addLights(`shop:${chunkKey(c.i, c.j)}`, c.details.lights); }
    if (!c.roofLoading && c.roof === undefined) {
      c.roofLoading = true;
      void fetchBuffer(`${DATA_URL}/details/${chunkKey(c.i, c.j)}.bin`).then(buf => {
        c.roofLoading = false;
        c.roof = buildRoofDetails(new Float32Array(buf), new THREE.Vector3(o.x, 0, o.z));
        if (c.roof) c.lod0.add(...c.roof.meshes);
      }).catch(() => { c.roofLoading = false; c.roof = null; });
    }
  }

  get pending() { return this.loader.pending; }
  get loadedCount() { let n = 0; for (const c of this.chunks.values()) if (c.loaded) n++; return n; }
  /** chunks with facade details, and their sign / plaque instance totals (HUD) */
  get detailStats() {
    let chunks = 0, signs = 0, plaques = 0;
    for (const c of this.chunks.values()) if (c.details) { chunks++; signs += c.details.signCount; plaques += c.details.plaqueCount; }
    return `details ${chunks} signs ${signs} plaques ${plaques}${this.dsmTris ? ` dsm ${(this.dsmTris / 1000).toFixed(0)}k` : ''}`;
  }
}
