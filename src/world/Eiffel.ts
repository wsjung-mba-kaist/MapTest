import * as THREE from 'three';
import { withLamps } from '../render/LocalLights';
import { REFLECT_LAYER } from '../render/WaterReflection';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildLattice } from './EiffelLattice';

/** lighthouse beams: length rendered (m), half-width at the lamp and at the far end (m), elevation (deg), seconds per turn */
const BEAM_LEN = 1600, BEAM_W0 = 2.2, BEAM_W1 = 70, BEAM_ELEV = 3, BEAM_PERIOD = 40;

interface EiffelMeta { kind?: 'scan' | '3dmr'; textured?: boolean; top?: number; height?: number; centre?: [number, number]; author?: string; license?: string; source?: string; title?: string }

/**
 * The tower: fitted glTF baked by scripts/lib/eiffel.ts. Photogrammetry scans keep their photo texture
 * (with a golden emissive wash after dusk); untextured models get a three-tone "Eiffel brown" paint.
 * Night extras: thousands of sparkle points sampled from the mesh, the aviation beacon on top and the lighthouse:
 * four 6000 W xenon "marine" projectors (31 Dec 1999) synchronised into a double beam that sweeps the sky through
 * 360 degrees with an 80 km reach. One full turn every BEAM_PERIOD seconds (an estimate from footage; the operator
 * does not publish it); on with the golden floodlights, so off after 23:45 like them.
 */
export class Eiffel {
  readonly group = new THREE.Group();
  meta: EiffelMeta = {};
  loaded = false;
  triangles = 0;
  private materials: THREE.MeshStandardMaterial[] = [];
  private sparkles?: THREE.Points;
  private beacon?: THREE.Sprite;
  private beams?: THREE.Group;
  private readonly uniforms = { uNight: { value: 0 }, uTime: { value: 0 }, uTowerLit: { value: 0 }, uSparkle: { value: 0 }, uCentre: { value: new THREE.Vector3() }, uBeam: { value: 0 } };
  /** floodlights on (0/1, from shared/nightlife towerLit) and the hourly sparkle (0/1); set by App every frame */
  lit = 1;
  sparkle = 0;
  private top = 300;
  private centre = new THREE.Vector3(1.3, 0, 12.1);

  constructor() { this.group.name = 'eiffel'; }

  /** 'lattice' = procedural see-through steel (default), 'scan' = the baked glTF (photogrammetry or 3DMR). */
  kind: 'lattice' | 'scan' = 'scan';

