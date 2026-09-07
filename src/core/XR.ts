import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import type { Input } from '../player/Input';

/**
 * WebXR (experimental, `?xr=1`). The headset drives the view; the left thumbstick walks or flies along the head's
 * heading and the right thumbstick snap-turns 45 degrees. Instead of parenting the camera to a rig (which would make
 * `camera.position` local and break every system that reads it as a world position), the XR reference space is
 * offset every frame so that the floor origin sits at the walker's feet: the camera keeps world coordinates and the
 * walking / flying controllers, collision and audio work unchanged. While presenting, the post chain is bypassed (the
 * composer cannot render stereo) and the renderer tone-maps directly with the same AgX curve and exposure.
 * Untested on hardware here (headless CI only); kept behind the flag.
 */
export class XRMode {
  presenting = false;
  private base: XRReferenceSpace | null = null;
  private turnCooldown = 0;
  private yawOffset = 0;                 // accumulated snap turns
  private prevTone: THREE.ToneMapping = THREE.NoToneMapping;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, private readonly camera: THREE.PerspectiveCamera, private readonly input: Input) {
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.xr.setFramebufferScaleFactor(0.85);
    document.body.appendChild(VRButton.createButton(renderer));
    renderer.xr.addEventListener('sessionstart', () => this.begin());
    renderer.xr.addEventListener('sessionend', () => this.end());
  }

  private begin() {
    this.presenting = true;
    this.base = this.renderer.xr.getReferenceSpace();
    this.prevTone = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.input.gamepadActive = true;
    this.yawOffset = 0;
  }

  private end() {
    this.presenting = false;
    this.base = null;
    this.renderer.toneMapping = this.prevTone;
    this.input.touchF = 0; this.input.touchS = 0;
  }

  /** After the movement controller ran: `feet` is the world point the floor origin should stand on. */
  update(dt: number, feet: THREE.Vector3) {
    if (!this.presenting || !this.base) return;
    const session = this.renderer.xr.getSession();
    let lx = 0, ly = 0, rx = 0;
    if (session) for (const src of session.inputSources) {
      const gp = src.gamepad; if (!gp) continue;
      // xr-standard mapping keeps the thumbstick on axes 2/3; fall back to 0/1 for touchpad-only controllers
      const ax = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] ?? 0, gp.axes[1] ?? 0];
      if (src.handedness === 'right') rx = ax[0]; else { lx = ax[0]; ly = ax[1]; }
    }
    const dz = (x: number) => Math.abs(x) < 0.15 ? 0 : x;
    this.input.touchF = -dz(ly); this.input.touchS = dz(lx);
    this.turnCooldown = Math.max(0, this.turnCooldown - dt);
    if (this.turnCooldown === 0 && Math.abs(dz(rx)) > 0.6) { this.yawOffset += Math.sign(rx) * Math.PI / 4; this.turnCooldown = 0.35; }
    // heading for the controllers from the head's world pose (Input: yaw 0 = -z, positive turns right = -euler.y)
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.input.yaw = -this.euler.y;
    this.input.pitch = this.euler.x;
    // floor origin at the feet, world rotated by the snap-turn: new = R(yaw) * base + feet  =>  offset = [R(-yaw) | -R(-yaw) feet]
    this.q.setFromAxisAngle(this.v.set(0, 1, 0), -this.yawOffset);
    const p = this.v.copy(feet).applyQuaternion(this.q).multiplyScalar(-1);
    this.renderer.xr.setReferenceSpace(this.base.getOffsetReferenceSpace(new XRRigidTransform({ x: p.x, y: p.y, z: p.z, w: 1 }, { x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w })));
  }

  /** Direct stereo render while presenting (the composer is skipped). */
  render() { this.renderer.render(this.scene, this.camera); }
}
