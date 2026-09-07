import * as THREE from 'three';
import { CHUNK_SIZE, GRID_N, chunkKey, chunkOrigin } from '../../shared/layout';
import { DATA_URL, loadBinMesh, PriorityLoader } from './DataLoader';
import { withLamps } from '../render/LocalLights';

/**
 * Road markings (zebra crossings, lane dashes) streamed per chunk as thin decal strips drawn just above the ground.
 * Analytic edge anti-aliasing from the across coordinate, distance fade so thin dashes never shimmer, a little wear.
 * `debug` paints every strip opaque magenta through everything (?marksdebug=1).
 */
export class Markings {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private readonly loader = new PriorityLoader(3);
  private readonly meshes = new Map<string, THREE.Mesh | null>();
  private readonly requested = new Set<string>();
  private playerX = 0; private playerZ = 0;
  loadDistance = 460;
  unloadDistance = 720;
  count = 0;
  lastError = '';

  constructor(readonly debug = false) {
    this.group.name = 'marks';
    this.material = new THREE.MeshStandardMaterial({
      color: debug ? 0xff00ff : 0xe8e6df, emissive: debug ? 0xff00ff : 0x000000, roughness: 0.6, metalness: 0,
      transparent: !debug, depthWrite: debug, depthTest: !debug,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.material.customProgramCacheKey = () => `road-marks${debug ? '-dbg' : ''}`;
    this.material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 muv; attribute float mkind; varying vec2 vMuv; varying float vKind; varying vec2 vWorldXZm;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMuv = muv; vKind = mkind; vWorldXZm = (modelMatrix * vec4(position, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vMuv; varying float vKind; varying vec2 vWorldXZm;\nfloat mhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }')
        .replace('#include <alphamap_fragment>', /* glsl */`#include <alphamap_fragment>
          #ifndef MARKS_DEBUG
          float aaM = fwidth(vMuv.x) * 1.2;
          float cov = smoothstep(0.0, aaM + 0.02, 1.0 - abs(vMuv.x));
          float distM = length(vViewPosition);
          bool thin = vKind > 0.5 && vKind < 2.5;
          float far = thin ? 1.0 - smoothstep(70.0, 130.0, distM) : 1.0 - smoothstep(160.0, 280.0, distM);
          vec2 wp = floor(vWorldXZm * 3.0);
          float wear = 0.72 + 0.28 * mhash(wp);
          diffuseColor.a *= cov * far * wear;
          if (diffuseColor.a < 0.02) discard;
          #endif`);
    };
    if (debug) this.material.defines = { MARKS_DEBUG: '' };
    withLamps(this.material);
  }

  get requestedCount() { return this.requested.size; }
  get stats() { return `marks ${this.count}/${this.requested.size}${this.lastError ? ' ERR ' + this.lastError : ''}`; }

  update(x: number, z: number) {
    this.playerX = x; this.playerZ = z;
    const ld2 = this.loadDistance ** 2, ud2 = this.unloadDistance ** 2;
    for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
      const k = chunkKey(i, j);
      const o = chunkOrigin(i, j);
      const d2 = (o.x + CHUNK_SIZE / 2 - x) ** 2 + (o.z + CHUNK_SIZE / 2 - z) ** 2;
      if (d2 < ld2 && !this.requested.has(k)) {
        this.requested.add(k);
        this.loader.add(k, () => (o.x + CHUNK_SIZE / 2 - this.playerX) ** 2 + (o.z + CHUNK_SIZE / 2 - this.playerZ) ** 2, async () => {
          try {
            const bm = await loadBinMesh(`${DATA_URL}/marks/${k}.bin`);
            if (!this.requested.has(k)) return;   // unloaded while the fetch was in flight: drop it
            const s = bm.sections.get('marks');
            if (!s) { this.meshes.set(k, null); return; }
            const m = new THREE.Mesh(s.geometry, this.material);
            m.position.set(o.x, 0, o.z); m.matrixAutoUpdate = false; m.updateMatrix();
            m.renderOrder = 2; m.receiveShadow = true; m.castShadow = false; m.frustumCulled = true;
            m.name = `marks_${k}`;
            this.group.add(m);
            this.meshes.set(k, m);
            this.count++;
          } catch (e) {
            this.lastError = `${k}: ${String((e as Error)?.message ?? e).slice(0, 80)}`;
            console.warn('marks load failed', k, e);
          }
        });
      } else if (d2 > ud2 && this.requested.has(k)) {
        const m = this.meshes.get(k);
        if (m) { this.group.remove(m); m.geometry.dispose(); this.count--; }
        else this.loader.cancel(k);   // still queued: take the request back so it can be re-issued later
        this.meshes.delete(k); this.requested.delete(k);
      }
    }
  }
}
