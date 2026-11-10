import * as THREE from 'three';
import type { Heightmap } from '../../shared/heightmap';
import { CHUNK_SIZE, GRID_N, MANIFEST_VERSION, WORLD_HALF, type Manifest } from '../../shared/layout';
import { DATUM_ALT } from '../../shared/geo';
import { Buildings } from './Buildings';
import { Terrain } from './Terrain';
import { Eiffel } from './Eiffel';
import { Trees } from './Trees';
import { Water } from './Water';
import { Fountains } from './Fountains';
import { Bridges } from './Bridges';
import { Furniture } from './Furniture';
import { FarRing } from './FarRing';
import { Life } from './life/Life';
import { Markings } from './Markings';
import { DATA_URL, fetchBuffer, fetchJson, loadHeightmap, loadManifest, MODELS_URL } from './DataLoader';
import { setPlaques } from './Signage';
import { Streets } from './Streets';
import { SurfaceGrid } from '../../shared/surfacegrid';
import type { PlaquesData } from '../../shared/layout';
import { Landmarks } from './Landmarks';
import { LandmarkLabels } from './LandmarkLabels';
import { LandmarkModel } from './LandmarkModel';

const DEFAULT_DIR = new THREE.Vector3(0, 0, -1);

/** Owns every baked layer and streams them around the player. */
export class World {
  readonly group = new THREE.Group();
  manifest!: Manifest;
  heightmap!: Heightmap;
  terrain!: Terrain;
  buildings!: Buildings;
  eiffel!: Eiffel;
  trees?: Trees;
  water?: Water;
  fountains?: Fountains;
  bridges?: Bridges;
  towerKind: 'lattice' | 'scan' = 'scan';
  furniture?: Furniture;
  far?: FarRing;
  life?: Life;
  marks?: Markings;
  marksEnabled = true;
  marksDebug = false;
  streets?: Streets;
  streetsEnabled = true;
  streetsDebug = false;
  /** 2 m surface class grid (sidewalk slabs, road, grass...); null when the streets bake has not run */
  surface: SurfaceGrid | null = null;
  /** curated sites (landmarks.json) and their floating name tags */
  readonly landmarks = new Landmarks();
  labels?: LandmarkLabels;
  labelsEnabled = true;
  /** landmark roofs from the LiDAR surface model (off on the mobile preset and with ?dsm=0) */
  dsmEnabled = true;
  /** hero models other than the tower (public/models/landmarks.json); `?hide=models` */
  readonly models = { group: new THREE.Group() };
  heroModels: LandmarkModel[] = [];
  heroLodOnly = false;
  /** floodlight schedule shared with the tower (nightlife.towerLit): 1 lit, 0 off after 23:45; set by App each frame */
  heroLit = 1;
  /** Which moving layers to start (set from the URL before load); null disables the moving city. */
  lifeOptions: { crowd: boolean; traffic: boolean; boats: boolean; signals: boolean; farTraffic: boolean; crossings: boolean; metro: boolean; cyclists: boolean; debug: boolean; simScale?: number; simTime?: number } | null = { crowd: true, traffic: true, boats: true, signals: true, farTraffic: true, crossings: true, metro: true, cyclists: true, debug: false };

