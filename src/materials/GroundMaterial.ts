import * as THREE from 'three';
import { loadTexture } from '../world/DataLoader';
import { withLamps } from '../render/LocalLights';
import { buildingUniforms } from './FacadeMaterial';
import { ORTHO_MARGIN, ORTHO_TILE_M, WORLD_HALF } from '../../shared/layout';

/**
 * Ground shading: ortho albedo (chunk tile or overview) + per-surface detail normals/roughness
 * selected by the baked mask (R road, G paving, B grass, A gravel), plus stone on steep slopes (quay walls).
 */

export interface DetailSet { color: THREE.Texture; normal: THREE.Texture }

const shared = {
  uHasDetail: { value: 0 },
  uAsphaltC: { value: null as THREE.Texture | null }, uAsphaltN: { value: null as THREE.Texture | null },
  uPavingC: { value: null as THREE.Texture | null }, uPavingN: { value: null as THREE.Texture | null },
  // grass and gravel keep only their normal maps: the fragment shader must stay within 16 samplers
  // (tile, overview, mask, 5 detail sets, shadow map, environment) or it fails to link on most GPUs
  uGrassN: { value: null as THREE.Texture | null },
  uGravelN: { value: null as THREE.Texture | null },
  uCobbleC: { value: null as THREE.Texture | null }, uCobbleN: { value: null as THREE.Texture | null },
  uStoneC: { value: null as THREE.Texture | null }, uStoneN: { value: null as THREE.Texture | null },
  uWaterY: { value: -7.5 },
  uWet: { value: 0 },      // 1 = rain-wet streets (?wet=1): glossy asphalt, puddles; at night roads are always a little damp
};
export function setWet(v: number) { shared.uWet.value = v; }

let detailPromise: Promise<void> | null = null;

/** Load the CC0 detail textures once; materials pick them up through shared uniforms. */
export function loadGroundDetail(): Promise<void> {
  if (detailPromise) return detailPromise;
  const rep = (t: THREE.Texture, srgb: boolean) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 16; return t; };
  const tex = (name: string, srgb: boolean) => loadTexture(`/textures/pbr/${name}.jpg`, srgb).then(t => rep(t, srgb));
  detailPromise = Promise.all([
    tex('Asphalt033_color', true), tex('Asphalt033_normal', false),
    tex('PavingStones138_color', true), tex('PavingStones138_normal', false),
    tex('Grass004_color', true), tex('Grass004_normal', false),
    tex('Gravel043_color', true), tex('Gravel043_normal', false),
    tex('plastered_stone_wall_color', true), tex('plastered_stone_wall_normal', false),
    tex('cobblestone_floor_08_color', true), tex('cobblestone_floor_08_normal', false),
  ]).then(([ac, an, pc, pn, gc, gn, vc, vn, sc, sn, cc, cn]) => {
    shared.uAsphaltC.value = ac; shared.uAsphaltN.value = an; shared.uPavingC.value = pc; shared.uPavingN.value = pn;
    shared.uGrassN.value = gn; shared.uGravelN.value = vn; gc.dispose(); vc.dispose();
    shared.uStoneC.value = sc; shared.uStoneN.value = sn; shared.uCobbleC.value = cc; shared.uCobbleN.value = cn; shared.uHasDetail.value = 1;
  }).catch(e => console.warn('ground detail textures missing', e));
  return detailPromise;
}

export function setGroundWaterLevel(y: number) { shared.uWaterY.value = y; }

export interface GroundMaterial extends THREE.MeshStandardMaterial {
  setTile(t: THREE.Texture | null): void;
  setMask(t: THREE.Texture | null): void;
  setOverview(t: THREE.Texture | null): void;
}

