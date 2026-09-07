import * as THREE from 'three';
import type { Landmark } from '../../shared/layout';

/**
 * Floating name tags above the landmarks: one sprite each (canvas text), visible from ~260 m, fading in by 150 m,
 * roughly constant on screen, drawn over the facades (wayfinding, not realism). The site the player is standing in
 * hides its own tag. `?labels=0` disables the layer.
 */
export class LandmarkLabels {
  readonly group = new THREE.Group();
  private readonly items: { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; lm: Landmark }[] = [];

  constructor(list: Landmark[], groundY: (x: number, z: number) => number) {
    this.group.name = 'landmarkLabels';
    for (const lm of list) {
      const tex = labelTexture(lm.short);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
      const sprite = new THREE.Sprite(mat);
      const h = Math.max(lm.facts?.height ?? 0, lm.category === 'bridge' ? 12 : 22) + 6;
      sprite.position.set(lm.x, groundY(lm.x, lm.z) + Math.min(h, 90), lm.z);
      sprite.renderOrder = 999; sprite.visible = false;
      sprite.center.set(0.5, 0);
      this.group.add(sprite);
      this.items.push({ sprite, mat, lm });
    }
  }

  update(px: number, pz: number, currentId: string | null) {
    for (const it of this.items) {
      const d = Math.hypot(it.lm.x - px, it.lm.z - pz);
      const fade = d > 260 ? 0 : d < 150 ? 1 : (260 - d) / 110;
      const near = d < 18 ? d / 18 : 1;
      const a = it.lm.id === currentId ? 0 : fade * near;
      it.mat.opacity = a; it.sprite.visible = a > 0.02;
      if (!it.sprite.visible) continue;
      const w = Math.max(8, Math.min(26, d * 0.07));
      it.sprite.scale.set(w, w / 4, 1);
    }
  }
}

function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 44px system-ui, -apple-system, "Segoe UI", sans-serif';
  const tw = Math.min(480, ctx.measureText(text).width + 48);
  const x0 = (512 - tw) / 2;
  ctx.fillStyle = 'rgba(8,10,16,0.78)';
  ctx.beginPath(); ctx.roundRect(x0, 18, tw, 84, 14); ctx.fill();
  ctx.fillStyle = '#e8c27a'; ctx.fillRect(x0 + 18, 92, tw - 36, 4);
  ctx.fillStyle = '#f4f1ea'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 56, 460);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
