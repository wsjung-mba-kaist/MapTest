import * as THREE from 'three';
import { withLamps } from '../render/LocalLights';
import { buildingUniforms } from '../materials/FacadeMaterial';
import type { PlaquesData } from '../../shared/layout';

/**
 * Canvas-drawn signage: a static atlas of generic French shop-front signs (no brands) and per-chunk street-name
 * plaques (blue enamel, green arrondissement header). Both are instanced quads whose instance attribute aRect picks
 * the atlas cell; shop signs glow at night (aLit), plaques only catch the lamp light.
 */

export const SHOP_NAMES = [
  'BOULANGERIE', 'PÂTISSERIE', 'BOUCHERIE', 'CHARCUTERIE', 'FROMAGERIE', 'POISSONNERIE', 'PRIMEUR', 'ÉPICERIE',
  'CAVISTE', 'TABAC', 'PRESSE', 'PHARMACIE', 'OPTIQUE', 'FLEURISTE', 'LIBRAIRIE', 'PAPETERIE',
  'COIFFEUR', 'INSTITUT', 'PRESSING', 'CORDONNERIE', 'SERRURERIE', 'QUINCAILLERIE', 'TRAITEUR', 'CAFÉ',
  'BRASSERIE', 'RESTAURANT', 'BISTROT', 'CRÊPERIE', 'SALON DE THÉ', 'GLACIER', 'CHOCOLATIER', 'BIJOUTERIE',
  'HORLOGERIE', 'ANTIQUITÉS', 'GALERIE', 'IMMOBILIER', 'BANQUE', 'ASSURANCES', 'LAVERIE', 'BOUTIQUE',
];
export const PHARMACY = SHOP_NAMES.indexOf('PHARMACIE');
const SERIF = new Set(['BOULANGERIE', 'PÂTISSERIE', 'BOUCHERIE', 'CHARCUTERIE', 'FROMAGERIE', 'CAVISTE', 'TRAITEUR', 'BRASSERIE', 'BISTROT', 'SALON DE THÉ', 'CHOCOLATIER', 'ANTIQUITÉS', 'HORLOGERIE']);
const PALETTES: [string, string][] = [['#1f3d2b', '#e6c46a'], ['#5a1e22', '#f1e6cf'], ['#1d2b4a', '#f4f4f4'], ['#141414', '#d8b45a'], ['#efe6d2', '#1a1a1a'], ['#2e2e33', '#f2f2f2']];
export const SIGN_PALETTES = 3;
const SIGN_COLS = 8, SIGN_CELL_W = 256, SIGN_CELL_H = 128, SIGN_SIZE = 2048;   // 8 x 16 cells
export const PHARMACY_CELL = SHOP_NAMES.length * SIGN_PALETTES;                 // green cross cell

let enabled = true;
export function setSignageEnabled(v: boolean) { enabled = v; }
export function signageEnabled() { return enabled; }

/** Atlas cell rectangle [u0, v0, u1, v1] for a top-left based grid on a flipY canvas texture. */
function cellRect(idx: number, cols: number, cellW: number, cellH: number, W: number, H: number): [number, number, number, number] {
  const c = idx % cols, r = Math.floor(idx / cols);
  const u0 = (c * cellW + 1) / W, u1 = ((c + 1) * cellW - 1) / W;
  const v1 = 1 - (r * cellH + 1) / H, v0 = 1 - ((r + 1) * cellH - 1) / H;
  return [u0, v0, u1, v1];
}
export function signCell(nameIdx: number, palette: number) { return nameIdx * SIGN_PALETTES + (palette % SIGN_PALETTES); }
export function signRect(cell: number) { return cellRect(cell, SIGN_COLS, SIGN_CELL_W, SIGN_CELL_H, SIGN_SIZE, SIGN_SIZE); }

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, family: string, start: number, weight = 'bold'): number {
  let size = start;
  for (; size > 12; size -= 2) { ctx.font = `${weight} ${size}px ${family}`; if (ctx.measureText(text).width <= maxW) break; }
  return size;
}

