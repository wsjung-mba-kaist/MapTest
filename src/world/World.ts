import * as THREE from 'three';
import type { Heightmap } from '../../shared/heightmap';
import type { Manifest } from '../../shared/layout';
import { Buildings } from './Buildings';
import { Terrain } from './Terrain';
import { Eiffel } from './Eiffel';
import { Trees } from './Trees';
import { Water } from './Water';
import { Bridges } from './Bridges';
import { Furniture } from './Furniture';
import { FarRing } from './FarRing';
import { Life } from './life/Life';
import { Markings } from './Markings';
import { DATA_URL, fetchBuffer, fetchJson, loadHeightmap, loadManifest } from './DataLoader';
import { setPlaques } from './Signage';
import { Streets } from './Streets';
import { SurfaceGrid } from '../../shared/surfacegrid';
import type { PlaquesData } from '../../shared/layout';

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
  /** Which moving layers to start (set from the URL before load); null disables the moving city. */
  lifeOptions: { crowd: boolean; traffic: boolean; boats: boolean; signals: boolean; debug: boolean } | null = { crowd: true, traffic: true, boats: true, signals: true, debug: false };

  async load(onProgress: (frac: number, msg: string) => void) {
    onProgress(0.05, 'Loading manifest...');
    this.manifest = await loadManifest();
    onProgress(0.15, 'Loading terrain...');
    this.heightmap = await loadHeightmap();
    if (this.streetsEnabled) { try { this.surface = SurfaceGrid.fromBuffer(await fetchBuffer(`${DATA_URL}/surface.bin`)); } catch { this.surface = null; } }
    this.terrain = new Terrain(this.heightmap);
    this.terrain.setWaterLevel(this.manifest.waterLevelY);
    this.terrain.build();
    this.group.add(this.terrain.group);
    onProgress(0.4, 'Loading buildings...');
    this.buildings = new Buildings();
    this.buildings.textureProvider = (i, j) => this.terrain.textureOf(i, j);
    this.buildings.setOverview(this.terrain.overview);
    this.terrain.onTileChanged = (i, j, tex) => this.buildings.setTile(i, j, tex);
    this.terrain.onOverview = tex => { this.buildings.setOverview(tex); this.bridges?.setOverview(tex); };
    this.buildings.start();
    this.group.add(this.buildings.group);
    onProgress(0.6, 'Loading water...');
    try { const w = new Water(); await w.load(); this.water = w; this.group.add(w.group); } catch (e) { console.warn('water layer missing', e); }
    try { const b = new Bridges(); await b.load(); this.bridges = b; b.setOverview(this.terrain.overview); this.group.add(b.group); } catch (e) { console.warn('bridges missing', e); }
    onProgress(0.7, 'Loading the tower...');
    this.eiffel = new Eiffel();
    this.eiffel.kind = this.towerKind;
    await this.eiffel.load();
    this.group.add(this.eiffel.group);
    onProgress(0.75, 'Planting trees...');
    try { const t = new Trees(); await t.load(this.surface); this.trees = t; this.group.add(t.group); } catch (e) { console.warn('trees missing', e); }
    try { const fu = new Furniture(); await fu.load(this.surface); this.furniture = fu; this.group.add(fu.group); } catch (e) { console.warn('furniture missing', e); }
    try { const far = new FarRing(); await far.load(); this.far = far; this.group.add(far.group); } catch (e) { console.warn('far ring missing', e); }
    if (this.marksEnabled) { const mk = new Markings(this.marksDebug); this.marks = mk; this.group.add(mk.group); }
    if (this.streetsEnabled) { const st = new Streets(this.terrain, this.streetsDebug); this.streets = st; this.group.add(st.group); }
    try { setPlaques(await fetchJson<PlaquesData>(`${DATA_URL}/plaques.json`)); } catch (e) { console.warn('plaques.json missing: no street-name plaques', e); }
    if (this.lifeOptions) {
      onProgress(0.78, 'Waking up the city...');
      try { const l = new Life(); await l.load(this.lifeOptions, this.surface); this.life = l; this.group.add(l.group); } catch (e) { console.warn('paths.bin missing: the city stays still', e); }
    }
    onProgress(0.8, 'Streaming...');
  }

  update(x: number, z: number, time = 0, night = 0, dt = 0, camDir: THREE.Vector3 = DEFAULT_DIR) {
    this.terrain.update(x, z);
    this.life?.update(dt, x, z, camDir, night);
    this.marks?.update(x, z);
    this.streets?.update(x, z);
    this.furniture?.update(night, time);
    this.eiffel?.update(night, time);
    this.buildings.update(x, z, time);
    this.trees?.update(x, z, time);
    this.water?.update(time);
  }

  groundY(x: number, z: number) { return this.heightmap.sample(x, z); }

  get pending() { return this.terrain.pending + this.buildings.pending; }
}
