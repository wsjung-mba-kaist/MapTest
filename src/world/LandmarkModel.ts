import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { withLamps } from '../render/LocalLights';
import { REFLECT_LAYER } from '../render/WaterReflection';
import { buildingUniforms } from '../materials/FacadeMaterial';

export interface LandmarkModelMeta {
  id: string; height?: number; top?: number; centre?: [number, number]; radius?: number; textured?: boolean; lod?: string;
  author?: string; license?: string; source?: string; title?: string;
  credits?: { title: string; author?: string; license: string; url: string };
  runtime?: { floodlit?: boolean; paint?: [number, number, number]; lodAtM?: number };
}

/**
 * A hero model baked by scripts/lib/models.ts: {id}.glb (full) and {id}_lod.glb (coarse), swapped by distance.
 * Photo-textured scans keep their texture (with a warm emissive wash at night for floodlit monuments); untextured
 * CAD models get a stone tint. The tower keeps its own class (sparkles, beacon, brown paint).
 */
export class LandmarkModel {
  readonly group = new THREE.Group();
  meta: LandmarkModelMeta;
  loaded = false;
  triangles = 0;
  private full?: THREE.Object3D;
  private lod?: THREE.Object3D;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private lodAt = 900;
  private centre = new THREE.Vector3();

  constructor(meta: LandmarkModelMeta, private readonly groundY: (x: number, z: number) => number) {
    this.meta = meta;
    this.group.name = `landmark:${meta.id}`;
    this.lodAt = meta.runtime?.lodAtM ?? 900;
    if (meta.centre) this.centre.set(meta.centre[0], 0, meta.centre[1]);
  }

  static async loadAll(url: string, groundY: (x: number, z: number) => number, lodOnly = false): Promise<LandmarkModel[]> {
    let index: { models: { id: string; glb: string; lod?: string; json: string }[] };
    try { index = await (await fetch(url)).json(); } catch { return []; }
    const out: LandmarkModel[] = [];
    for (const m of index.models ?? []) {
      if (m.id === 'eiffel') continue;
      try {
        const meta = await (await fetch(`/models/${m.json}`)).json() as LandmarkModelMeta;
        const lm = new LandmarkModel({ ...meta, id: m.id, lod: m.lod }, groundY);
        await lm.load(`/models/${m.glb}`, m.lod ? `/models/${m.lod}` : undefined, lodOnly);
        out.push(lm);
      } catch (e) { console.warn(`landmark model ${m.id} failed`, e); }
    }
    return out;
  }

  async load(glbUrl: string, lodUrl?: string, lodOnly = false) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const y = this.groundY(this.centre.x, this.centre.z);
    const adopt = (scene: THREE.Object3D) => {
      scene.updateMatrixWorld(true);
      scene.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true; m.frustumCulled = true;
        m.layers.enable(REFLECT_LAYER);
        const g = m.geometry; const idx = g.index;
        this.triangles += (idx ? idx.count : g.attributes.position.count) / 3;
        m.material = this.adaptMaterial(m.material as THREE.MeshStandardMaterial);
      });
      scene.position.y = y;
      return scene;
    };
    if (lodUrl && lodOnly) { this.lod = adopt((await loader.loadAsync(lodUrl)).scene); this.group.add(this.lod); }
    else {
      this.full = adopt((await loader.loadAsync(glbUrl)).scene); this.group.add(this.full);
      if (lodUrl) { try { this.lod = adopt((await loader.loadAsync(lodUrl)).scene); this.lod.visible = false; this.group.add(this.lod); } catch { /* full model only */ } }
    }
    this.loaded = true;
  }

  private adaptMaterial(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const textured = !!src.map;
    const mat = textured ? src : new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0 });
    if (textured) {
      mat.roughness = Math.max(0.6, mat.roughness); mat.envMapIntensity = 0.6;
      if (mat.map) { mat.map.anisotropy = 8; mat.map.colorSpace = THREE.SRGBColorSpace; }
      if (this.meta.runtime?.floodlit) { mat.emissiveMap = mat.map; mat.emissive = new THREE.Color(0, 0, 0); }
    } else {
      const p = this.meta.runtime?.paint ?? [222, 214, 196];
      mat.color.setRGB(p[0] / 255, p[1] / 255, p[2] / 255);
      mat.side = src.side;
      mat.emissive = new THREE.Color(0, 0, 0);
    }
    withLamps(mat);
    this.materials.push(mat);
    return mat;
  }

  update(night: number, px: number, pz: number) {
    if (this.full && this.lod) {
      const far = Math.hypot(this.centre.x - px, this.centre.z - pz) > this.lodAt;
      if (this.full.visible === far) { this.full.visible = !far; this.lod.visible = far; }
    }
    if (this.meta.runtime?.floodlit) {
      const k = night * (buildingUniforms.uNight.value >= 0 ? 1 : 1);
      for (const m of this.materials) m.emissive.setRGB(1.0, 0.78, 0.55).multiplyScalar((m.emissiveMap ? 0.35 : 0.12) * k);
    }
  }
}