let shopTex: THREE.CanvasTexture | null = null;
export function shopAtlas(): THREE.CanvasTexture {
  if (shopTex) return shopTex;
  const c = document.createElement('canvas'); c.width = c.height = SIGN_SIZE;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, SIGN_SIZE, SIGN_SIZE);
  SHOP_NAMES.forEach((name, ni) => {
    for (let p = 0; p < SIGN_PALETTES; p++) {
      const cell = signCell(ni, p);
      const [bg, fg] = PALETTES[(ni + p * 2) % PALETTES.length];
      const x = (cell % SIGN_COLS) * SIGN_CELL_W, y = Math.floor(cell / SIGN_COLS) * SIGN_CELL_H;
      ctx.fillStyle = bg; ctx.fillRect(x, y, SIGN_CELL_W, SIGN_CELL_H);
      ctx.strokeStyle = fg; ctx.globalAlpha = 0.55; ctx.lineWidth = 4; ctx.strokeRect(x + 8, y + 8, SIGN_CELL_W - 16, SIGN_CELL_H - 16); ctx.globalAlpha = 1;
      const family = SERIF.has(name) ? 'Georgia, "Times New Roman", serif' : 'Arial, Helvetica, sans-serif';
      const size = fitText(ctx, name, SIGN_CELL_W - 40, family, 54);
      ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(name, x + SIGN_CELL_W / 2, y + SIGN_CELL_H / 2 + size * 0.04);
    }
  });
  // pharmacy cross
  {
    const x = (PHARMACY_CELL % SIGN_COLS) * SIGN_CELL_W, y = Math.floor(PHARMACY_CELL / SIGN_COLS) * SIGN_CELL_H;
    ctx.fillStyle = '#0b7a3b'; ctx.fillRect(x, y, SIGN_CELL_W, SIGN_CELL_H);
    ctx.fillStyle = '#e9fff0';
    const cx = x + SIGN_CELL_W / 2, cy = y + SIGN_CELL_H / 2, arm = 44, t = 14;
    ctx.fillRect(cx - t, cy - arm, 2 * t, 2 * arm); ctx.fillRect(cx - arm, cy - t, 2 * arm, 2 * t);
  }
  shopTex = new THREE.CanvasTexture(c);
  shopTex.colorSpace = THREE.SRGBColorSpace; shopTex.anisotropy = 8;
  shopTex.generateMipmaps = true; shopTex.minFilter = THREE.LinearMipmapLinearFilter;
  return shopTex;
}