  async load(): Promise<void> {
    try { this.meta = await (await fetch('/models/eiffel.json')).json(); } catch { this.meta = {}; }
    this.top = this.meta.top ?? this.meta.height ?? 300;
    if (this.meta.centre) this.centre.set(this.meta.centre[0], 0, this.meta.centre[1]);
    if (this.kind === 'lattice') {
      const lat = buildLattice();
      lat.mesh.position.copy(this.centre);
      lat.mesh.updateMatrixWorld(true);
      lat.panels.position.copy(this.centre);
      const panelMat = lat.panels.material as THREE.MeshStandardMaterial;
      panelMat.userData.latticePanel = true;
      this.materials.push(lat.material, panelMat);
      withLamps(lat.material); withLamps(panelMat);
      this.triangles = lat.instances * 12;
      this.top = lat.top;
      this.group.add(lat.mesh, lat.panels);
      this.addSparkles(lat.samples.map(p => p.clone().add(this.centre)));
      this.addBeacon();
      this.addBeams();
      this.loaded = true;
      this.meta = { ...this.meta, author: undefined, license: undefined, title: 'procedural lattice' };
      return;
    }
    try {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync('/models/eiffel.glb');
      const positions: THREE.Vector3[] = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true;
        m.frustumCulled = true;
        const g = m.geometry;
        const idx = g.index;
        this.triangles += (idx ? idx.count : g.attributes.position.count) / 3;
        m.material = this.adaptMaterial(m.material as THREE.MeshStandardMaterial);
        // Sample vertices for night sparkles (world space).
        const pos = g.attributes.position;
        const step = Math.max(1, Math.floor(pos.count / 6000));
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i += step) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); positions.push(v.clone()); }
      });
      this.group.add(gltf.scene);
      this.addSparkles(positions);
      this.addBeacon();
      this.addBeams();
      this.loaded = true;
    } catch (e) {
      console.warn('eiffel.glb missing, using procedural tower', e);
      this.group.add(this.procedural());
    }
  }

  private adaptMaterial(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const textured = !!src.map;
    const mat = textured ? src : new THREE.MeshStandardMaterial();
    if (textured) {
      // Photogrammetry: keep the photo, but give the paint a little sheen and a night glow driven by the same texture.
      mat.roughness = 0.62; mat.metalness = 0.12; mat.envMapIntensity = 0.7;
      mat.color.setRGB(1.10, 0.99, 0.88); // the scan was shot under a grey sky; nudge toward the real "Eiffel brown"
      mat.emissiveMap = mat.map; mat.emissive = new THREE.Color(0, 0, 0);
      if (mat.map) { mat.map.anisotropy = 8; mat.map.colorSpace = THREE.SRGBColorSpace; }
    } else {
      // Solid model: three-tone "Eiffel brown", darker at the base and lighter towards the top.
      mat.color.set(0xffffff); mat.roughness = 0.5; mat.metalness = 0.35; mat.side = src.side;
      mat.customProgramCacheKey = () => 'eiffel-paint-v2';
      mat.userData.floodlit = true;
      mat.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, { uTowerLit: this.uniforms.uTowerLit, uCentre: this.uniforms.uCentre });
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying float vHeightE; varying vec3 vWorldE; varying vec3 vNormalE;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldE = (modelMatrix * vec4(transformed, 1.0)).xyz; vHeightE = vWorldE.y; vNormalE = normalize(mat3(modelMatrix) * objectNormal);');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vHeightE; varying vec3 vWorldE; varying vec3 vNormalE; uniform float uTowerLit; uniform vec3 uCentre;')
          .replace('#include <color_fragment>', `#include <color_fragment>
            // "Eiffel brown" (2019 golden-brown repaint), linear albedo; the real paint is darker than it reads against the sky.
            vec3 low = vec3(0.17, 0.11, 0.065), mid = vec3(0.24, 0.16, 0.10), high = vec3(0.31, 0.22, 0.14);
            float t = clamp(vHeightE / 300.0, 0.0, 1.0);
            diffuseColor.rgb *= t < 0.5 ? mix(low, mid, t * 2.0) : mix(mid, high, (t - 0.5) * 2.0);`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            {
              // 336 sodium projectors sit inside the structure pointing up and out: undersides and faces turned toward the
              // axis glow, outward-facing plates stay darker, the floors' bands are brighter and the spire fades.
              vec3 Nw = normalize(vNormalE);
              vec3 toC = normalize(vec3(uCentre.x - vWorldE.x, 0.0, uCentre.z - vWorldE.z));
              float inward = max(0.0, dot(Nw, toC));
              float under = max(0.0, -Nw.y);
              float band = 1.0 + 0.3 * (exp(-pow((vHeightE - 60.0) / 6.0, 2.0)) + exp(-pow((vHeightE - 118.0) / 6.0, 2.0)));
              float spire = 1.0 - 0.4 * smoothstep(250.0, 300.0, vHeightE);
              float litk = (0.2 + 0.5 * under + 0.5 * inward) * band * spire;
              totalEmissiveRadiance += vec3(1.0, 0.50, 0.15) * 0.9 * litk * uTowerLit;
            }`);
      };
      mat.emissive = new THREE.Color(0, 0, 0);
    }
    withLamps(mat);
    this.materials.push(mat);
    return mat;
  }

  private addSparkles(points: THREE.Vector3[]) {
    if (points.length < 50) return;
    const n = points.length;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n);
    points.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z; seed[i] = Math.random(); });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      // plain additive (One, One): the bulb's brightness is written linearly, not squared through alpha
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      vertexShader: /* glsl */`
        attribute float seed; uniform float uTime; uniform float uNight; uniform float uTowerLit; uniform float uSparkle; varying float vA;
        void main() {
          // 20 000 flash bulbs: during the five-minute show at each full hour every bulb flashes at its own phase;
          // outside the show only a faint random twinkle remains.
          float phase = fract(uTime * (0.6 + seed * 0.9) + seed * 7.0);
          float flash = pow(max(0.0, 1.0 - phase * 4.0), 2.0);
          vA = uNight * uTowerLit * flash * mix(0.08, 1.0, uSparkle);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // the bulbs sit on the members they were sampled from: pull them 0.5 m toward the eye so they pass the depth
          // test against their own girder while buildings in front still hide them
          mv.xyz -= normalize(mv.xyz) * 0.5;
          gl_PointSize = clamp(320.0 / max(1.0, -mv.z), 2.0, 14.0) * (1.0 + 0.8 * uSparkle) + 1.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uSparkle; varying float vA;
        void main() { float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard; float a = pow(1.0 - d, 1.8) * vA * mix(0.6, 2.6, uSparkle); gl_FragColor = vec4(vec3(1.0, 0.95, 0.82) * a, 1.0); }`,
    });
    this.sparkles = new THREE.Points(g, mat);
    this.sparkles.frustumCulled = false;
    this.group.add(this.sparkles);
  }

  private addBeacon() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,245,220,0.8)'); grd.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
    this.beacon = new THREE.Sprite(mat);
    this.beacon.position.set(this.centre.x, this.top + 1.5, this.centre.z);
    this.beacon.scale.setScalar(14);
    this.group.add(this.beacon);
  }

  /**
   * The lighthouse: two opposite beams from the summit, each a pair of crossed additive fans (vertical + horizontal)
   * so the shaft reads from every direction, brightest and narrowest at the lamp, thinning out over BEAM_LEN metres.
   * A few degrees above horizontal, as the real projectors are aimed over the rooftops.
   */
  private addBeams() {
    const fan = (vertical: boolean) => {
      const g = new THREE.BufferGeometry();
      const N = 24, pos: number[] = [], st: number[] = [], idx: number[] = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N, x = t * BEAM_LEN, w = BEAM_W0 + (BEAM_W1 - BEAM_W0) * t;
        for (const sgn of [-1, 1]) { pos.push(x, vertical ? sgn * w : 0, vertical ? 0 : sgn * w); st.push(t, sgn); }
        if (i) { const b = (i - 1) * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('st', new THREE.Float32BufferAttribute(st, 2));
      g.setIndex(idx);
      return g;
    };
    // What the eye sees is haze lit by the lamp, so the shaft is a pale blue-white, soft-edged, and much brighter
    // when the beam is coming toward the viewer (forward scattering) than when it is going away; the intensity
    // stays low so additive blending never saturates to white - the photos show a translucent veil, not a bar.
    const mat = new THREE.ShaderMaterial({
      uniforms: { uBeam: this.uniforms.uBeam, uTime: this.uniforms.uTime }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec2 st; varying vec2 vSt; varying vec3 vWorld; varying vec3 vDir;
        void main() {
          vSt = st;
          vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
          vDir = normalize((modelMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uBeam; uniform float uTime; varying vec2 vSt; varying vec3 vWorld; varying vec3 vDir;
        void main() {
          vec3 toCam = normalize(cameraPosition - vWorld);
          float fwd = dot(vDir, toCam) * 0.5 + 0.5;                     // 1 = the beam is heading at the viewer
          float scatter = mix(0.18, 1.0, pow(fwd, 3.0));
          float along = pow(1.0 - vSt.x, 1.6);
          float core = pow(1.0 - abs(vSt.y), 4.0), halo = pow(1.0 - abs(vSt.y), 1.4);
          // slow drifting unevenness, as if the haze it lights were patchy
          float haze = 0.82 + 0.18 * sin(vSt.x * 41.0 - uTime * 0.35) * sin(vSt.x * 9.0 + uTime * 0.11);
          float a = uBeam * scatter * along * haze * (0.30 * core + 0.22 * halo);
          gl_FragColor = vec4(vec3(0.70, 0.80, 1.0) * a, a);
        }`,
    });
    this.beams = new THREE.Group();
    for (const dir of [0, Math.PI]) {
      const beam = new THREE.Group();
      beam.rotation.set(0, dir, THREE.MathUtils.degToRad(BEAM_ELEV), 'YZX');
      for (const v of [true, false]) { const m = new THREE.Mesh(fan(v), mat); m.frustumCulled = false; beam.add(m); }
      this.beams.add(beam);
    }
    this.beams.position.set(this.centre.x, this.top + 2.0, this.centre.z);
    this.group.add(this.beams);
  }

  /** The whole tower (mesh, sparkles, beacon) shows in the river. */
  enableReflection() { this.group.traverse(o => o.layers.enable(REFLECT_LAYER)); }

  update(night: number, time: number) {
    const on = night * this.lit;
    this.uniforms.uNight.value = night; this.uniforms.uTime.value = time;
    this.uniforms.uTowerLit.value = on; this.uniforms.uSparkle.value = this.sparkle * this.lit;
    this.uniforms.uCentre.value.copy(this.centre);
    // Sodium-gold floodlighting: the CAD model shades it per normal in its shader (userData.floodlit); the photo scan
    // modulates its texture, and the procedural lattice glows a little more on beams than on the see-through panels.
    for (const m of this.materials) {
      if (m.userData.floodlit) continue;
      const k = m.emissiveMap ? 1.3 : (m.userData.latticePanel ? 0.22 : 0.38);
      m.emissive.setRGB(1.0, 0.52, 0.17).multiplyScalar(k * on);
    }
    // the lighthouse turns with the floodlights on; the aviation beacon stays on all night, lights or not
    this.uniforms.uBeam.value = on;
    if (this.beams) { this.beams.visible = on > 0.01; this.beams.rotation.y = -(time % BEAM_PERIOD) / BEAM_PERIOD * Math.PI * 2; }
    if (this.beacon) (this.beacon.material as THREE.SpriteMaterial).opacity = night * (0.5 + 0.5 * Math.abs(Math.sin(time * 1.6)));
  }

  /** Coarse parametric lattice tower used only when the baked model is missing. */
  private procedural(): THREE.Object3D {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x5c4a3a, roughness: 0.6, metalness: 0.4 });
    this.materials.push(mat);
    const beam = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(beam, mat, 4 * 60 + 3 * 8);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const halfW = (h: number) => 62.5 * Math.exp(-0.0105 * h);
    let k = 0;
    for (let leg = 0; leg < 4; leg++) {
      const sx = leg & 1 ? 1 : -1, sz = leg & 2 ? 1 : -1;
      let prev = new THREE.Vector3(sx * halfW(0), 0, sz * halfW(0));
      for (let i = 1; i <= 60; i++) {
        const h = (i / 60) * 300;
        const cur = new THREE.Vector3(sx * halfW(h) * 0.8, h, sz * halfW(h) * 0.8);
        const dir = cur.clone().sub(prev);
        const len = dir.length();
        p.copy(prev).add(cur).multiplyScalar(0.5);
        q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        s.set(2.2 - h / 200, len, 2.2 - h / 200);
        m.compose(p, q, s);
        mesh.setMatrixAt(k++, m);
        prev = cur;
      }
    }
    for (const [h, size] of [[57.6, 70], [115.7, 40], [276, 18]] as const) {
      for (let e = 0; e < 8; e++) {
        const a = (e / 8) * Math.PI * 2;
        p.set(Math.cos(a) * size * 0.5, h, Math.sin(a) * size * 0.5);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
        s.set(2, 3, size * 0.4);
        m.compose(p, q, s);
        mesh.setMatrixAt(k++, m);
      }
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    g.add(mesh);
    g.position.copy(this.centre);
    return g;
  }
}
