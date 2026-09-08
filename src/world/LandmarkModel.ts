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
  runtime?: {
    floodlit?: boolean; paint?: [number, number, number]; lodAtM?: number; metalness?: number; roughness?: number;
    /** Multiplies a scan's base colour (values may exceed 1): photogrammetry textures often bake in shadow. */
    tint?: [number, number, number];
    /** Draw both faces — scans frequently have inconsistent winding, which reads as holes punched in the surface. */
    doubleSided?: boolean;
    /** Masonry pedestal built under the model, which is then raised to stand on it. */
    pedestal?: { height: number; baseW: number; topW: number; stepH?: number; stepW?: number; colour?: [number, number, number] };
  };
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
    // Load them side by side: awaiting each in turn made boot wait for the sum of every model's fetch and parse.
    const loaded = await Promise.all((index.models ?? []).filter(m => m.id !== 'eiffel').map(async m => {
      try {
        const meta = await (await fetch(`/models/${m.json}`)).json() as LandmarkModelMeta;
        const lm = new LandmarkModel({ ...meta, id: m.id, lod: m.lod }, groundY);
        await lm.load(`/models/${m.glb}`, m.lod ? `/models/${m.lod}` : undefined, lodOnly);
        return lm;
      } catch (e) { console.warn(`landmark model ${m.id} failed`, e); return null; }
    }));
    return loaded.filter((m): m is LandmarkModel => m !== null);
  }

  async load(glbUrl: string, lodUrl?: string, lodOnly = false) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    let y = this.groundY(this.centre.x, this.centre.z);
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
    // A monument's pedestal is masonry, not part of the sculpture, so models never ship one. Build it and stand the
    // model on top: the Liberty replica on the Ile aux Cygnes rises from a tapered limestone block on a low platform.
    const ped = this.meta.runtime?.pedestal;
    if (ped) {
      this.group.add(buildPedestal(ped, y, this.centre.x, this.centre.z));
      y += ped.height + (ped.stepH ?? 0.35);
    }
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
      mat.roughness = this.meta.runtime?.roughness ?? Math.max(0.6, mat.roughness); mat.envMapIntensity = 0.6;
      // Photogrammetry and asset-store models often ship a near-metal PBR material (this one is metalness 0.9).
      // A metal has no diffuse term, so under our modest environment intensity it renders as a black silhouette
      // speckled with reflections. Real subjects here are stone, plaster and oxidised copper, all dielectric.
      mat.metalness = this.meta.runtime?.metalness ?? Math.min(mat.metalness, 0.15);
      const t = this.meta.runtime?.tint;
      if (t) mat.color.setRGB(t[0], t[1], t[2]);           // three multiplies the map by this, so > 1 lifts a dark scan
      if (this.meta.runtime?.doubleSided) mat.side = THREE.DoubleSide;
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

  /**
   * Uplighters ringing the platform, as the monument is lit after dark. Returned for the local-light array rather
   * than added here, so they share the same budget and falloff as the street lamps.
   */
  floodlights(): { x: number; y: number; z: number; radius: number; r: number; g: number; b: number; intensity: number; kind: 'tower' }[] {
    const ped = this.meta.runtime?.pedestal;
    if (!this.meta.runtime?.floodlit || !ped) return [];
    const y = this.groundY(this.centre.x, this.centre.z) + (ped.stepH ?? 0.35) + 0.3;
    const r = (ped.stepW ?? ped.baseW + 2.4) / 2 - 0.6;
    return [0, 1, 2, 3].map(k => {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      return { x: this.centre.x + Math.cos(a) * r, y, z: this.centre.z + Math.sin(a) * r, radius: 26, r: 1.0, g: 0.88, b: 0.72, intensity: 16, kind: 'tower' as const };
    });
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

/**
 * Tapered masonry pedestal on a low step platform, in world coordinates. Plain boxes: at the distance these are
 * read from, the taper and the step are the whole silhouette.
 */
function buildPedestal(p: NonNullable<NonNullable<LandmarkModelMeta['runtime']>['pedestal']>, groundY: number, cx: number, cz: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'pedestal';
  const stepH = p.stepH ?? 0.35, stepW = p.stepW ?? p.baseW + 2.4;
  const colour = p.colour ?? [216, 210, 196];
  const mat = withLamps(new THREE.MeshStandardMaterial({ color: new THREE.Color(colour[0] / 255, colour[1] / 255, colour[2] / 255), roughness: 0.92, metalness: 0 }));
  const add = (geom: THREE.BufferGeometry, yMid: number) => {
    const m = new THREE.Mesh(geom, mat);
    m.position.set(cx, yMid, cz);
    m.castShadow = true; m.receiveShadow = true;
    m.layers.enable(REFLECT_LAYER);
    m.matrixAutoUpdate = false; m.updateMatrix();
    g.add(m);
  };
  add(new THREE.BoxGeometry(stepW, stepH, stepW), groundY + stepH / 2);
  // The shaft tapers from base to top; a box scaled per end would shear, so use a four-sided frustum.
  const shaft = new THREE.CylinderGeometry(p.topW / Math.SQRT2, p.baseW / Math.SQRT2, p.height, 4, 1);
  shaft.rotateY(Math.PI / 4);
  add(shaft, groundY + stepH + p.height / 2);
  // A thin cap course under the statue's feet, as in the photographs.
  add(new THREE.BoxGeometry(p.topW + 0.5, 0.3, p.topW + 0.5), groundY + stepH + p.height - 0.15);
  return g;
}
