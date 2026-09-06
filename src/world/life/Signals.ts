import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PathGraph } from './PathGraph';
import { NodeFlag } from '../../../shared/paths';
import { hash32 } from '../../../shared/hash';
import { withLamps } from '../../render/LocalLights';

/**
 * Traffic lights at the graph's signal junctions (3+ drivable arms): one post per incoming arm on the right-hand
 * kerb, three lamps cycling red 14 s / green 15 s / amber 3 s with a per-junction phase. Visual only: cars do not
 * stop for them (yet). One instanced draw call.
 */
const CYCLE = 32;

export class Signals {
  readonly group = new THREE.Group();
  count = 0;
  private readonly uniforms = { uTime: { value: 0 }, uNight: { value: 0 } };

  constructor(graph: PathGraph) {
    this.group.name = 'signals';
    const posts: { x: number; y: number; z: number; yaw: number; phase: number }[] = [];
    const inc: number[] = [];
    const seen = new Set<string>();
    for (let n = 0; n < graph.nodeCount; n++) {
      if (!graph.nodeFlag(n, NodeFlag.SIGNAL)) continue;
      const phase = hash32(n, 41);
      for (const e of graph.incident(n, inc)) {
        if (!graph.drivable(e)) continue;
        // direction of travel INTO the node along this edge, from the last / first segment
        const v0 = graph.eV0[e], nv = graph.eNv[e];
        if (nv < 2) continue;
        const atEnd = graph.eB[e] === n;
        if (graph.isOneway(e) && !atEnd) continue;              // one-way arms only carry traffic in one direction
        const i = atEnd ? v0 + nv - 2 : v0 + 1, j = atEnd ? v0 + nv - 1 : v0;
        const dx = graph.vPos[j * 3] - graph.vPos[i * 3], dz = graph.vPos[j * 3 + 2] - graph.vPos[i * 3 + 2], l = Math.hypot(dx, dz) || 1;
        const ux = dx / l, uz = dz / l;                          // toward the node
        const rx = -uz, rz = ux;                                 // right of travel
        const off = graph.eWidth[e] / 2 + 0.7;
        const x = graph.nodeX(n) - ux * 4.5 + rx * off, z = graph.nodeZ(n) - uz * 4.5 + rz * off;
        const key = `${Math.round(x)}_${Math.round(z)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        posts.push({ x, y: graph.vPos[j * 3 + 1], z, yaw: Math.atan2(-ux, -uz) + Math.PI, phase });   // lamps face the arriving cars
      }
    }
    this.count = posts.length;
    if (!posts.length) return;
    const geom = signalGeometry();
    const phases = new Float32Array(posts.length);
    const mesh = new THREE.InstancedMesh(geom, signalMaterial(this.uniforms), posts.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), P = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    posts.forEach((p, k) => { P.set(p.x, p.y, p.z); Q.setFromAxisAngle(up, p.yaw); mesh.setMatrixAt(k, M.compose(P, Q, S)); phases[k] = p.phase; });
    geom.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
    this.group.add(mesh);
  }

  update(time: number, night: number) { this.uniforms.uTime.value = time; this.uniforms.uNight.value = night; }
}

/** Pole + head + three lamp discs (aEmit 1 red, 2 amber, 3 green); the head faces -z at yaw 0. */
function signalGeometry(): THREE.BufferGeometry {
  const tag = (g: THREE.BufferGeometry, emit: number) => {
    const n = g.attributes.position.count;
    g.setAttribute('aEmit', new THREE.BufferAttribute(new Float32Array(n).fill(emit), 1));
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    return g.toNonIndexed();
  };
  const pole = tag(new THREE.CylinderGeometry(0.06, 0.07, 3.0, 8).translate(0, 1.5, 0), 0);
  const head = tag(new THREE.BoxGeometry(0.3, 0.95, 0.24).translate(0, 3.35, 0), 0);
  const lamps: THREE.BufferGeometry[] = [];
  [[1, 3.65], [2, 3.35], [3, 3.05]].forEach(([emit, y]) => lamps.push(tag(new THREE.CircleGeometry(0.1, 12).rotateY(Math.PI).translate(0, y, -0.125), emit)));
  return mergeGeometries([pole, head, ...lamps], false)!;
}

function signalMaterial(uniforms: { uTime: { value: number }; uNight: { value: number } }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.6, metalness: 0.4 });
  mat.customProgramCacheKey = () => 'traffic-signal';
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEmit; attribute float aPhase; varying float vEmit; varying float vPhase;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmit = aEmit; vPhase = aPhase;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uNight; varying float vEmit; varying float vPhase;')
      .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
        if (vEmit > 0.5) {
          float t = fract((uTime + vPhase * ${CYCLE.toFixed(1)}) / ${CYCLE.toFixed(1)});
          int state = t < 0.47 ? 3 : (t < 0.56 ? 2 : 1);          // green, amber, red
          bool on = int(vEmit + 0.5) == state;
          vec3 col = vEmit < 1.5 ? vec3(1.0, 0.08, 0.03) : (vEmit < 2.5 ? vec3(1.0, 0.55, 0.05) : vec3(0.10, 1.0, 0.35));
          diffuseColor.rgb = on ? col * 0.6 : col * 0.08;
          totalEmissiveRadiance += on ? col * (1.0 + 0.6 * uNight) : vec3(0.0);
        }`);
  };
  return withLamps(mat);
}