  async load(onProgress: (frac: number, msg: string) => void) {
    onProgress(0.05, '지도 정보 읽는 중…');
    this.manifest = await loadManifest();
    // The manifest carries the frame the data was baked in: refuse a stale public/data loudly instead of placing every
    // chunk a grid cell off and failing somewhere deep in a loader.
    const m = this.manifest, bad: string[] = [];
    if (m.version !== MANIFEST_VERSION) bad.push(`version ${m.version} (expected ${MANIFEST_VERSION})`);
    if (m.worldHalf !== WORLD_HALF || m.chunkSize !== CHUNK_SIZE || m.gridN !== GRID_N) bad.push(`grid ${m.worldHalf}/${m.chunkSize}/${m.gridN} (expected ${WORLD_HALF}/${CHUNK_SIZE}/${GRID_N})`);
    if (Math.abs(m.datumAlt - DATUM_ALT) > 1e-6) bad.push(`datumAlt ${m.datumAlt} (expected ${DATUM_ALT})`);
    if (bad.length) throw new Error(`manifest.json does not match this build: ${bad.join(', ')} — re-run npm run bake`);
    onProgress(0.15, '지형 만드는 중…');
    this.heightmap = await loadHeightmap();
    if (this.streetsEnabled) { try { this.surface = SurfaceGrid.fromBuffer(await fetchBuffer(`${DATA_URL}/surface.bin`)); } catch { this.surface = null; } }
    this.terrain = new Terrain(this.heightmap);
    this.terrain.setWaterLevel(this.manifest.waterLevelY);
    this.terrain.build();
    this.group.add(this.terrain.group);
    onProgress(0.4, '건물 불러오는 중…');
    this.buildings = new Buildings();
    this.buildings.dsmEnabled = this.dsmEnabled;
    this.buildings.attachTerrain(this.terrain);
    this.buildings.start();
    this.group.add(this.buildings.group);
    onProgress(0.6, '센강·다리·탑·가로수 불러오는 중…');
    // Independent layers load together (each is best-effort): the sum of ten fetch latencies used to be the boot time.
    // Only the order of `group.add` is kept deterministic (it is the draw order within a render pass).
    const opt = async <T>(what: string, make: () => Promise<T>): Promise<T | undefined> => { try { return await make(); } catch (e) { console.warn(`${what} missing`, e); return undefined; } };
    const [water, fountains, bridges, eiffel, heroModels, trees, furniture, far, plaques, landmarksDone] = await Promise.all([
      opt('water layer', async () => { const w = new Water(); await w.load(); return w; }),
      opt('fountains', async () => { const f = new Fountains(); await f.load(); return f; }),
      opt('bridges', async () => { const b = new Bridges(); await b.load(); return b; }),
      (async () => { const e = new Eiffel(); e.kind = this.towerKind; await e.load(); return e; })(),
      LandmarkModel.loadAll(`${MODELS_URL}/landmarks.json`, (x, z) => this.heightmap.sample(x, z), this.heroLodOnly),
      opt('trees', async () => { const t = new Trees(); await t.load(this.surface, (x, z) => this.heightmap.meshY(x, z)); return t; }),
      opt('furniture', async () => { const fu = new Furniture(); await fu.load(this.surface); return fu; }),
      opt('far ring', async () => { const far = new FarRing(); await far.load(); return far; }),
      opt('plaques.json (no street-name plaques)', () => fetchJson<PlaquesData>(`${DATA_URL}/plaques.json`)),
      this.landmarks.load(),
    ]);
    void landmarksDone;
    if (water) { this.water = water; this.group.add(water.group); }
    if (fountains) { this.fountains = fountains; this.group.add(fountains.group); }
    if (bridges) { this.bridges = bridges; bridges.attachTerrain(this.terrain); this.group.add(bridges.group); }
    this.eiffel = eiffel;
    this.group.add(this.eiffel.group);
    this.models.group.name = 'models';
    this.heroModels = heroModels;
    for (const m of this.heroModels) this.models.group.add(m.group);
    this.group.add(this.models.group);
    if (trees) { this.trees = trees; this.group.add(trees.group); }
    if (furniture) { this.furniture = furniture; this.group.add(furniture.group); }
    if (far) { this.far = far; this.group.add(far.group); }
    if (plaques) setPlaques(plaques);
    if (this.marksEnabled) { const mk = new Markings(this.marksDebug); this.marks = mk; this.group.add(mk.group); }
    if (this.streetsEnabled) { const st = new Streets(this.terrain, this.streetsDebug); this.streets = st; this.group.add(st.group); }
    if (this.labelsEnabled && this.landmarks.baked) {
      this.labels = new LandmarkLabels(this.landmarks.visible.filter(l => l.id !== 'eiffel'), (x, z) => this.heightmap.sample(x, z));
      this.group.add(this.labels.group);
    }
    if (this.lifeOptions) {
      onProgress(0.78, '도시 깨우는 중…');
      try { const l = new Life(); await l.load(this.lifeOptions, this.surface); this.life = l; this.group.add(l.group); } catch (e) { console.warn('paths.bin missing: the city stays still', e); }
    }
    onProgress(0.8, '거의 다 됐습니다…');
  }

  update(x: number, z: number, time = 0, night = 0, dt = 0, camDir: THREE.Vector3 = DEFAULT_DIR, hour = 12, camY = 60) {
    this.terrain.update(x, z);
    this.life?.update(dt, x, z, camDir, night, hour);
    this.marks?.update(x, z);
    this.streets?.update(x, z);
    this.furniture?.update(night, time);
    this.eiffel?.update(night, time, x, camY, z);
    for (const m of this.heroModels) m.update(night, x, z, this.heroLit);
    this.buildings.update(x, z, time);
    this.trees?.update(x, z, time);
    this.water?.update(time);
  }

  groundY(x: number, z: number) { return this.heightmap.sample(x, z); }

  /** Floating landmark name tags on / off after the load (settings); the layer is built on first use. */
  setLabels(on: boolean) {
    if (on && !this.labels && this.landmarks.baked) { this.labels = new LandmarkLabels(this.landmarks.visible.filter(l => l.id !== 'eiffel'), (x, z) => this.heightmap.sample(x, z)); this.group.add(this.labels.group); }
    if (this.labels) this.labels.group.visible = on;
    this.labelsEnabled = on;
  }

  get pending() { return this.terrain.pending + this.buildings.pending; }
}
