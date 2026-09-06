import * as THREE from 'three';
import type { Heightmap } from '../../shared/heightmap';

/**
 * Walking on the tower: invisible square decks at the baked floor heights (walkable), guard rails at their edges
 * (blocking) and lift hotspots at the four pillars / on each deck. `E` next to a hotspot rides the player to its
 * destination (FirstPersonController.startRide). Data: /models/eiffel_walk.json from `npm run bake:towerwalk`.
 */
export interface TowerFloor { y: number; rOut: number; rIn: number }
export interface TowerWalkData { floors: TowerFloor[]; pillars: [number, number][]; centre: [number, number]; top: number }
export interface Hotspot { x: number; y: number; z: number; label: string; to: THREE.Vector3; seconds: number }
export interface CollisionSink { walkable(key: string, geom: THREE.BufferGeometry): void; stat(key: string, geom: THREE.BufferGeometry): void }

const GUARD_H = 1.3;
const NAMES = ['1층', '2층', '꼭대기'];

export class TowerAccess {
  floors: TowerFloor[] = [];
  pillars: [number, number][] = [];
  hotspots: Hotspot[] = [];
  centre = new THREE.Vector2();
  ready = false;

  async load(heightmap: Heightmap, sink: CollisionSink) {
    let data: TowerWalkData;
    try { data = await (await fetch('/models/eiffel_walk.json')).json(); } catch { return; }
    if (!data.floors?.length || data.pillars?.length < 4) return;
    this.floors = data.floors;
    this.pillars = data.pillars;
    this.centre.set(data.centre[0], data.centre[1]);
    const cx = this.centre.x, cz = this.centre.y;
    data.floors.forEach((f, i) => {
      sink.walkable(`tower-floor-${i}`, squareRing(cx, cz, f.y, f.rOut + 0.3, f.rIn > 0 ? f.rIn - 0.3 : 0));
      sink.stat(`tower-guard-${i}`, guardRails(cx, cz, f.y, f.rOut + 0.6, f.rIn > 0 ? f.rIn - 0.6 : 0));
    });
    // lift hotspots along each pillar's diagonal
    const f1 = data.floors[0], f2 = data.floors[1], f3 = data.floors[2];
    const mid = (f: TowerFloor) => f.rIn > 0 ? (f.rIn + f.rOut) / 2 : Math.max(2, f.rOut * 0.5);
    const rot = (dx: number, dz: number, a: number) => [dx * Math.cos(a) - dz * Math.sin(a), dx * Math.sin(a) + dz * Math.cos(a)] as const;
    data.pillars.forEach(([px, pz], i) => {
      const dx0 = px - cx, dz0 = pz - cz, dl = Math.hypot(dx0, dz0) || 1;
      const dx = dx0 / dl, dz = dz0 / dl;                    // pillar direction (a diagonal of the square)
      const at = (r: number, y: number, a = 0) => { const [ux, uz] = rot(dx, dz, a); return new THREE.Vector3(cx + ux * r, y, cz + uz * r); };
      // ground hotspot just outside the leg, on the terrain
      const gx = px + dx * 4, gz = pz + dz * 4;
      const g = new THREE.Vector3(gx, heightmap.sample(gx, gz), gz);
      const up1 = at(mid(f1), f1.y), dn1 = at(mid(f1), f1.y, 0.12);
      this.hotspots.push({ x: g.x, y: g.y, z: g.z, label: `${NAMES[0]}으로`, to: up1, seconds: 8 });
      this.hotspots.push({ x: dn1.x, y: dn1.y, z: dn1.z, label: '지상으로', to: g, seconds: 8 });
      if (f2) {
        const up2 = at(mid(f2), f2.y), dn2 = at(mid(f2), f2.y, 0.12);
        this.hotspots.push({ x: up1.x, y: up1.y, z: up1.z, label: `${NAMES[1]}으로`, to: up2, seconds: 7 });
        this.hotspots.push({ x: dn2.x, y: dn2.y, z: dn2.z, label: `${NAMES[0]}으로`, to: dn1, seconds: 7 });
        if (f3 && i === 0) {
          const up3 = at(Math.min(3, f3.rOut * 0.5), f3.y), dn3 = at(Math.min(3, f3.rOut * 0.5), f3.y, Math.PI / 2);
          this.hotspots.push({ x: up2.x, y: up2.y, z: up2.z, label: `${NAMES[2]}로`, to: up3, seconds: 12 });
          this.hotspots.push({ x: dn3.x, y: dn3.y, z: dn3.z, label: `${NAMES[1]}으로`, to: dn2, seconds: 12 });
        }
      }
    });
    this.ready = true;
  }

  /** the hotspot the player is standing at (feet position), if any */
  nearest(x: number, y: number, z: number, r = 3): Hotspot | null {
    let best: Hotspot | null = null, bd = r;
    for (const h of this.hotspots) {
      if (Math.abs(h.y - y) > 2) continue;
      const d = Math.hypot(h.x - x, h.z - z);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  /** '1F' | '2F' | '3F' when the feet are on a deck */
  floorAt(x: number, y: number, z: number): string | null {
    for (let i = 0; i < this.floors.length; i++) {
      const f = this.floors[i];
      if (Math.abs(y - f.y) < 1.5 && Math.max(Math.abs(x - this.centre.x), Math.abs(z - this.centre.y)) <= f.rOut + 1) return `${i + 1}F`;
    }
    return null;
  }

  /** a spot on the 2nd floor facing the Trocadéro (viewpoint 8) */
  viewpoint(): { x: number; y: number; z: number } | null {
    const f = this.floors[1] ?? this.floors[0];
    if (!f) return null;
    const r = f.rIn > 0 ? (f.rIn + f.rOut) / 2 : f.rOut * 0.5;
    const dx = -480 - this.centre.x, dz = -409 - this.centre.y, l = Math.hypot(dx, dz);
    return { x: this.centre.x + dx / l * r, y: f.y, z: this.centre.y + dz / l * r };
  }
}

/** Flat square ring (or full square when rIn = 0) at height y, facing up. */
function squareRing(cx: number, cz: number, y: number, rOut: number, rIn: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number) => {
    pos.push(x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1);
  };
  if (rIn <= 0) quad(cx - rOut, cz - rOut, cx + rOut, cz + rOut);
  else {
    quad(cx - rOut, cz - rOut, cx + rOut, cz - rIn);    // north band
    quad(cx - rOut, cz + rIn, cx + rOut, cz + rOut);    // south band
    quad(cx - rOut, cz - rIn, cx - rIn, cz + rIn);      // west band
    quad(cx + rIn, cz - rIn, cx + rOut, cz + rIn);      // east band
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Vertical rails around the outer square and the inner void. */
function guardRails(cx: number, cz: number, y: number, rOut: number, rIn: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const wall = (x0: number, z0: number, x1: number, z1: number) => {
    pos.push(x0, y, z0, x1, y, z1, x0, y + GUARD_H, z0, x1, y, z1, x1, y + GUARD_H, z1, x0, y + GUARD_H, z0);
  };
  const square = (r: number) => {
    wall(cx - r, cz - r, cx + r, cz - r); wall(cx + r, cz - r, cx + r, cz + r);
    wall(cx + r, cz + r, cx - r, cz + r); wall(cx - r, cz + r, cx - r, cz - r);
  };
  square(rOut);
  if (rIn > 0) square(rIn);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
