import * as THREE from 'three';
import { buildingUniforms } from '../materials/FacadeMaterial';
import { withLamps, type LocalLight } from '../render/LocalLights';
import { PHARMACY, PHARMACY_CELL, SHOP_NAMES, SIGN_PALETTES, plaqueArmsNear, plaqueCanvas, plaqueMaterial, shopSignMaterial, signCell, signRect, signageDebug, signageEnabled, type PlaqueArm } from './Signage';

/**
 * Protruding facade details generated from the baked wall quads of a chunk:
 * continuous balcony slabs with iron railings (Haussmann floors 2 and 5), the crowning cornice, shop awnings and
 * shop signs on the ground floor, and street-name plaques on the corners next to junctions. Everything is instanced
 * boxes / sheets, so it is cheap and only exists for chunks near the viewer.
 */

const SLAB_D = 0.85, SLAB_T = 0.2, RAIL_H = 0.95;
const CORNICE_D = 0.45, CORNICE_T = 0.4;
const HAUSSMANN_GROUND = 4.3;
const SIGN_Y = 3.75, SIGN_H = 0.6;           // fascia between the awning (top ~3.4) and the first-floor band (4.3)
const PLAQUE_Y = 2.7, PLAQUE_W = 0.7, PLAQUE_H = 0.45;

let railTex: THREE.CanvasTexture | null = null;
function railingTexture(): THREE.CanvasTexture {
  if (railTex) return railTex;
  const S = 128, c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#fff';
  for (let x = 6; x < S; x += 16) ctx.fillRect(x, 0, 4, S);          // vertical bars every ~12 cm at 1 m per tile
  ctx.fillRect(0, 0, S, 7); ctx.fillRect(0, S * 0.55, S, 4);           // top rail and mid rail
  railTex = new THREE.CanvasTexture(c);
  railTex.wrapS = railTex.wrapT = THREE.RepeatWrapping; railTex.anisotropy = 8;
  return railTex;
}

const AWNING_COLORS = [0x7a2a2a, 0x2a4a3a, 0x2f3d5a, 0x6b4a1f, 0x3a3a3a, 0x8a5a2a];

export interface DetailMeshes {
  boxes: THREE.InstancedMesh; rails: THREE.InstancedMesh; awnings: THREE.InstancedMesh;
  signs: THREE.InstancedMesh | null; plaques: THREE.InstancedMesh | null;
  /** everything to add to the chunk group */
  meshes: THREE.Object3D[];
  count: number; signCount: number; plaqueCount: number;
  /** shop-front display lights (world coordinates) for the local-light array */
  lights: LocalLight[];
  dispose(): void;
}

const boxGeom = new THREE.BoxGeometry(1, 1, 1);
const planeGeom = new THREE.PlaneGeometry(1, 1);
let boxMat: THREE.MeshStandardMaterial | null = null, railMat: THREE.MeshStandardMaterial | null = null, awningMat: THREE.MeshStandardMaterial | null = null;

function materials() {
  boxMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  if (!railMat) {
    railMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, alphaMap: railingTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.5 });
    railMat.customProgramCacheKey = () => 'balcony-rail';
    railMat.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float railLen;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_ALPHAMAP\nvAlphaMapUv = vec2(uv.x * railLen, uv.y);\n#endif');
      // Bars alias into moiré at distance: fade the cut-off so the sheet turns into a plain dark band.
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', 'float railCut = mix(0.5, 0.35, smoothstep(40.0, 160.0, length(vViewPosition))); if (diffuseColor.a < railCut) discard;');
    };
  }
  awningMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  withLamps(boxMat); withLamps(railMat); withLamps(awningMat);
  return { boxMat, railMat, awningMat };
}

