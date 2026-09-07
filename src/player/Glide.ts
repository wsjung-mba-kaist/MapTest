import * as THREE from 'three';
import type { Input } from './Input';
import { easeInOut, glideSeconds, shortestYaw } from '../../shared/landmarks';

/**
 * Camera flight to a landmark: smoothstep along a straight line with a gentle arc up (higher for longer hops), the
 * yaw turning along the shortest way and the pitch settling to the landing value. Drives the camera directly, like
 * the lift ride; the caller places the walking / flying controller when `onDone` fires.
 */
export class Glide {
  active = false;
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private t = 0; private dur = 1; private arc = 0;
  private yaw0 = 0; private yaw1 = 0; private pitch0 = 0; private pitch1 = 0;
  private onDone: (() => void) | null = null;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly input: Input) {}

  start(to: THREE.Vector3, yaw1: number, pitch1: number, onDone: () => void) {
    this.from.copy(this.camera.position); this.to.copy(to);
    const dist = Math.hypot(to.x - this.from.x, to.z - this.from.z);
    this.dur = glideSeconds(dist);
    this.arc = Math.max(0, Math.min(40, dist * 0.12));
    this.yaw0 = this.input.yaw; this.yaw1 = this.yaw0 + shortestYaw(this.yaw0, yaw1);
    this.pitch0 = this.input.pitch; this.pitch1 = pitch1;
    this.t = 0; this.active = true; this.onDone = onDone;
  }

  cancel() { this.active = false; this.onDone = null; }

  update(dt: number) {
    if (!this.active) return;
    this.t += dt;
    const u = Math.min(1, this.t / this.dur), k = easeInOut(u);
    this.pos.lerpVectors(this.from, this.to, k);
    this.pos.y += this.arc * Math.sin(Math.PI * k);
    this.camera.position.copy(this.pos);
    this.input.yaw = this.yaw0 + (this.yaw1 - this.yaw0) * k;
    // look slightly down while high up, then level out on the landing pitch
    this.input.pitch = this.pitch0 + (this.pitch1 - this.pitch0) * k - 0.25 * Math.sin(Math.PI * k) * Math.min(1, this.arc / 40);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.input.pitch, -this.input.yaw, 0);
    if (u >= 1) { this.active = false; const cb = this.onDone; this.onDone = null; cb?.(); }
  }
}
