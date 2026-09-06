import * as THREE from 'three';

/** Objects on this layer are drawn in the mirrored pass (buildings, terrain, tower, bridges, sky, lamps, lights). */
export const REFLECT_LAYER = 1;

/**
 * Planar reflection of the Seine: the scene is rendered once more from the camera mirrored across the water
 * plane into a half-resolution target, with an oblique near plane so nothing below the water leaks in.
 * Only REFLECT_LAYER objects are drawn (trees, cars, people and details are skipped to keep it cheap).
 */
export class WaterReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly camera = new THREE.PerspectiveCamera();
  readonly textureMatrix = new THREE.Matrix4();
  enabled = true;
  clipBias = 0.02;
  private div = 2;
  private readonly plane = new THREE.Plane();
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly planePoint = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly rot = new THREE.Matrix4();
  private readonly view = new THREE.Vector3();
  private readonly target3 = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private width = 2; private height = 2;
  private frames = 0;
  /** ?refldbg=noclip|noshadow|norender isolates parts of the pass while debugging. */
  private readonly dbg = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('refldbg') ?? '') : '';

  constructor(readonly renderer: THREE.WebGLRenderer, public planeY: number, width: number, height: number, div = 2) {
    this.div = div;
    this.target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, samples: 0 });
    this.target.texture.minFilter = THREE.LinearFilter; this.target.texture.magFilter = THREE.LinearFilter;
    this.target.texture.generateMipmaps = false;
    this.camera.layers.set(REFLECT_LAYER);
    this.setSize(width, height);
  }

  setSize(w: number, h: number) {
    this.width = w; this.height = h;
    this.target.setSize(Math.max(2, Math.floor(w / this.div)), Math.max(2, Math.floor(h / this.div)));
  }
  setDivisor(div: number) { this.div = div; this.setSize(this.width, this.height); }

  /** Render the mirrored view; returns false when the camera is under the plane (nothing to reflect). */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): boolean {
    this.planePoint.set(0, this.planeY, 0);
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    if (this.camPos.y <= this.planeY + 0.05) return false;
    this.rot.extractRotation(camera.matrixWorld);
    // mirrored position (same construction as three's Reflector: plane - camera, reflect, negate, + plane)
    this.view.subVectors(this.planePoint, this.camPos).reflect(this.normal).negate().add(this.planePoint);
    // mirrored look-at
    this.lookAt.set(0, 0, -1).applyMatrix4(this.rot).add(this.camPos);
    this.target3.subVectors(this.planePoint, this.lookAt).reflect(this.normal).negate().add(this.planePoint);
    const vc = this.camera;
    vc.position.copy(this.view);
    vc.up.set(0, 1, 0).applyMatrix4(this.rot).reflect(this.normal);
    vc.lookAt(this.target3);
    vc.near = camera.near; vc.far = camera.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
    // texture matrix: clip space -> [0,1]
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    if (this.dbg && this.frames < 3) {
      const p = new THREE.Vector4(camera.position.x + 20, this.planeY, camera.position.z - 20, 1).applyMatrix4(this.textureMatrix);
      console.log(`REFLDBG frame ${this.frames} vc=${vc.position.toArray().map(v => v.toFixed(1))} texM=${Array.from(this.textureMatrix.elements).map(v => v.toFixed(3)).join(',')} sample=${p.toArray().map(v => v.toFixed(3))} uv=${(p.x / p.w).toFixed(3)},${(p.y / p.w).toFixed(3)}`);
    }
    // oblique near plane (Lengyel) so geometry below the water is clipped
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.planePoint);
    this.plane.applyMatrix4(vc.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = vc.projectionMatrix;
    this.q.x = (Math.sign(this.clip.x) + pm.elements[8]) / pm.elements[0];
    this.q.y = (Math.sign(this.clip.y) + pm.elements[9]) / pm.elements[5];
    this.q.z = -1.0;
    this.q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    this.clip.multiplyScalar(2.0 / this.clip.dot(this.q));
    if (this.dbg !== 'noclip') { pm.elements[2] = this.clip.x; pm.elements[6] = this.clip.y; pm.elements[10] = this.clip.z + 1.0 - this.clipBias; pm.elements[14] = this.clip.w; }
    vc.projectionMatrixInverse.copy(pm).invert();
    // render
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevShadowAuto = r.shadowMap.autoUpdate;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    // Reuse the main pass's shadow map, but only once one exists: rendering with shadow updates off before the
    // first main pass compiles the layer-1 materials against an empty shadow texture and every later draw of
    // those materials fails with a sampler/format mismatch (objects vanish).
    if (this.dbg !== 'noshadow' && this.frames++ >= 2) r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.target);
    r.clear();
    if (this.dbg !== 'norender') r.render(scene, vc);
    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevShadowAuto;
    r.xr.enabled = prevXr;
    return true;
  }

  private blitScene?: THREE.Scene;
  private blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** Debug: draw the reflection target over the frame (?refldbg=show). */
  debugBlit() {
    if (this.dbg !== 'show') return;
    if (!this.blitScene) {
      this.blitScene = new THREE.Scene();
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: this.target.texture }));
      this.blitScene.add(m);
    }
    const r = this.renderer;
    const prevAuto = r.autoClear; r.autoClear = false;
    const prevTone = r.toneMapping; r.toneMapping = THREE.ACESFilmicToneMapping;
    r.render(this.blitScene, this.blitCam);
    r.autoClear = prevAuto; r.toneMapping = prevTone;
  }

  dispose() { this.target.dispose(); }
}
