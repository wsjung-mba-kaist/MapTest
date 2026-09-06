import * as THREE from 'three';
import facadeGlsl from './shaders/facade.glsl?raw';
import { loadTexture } from '../world/DataLoader';
import { withLamps } from '../render/LocalLights';

/**
 * Shared uniforms for all building materials (night factor, time).
 */
export const buildingUniforms = {
  uNight: { value: 0 },
  uTime: { value: 0 },
  uHour: { value: 12 },   // local hour: drives which windows are lit and shop opening hours (shared/nightlife.ts)
};

/** Photographic micro-detail shared by every wall/roof material; filled by loadFacadeDetail(). */
const facadeTex = {
  uHasFacadeTex: { value: 0 },
  uWallC: { value: null as THREE.Texture | null }, uWallR: { value: null as THREE.Texture | null }, uPlasterN: { value: null as THREE.Texture | null },
  uBaseC: { value: null as THREE.Texture | null }, uBaseN: { value: null as THREE.Texture | null },
  uSlateC: { value: null as THREE.Texture | null }, uSlateN: { value: null as THREE.Texture | null }, uSlateR: { value: null as THREE.Texture | null },
  uWallMean: { value: new THREE.Vector3(0.3, 0.3, 0.3) }, uBaseMean: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
};
const normalMapped: { mat: THREE.MeshStandardMaterial; kind: 'wall' | 'roof' }[] = [];
let detailPromise: Promise<void> | null = null;

/** Mean linear albedo of an sRGB texture (drawn small on a canvas), used to normalise detail to ~1.0. */
function meanLinear(tex: THREE.Texture): THREE.Vector3 {
  const out = new THREE.Vector3(0.3, 0.3, 0.3);
  const img = tex.image as CanvasImageSource | undefined;
  if (!img) return out;
  try {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return out;
    ctx.drawImage(img, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    const acc = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { acc[0] += lin(d[i]); acc[1] += lin(d[i + 1]); acc[2] += lin(d[i + 2]); }
    const n = d.length / 4;
    out.set(acc[0] / n, acc[1] / n, acc[2] / n);
  } catch { /* no DOM or tainted canvas: keep the default */ }
  return out;
}

/** Load the CC0 detail sets once (2K plaster grain, rusticated ashlar trim sheet, slates) and enable normal mapping. */
export function loadFacadeDetail(): Promise<void> {
  if (detailPromise) return detailPromise;
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('facadetex') === '0') return (detailPromise = Promise.resolve()); // debug: procedural only
  const rep = (t: THREE.Texture) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 16; return t; };
  const tex = (name: string, srgb: boolean) => loadTexture(`/textures/pbr/${name}.jpg`, srgb).then(rep);
  detailPromise = Promise.all([
    tex('plaster_grey_04_color', true), tex('plaster_grey_04_roughness', false), tex('plaster_grey_04_normal', false),
    tex('large_sandstone_blocks_color', true), tex('large_sandstone_blocks_normal', false),
    tex('roof_slates_02_color', true), tex('roof_slates_02_normal', false), tex('roof_slates_02_roughness', false),
  ]).then(([wc, wr, wn, bc, bn, sc, sn, sr]) => {
    facadeTex.uWallC.value = wc; facadeTex.uWallR.value = wr; facadeTex.uPlasterN.value = wn;
    facadeTex.uBaseC.value = bc; facadeTex.uBaseN.value = bn;
    facadeTex.uSlateC.value = sc; facadeTex.uSlateN.value = sn; facadeTex.uSlateR.value = sr;
    facadeTex.uWallMean.value.copy(meanLinear(wc)); facadeTex.uBaseMean.value.copy(meanLinear(bc));
    facadeTex.uHasFacadeTex.value = 1;
    // A normalMap on the material makes three.js build the tangent frame; the shader samples its own detail normals.
    for (const { mat, kind } of normalMapped) { mat.normalMap = kind === 'wall' ? wn : sn; mat.needsUpdate = true; }
  }).catch(e => console.warn('facade detail textures missing', e));
  return detailPromise;
}

function registerNormalMapped(mat: THREE.MeshStandardMaterial, kind: 'wall' | 'roof') {
  normalMapped.push({ mat, kind });
  if (facadeTex.uHasFacadeTex.value) { mat.normalMap = kind === 'wall' ? facadeTex.uPlasterN.value : facadeTex.uSlateN.value; }
  void loadFacadeDetail();
}

const VERT_DECL = /* glsl */`
attribute vec4 meta;
varying vec2 vUvM;
varying vec4 vMetaV;
varying vec3 vWorldPosV;
`;
const VERT_BODY = /* glsl */`
vUvM = uv;
vMetaV = meta;
vWorldPosV = (modelMatrix * vec4(position, 1.0)).xyz;
`;
const FRAG_DECL = /* glsl */`
uniform float uNight;
uniform float uTime;
uniform float uHour;
varying vec2 vUvM;
varying vec4 vMetaV;
varying vec3 vWorldPosV;
${facadeGlsl}
`;

type Hooks = (shader: THREE.WebGLProgramParametersWithUniforms) => void;

