import * as THREE from 'three';
import { REFLECT_LAYER } from '../render/WaterReflection';
import { DATA_URL, loadBinMesh } from './DataLoader';
import { createRoofTopMaterial, createWallMaterial } from '../materials/FacadeMaterial';

/** Bridge decks (ortho-projected), stone sides/piers and parapets. */
export class Bridges {
  readonly group = new THREE.Group();
  deck?: THREE.Mesh;
  parapet?: THREE.Mesh;
  stone?: THREE.Mesh;
  readonly deckMaterial = createRoofTopMaterial({ x: 0, z: 0 }, null, null);
  readonly stoneMaterial = createWallMaterial();
  count = 0;

  constructor() { this.group.name = 'bridges'; }

  async load() {
    const bm = await loadBinMesh(`${DATA_URL}/bridges.bin`);
    this.count = (bm.header.meta?.count as number) ?? 0;
    const mk = (name: string, mat: THREE.Material) => {
      const s = bm.sections.get(name);
      if (!s) return undefined;
      const m = new THREE.Mesh(s.geometry, mat);
      m.layers.enable(REFLECT_LAYER);
      m.name = `bridge_${name}`;
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    this.deck = mk('deck', this.deckMaterial);
    this.stone = mk('stone', this.stoneMaterial);
    this.parapet = mk('parapet', this.stoneMaterial);
  }

  setOverview(tex: THREE.Texture | null) { this.deckMaterial.setOverview(tex); }
}
