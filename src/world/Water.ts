import * as THREE from 'three';
import { DATA_URL, loadBinMesh } from './DataLoader';
import { withLamps } from '../render/LocalLights';

/**
 * Seine + basins: physically based water using the scene environment for reflections and a
 * procedural, animated normal map (two scrolling layers). No extra render pass.
 */
export class Water {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshPhysicalMaterial;
  private readonly uniforms = { uTime: { value: 0 }, uReflMap: { value: null as THREE.Texture | null }, uReflMatrix: { value: new THREE.Matrix4() }, uReflMix: { value: 0 }, uReflDistort: { value: 0.035 }, uReflDebug: { value: 0 } };
  waterLevelY = -7;

  constructor() {
    this.group.name = 'water';
    const normals = makeWaterNormals(256);
    this.material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0x1d2a2c),
      roughness: 0.08,
      metalness: 0.0,
      normalMap: normals,
      normalScale: new THREE.Vector2(0.35, 0.35),
      transparent: false,
      envMapIntensity: 1.0,
      clearcoat: 0.0,
    });
    this.material.customProgramCacheKey = () => 'seine-water';
    this.material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ; varying vec4 vReflUv; uniform mat4 uReflMatrix;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;\nvReflUv = uReflMatrix * modelMatrix * vec4(position, 1.0);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; varying vec2 vWorldXZ; varying vec4 vReflUv; uniform sampler2D uReflMap; uniform float uReflMix; uniform float uReflDistort; uniform float uReflDebug; vec3 gRipple;')
        .replace('#include <normal_fragment_maps>', /* glsl */`
          // Two scrolling layers of the tiled normal map, in world metres (tile = 6 m and 17 m).
          vec2 uvA = vWorldXZ / 6.0 + vec2(uTime * 0.020, uTime * 0.013);
          vec2 uvB = vWorldXZ / 17.0 - vec2(uTime * 0.009, uTime * 0.016);
          vec3 nA = texture2D(normalMap, uvA).xyz * 2.0 - 1.0;
          vec3 nB = texture2D(normalMap, uvB).xyz * 2.0 - 1.0;
          vec3 mapN = normalize(vec3(nA.xy + nB.xy, nA.z * nB.z));
          mapN.xy *= normalScale;
          // Fade ripples with distance to avoid sparkle.
          float fade = 1.0 - smoothstep(150.0, 900.0, length(vViewPosition));
          mapN.xy *= fade;
          gRipple = mapN;
          vec3 worldN = normalize(vec3(mapN.x, mapN.z, -mapN.y)); // flat water: tangent frame = world xz
          normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);`)
        .replace('#include <lights_fragment_maps>', /* glsl */`#include <lights_fragment_maps>
          #ifdef USE_ENVMAP
          if (uReflMix > 0.0) {
            // Planar reflection replaces the environment radiance; ripples distort the lookup.
            vec4 ruv = vReflUv;
            ruv.xy += gRipple.xy * uReflDistort * ruv.w;
            vec2 suv = ruv.xy / max(ruv.w, 1e-4);
            float edge = smoothstep(0.0, 0.03, suv.x) * smoothstep(0.0, 0.03, 1.0 - suv.x) * smoothstep(0.0, 0.03, suv.y) * smoothstep(0.0, 0.03, 1.0 - suv.y);
            vec3 refl = texture2DProj(uReflMap, ruv).rgb;
            radiance = mix(radiance, refl, uReflMix * edge);
          }
          #endif`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (uReflDebug > 1.5) { totalEmissiveRadiance = vec3(fract(vReflUv.xy / vReflUv.w), step(vReflUv.w, 0.0)); diffuseColor.rgb = vec3(0.0); } else if (uReflDebug > 0.5) { totalEmissiveRadiance = texture2DProj(uReflMap, vReflUv).rgb; diffuseColor.rgb = vec3(0.0); }');
    };
    withLamps(this.material);
  }

  async load() {
    const bm = await loadBinMesh(`${DATA_URL}/water.bin`);
    this.waterLevelY = (bm.header.meta?.waterLevelY as number) ?? this.waterLevelY;
    for (const s of bm.sections.values()) {
      const m = new THREE.Mesh(s.geometry, this.material);
      m.name = `water_${s.name}`;
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  update(time: number) { this.uniforms.uTime.value = time; }

  /** Debug: show the raw reflection lookup as emissive (?refldbg=uv). */
  setReflectionDebug(mode: number) { this.uniforms.uReflDebug.value = mode; console.log('REFLDBG water uniforms', this.uniforms.uReflMap.value ? 'map ok' : 'no map', Array.from(this.uniforms.uReflMatrix.value.elements).map(v => v.toFixed(2)).join(',')); }

  /** Bind the reflection pass output (texture matrix is updated in place every frame). */
  setReflection(texture: THREE.Texture | null, matrix: THREE.Matrix4 | null, mix = 1) {
    this.uniforms.uReflMap.value = texture; if (matrix) this.uniforms.uReflMatrix.value = matrix; this.uniforms.uReflMix.value = texture ? mix : 0;
  }
}

/** Tileable normal map from a sum of gerstner-ish sines, encoded in tangent space. */
function makeWaterNormals(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const waves = [
    [1, 0, 3.0, 0.9], [0.6, 0.8, 5.0, 0.6], [-0.7, 0.7, 2.0, 0.5], [0.2, -1.0, 7.0, 0.4], [-0.9, -0.3, 11.0, 0.25], [0.5, 0.5, 13.0, 0.2],
  ];
  const h = (x: number, y: number) => {
    let s = 0;
    for (const [dx, dy, f, a] of waves) s += Math.sin(((dx * x + dy * y) * f) * Math.PI * 2) * a;
    return s;
  };
  const e = 1 / size;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = i / size, y = j / size;
    const dx = (h(x + e, y) - h(x - e, y)) / (2 * e) * 0.004;
    const dy = (h(x, y + e) - h(x, y - e)) / (2 * e) * 0.004;
    const n = new THREE.Vector3(-dx, -dy, 1).normalize();
    const o = (j * size + i) * 4;
    data[o] = Math.round((n.x * 0.5 + 0.5) * 255); data[o + 1] = Math.round((n.y * 0.5 + 0.5) * 255); data[o + 2] = Math.round((n.z * 0.5 + 0.5) * 255); data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