/** Warm terrace bulbs (additive points) in front of cafes, on from 17:00 until 01:00. */
function terraceGlare(xyz: Float32Array): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNight: buildingUniforms.uNight, uHour: buildingUniforms.uHour }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      uniform float uNight; uniform float uHour; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(1.0, -mv.z);
        float h = mod(uHour, 24.0);
        float open = (h >= 17.0 || h < 1.0) ? 1.0 : 0.0;
        gl_PointSize = clamp(260.0 / d, 4.0, 40.0);
        vA = uNight * open * clamp(1.3 - d / 120.0, 0.3, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main() { if (vA <= 0.001) discard; float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; float a = pow(1.0 - r, 2.4) * 0.45 * vA; gl_FragColor = vec4(vec3(1.0, 0.62, 0.30) * a, a); }`,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  p.name = 'terrace_lights';
  return p;
}

/** Same deterministic shop rule as facade.glsl (integer arithmetic only). */
export const isShopBay = (seed: number, b: number) => ((seed * 7 + b * 13) % 10) < 5;

interface SignInst { m: THREE.Matrix4; rect: [number, number, number, number]; lit: number; neon?: number }
let shopLightsOn = true;
/** ?shoplights=0 */
export function setShopLights(v: boolean) { shopLightsOn = v; }

// Geometry is chunk-local; the chunk group already carries the origin, so the meshes stay at the group origin.
function instancedQuads(list: SignInst[], mat: THREE.Material, shadows: boolean): THREE.InstancedMesh {
  const geom = planeGeom.clone();
  const rect = new Float32Array(list.length * 4), lit = new Float32Array(list.length), neon = new Float32Array(list.length);
  list.forEach((s, i) => { rect.set(s.rect, i * 4); lit[i] = s.lit; neon[i] = s.neon ?? 0; });
  geom.setAttribute('aRect', new THREE.InstancedBufferAttribute(rect, 4));
  geom.setAttribute('aLit', new THREE.InstancedBufferAttribute(lit, 1));
  geom.setAttribute('aNeon', new THREE.InstancedBufferAttribute(neon, 1));
  const mesh = new THREE.InstancedMesh(geom, mat, list.length);
  list.forEach((s, i) => mesh.setMatrixAt(i, s.m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadows; mesh.receiveShadow = true; mesh.frustumCulled = false;
  return mesh;
}

/** Build details for one chunk from its walls geometry (chunk-local positions). */
export function buildDetails(walls: THREE.BufferGeometry, chunkOrigin: THREE.Vector3): DetailMeshes | null {
  const pos = walls.attributes.position as THREE.BufferAttribute;
  const uv = walls.attributes.uv as THREE.BufferAttribute;
  const meta = walls.attributes.meta as THREE.BufferAttribute;
  const col = walls.attributes.color as THREE.BufferAttribute;
  if (!pos || !uv || !meta || !col) return null;

  const boxes: { m: THREE.Matrix4; c: THREE.Color }[] = [];
  const rails: { m: THREE.Matrix4; len: number }[] = [];
  const awnings: { m: THREE.Matrix4; c: THREE.Color }[] = [];
  const signs: SignInst[] = [];
  const terrace: number[] = [];
  const lights: LocalLight[] = [];
  const plaqueCands: { arm: PlaqueArm; side: number; pd: number; m: THREE.Matrix4 }[] = [];
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();
  const arms: PlaqueArm[] = [];
  const signage = signageEnabled();

  const quads = Math.floor(pos.count / 4);
  for (let q = 0; q < quads; q++) {
    const i0 = q * 4, i1 = i0 + 1, i3 = i0 + 3;
    const flag = Math.round(col.getW(i0) * 255);
    if (flag !== 0) continue;                                   // walls only (no plinths)
    const style = Math.floor(meta.getW(i0) / 256 + 0.5);
    const seed = meta.getW(i0) % 256;
    const ax = pos.getX(i0), az = pos.getZ(i0), bx = pos.getX(i1), bz = pos.getZ(i1);
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 3) continue;
    const y0 = pos.getY(i0), v0 = uv.getY(i0);
    const groundY = y0 - v0;                                    // v is metres above ground
    const eaveY = pos.getY(i3);
    const wallH = eaveY - groundY;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    const nx = -dz, nz = dx;                                    // outward normal (left-hand, matches the bake winding)
    const yaw = Math.atan2(dx, dz);                             // box local +z along the wall
    // A PlaneGeometry rotated by yaw - pi/2 about y has its +z normal on (-dz, dx) = outward, so text reads correctly
    // from the street; railings and awnings are double-sided sheets and keep the legacy yaw + pi/2 frame.
    const faceOut = new THREE.Quaternion().setFromAxisAngle(up, yaw - Math.PI / 2);
    const sheetQ = new THREE.Quaternion().setFromAxisAngle(up, yaw + Math.PI / 2);

    // Street-name plaques: a junction arm parallel to this wall, with the junction just past one end of the wall.
    if (signage && wallH >= 5) {
      const cx0 = ax + dx * len / 2, cz0 = az + dz * len / 2;
      plaqueArmsNear(cx0 + chunkOrigin.x, cz0 + chunkOrigin.z, len / 2 + 22, arms);
      for (const arm of arms) {
        if (Math.abs(dx * arm.ux + dz * arm.uz) < 0.9) continue;                       // wall must run along the street
        const jx = arm.x - chunkOrigin.x - ax, jz = arm.z - chunkOrigin.z - az;          // junction relative to a
        if ((cx0 - jx - ax) * arm.ux + (cz0 - jz - az) * arm.uz < 0) continue;          // the wall lies ahead along this arm
        const pd = jx * nx + jz * nz;                                                    // outward distance of the junction
        if (pd < 1.5 || pd > 24) continue;
        const s = jx * dx + jz * dz;                                                     // along the wall
        const nearA = s < len / 2;
        if (nearA ? (s < -18 || s > 16) : (s < len - 16 || s > len + 18)) continue;
        // the plaque hangs on the corner pier (the ~1 m of wall before the first window bay)
        const t = nearA ? Math.min(0.55, len / 2) : len - Math.min(0.55, len / 2);
        P.set(ax + dx * t + nx * 0.05, groundY + PLAQUE_Y, az + dz * t + nz * 0.05);
        S.set(PLAQUE_W, PLAQUE_H, 1);
        const side = Math.sign(arm.ux * (cz0 - (arm.z - chunkOrigin.z)) - arm.uz * (cx0 - (arm.x - chunkOrigin.x))) || 1;
        plaqueCands.push({ arm, side, pd, m: M.compose(P, faceOut, S).clone() });
      }
    }

    if (style !== 0 && style !== 4) continue;
    if (len < 3.5 || wallH < 7) continue;
    const floorH = Math.max(2.4, meta.getX(i0));
    const levels = Math.max(1, meta.getY(i0));
    const cx = (ax + bx) / 2, cz = (az + bz) / 2;
    tint.setRGB(col.getX(i0), col.getY(i0), col.getZ(i0));

    // Cornice just under the eave.
    P.set(cx + nx * (CORNICE_D / 2 - 0.05), eaveY - 0.5, cz + nz * (CORNICE_D / 2 - 0.05));
    Q.setFromAxisAngle(up, yaw); S.set(CORNICE_D, CORNICE_T, len);
    boxes.push({ m: M.compose(P, Q, S).clone(), c: tint.clone().multiplyScalar(1.05) });

    if (style === 0) {
      // Continuous balconies on floors 2 and 5 (Haussmann), when the building is tall enough.
      const floors = [2, ...(levels > 5.5 ? [5] : [])];
      for (const k of floors) {
        const yb = groundY + HAUSSMANN_GROUND + (k - 1) * floorH;
        if (yb > eaveY - 1.5) continue;
        P.set(cx + nx * (SLAB_D / 2), yb + SLAB_T / 2, cz + nz * (SLAB_D / 2));
        S.set(SLAB_D, SLAB_T, len);
        boxes.push({ m: M.compose(P, Q, S).clone(), c: tint.clone().multiplyScalar(1.08) });
        // Railing sheet at the slab's outer edge.
        P.set(cx + nx * (SLAB_D - 0.03), yb + SLAB_T + RAIL_H / 2, cz + nz * (SLAB_D - 0.03));
        S.set(len, RAIL_H, 1);
        rails.push({ m: M.compose(P, sheetQ, S).clone(), len });
      }
      // Shop awnings and signs (same deterministic bay rule as the facade shader).
      if (len > 6 && wallH > 6) {
        const nBays = Math.max(1, Math.floor(len / 3.2 + 0.5)), bayW = len / nBays;
        for (let b = 0; b < nBays; b++) {
          if (!isShopBay(seed, b)) continue;
          if (((seed + b * 31) % 7) > 3) continue;              // not every shop has an awning
          const t = (b + 0.5) * bayW;
          const px = ax + dx * t, pz = az + dz * t;
          const depth = 1.4;
          P.set(px + nx * depth * 0.5, groundY + 3.35 - 0.25, pz + nz * depth * 0.5);
          const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(dx, 0, dz), -0.35);
          const rot = sheetQ.clone().premultiply(tilt);
          S.set(depth, 1, bayW - 0.5);
          awnings.push({ m: M.compose(P, rot, S).clone(), c: new THREE.Color(AWNING_COLORS[(seed + b) % AWNING_COLORS.length]) });
        }
        if (signage) {
          // one fascia sign per run of consecutive shop bays (at most 3 bays wide)
          let b = 0;
          while (b < nBays) {
            if (!isShopBay(seed, b)) { b++; continue; }
            let e = b; while (e + 1 < nBays && e - b < 2 && isShopBay(seed, e + 1)) e++;
            const t0 = b * bayW + 0.15, t1 = (e + 1) * bayW - 0.15;
            const nameIdx = (seed * 3 + b * 5 + (q % 11)) % SHOP_NAMES.length;
            const lit = ((seed + b * 7 + q) % 2) === 0 ? 1 : 0;
            const tc = (t0 + t1) / 2;
            P.set(ax + dx * tc + nx * 0.08, groundY + SIGN_Y, az + dz * tc + nz * 0.08);
            S.set(t1 - t0, SIGN_H, 1);
            const rest = ((seed * 3 + b) % 10) < 3;   // some shops are restaurants / cafes open late
            const neon = lit && ((seed * 11 + b * 3 + q) % 6) === 0 ? 0.2 + 0.8 * (((seed + b) % 7) / 7) : 0;
            signs.push({ m: M.compose(P, faceOut, S).clone(), rect: signRect(signCell(nameIdx, (seed + b) % SIGN_PALETTES)), lit, neon });
            if (shopLightsOn) {
              // the display window lights the sidewalk in front of it (cool white, ~11 m); cafes glow warmer
              lights.push({ x: chunkOrigin.x + ax + dx * tc + nx * 1.2, y: groundY + 2.2, z: chunkOrigin.z + az + dz * tc + nz * 1.2, radius: 11, r: rest ? 1.0 : 0.95, g: rest ? 0.8 : 0.93, b: rest ? 0.55 : 0.85, intensity: rest ? 10 : 9, kind: rest ? 'restaurant' : 'shop' });
            }
            // terrace: a string of warm bulbs under the awning, lit while the cafe is open
            if (rest) for (let t = t0 + 0.5; t < t1 - 0.2; t += 1.5) terrace.push(ax + dx * t + nx * 0.95, groundY + 2.55, az + dz * t + nz * 0.95);
            if (nameIdx === PHARMACY) {
              // perpendicular green-cross flag over the shop entrance
              const tf = t0 + 0.3;
              P.set(ax + dx * tf + nx * 0.5, groundY + SIGN_Y + 0.85, az + dz * tf + nz * 0.5);
              S.set(0.7, 0.7, 1);
              const along = new THREE.Quaternion().setFromAxisAngle(up, yaw);   // plane normal along the wall
              signs.push({ m: M.compose(P, along, S).clone(), rect: signRect(PHARMACY_CELL), lit: 1 });
            }
            b = e + 1;
          }
        }
      }
    }
  }

  // Plaques: for each arm keep the closest facade on each side of the street.
  const best = new Map<string, { pd: number; m: THREE.Matrix4; key: string }>();
  for (const c of plaqueCands) {
    const k = `${c.arm.x}_${c.arm.z}_${c.arm.name}_${c.side}`;
    const cur = best.get(k);
    if (!cur || c.pd < cur.pd) best.set(k, { pd: c.pd, m: c.m, key: `${c.arm.name}|${c.arm.arr}` });
  }

  if (signageDebug() && best.size) {
    const list = [...best.values()].slice(0, 3).map(b => { const e = b.m.elements; const x = e[12] + chunkOrigin.x, z = e[14] + chunkOrigin.z; return `${b.key} at ${x.toFixed(1)},${e[13].toFixed(1)},${z.toFixed(1)} view fly=1&x=${(x + e[8] * 4).toFixed(1)}&y=${(e[13] - 0.3).toFixed(1)}&z=${(z + e[10] * 4).toFixed(1)}&yaw=${(Math.atan2(-e[8], e[10]) * 180 / Math.PI).toFixed(0)}&pitch=4`; });
    console.info(`[plaques] chunk ${chunkOrigin.x},${chunkOrigin.z}: ${plaqueCands.length} candidates -> ${best.size}; ${list.join(' | ')}`);
  }
  if (!boxes.length && !rails.length && !signs.length && !best.size) return null;
  const { boxMat, railMat, awningMat } = materials();
  const mkBoxes = (list: { m: THREE.Matrix4; c: THREE.Color }[], mat: THREE.Material, geom: THREE.BufferGeometry) => {
    const mesh = new THREE.InstancedMesh(geom, mat, Math.max(1, list.length));
    list.forEach((b, i) => { mesh.setMatrixAt(i, b.m); mesh.setColorAt(i, b.c); });
    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    return mesh;
  };
  const boxesMesh = mkBoxes(boxes, boxMat, boxGeom);
  const awningsMesh = mkBoxes(awnings, awningMat, planeGeom);
  const railGeom = planeGeom.clone();
  railGeom.setAttribute('railLen', new THREE.InstancedBufferAttribute(new Float32Array(rails.map(r => r.len)), 1));
  const railsMesh = new THREE.InstancedMesh(railGeom, railMat, Math.max(1, rails.length));
  rails.forEach((r, i) => railsMesh.setMatrixAt(i, r.m));
  railsMesh.count = rails.length;
  railsMesh.instanceMatrix.needsUpdate = true;
  railsMesh.castShadow = true; railsMesh.frustumCulled = false;

  const signsMesh = signs.length ? instancedQuads(signs, shopSignMaterial(), false) : null;
  let plaquesMesh: THREE.InstancedMesh | null = null;
  let plaqueTex: THREE.Texture | null = null, plaqueMat: THREE.Material | null = null;
  if (best.size) {
    const keys = [...new Set([...best.values()].map(b => b.key))];
    const { texture, rects } = plaqueCanvas(keys);
    plaqueTex = texture; plaqueMat = plaqueMaterial(texture);
    plaquesMesh = instancedQuads([...best.values()].map(b => ({ m: b.m, rect: rects.get(b.key)!, lit: 0 })), plaqueMat, false);
  }
  const meshes: THREE.Object3D[] = [boxesMesh, railsMesh, awningsMesh];
  if (signsMesh) meshes.push(signsMesh);
  if (plaquesMesh) meshes.push(plaquesMesh);
  const terraceMesh = terrace.length ? terraceGlare(new Float32Array(terrace)) : null;
  if (terraceMesh) meshes.push(terraceMesh);
  return {
    boxes: boxesMesh, rails: railsMesh, awnings: awningsMesh, signs: signsMesh, plaques: plaquesMesh, meshes,
    count: boxes.length + rails.length + awnings.length + signs.length + best.size, signCount: signs.length, plaqueCount: best.size, lights,
    dispose() {
      boxesMesh.dispose(); railsMesh.dispose(); awningsMesh.dispose(); railGeom.dispose();
      if (signsMesh) { signsMesh.geometry.dispose(); signsMesh.dispose(); }
      if (plaquesMesh) { plaquesMesh.geometry.dispose(); plaquesMesh.dispose(); }
      if (terraceMesh) { terraceMesh.geometry.dispose(); (terraceMesh.material as THREE.Material).dispose(); }
      plaqueMat?.dispose(); plaqueTex?.dispose();
    },
  };
}
