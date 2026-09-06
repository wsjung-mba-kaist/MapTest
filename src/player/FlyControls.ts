import * as THREE from 'three';
import type { Input } from './Input';

/** Free-flying noclip camera (debug / "F" mode). */
export class FlyControls {
  speed = 40;
  readonly position = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly input: Input) {}

  update(dt: number) {
    const { f, s, v, sprint } = this.input.axes();
    const yaw = this.input.yaw, pitch = this.input.pitch;
    this.dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    this.right.set(Math.cos(yaw), 0, Math.sin(yaw));
    const sp = this.speed * (sprint ? 5 : 1) * dt;
    this.position.addScaledVector(this.dir, f * sp).addScaledVector(this.right, s * sp);
    this.position.y += v * sp;
    this.apply();
  }

  apply() {
    this.camera.position.copy(this.position);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.input.pitch, -this.input.yaw, 0);
  }
}