/** `street`: sidewalk slab variant (forced paving weights, kerb faces in granite grey, per-vertex `sflag`). */
export function createGroundMaterial(opts: { street?: boolean } = {}): GroundMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x6a6f60, roughness: 0.92, metalness: 0 }) as GroundMaterial;
  mat.name = opts.street ? 'street' : 'ground';
  const own = {
    uMask: { value: null as THREE.Texture | null }, uHasMask: { value: 0 },
    uOverview: { value: null as THREE.Texture | null }, uHasOverview: { value: 0 },
    uHasTile: { value: 0 },
  };
  if (opts.street) mat.defines = { STREET_SLAB: '' };
  mat.customProgramCacheKey = () => opts.street ? 'ground-v3-street' : 'ground-v3';
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, shared, own, { uNight: buildingUniforms.uNight });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 uvOv;\nvarying vec3 vWorldPosG; varying vec3 vNormalWG; varying vec2 vUvOv; varying vec2 vUvG;\n#ifdef STREET_SLAB\nattribute float sflag; varying float vSFlag;\n#endif')
      .replace('#include <uv_vertex>', /* glsl */`#include <uv_vertex>
        #ifdef STREET_SLAB
          // slabs carry no uvs: derive the ortho tile / overview coordinates from the chunk-local position
          vSFlag = sflag;
          vUvG = vec2((position.x + ${ORTHO_MARGIN.toFixed(1)}) / ${ORTHO_TILE_M.toFixed(1)}, 1.0 - (position.z + ${ORTHO_MARGIN.toFixed(1)}) / ${ORTHO_TILE_M.toFixed(1)});
          vec3 wpS = (modelMatrix * vec4(position, 1.0)).xyz;
          vUvOv = vec2((wpS.x + ${WORLD_HALF.toFixed(1)}) / ${(2 * WORLD_HALF).toFixed(1)}, 1.0 - (wpS.z + ${WORLD_HALF.toFixed(1)}) / ${(2 * WORLD_HALF).toFixed(1)});
        #else
          vUvOv = uvOv; vUvG = uv;
        #endif`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPosG = (modelMatrix * vec4(transformed, 1.0)).xyz; vNormalWG = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        varying vec3 vWorldPosG; varying vec3 vNormalWG; varying vec2 vUvOv; varying vec2 vUvG;
        #ifdef STREET_SLAB
        varying float vSFlag;
        #endif
        uniform sampler2D uMask; uniform float uHasMask; uniform sampler2D uOverview; uniform float uHasOverview; uniform float uHasTile; uniform float uHasDetail;
        uniform sampler2D uAsphaltC, uAsphaltN, uPavingC, uPavingN, uGrassN, uGravelN, uStoneC, uStoneN;
        uniform float uWaterY; uniform float uNight; uniform float uWet; uniform sampler2D uCobbleC; uniform sampler2D uCobbleN;
        float ghash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(ghash(i), ghash(i + vec2(1.0, 0.0)), f.x), mix(ghash(i + vec2(0.0, 1.0)), ghash(i + vec2(1.0, 1.0)), f.x), f.y); }
        vec4 gWeights;    // road, gravel, paving, grass
        float gPave;      // sett / cobbles (part of the carriageway)
        float gStone;     // steep slope blend
        float gFade;      // detail fade with distance
        vec3 gDetailN;    // tangent-space detail normal (xy in ground plane)
        float gRough;`)
      .replace('#include <map_fragment>', /* glsl */`
        vec3 albedo = vec3(0.42, 0.44, 0.38);
        #ifdef USE_MAP
          if (uHasTile > 0.5) albedo = texture2D(map, vUvG).rgb;
          else if (uHasOverview > 0.5) albedo = texture2D(uOverview, vUvOv).rgb;
        #else
          if (uHasOverview > 0.5) albedo = texture2D(uOverview, vUvOv).rgb;
        #endif
        vec4 m = uHasMask > 0.5 ? texture2D(uMask, vUvG) : vec4(0.0);
        // A carries two classes: ~0.38 = gravel path (never on a carriageway), 1.0 = pavé (sett / cobbles, which also carry R)
        float pave = smoothstep(0.55, 0.75, m.a) * m.r;
        float gravel = clamp(m.a * 2.6, 0.0, 1.0) * (1.0 - smoothstep(0.45, 0.6, m.a)) * (1.0 - m.r);
        float r = m.r - pave; float a = gravel; float g = m.g * (1.0 - m.r - a); float b = m.b * (1.0 - m.r - a - g);
        gPave = pave;
        #ifdef STREET_SLAB
          // slab tops are paving whatever the painted mask says; kerb faces are plain granite
          gPave = 0.0;
          if (vSFlag > 0.5) { albedo = mix(albedo, vec3(0.36, 0.36, 0.35), 0.85); r = 0.0; a = 0.0; g = 1.0; b = 0.0; }
          else {
            // the photo under a sidewalk is mostly tree crowns and building shadow: pull it toward pavement grey
            albedo = mix(albedo, vec3(0.58, 0.57, 0.54), 0.5);
            r = 0.0; b = 0.0; a = min(a, 0.15); g = max(g, 0.85);
          }
        #endif
        gWeights = vec4(r, a, g, b);
        float dist = length(vViewPosition);
        gFade = 1.0 - smoothstep(80.0, 300.0, dist);
        // Near the viewer the photo's own zebra stripes, lane paint and parked cars would double up with the marking
        // decals and the moving traffic: blur the carriageway (mip bias) within ~80 m.
        #ifdef USE_MAP
          if (uHasTile > 0.5) { float blurK = r * (1.0 - smoothstep(30.0, 80.0, dist)); if (blurK > 0.01) albedo = mix(albedo, texture2D(map, vUvG, 3.0).rgb, blurK); }
        #endif
        gStone = smoothstep(0.80, 0.55, vNormalWG.y);
        vec2 wxz = vWorldPosG.xz;
        gDetailN = vec3(0.0, 0.0, 1.0);
        gRough = 0.9;
        if (uHasDetail > 0.5 && gFade > 0.001) {
          // two samples per set at unrelated scales, picked by an 11 m noise: no visible 2 m repeat on the big squares
          float macro = smoothstep(0.35, 0.65, gnoise(wxz / 11.0));
          vec2 uvA1 = wxz / 2.5, uvA2 = wxz * 0.29 + 7.3, uvP1 = wxz / 1.6, uvP2 = wxz * 0.47 + 3.1, uvC = wxz / 1.9;
          vec3 nA = mix(texture2D(uAsphaltN, uvA1).xyz, texture2D(uAsphaltN, uvA2).xyz, macro) * 2.0 - 1.0;
          vec3 nP = mix(texture2D(uPavingN, uvP1).xyz, texture2D(uPavingN, uvP2).xyz, macro) * 2.0 - 1.0;
          vec3 nG = texture2D(uGrassN, wxz / 1.4).xyz * 2.0 - 1.0;
          vec3 nV = texture2D(uGravelN, wxz / 1.1).xyz * 2.0 - 1.0;
          vec3 nC = texture2D(uCobbleN, uvC).xyz * 2.0 - 1.0;
          float rest = max(0.0, 1.0 - r - a - g - b - gPave);
          vec3 n = nA * r + nV * a + nP * g + nG * b + nC * gPave * 1.3 + nP * rest * 0.5;
          gDetailN = normalize(vec3(n.xy * 0.9, max(0.3, n.z)));
          float cA = mix(texture2D(uAsphaltC, uvA1).g, texture2D(uAsphaltC, uvA2).g, macro), cP = mix(texture2D(uPavingC, uvP1).g, texture2D(uPavingC, uvP2).g, macro);
          float cG = 0.5 + 0.35 * (nG.z - 0.85), cV = 0.5 + 0.4 * (nV.z - 0.85);   // relief-derived shade (no colour samplers left)
          vec3 cobble = texture2D(uCobbleC, uvC).rgb;
          float luma = cA * r + cV * a + cP * g + cG * b + dot(cobble, vec3(0.333)) * gPave + 0.5 * rest;
          // Micro-contrast from the detail colour, fading with distance; pavé shows its own stones (the photo is plain grey there)
          albedo *= 1.0 + (luma - 0.5) * 0.35 * gFade;
          albedo = mix(albedo, cobble * vec3(0.92, 0.90, 0.87), gPave * 0.65 * gFade);
          gRough = 0.86 * r + 0.92 * a + 0.72 * g + 0.95 * b + 0.80 * gPave + 0.85 * rest;
          // Steep faces (quay walls, embankments): the ortho is smeared there, use stone instead.
          if (gStone > 0.001) {
            vec2 suv = vec2(vWorldPosG.x + vWorldPosG.z, vWorldPosG.y) / 2.2;
            vec3 stone = texture2D(uStoneC, suv).rgb * vec3(0.78, 0.76, 0.72);
            albedo = mix(albedo, stone, gStone * 0.9);
            vec3 nS = texture2D(uStoneN, suv).xyz * 2.0 - 1.0;
            gDetailN = normalize(mix(gDetailN, vec3(nS.xy * 0.6, nS.z), gStone));
            gRough = mix(gRough, 0.9, gStone);
          }
        }
        // Damp / wet streets: night asphalt is never bone dry (lamp reflections stretch on it); ?wet=1 adds puddles.
        {
          float damp = max(uNight * 0.45, uWet);
          gRough = mix(gRough, 0.38, damp * r) ;
          gRough = mix(gRough, 0.52, damp * g * 0.8);
          albedo *= 1.0 - 0.28 * damp * max(r, g * 0.5);
          if (uWet > 0.5) {
            float pud = smoothstep(0.58, 0.74, gnoise(wxz / 9.0) * 0.6 + gnoise(wxz / 2.3) * 0.4) * r;
            gRough = mix(gRough, 0.06, pud);
            albedo *= 1.0 - 0.45 * pud;
          }
        }
        // The photo carries the capture-time lighting; on roads and pavement pull it toward the blurred overview colour
        // (more at night, when baked sun shadows would read as random dark patches under the lamps).
        if (uHasOverview > 0.5) {
          float flatAmt = mix(0.22, 0.5, uNight) * min(1.0, r + g) * gFade;
          vec3 low = texture2D(uOverview, vUvOv, 3.0).rgb;
          albedo = mix(albedo, low, flatAmt);
        }
        // Darken the strip just above the water line (wet stone).
        albedo *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 1.2, vWorldPosG.y - uWaterY));
        diffuseColor.rgb *= albedo;`)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        {
          // Ground-plane tangent frame (x east, z south); enough for near-flat terrain, blended out on slopes.
          vec3 wN = normalize(vNormalWG);
          vec3 pert = normalize(wN + vec3(gDetailN.x, 0.0, -gDetailN.y) * 0.8 * gFade * (1.0 - gStone * 0.5));
          #ifdef STREET_SLAB
            if (vSFlag > 0.5) pert = wN;   // kerb faces are vertical: the ground-plane detail frame does not apply
          #endif
          normal = normalize((viewMatrix * vec4(pert, 0.0)).xyz);
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, gRough, uHasDetail);')
      // kerb faces sit in the slab's own shadow most of the day: a little ambient lift keeps them readable stone grey
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef STREET_SLAB\nif (vSFlag > 0.5) totalEmissiveRadiance += diffuseColor.rgb * 0.08;\n#endif');
  };
  withLamps(mat);
  mat.setTile = t => { mat.map = t; own.uHasTile.value = t ? 1 : 0; mat.needsUpdate = true; };
  mat.setMask = t => { own.uMask.value = t; own.uHasMask.value = t ? 1 : 0; };
  mat.setOverview = t => { own.uOverview.value = t; own.uHasOverview.value = t ? 1 : 0; };
  return mat;
}
