import * as THREE from 'three';

const N = 3200;

/**
 * Rain: a box of falling streaks that follows the camera (positions wrap in a 36 x 26 x 36 m window around it, so
 * the same points serve wherever the viewer goes), drifting a little with the wind. Drawn as thin vertical bars
 * cut from point sprites; brightness fades with distance so it reads as rain, not as fog. Toggled by the weather.
 */
export class Rain {
  readonly points: THREE.Points;
  private readonly uniforms = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uOn: { value: 0 }, uNight: { value: 0 } };
  private level = 0;

  constructor() {
    const pos = new Float32Array(N * 3);
    let seed = 987654321;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < pos.length; i++) pos[i] = rnd();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        uniform float uTime; uniform vec3 uCam; uniform float uOn; uniform float uNight; varying float vA;
        void main() {
          vec3 box = vec3(36.0, 26.0, 36.0);
          vec3 p = position * box;
          float speed = 9.0 + 4.0 * position.x;
          vec3 origin = uCam - vec3(18.0, 12.0, 18.0);
          p.x = origin.x + mod(p.x - origin.x + uTime * 1.6, box.x);   // wind drift
          p.z = origin.z + mod(p.z - origin.z, box.z);
          p.y = origin.y + mod(p.y - origin.y - uTime * speed, box.y);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float d = max(0.5, -mv.z);
          gl_PointSize = clamp(70.0 / d, 1.0, 3.5);
          // by night only the drops near lights show; keep them a little dimmer overall
          vA = uOn * clamp(1.25 - d / 28.0, 0.0, 1.0) * mix(0.55, 0.35, uNight);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() { vec2 q = gl_PointCoord - 0.5; if (abs(q.x) > 0.2 || vA <= 0.003) discard; gl_FragColor = vec4(vec3(0.72, 0.76, 0.84), vA * (1.0 - abs(q.y) * 1.4)); }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 50;
    this.points.name = 'rain';
    this.points.visible = false;
  }

  /** 0..1 rain amount (fades in/out over a second or so). */
  set on(v: boolean) { this.level = v ? 1 : 0; }

  update(time: number, cam: THREE.Vector3, night: number, dt: number) {
    const u = this.uniforms;
    u.uTime.value = time; u.uCam.value.copy(cam); u.uNight.value = night;
    u.uOn.value += Math.max(-dt, Math.min(dt, this.level - u.uOn.value));
    this.points.visible = u.uOn.value > 0.01;
  }
}
