import * as THREE from 'three';
import type { SurfaceGrid } from '../../../shared/surfacegrid';
import { PathGraph } from './PathGraph';
import { SimClock } from './SimClock';
import { EdgeFlag } from '../../../shared/paths';
import type { Crowd } from './Crowd';
import type { Traffic } from './Traffic';
import type { Boats } from './Boats';
import type { Signals } from './Signals';
import type { FarTraffic } from './FarTraffic';
import type { LocalLight } from '../../render/LocalLights';
import { activity } from '../../../shared/nightlife';

/**
 * The moving city: owns the path graph, the simulation clock and the crowd / traffic / boat layers, and keeps
 * only the edges around the viewer active. Layers are optional so the graph can be inspected on its own
 * (?lifedebug=1 draws the active edges: red drivable, green walkable centre, blue synthetic sidewalks).
 */
export class Life {
  readonly group = new THREE.Group();
  readonly graph = new PathGraph();
  readonly clock = new SimClock();
  crowd?: Crowd;
  traffic?: Traffic;
  boats?: Boats;
  signals?: Signals;
  farTraffic?: FarTraffic;
  /** activation radii (metres) */
  walkRadius = 220;
  driveRadius = 350;
  private lastX = NaN; private lastZ = NaN;
  private debug?: THREE.LineSegments;
  private debugOn = false;
  lastMs = 0;
  readonly activeWalk: number[] = [];
  readonly activeDrive: number[] = [];

  constructor() { this.group.name = 'life'; }

  async load(opts: { crowd?: boolean; traffic?: boolean; boats?: boolean; signals?: boolean; farTraffic?: boolean; debug?: boolean } = {}, surface: SurfaceGrid | null = null) {
    await this.graph.load();
    this.debugOn = !!opts.debug;
    if (opts.crowd) { const { Crowd } = await import('./Crowd'); this.crowd = new Crowd(this.graph, this.clock, surface); this.group.add(this.crowd.group); }
    if (opts.traffic) { const { Traffic } = await import('./Traffic'); this.traffic = new Traffic(this.graph, this.clock); await this.traffic.load(); this.group.add(this.traffic.group); }
    if (opts.boats) { const { Boats } = await import('./Boats'); this.boats = new Boats(this.graph, this.clock); this.group.add(this.boats.group); }
    if (opts.signals !== false) { const { Signals } = await import('./Signals'); this.signals = new Signals(this.graph); this.group.add(this.signals.group); }
    if (opts.traffic && opts.farTraffic !== false) { const { FarTraffic } = await import('./FarTraffic'); this.farTraffic = new FarTraffic(this.graph, this.clock); this.group.add(this.farTraffic.group); }
  }

  /** Dynamic local lights (boat floodlights first, then the nearest cars' headlights); `cars` = 0 disables headlights. */
  dynamicLights(x: number, z: number, cars = 5): LocalLight[] {
    const out: LocalLight[] = [];
    this.boats?.dynamicLights(out, x, z, 2);
    if (cars > 0) this.traffic?.dynamicLights(out, x, z, cars);
    return out;
  }

  update(dt: number, x: number, z: number, camDir: THREE.Vector3, night: number, hour = 12) {
    const t0 = performance.now();
    const simDt = this.clock.tick(dt);
    const moved = !Number.isFinite(this.lastX) || Math.hypot(x - this.lastX, z - this.lastZ) > 32;
    // time of day thins or refills the streets (rush hour vs. 4 am)
    const reseedWalk = this.crowd?.setActivity(activity(hour, 'walk')) ?? false;
    const reseedDrive = this.traffic?.setActivity(activity(hour, 'car')) ?? false;
    if (moved) {
      this.lastX = x; this.lastZ = z;
      this.graph.edgesNear(x, z, this.walkRadius, this.activeWalk);
      this.graph.edgesNear(x, z, this.driveRadius, this.activeDrive);
      if (this.debugOn) this.rebuildDebug();
    }
    if (moved || reseedWalk) this.crowd?.setActive(this.activeWalk, x, z, this.walkRadius);
    if (moved || reseedDrive) this.traffic?.setActive(this.activeDrive, x, z, this.driveRadius);
    this.crowd?.update(simDt, x, z, camDir, night);
    this.traffic?.update(simDt, x, z, camDir, night);
    this.boats?.update(simDt, night);
    this.signals?.update(this.clock.time, night);
    if (night > 0.02) this.farTraffic?.update(simDt);
    this.lastMs = performance.now() - t0;
  }

  get stats(): string {
    const parts: string[] = [];
    if (this.crowd) parts.push(`walk ${this.crowd.count}`);
    if (this.traffic) parts.push(`cars ${this.traffic.count}`);
    if (this.boats) parts.push(`boats ${this.boats.count} ${this.boats.stats}`);
    return `life ${parts.join(' ')} ${this.lastMs.toFixed(2)}ms`;
  }

  private rebuildDebug() {
    if (this.debug) { this.group.remove(this.debug); this.debug.geometry.dispose(); }
    const g = this.graph;
    const pos: number[] = [], col: number[] = [];
    const seen = new Set<number>();
    const push = (e: number, lat: number, r: number, gg: number, b: number) => {
      const v0 = g.eV0[e], nv = g.eNv[e];
      for (let k = 0; k + 1 < nv; k++) {
        const i = v0 + k, j = i + 1;
        const dx = g.vPos[j * 3] - g.vPos[i * 3], dz = g.vPos[j * 3 + 2] - g.vPos[i * 3 + 2], l = Math.hypot(dx, dz) || 1;
        const nx = -dz / l * lat, nz = dx / l * lat;
        pos.push(g.vPos[i * 3] + nx, g.vPos[i * 3 + 1] + 0.4, g.vPos[i * 3 + 2] + nz, g.vPos[j * 3] + nx, g.vPos[j * 3 + 1] + 0.4, g.vPos[j * 3 + 2] + nz);
        col.push(r, gg, b, r, gg, b);
      }
    };
    for (const e of [...this.activeDrive, ...this.activeWalk]) {
      if (seen.has(e)) continue; seen.add(e);
      const f = g.eFlags[e];
      if (f & EdgeFlag.DRIVE) push(e, 0, 1, 0.15, 0.1);
      if (f & EdgeFlag.WALK) push(e, 0, 0.1, 1, 0.2);
      if (f & EdgeFlag.SIDE_L) push(e, g.sideLat(e, -1), 0.2, 0.5, 1);
      if (f & EdgeFlag.SIDE_R) push(e, g.sideLat(e, 1), 0.2, 0.5, 1);
    }
    // river loops in cyan
    for (let i = 0; i + 1 < g.river.length / 3; i++) { pos.push(g.river[i * 3], g.river[i * 3 + 1] + 0.5, g.river[i * 3 + 2], g.river[i * 3 + 3], g.river[i * 3 + 4] + 0.5, g.river[i * 3 + 5]); col.push(0, 1, 1, 0, 1, 1); }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.debug = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }));
    this.debug.renderOrder = 50; this.debug.frustumCulled = false;
    this.group.add(this.debug);
  }
}
