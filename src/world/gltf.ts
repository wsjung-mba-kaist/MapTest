import * as THREE from 'three';
import { withLamps } from '../render/LocalLights';
import { REFLECT_LAYER } from '../render/WaterReflection';

export interface AdoptOptions {
  /** every mesh's material goes through this (see adaptGltfMaterial) and is collected into `materials` */
  adapt: (src: THREE.MeshStandardMaterial) => THREE.MeshStandardMaterial;
  /** receives each adapted material, one entry per mesh, for the per-frame emissive wash */
  materials: THREE.MeshStandardMaterial[];
  /** draw the meshes in the river reflection; the tower instead enables the layer for its whole group later (Eiffel.enableReflection) */
  reflect?: boolean;
  /** per-mesh hook after the common flags (the tower samples its sparkle points here) */
  onMesh?: (m: THREE.Mesh) => void;
}

/**
 * Common adoption of a hero glTF (the tower and the landmark models): world matrices settled, every mesh casting and
 * receiving shadows and frustum-culled, its material adapted, its triangles counted (returned, for the HUD).
 */
export function adoptGltfScene(scene: THREE.Object3D, opts: AdoptOptions): number {
  let triangles = 0;
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = true;
    if (opts.reflect) m.layers.enable(REFLECT_LAYER);
    const g = m.geometry, idx = g.index;
    triangles += (idx ? idx.count : g.attributes.position.count) / 3;
    const mat = opts.adapt(m.material as THREE.MeshStandardMaterial);
    m.material = mat; opts.materials.push(mat);
    opts.onMesh?.(m);
  });
  return triangles;
}

export interface AdaptOptions {
  /** parameters of the fresh material an untextured (CAD) model gets */
  untextured?: THREE.MeshStandardMaterialParameters;
  /** a photo-textured scan's map doubles as its emissive map, so the night wash follows the photo (floodlit monuments) */
  glow: boolean;
  /** the model-specific colour / roughness / metalness, applied before the lamp hook */
  tune: (mat: THREE.MeshStandardMaterial, src: THREE.MeshStandardMaterial, textured: boolean) => void;
}

/**
 * The material path both hero classes shared: a photogrammetry scan keeps its own material (texture filtered and tagged
 * sRGB — glTF loaders leave it linear when the material is replaced), an untextured model gets a fresh
 * MeshStandardMaterial that keeps the source's face side; both start with a black emissive the night wash drives and
 * end hooked into the street lamps.
 */
export function adaptGltfMaterial(src: THREE.MeshStandardMaterial, opts: AdaptOptions): THREE.MeshStandardMaterial {
  const textured = !!src.map;
  const mat = textured ? src : new THREE.MeshStandardMaterial(opts.untextured);
  if (textured) {
    if (mat.map) { mat.map.anisotropy = 8; mat.map.colorSpace = THREE.SRGBColorSpace; }
    if (opts.glow) { mat.emissiveMap = mat.map; mat.emissive = new THREE.Color(0, 0, 0); }
  } else { mat.side = src.side; mat.emissive = new THREE.Color(0, 0, 0); }
  opts.tune(mat, src, textured);
  return withLamps(mat);
}