function patchSignShader(mat: THREE.MeshStandardMaterial, key: string, glow: boolean) {
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = shader => {
    shader.uniforms.uNight = buildingUniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRect; attribute float aLit; attribute float aNeon; varying vec2 vSignUv; varying float vLit; varying float vNeon;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSignUv = mix(aRect.xy, aRect.zw, uv); vLit = aLit; vNeon = aNeon;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSignUv; varying float vLit; varying float vNeon; uniform float uNight;')
      .replace('#include <map_fragment>', 'vec4 signTex = texture2D(map, vSignUv); diffuseColor *= signTex;')
      // a sixth of the lit signs are neon tubes: saturated pink / blue / red-orange after dark
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${glow ? 'vec3 neonCol = vNeon < 0.34 ? vec3(1.0, 0.22, 0.45) : (vNeon < 0.67 ? vec3(0.25, 0.65, 1.0) : vec3(1.0, 0.35, 0.15)); totalEmissiveRadiance += signTex.rgb * (0.15 + vLit * uNight * 1.1) * mix(vec3(1.0), neonCol * 2.2, step(0.01, vNeon) * uNight);' : ''}`);
  };
  withLamps(mat);
}

let shopMat: THREE.MeshStandardMaterial | null = null;
let debugMat: THREE.Material | null = null;
let debug = false;
/** ?signsdebug=1: plain magenta quads (no custom shader), to separate placement problems from shader problems. */
export function setSignageDebug(v: boolean) { debug = v; }
export function signageDebug() { return debug; }
export function shopSignMaterial(): THREE.Material {
  if (debug) return debugMat ??= new THREE.MeshBasicMaterial({ color: 0xff00ff, side: THREE.DoubleSide });
  if (shopMat) return shopMat;
  shopMat = new THREE.MeshStandardMaterial({ map: shopAtlas(), roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide });
  patchSignShader(shopMat, 'shop-sign', true);
  return shopMat;
}

// ---------------------------------------------------------------------------------------------- street-name plaques

export const PLAQUE_COLS = 4, PLAQUE_CELL_W = 256, PLAQUE_CELL_H = 128;

function wrapName(ctx: CanvasRenderingContext2D, name: string, maxW: number): string[] {
  const words = name.toUpperCase().split(/\s+/);
  const lines: string[] = []; let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

/** One canvas texture holding every plaque a chunk needs; returns the texture and the cell rect per key ("name|arr"). */
export function plaqueCanvas(keys: string[]): { texture: THREE.CanvasTexture; rects: Map<string, [number, number, number, number]> } {
  const rows = Math.max(1, Math.ceil(keys.length / PLAQUE_COLS));
  const W = PLAQUE_COLS * PLAQUE_CELL_W, H = rows * PLAQUE_CELL_H;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  const rects = new Map<string, [number, number, number, number]>();
  keys.forEach((key, i) => {
    const [name, arrS] = key.split('|');
    const x = (i % PLAQUE_COLS) * PLAQUE_CELL_W, y = Math.floor(i / PLAQUE_COLS) * PLAQUE_CELL_H;
    // enamel plate: dark blue field, white border, green header band
    ctx.fillStyle = '#16407a'; ctx.fillRect(x, y, PLAQUE_CELL_W, PLAQUE_CELL_H);
    ctx.strokeStyle = '#f2f4f7'; ctx.lineWidth = 5; ctx.strokeRect(x + 6, y + 6, PLAQUE_CELL_W - 12, PLAQUE_CELL_H - 12);
    ctx.fillStyle = '#2e7d46'; ctx.fillRect(x + 9, y + 9, PLAQUE_CELL_W - 18, 30);
    ctx.fillStyle = '#f2f4f7'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 19px Arial, Helvetica, sans-serif';
    ctx.fillText(`${arrS}${arrS === '1' ? 'ER' : 'E'} ARR.`, x + PLAQUE_CELL_W / 2, y + 24);
    ctx.font = 'bold 30px Arial, Helvetica, sans-serif';
    const lines = wrapName(ctx, name, PLAQUE_CELL_W - 36);
    const size = lines.length >= 3 ? 20 : lines.length === 2 ? 25 : 30;
    ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    const lineH = size + 4, top = y + 44 + (PLAQUE_CELL_H - 50 - lines.length * lineH) / 2 + lineH / 2;
    lines.forEach((ln, k) => {
      let s = size; while (s > 12 && ctx.measureText(ln).width > PLAQUE_CELL_W - 30) { s -= 1; ctx.font = `bold ${s}px Arial, Helvetica, sans-serif`; }
      ctx.fillText(ln, x + PLAQUE_CELL_W / 2, top + k * lineH);
      ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    });
    rects.set(key, cellRect(i, PLAQUE_COLS, PLAQUE_CELL_W, PLAQUE_CELL_H, W, H));
  });
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture, rects };
}

export function plaqueMaterial(texture: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.35, metalness: 0.05 });
  patchSignShader(mat, 'street-plaque', false);
  return mat;
}

// ---------------------------------------------------------------------------------------------- plaque index

export interface PlaqueArm { x: number; z: number; ux: number; uz: number; name: string; arr: number }
const CELL = 32;
let armGrid: Map<string, PlaqueArm[]> | null = null;
let armCount = 0;

export function setPlaques(data: PlaquesData) {
  armGrid = new Map();
  armCount = 0;
  for (const r of data.arms) {
    const arm: PlaqueArm = { x: r[0], z: r[1], ux: r[2], uz: r[3], name: data.names[r[4]] ?? '', arr: r[5] };
    if (!arm.name) continue;
    const k = `${Math.floor(arm.x / CELL)}_${Math.floor(arm.z / CELL)}`;
    const a = armGrid.get(k); if (a) a.push(arm); else armGrid.set(k, [arm]);
    armCount++;
  }
}
export function plaqueArmCount() { return armCount; }

export function plaqueArmsNear(x: number, z: number, r: number, out: PlaqueArm[] = []): PlaqueArm[] {
  out.length = 0;
  if (!armGrid) return out;
  for (let gi = Math.floor((x - r) / CELL); gi <= Math.floor((x + r) / CELL); gi++)
    for (let gj = Math.floor((z - r) / CELL); gj <= Math.floor((z + r) / CELL); gj++)
      for (const a of armGrid.get(`${gi}_${gj}`) ?? []) if (Math.hypot(a.x - x, a.z - z) <= r) out.push(a);
  return out;
}
