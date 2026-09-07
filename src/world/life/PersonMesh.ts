import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { withLamps } from '../../render/LocalLights';

/**
 * Procedural pedestrian (~1.72 m) with limbs tagged for a vertex-shader walk cycle.
 * aLimb: 0 body/head, 1 left leg, 2 right leg, 3 left arm, 4 right arm. aPart: 0 clothing (instance colour), 1 skin,
 * 2 hair, 3 trousers, 4 shoes; the per-instance aLook = (skin tone, hair tone, trouser style, unused) picks the
 * palette entry in the vertex shader, so every walker differs. The model faces -z at yaw 0.
 * Per-instance aAnim = (phase, walkAmount, seed, unused).
 */
export function walkerGeometry(): THREE.BufferGeometry {
  const tag = (g: THREE.BufferGeometry, limb: number, part: number) => {
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3).fill(1), lim = new Float32Array(n), prt = new Float32Array(n).fill(part);
    for (let i = 0; i < n; i++) lim[i] = limb;
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aLimb', new THREE.BufferAttribute(lim, 1));
    g.setAttribute('aPart', new THREE.BufferAttribute(prt, 1));
    g.deleteAttribute('uv');
    return g;
  };
  const CLOTH = 0, SKIN = 1, HAIR = 2, TROUSERS = 3, SHOE = 4;
  const leg = (x: number, limb: number) => {
    const thigh = new THREE.CylinderGeometry(0.075, 0.06, 0.86, 7).translate(x, 0.45, 0);
    const foot = new THREE.BoxGeometry(0.09, 0.06, 0.22).translate(x, 0.03, -0.04);
    return [tag(thigh, limb, TROUSERS), tag(foot, limb, SHOE)];
  };
  const arm = (x: number, limb: number) => {
    const upper = new THREE.CylinderGeometry(0.048, 0.04, 0.58, 6).translate(x, 1.42 - 0.29, 0);
    const hand = new THREE.SphereGeometry(0.04, 6, 5).translate(x, 1.42 - 0.6, 0);
    return [tag(upper, limb, CLOTH), tag(hand, limb, SKIN)];
  };
  const torso = tag(new THREE.CapsuleGeometry(0.17, 0.44, 3, 8).translate(0, 1.15, 0), 0, CLOTH);
  const neck = tag(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 6).translate(0, 1.48, 0), 0, SKIN);
  const head = tag(new THREE.SphereGeometry(0.11, 8, 6).translate(0, 1.6, 0), 0, SKIN);
  const cap = tag(new THREE.SphereGeometry(0.115, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.61, 0), 0, HAIR);
  const merged = mergeGeometries([...leg(-0.1, 1), ...leg(0.1, 2), ...arm(-0.24, 3), ...arm(0.24, 4), torso, neck, head, cap], false)!;
  merged.computeBoundingSphere();
  return merged;
}

export interface PeopleUniforms { uTime: { value: number } }

/** Standard material with the walk cycle injected; shared by moving walkers and the static crowd (walk = 0 → idle sway). */
export function makePeopleMaterial(uniforms: PeopleUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.customProgramCacheKey = () => 'people-walk';
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`#include <common>
        attribute float aLimb;
        attribute vec4 aAnim;
        attribute float aPart;
        attribute vec4 aLook;
        uniform float uTime;
        mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }`)
      // per-part colours: clothing from the instance colour, the rest from small palettes picked by aLook (sRGB -> linear)
      .replace('#include <color_vertex>', /* glsl */`
        vec3 clothCol = vec3(0.6);
        #ifdef USE_INSTANCING_COLOR
          clothCol = instanceColor.rgb;
        #endif
        float sk = aLook.x, hr = aLook.y, tr = aLook.z;
        vec3 skinS = sk < 0.62 ? mix(vec3(0.96, 0.82, 0.70), vec3(0.87, 0.68, 0.54), sk / 0.62) : sk < 0.85 ? mix(vec3(0.78, 0.56, 0.40), vec3(0.62, 0.42, 0.28), (sk - 0.62) / 0.23) : mix(vec3(0.45, 0.30, 0.20), vec3(0.28, 0.18, 0.12), (sk - 0.85) / 0.15);
        vec3 hairS = hr < 0.15 ? vec3(0.80, 0.68, 0.45) : hr < 0.45 ? vec3(0.40, 0.25, 0.13) : hr < 0.90 ? vec3(0.10, 0.08, 0.07) : vec3(0.72, 0.72, 0.72);
        vec3 trouS = tr < 0.40 ? vec3(0.16, 0.17, 0.22) : tr < 0.70 ? vec3(0.36, 0.43, 0.60) : tr < 0.85 ? vec3(0.70, 0.64, 0.54) : vec3(0.09, 0.09, 0.09);
        vec3 pick = aPart < 0.5 ? vec3(-1.0) : aPart < 1.5 ? skinS : aPart < 2.5 ? hairS : aPart < 3.5 ? trouS : vec3(0.12, 0.12, 0.13);
        vColor = vec4(aPart < 0.5 ? clothCol : pow(pick, vec3(2.2)), 1.0);   // three r185: vColor is always vec4`)
      .replace('#include <beginnormal_vertex>', /* glsl */`
        // Limb swing: triangle wave keeps the foot speed constant on the ground (no sliding); arms swing opposite.
        float wAmt = aAnim.y;
        float ph = aAnim.x;
        mat3 limbRot = mat3(1.0);
        if (aLimb > 0.5) {
          bool leg = aLimb < 2.5;
          float sgn = (aLimb == 1.0 || aLimb == 4.0) ? 1.0 : -1.0;
          float amp = leg ? 0.42 : 0.32;
          float tri = asin(sin(ph)) * 0.6366;
          float ang = sgn * amp * tri * wAmt;
          if (leg) ang += 0.22 * wAmt * max(0.0, sin(ph) * sgn);
          limbRot = rotX(ang);
        }
        vec3 objectNormal = limbRot * vec3(normal);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = vec3(position);
        if (aLimb > 0.5) {
          float pivot = aLimb < 2.5 ? 0.88 : 1.42;
          transformed.y -= pivot; transformed = limbRot * transformed; transformed.y += pivot;
        }
        transformed.y += (0.5 - abs(sin(ph))) * 0.03 * wAmt;            // bob: high when the legs pass
        transformed.z -= max(0.0, transformed.y - 0.8) * 0.05 * wAmt;   // slight forward lean
        transformed.x += sin(uTime * 0.9 + aAnim.z * 6.2832) * 0.006 * (1.0 - wAmt) * transformed.y; // idle sway`);
  };
  withLamps(mat);
  return mat;
}

export const CLOTH_PALETTE = [0x2b2f3a, 0x8c2f2f, 0x2f5a3a, 0xe0d8c8, 0x3a3a3a, 0x5a6a9a, 0xa07040, 0x1f1f24, 0xc8c0b8, 0x704060, 0xd9b44a, 0x6b8fb5];
