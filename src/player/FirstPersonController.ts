import * as THREE from 'three';
import type { Input } from './Input';
import type { Collision } from './Collision';
import type { Heightmap } from '../../shared/heightmap';

const EYE = 1.70;
const RADIUS = 0.35;
const HEIGHT = 1.75;
const WALK = 2.0;
const SPRINT = 5.2;
const GRAVITY = 9.81;

const segStart = new THREE.Vector3();
const segEnd = new THREE.Vector3();
const correction = new THREE.Vector3();
const wish = new THREE.Vector3();

/** Walking controller: capsule collision against buildings, feet clamped to terrain / walkable decks. */
export class FirstPersonController {
  /** Feet position. */
  readonly position = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private vy = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  waterLevelY = -7;
  headBob = true;
  grounded = true;
  /** called once per footstep with the speed fraction (0..1) */
  onStep: ((strength: number) => void) | null = null;
  /** moving obstacles (people, cars): accumulates a horizontal push-out for the capsule's footprint */
  obstacles: ((x: number, z: number, r: number, out: { dx: number; dz: number }) => void) | null = null;
  private readonly push = { dx: 0, dz: 0 };

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly input: Input, private readonly heightmap: Heightmap, private readonly collision: Collision) {}

  /** Put the feet on the ground at (x,z); `y` probes walkable decks (bridges, tower floors) near that height. */
  place(x: number, z: number, yaw: number, y?: number) {
    this.position.set(x, this.groundAt(x, z, y ?? this.heightmap.sample(x, z) + 1), z);
    this.input.yaw = yaw; this.input.pitch = 0.02;
    this.vel.set(0, 0, 0); this.vy = 0;
    this.apply();
  }

  /** Ground height under (x,z): terrain, or a walkable deck if one is within reach of yRef. */
  groundAt(x: number, z: number, yRef: number): number {
    const t = this.heightmap.sample(x, z);
    const w = this.collision.walkableY(x, yRef, z, 1.2, 2.5);
    return Number.isFinite(w) && w > t - 0.2 ? w : t;
  }

  private ride: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number } | null = null;
  get riding() { return !!this.ride; }
  /** Lift ride: glide from the current position to `to` over `seconds` (no gravity / collision meanwhile). */
  startRide(to: THREE.Vector3, seconds: number) {
    this.ride = { from: this.position.clone(), to: to.clone(), t: 0, dur: Math.max(0.5, seconds) };
    this.vel.set(0, 0, 0); this.vy = 0;
  }

  update(dt: number) {
    if (this.ride) {
      const r = this.ride;
      r.t += dt;
      const u = Math.min(1, r.t / r.dur), k = u * u * (3 - 2 * u);
      this.position.lerpVectors(r.from, r.to, k);
      if (u >= 1) { this.position.copy(r.to); this.ride = null; }
      this.apply();
      return;
    }
    const { f, s, sprint } = this.input.axes();
    const yaw = this.input.yaw;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    wish.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
    if (wish.lengthSq() > 1) wish.normalize();
    const speed = sprint ? SPRINT : WALK;
    // Smooth acceleration/deceleration.
    const accel = wish.lengthSq() > 0 ? 14 : 18;
    this.vel.x += (wish.x * speed - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wish.z * speed - this.vel.z) * Math.min(1, accel * dt);

    const p = this.position;
    const nx = p.x + this.vel.x * dt, nz = p.z + this.vel.z * dt;
    // Keep out of the river: refuse steps whose ground is under water (slide along the bank). The bake sinks the
    // river bed 1.5 m below the water line, so the terrain under every bridge deck fails this test — check for a
    // walkable deck at the current feet height before refusing, or the player freezes mid-span. The raycast only
    // runs where the terrain test already failed, so walking on land costs nothing, and stepping off the deck edge
    // is still refused because walkableY returns NaN out there.
    const tryMove = (x: number, z: number) =>
      this.heightmap.sample(x, z) > this.waterLevelY + 0.15
      || Number.isFinite(this.collision.walkableY(x, p.y, z, 1.2, 2.5));
    if (tryMove(nx, nz)) { p.x = nx; p.z = nz; }
    else if (tryMove(nx, p.z)) { p.x = nx; this.vel.z = 0; }
    else if (tryMove(p.x, nz)) { p.z = nz; this.vel.x = 0; }
    else { this.vel.set(0, 0, 0); }

    // Vertical: gravity toward the ground surface, snap when close (stairs, curbs).
    const ground = this.groundAt(p.x, p.z, p.y);
    if (p.y - ground > 0.35 && !(this.vy > 0)) {
      this.vy -= GRAVITY * dt;
      p.y = Math.max(ground, p.y + this.vy * dt);
      this.grounded = p.y <= ground + 1e-3;
      if (this.grounded) this.vy = 0;
    } else {
      // Snap up/down smoothly to the ground.
      p.y += (ground - p.y) * Math.min(1, 25 * dt);
      if (Math.abs(ground - p.y) < 0.01) p.y = ground;
      this.vy = 0; this.grounded = true;
    }

    // Capsule collision against building walls (3 iterations).
    for (let it = 0; it < 3; it++) {
      segStart.set(p.x, p.y + RADIUS + 0.25, p.z); // start slightly above the feet so curbs don't block
      segEnd.set(p.x, p.y + HEIGHT - RADIUS, p.z);
      this.collision.resolveCapsule(segStart, segEnd, RADIUS, correction);
      if (correction.lengthSq() < 1e-10) break;
      p.x += correction.x; p.z += correction.z;
      if (correction.y > 0.02) p.y += correction.y * 0.5;
    }
    if (this.obstacles) {
      this.push.dx = 0; this.push.dz = 0;
      this.obstacles(p.x, p.z, RADIUS, this.push);
      const pl = Math.hypot(this.push.dx, this.push.dz);
      if (pl > 1e-4) { const k = Math.min(pl, 0.35) / pl; p.x += this.push.dx * k; p.z += this.push.dz * k; const into = (this.vel.x * this.push.dx + this.vel.z * this.push.dz) / pl; if (into < 0) { this.vel.x -= this.push.dx / pl * into; this.vel.z -= this.push.dz / pl * into; } }
    }
    // Remove velocity into walls so we slide.
    if (correction.lengthSq() > 1e-10) {
      const n = correction.clone().setY(0).normalize();
      const into = this.vel.dot(n);
      if (into < 0) this.vel.addScaledVector(n, -into);
    }

    // Head bob.
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const target = this.headBob && this.grounded && hs > 0.3 ? Math.min(1, hs / SPRINT) : 0;
    this.bobAmp += (target - this.bobAmp) * Math.min(1, 8 * dt);
    const prevPhase = this.bobPhase;
    this.bobPhase += dt * (4.2 + hs * 1.2);
    // one footstep per half bob cycle while moving on the ground
    if (this.grounded && hs > 0.3 && Math.floor(prevPhase / Math.PI) !== Math.floor(this.bobPhase / Math.PI)) this.onStep?.(Math.min(1, hs / SPRINT));
    this.apply();
  }

  apply() {
    const bobY = Math.sin(this.bobPhase * 2) * 0.03 * this.bobAmp;
    const bobX = Math.cos(this.bobPhase) * 0.02 * this.bobAmp;
    const yaw = this.input.yaw;
    this.camera.position.set(this.position.x + Math.cos(yaw) * bobX, this.position.y + EYE + bobY, this.position.z + Math.sin(yaw) * bobX);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.input.pitch, -yaw, 0);
  }
}