/** Patch a MeshStandardMaterial so it runs the procedural facade/roof shading. fragMain must define fDetailN (tangent-space). */
function patch(mat: THREE.MeshStandardMaterial, fragMain: string, extraHooks?: Hooks) {
  mat.vertexColors = true;
  mat.customProgramCacheKey = () => `facade:${fragMain.length}:${mat.name}`;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    Object.assign(shader.uniforms, buildingUniforms, facadeTex);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <color_fragment>', '')
      .replace('#include <map_fragment>', fragMain)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = fRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = fMetal;')
      // The tangent frame (tbn) comes from three's normal_fragment_begin once a normalMap is assigned; the detail normal is ours.
      .replace('#include <normal_fragment_maps>', '#ifdef USE_NORMALMAP_TANGENTSPACE\n\tnormal = normalize( tbn * fDetailN );\n#endif')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = fEmissive;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= fAo;');
    extraHooks?.(shader);
  };
  withLamps(mat);
}

export function createWallMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, flatShading: false });
  mat.name = 'walls';
  patch(mat, /* glsl */`
    float fFlag = floor(vColor.a * 255.0 + 0.5);
    // Tangent-space view vector for the parallax reveals: walls are vertical, u runs along cross(up, N).
    vec3 Nw = normalize(transpose(mat3(viewMatrix)) * normalize(vNormal));
    vec3 Vw = normalize(cameraPosition - vWorldPosV);
    if (dot(Nw, Vw) < 0.0) Nw = -Nw;
    vec3 Tw = normalize(cross(vec3(0.0, 1.0, 0.0), Nw));
    vec3 viewTS = vec3(dot(Vw, Tw), Vw.y, dot(Vw, Nw));
    Facade fc = shadeWall(vUvM, vMetaV, vColor.rgb, fFlag, uNight, uTime, viewTS);
    diffuseColor.rgb = fc.color;
    float fRough = fc.rough; float fMetal = fc.metal; vec3 fEmissive = fc.emissive; float fAo = fc.ao; vec3 fDetailN = fc.n;
  `);
  registerNormalMapped(mat, 'wall');
  return mat;
}

export function createRoofSlopeMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.5, flatShading: false });
  mat.name = 'roofs';
  patch(mat, /* glsl */`
    Facade fc = shadeRoofSlope(vUvM, vMetaV, vColor.rgb, uTime);
    diffuseColor.rgb = fc.color;
    float fRough = fc.rough; float fMetal = fc.metal; vec3 fEmissive = fc.emissive; float fAo = fc.ao; vec3 fDetailN = fc.n;
  `);
  registerNormalMapped(mat, 'roof');
  return mat;
}

/**
 * Roof tops: project the chunk's own ortho tile (or the overview) straight down.
 * uv attribute holds absolute world (x, z); flag 4 selects the overview texture.
 */
export function createRoofTopMaterial(chunkOrigin: { x: number; z: number }, tile: THREE.Texture | null, overview: THREE.Texture | null): THREE.MeshStandardMaterial & { setTile: (t: THREE.Texture | null) => void; setOverview: (t: THREE.Texture | null) => void } {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, flatShading: false });
  mat.name = 'tops';
  const uniforms = {
    uTile: { value: tile as THREE.Texture | null },
    uOverview: { value: overview as THREE.Texture | null },
    uChunkOrigin: { value: new THREE.Vector2(chunkOrigin.x, chunkOrigin.z) },
    uHasTile: { value: tile ? 1 : 0 },
    uHasOverview: { value: overview ? 1 : 0 },
  };
  patch(mat, /* glsl */`
    float fFlag = floor(vColor.a * 255.0 + 0.5);
    vec2 uvT = (vUvM - uChunkOrigin + 32.0) / 320.0; uvT.y = 1.0 - uvT.y;
    vec2 uvO = (vUvM + 1536.0) / 3072.0; uvO.y = 1.0 - uvO.y;
    bool inTile = all(greaterThan(uvT, vec2(0.002))) && all(lessThan(uvT, vec2(0.998)));
    vec3 col = vColor.rgb;
    if (fFlag != 4.0 && inTile && uHasTile > 0.5) col = texture2D(uTile, uvT).rgb;
    else if (uHasOverview > 0.5) col = texture2D(uOverview, uvO).rgb;
    // Ortho roofs carry baked sunlight; flatten a little and cool the shadows so dynamic light dominates.
    col = mix(col, vec3(dot(col, vec3(0.3, 0.59, 0.11))), 0.15) * 0.92;
    diffuseColor.rgb = col;
    float fRough = 0.85; float fMetal = 0.0; vec3 fEmissive = vec3(0.0); float fAo = 1.0; vec3 fDetailN = vec3(0.0, 0.0, 1.0);
  `, shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>',
      '#include <common>\nuniform sampler2D uTile; uniform sampler2D uOverview; uniform vec2 uChunkOrigin; uniform float uHasTile; uniform float uHasOverview;');
  });
  const m = mat as ReturnType<typeof createRoofTopMaterial>;
  m.setTile = t => { uniforms.uTile.value = t; uniforms.uHasTile.value = t ? 1 : 0; };
  m.setOverview = t => { uniforms.uOverview.value = t; uniforms.uHasOverview.value = t ? 1 : 0; };
  return m;
}
