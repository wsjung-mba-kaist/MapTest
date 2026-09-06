import * as THREE from 'three';
import Stats from 'stats-gl';
import { Loop } from './Loop';
import { setSignageDebug, setSignageEnabled } from '../world/Signage';
import { setShopLights } from '../world/BuildingDetails';
import { towerLit, towerSparkle } from '../../shared/nightlife';
import { setWet } from '../materials/GroundMaterial';
import { Minimap } from '../ui/Minimap';
import { TouchControls } from '../ui/TouchControls';
import { AudioEngine } from '../audio/Audio';
import { TowerAccess, type Hotspot } from '../world/TowerAccess';
import { createRenderer } from './Renderer';
import { Hud, formatHour } from '../ui/Hud';
import { copyText, saveCanvas, shareUrl } from '../ui/Share';
import { localLights } from '../render/LocalLights';
import { buildingUniforms } from '../materials/FacadeMaterial';
import { WaterReflection } from '../render/WaterReflection';
import { Input } from '../player/Input';
import { FlyControls } from '../player/FlyControls';
import { FirstPersonController } from '../player/FirstPersonController';
import { Collision } from '../player/Collision';
import { World } from '../world/World';
import { Environment } from '../render/Environment';
import { Post } from '../render/Post';

/** Named viewpoints (world x/z; yaw defaults to facing the tower). */
export const VIEWPOINTS: { key: string; name: string; x: number; z: number; yaw?: number }[] = [
  { key: 'Digit1', name: 'Trocadéro', x: -480, z: -409 },
  { key: 'Digit2', name: "Pont d'Iéna", x: -190, z: -200 },
  { key: 'Digit3', name: 'Under the tower', x: 0, z: 70 },
  { key: 'Digit4', name: 'Champ de Mars', x: 290, z: 380 },
  { key: 'Digit5', name: 'École Militaire', x: 600, z: 760 },
  { key: 'Digit6', name: 'Bir-Hakeim', x: -540, z: 380 },
  { key: 'Digit7', name: 'Quai Branly', x: 260, z: -80 },
  { key: 'Digit8', name: 'Tower 2nd floor (view)', x: -42, z: -30 },
];

/** yaw so that the camera at (x,z) faces (tx,tz); yaw 0 = north (-z), clockwise positive. */
export const yawTo = (x: number, z: number, tx = 0, tz = 0) => Math.atan2(tx - x, -(tz - z));

export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly loop = new Loop();
  readonly hud = new Hud();
  readonly input: Input;
  readonly world = new World();
  readonly stats: Stats;
  readonly fly: FlyControls;
  readonly collision = new Collision();
  readonly env: Environment;
  readonly post: Post;
  player!: FirstPersonController;
  minimap!: Minimap;
  audio!: AudioEngine;
  touch!: TouchControls;
  readonly tower = new TowerAccess();
  private headlights = true;
  towerAlwaysOn = false;
  private hotspot: Hotspot | null = null;
  flying = false;
  private captureRequested = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.2, 9000);
    this.input = new Input(canvas);
    this.fly = new FlyControls(this.camera, this.input);
    this.scene.add(this.world.group);
    this.env = new Environment(this.scene, this.renderer);
    this.post = new Post(this.renderer, this.scene, this.camera);
    this.stats = new Stats({ trackGPU: false, horizontal: true });
    this.stats.dom.style.cssText = 'position:fixed;left:8px;top:8px;opacity:.8;z-index:10';
    document.body.appendChild(this.stats.dom);
    this.stats.init(this.renderer);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h);
  }

  async boot() {
    const tower = new URLSearchParams(location.search).get('tower');
    if (tower === 'lattice') this.world.towerKind = 'lattice';
    else if (tower === 'scan' || tower === 'model' || tower === 'glb') this.world.towerKind = 'scan';
    if (new URLSearchParams(location.search).get('skyenv') === '1') this.env.useHdri = false;
    {
      // ?life=0 disables the moving city; ?life=crowd,traffic,boats picks layers; ?lifedebug=1 draws the active path graph.
      const q = new URLSearchParams(location.search);
      const life = q.get('life');
      // ?date=YYYY-MM-DD: calendar day for the sun path (default: today in Paris)
      const dateS = q.get('date');
      if (dateS && /^\d{4}-\d{2}-\d{2}$/.test(dateS)) { const [y, m, d] = dateS.split('-').map(Number); this.env.setDate([y, m, d]); }
      if (life === '0') this.world.lifeOptions = null;
      else if (life) { const set = new Set(life.split(',')); this.world.lifeOptions = { crowd: set.has('crowd'), traffic: set.has('traffic'), boats: set.has('boats'), signals: set.has('signals') || set.has('traffic'), debug: q.get('lifedebug') === '1' }; }
      else if (this.world.lifeOptions) this.world.lifeOptions.debug = q.get('lifedebug') === '1';
      // ?marks=0 road markings, ?streets=0 sidewalk slabs, ?signs=0 shop signs + plaques; *debug=1 variants paint them magenta / log placements
      if (q.get('marks') === '0') this.world.marksEnabled = false;
      if (q.get('streets') === '0') this.world.streetsEnabled = false;
      if (q.get('marksdebug') === '1') this.world.marksDebug = true;
      if (q.get('streetsdebug') === '1') this.world.streetsDebug = true;
      if (q.get('signs') === '0') setSignageEnabled(false);
      if (q.get('glow') === '0') this.env.setGlow(false);
      if (q.get('headlights') === '0') this.headlights = false;
      if (q.get('wet') === '1') setWet(1);
      if (q.get('signals') === '0' && this.world.lifeOptions) this.world.lifeOptions.signals = false;
      if (q.get('shoplights') === '0') setShopLights(false);
      if (tower === 'lit') this.towerAlwaysOn = true;
      if (q.get('signsdebug') === '1') setSignageDebug(true);
    }
    void this.env.loadHdri('/textures/hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr');
    await this.world.load((f, m) => this.hud.progress(f, m));
    if (this.world.furniture) localLights.setLamps(this.world.furniture.lampPositions);
    this.world.eiffel.enableReflection();
    if (this.world.water) {
      const refl = new WaterReflection(this.renderer, this.world.manifest.waterLevelY + 0.3, window.innerWidth, window.innerHeight);
      this.post.reflection = refl;
      this.world.water.setReflection(refl.target.texture, refl.textureMatrix);
    }
    this.world.buildings.onChunkLoaded = c => { if (c.walls) this.collision.registerChunk(c.i, c.j, c.walls.geometry); };
    for (const c of this.world.buildings.chunks.values()) if (c.loaded && c.walls) this.collision.registerChunk(c.i, c.j, c.walls.geometry);

    if (this.world.bridges?.deck) this.collision.registerWalkable("bridges", this.world.bridges.deck.geometry);
    if (this.world.streets) this.world.streets.walkables = { register: (k, g, o) => this.collision.registerWalkable(k, g, o), unregister: k => this.collision.unregisterWalkable(k) };
    if (this.world.bridges?.parapet) this.collision.registerStatic("parapets", this.world.bridges.parapet.geometry);
    if (this.world.bridges?.stone) this.collision.registerStatic("bridge-stone", this.world.bridges.stone.geometry);
    this.player = new FirstPersonController(this.camera, this.input, this.world.heightmap, this.collision);
    this.player.waterLevelY = this.world.manifest.waterLevelY;
    // tower decks, guard rails and lift hotspots (needs public/models/eiffel_walk.json from bake:towerwalk)
    await this.tower.load(this.world.heightmap, { walkable: (k, g) => this.collision.registerWalkable(k, g), stat: (k, g) => this.collision.registerStatic(k, g) });
    this.collision.flushWalkables();   // bridge decks + tower floors must exist before a URL / viewpoint placement probes them
    // golden projectors at the foot of each pillar (off with the tower after 23:45)
    if (this.tower.pillars.length) localLights.addLights('tower', this.tower.pillars.map(([px, pz]) => ({ x: px, y: this.world.groundY(px, pz) + 1.5, z: pz, radius: 25, r: 1.0, g: 0.62, b: 0.25, intensity: 30, kind: 'tower' as const })));
    this.goTo(VIEWPOINTS[0]);

    // ---- Phase D: minimap, soundscape, touch / gamepad
    const q = new URLSearchParams(location.search);
    const hudEl = document.getElementById('hud') as HTMLElement;
    this.minimap = new Minimap(hudEl, VIEWPOINTS.filter(v => v.key !== 'Digit8').map(v => ({ x: v.x, z: v.z, name: v.name })));
    if (q.get('minimap') === '1') this.minimap.toggle(true);
    this.audio = new AudioEngine(q.get('audio'));
    const wake = () => this.audio.ensure();
    window.addEventListener('pointerdown', wake); window.addEventListener('keydown', wake);
    this.player.onStep = s => {
      const p = this.player.position;
      this.audio.step(AudioEngine.kindAt(this.world.surface, p.x, p.z, p.y - this.world.groundY(p.x, p.z)), s);
    };
    this.touch = new TouchControls(this.input, hudEl, q.get('touch') === '1');
    if (this.touch.enabled) {
      // mobile preset: native resolution capped at 1x, no ambient occlusion, no planar reflection, smaller shadow map,
      // facade details only nearby
      this.renderer.setPixelRatio(1);
      this.post.n8ao.enabled = false;
      if (this.post.reflection) { this.post.reflection = undefined; this.world.water?.setReflection(null, null, 0); }
      this.env.sun.shadow.mapSize.set(2048, 2048);
      if (this.env.sun.shadow.map) { this.env.sun.shadow.map.dispose(); this.env.sun.shadow.map = null; }
      this.world.buildings.detailDistance = 320;
      if (this.world.trees) this.world.trees.lodDistance = 160;
    }
    if (q.get('status') === '1') document.documentElement.classList.add('debug');
    if (q.get('drive') === '1') this.input.touchF = 1;   // headless self-test: hold the virtual stick forward

    this.loop.add(dt => {
      this.input.update(dt);
      const p = this.camera.position;
      this.collision.update(p.x, p.z);
      if (this.flying) this.fly.update(dt); else this.player.update(dt);
    });
    this.loop.add((dt, t) => {
      const p = this.camera.position;
      this.minimap.update(p.x, p.z, this.input.yaw, performance.now());
      this.audio.update(dt, p.x, p.z, this.env.hour, p.y - this.world.groundY(p.x, p.z), this.world.surface);
      // lift prompt (walking only)
      const feet = this.player.position;
      this.hotspot = !this.flying && !this.player.riding && this.tower.ready ? this.tower.nearest(feet.x, feet.y, feet.z) : null;
      this.hud.prompt(this.hotspot ? `E · ${this.hotspot.label}` : null);
      void t;
    });
    const camDir = new THREE.Vector3();
    this.loop.add((dt, t) => { this.camera.getWorldDirection(camDir); this.world.update(this.camera.position.x, this.camera.position.z, t, this.env.night, dt, camDir); });
    this.loop.add((_dt, t) => { this.env.follow(this.camera.position); this.env.tick(t); this.post.setNight(this.env.night); buildingUniforms.uHour.value = this.env.hour; });
    this.loop.add(() => {
      const p = this.camera.position, n = this.env.night;
      const st = this.env.sunTimes();
      localLights.hour = this.env.hour;
      const lit = towerLit(this.env.hour, st.sunset, st.sunrise, this.towerAlwaysOn);
      localLights.towerScale = lit * n;
      this.world.eiffel.lit = lit;
      this.world.eiffel.sparkle = towerSparkle(this.env.hour, st.sunset, this.towerAlwaysOn);
      localLights.setDynamic(n > 0.05 ? (this.world.life?.dynamicLights(p.x, p.z, this.headlights ? 5 : 0) ?? []) : []);
      localLights.update(p.x, p.z, n);
    });
    this.loop.add(() => this.updateStatus());
    this.loop.onRender = () => {
      this.post.render(1 / 60);
      if (this.captureRequested) { // same task as the render: the drawing buffer is still valid
        this.captureRequested = false;
        const p = this.camera.position;
        saveCanvas(this.canvas, `paris-eiffel_${formatHour(this.env.hour).replace(':', '-')}_${Math.round(p.x)}_${Math.round(p.z)}.png`);
      }
      this.stats.update();
    };
    this.loop.start();

    this.input.onKey((code, e) => {
      if (code === 'KeyH') this.hud.toggleHelp();
      if (code === 'KeyF') this.toggleFly();
      if (code === 'KeyT') this.toggleTimePanel();
      if (code === 'KeyN') this.cycleTime();
      if (code === 'KeyP') void this.share();
      if (code === 'KeyO') this.captureRequested = true;
      if (code === 'KeyM') this.minimap.toggle();
      if (code === 'KeyE' && !this.flying && this.hotspot && !this.player.riding) { this.player.startRide(this.hotspot.to, this.hotspot.seconds); this.hud.prompt(null); }
      if (code === 'KeyV') this.hud.toast(this.audio.toggleMute() ? '소리 끔' : '소리 켬');
      if (code === 'Comma' || code === 'Period') this.stepTime((code === 'Comma' ? -1 : 1) * (e.shiftKey ? 1 : 0.25));
      const vp = VIEWPOINTS.find(v => v.key === code);
      if (vp) this.goTo(vp);
    });
    this.hud.onTimeChange = h => this.env.setHour(h);
    this.applyDayPresets();
    const em = this.world.eiffel.meta;
    if (em.author) this.hud.addCredit(`Eiffel Tower model: "${em.title ?? 'Eiffel Tower'}" by ${em.author.replace(/\s*\(.*\)\s*$/, '')} (${(em.license ?? '').split(' ')[0]})`);
    else this.hud.addCredit(em.title === 'procedural lattice' ? 'Eiffel Tower: procedural lattice generated from published dimensions' : 'Eiffel Tower model: 3DMR #4 (CC0)');
    this.hud.addCredit('Map data © OpenStreetMap contributors · IGN BD TOPO / BD ORTHO / RGE ALTI · Ville de Paris');
    this.hud.setTimeDisplay(this.env.hour);
    document.addEventListener('pointerlockchange', () => { if (!this.input.touchMode) this.hud.showOverlay(!this.input.locked); });
    this.hud.onStart = () => {
      this.audio.ensure();
      if (this.touch.enabled) { this.input.touchMode = true; this.hud.showOverlay(false); }   // phones: no pointer lock
      else this.input.lock();
    };
    this.hud.setReady(this.touch.enabled ? '탭하면 시작합니다 · 왼쪽 조이스틱 이동 · 오른쪽 드래그 시점 · 오른쪽 아래 버튼' : undefined);
    this.applyUrlParams();
  }

  /** T while walking: release the pointer (and show the panel) so the slider can be dragged; T again hides it and grabs the pointer back. */
  toggleTimePanel(open = this.input.locked || !this.hud.timePanelOpen) {
    this.hud.toggleTimePanel(open);
    if (open) this.input.unlock();
    else if (!this.input.locked) this.input.lock();
  }
  setHour(h: number) { this.env.setHour(h); this.hud.setTimeDisplay(this.env.hour); }
  /** Preset hours follow the day's real sunrise / sunset (a June sunset is 21:58, a December one 16:56). */
  applyDayPresets() {
    const { sunrise, sunset } = this.env.sunTimes();
    const r = (h: number) => Math.round(h * 4) / 4;
    this.hud.setPresets([
      { label: '새벽', hour: r(sunrise - 0.25) }, { label: '낮', hour: 13 }, { label: '오후', hour: r(Math.max(14, sunset - 3.2)) },
      { label: '노을', hour: r(sunset - 0.35) }, { label: '야경', hour: Math.ceil(sunset + 1.4) % 24 + 0.02 }, { label: '심야', hour: 1 },
    ]);
    this.hud.setDateLabel(`${this.env.dateLabel()} · 파리`);
  }
  /** P: copy a link that reproduces this view. */
  async share() {
    const url = shareUrl(this);
    const ok = await copyText(url);
    this.hud.toast(ok ? '링크를 복사했습니다' : '복사 실패 · 콘솔에 링크를 출력했습니다');
    if (!ok) console.log(url);
  }
  stepTime(dh: number) { this.setHour(this.env.hour + dh); }
  /** N: jump to the next preset after the current time (dawn, noon, afternoon, sunset, night, late night). */
  cycleTime() {
    const sorted = [...this.hud.presets].sort((a, b) => a.hour - b.hour);
    const h = this.env.hour;
    this.setHour((sorted.find(p => p.hour > h + 0.05) ?? sorted[0]).hour);
  }

  /** Debug helpers: ?auto=1 skips the overlay; ?fly=1&x=..&y=..&z=..&yaw=deg&pitch=deg places the camera; ?hour=19.5 sets the time. */
  private applyUrlParams() {
    const q = new URLSearchParams(location.search);
    if (q.get('walk') === '1' && q.has('x')) {
      // Walk-mode placement (share links): feet at (x,z), optional y to probe a deck at that height.
      this.flying = false;
      const x = parseFloat(q.get('x')!), z = parseFloat(q.get('z') ?? '-409');
      this.player.place(x, z, q.has('yaw') ? THREE.MathUtils.degToRad(parseFloat(q.get('yaw')!)) : yawTo(x, z), q.has('y') ? parseFloat(q.get('y')!) : undefined);
      if (q.has('pitch')) { this.input.pitch = THREE.MathUtils.degToRad(parseFloat(q.get('pitch')!)); this.player.apply(); }
    } else if (q.has('x') || q.has('fly')) {
      this.flying = true;
      const x = parseFloat(q.get('x') ?? '-480'), z = parseFloat(q.get('z') ?? '-409');
      const y = q.has('y') ? parseFloat(q.get('y')!) : this.world.groundY(x, z) + 1.7;
      this.fly.position.set(x, y, z);
      this.input.yaw = q.has('yaw') ? THREE.MathUtils.degToRad(parseFloat(q.get('yaw')!)) : yawTo(x, z);
      this.input.pitch = q.has('pitch') ? THREE.MathUtils.degToRad(parseFloat(q.get('pitch')!)) : 0;
      this.fly.apply();
    }
    if (q.has('hour')) this.setHour(parseFloat(q.get('hour')!));
    if (q.has('timepanel')) this.hud.toggleTimePanel(q.get('timepanel') !== '0');
    if (q.get('auto') === '1') this.hud.showOverlay(false);
    if (q.has('fov')) { this.camera.fov = parseFloat(q.get('fov')!); this.camera.updateProjectionMatrix(); }
    if (q.get('post') === '0') this.post.enabled = false;
    if (q.get('ao') === '0') this.post.n8ao.enabled = false;                 // no ambient occlusion (A/B)
    if (q.get('noshadow') === '1') this.renderer.shadowMap.enabled = false;
    if (q.get('noenv') === '1') { this.scene.environment = null; this.env.disableHdri = true; }
    if (q.get('details') === '0') this.world.buildings.detailDistance = 0;
    if (q.get('lamps') === '0') localLights.enabled = false;           // no local lamp lighting (A/B)
    const refl = q.get('refl');                                          // ?refl=0 off, 1 half res (default), 2 quarter res
    if (refl === '0' && this.post.reflection) { this.post.reflection.enabled = false; this.world.water?.setReflection(null, null); }
    else if (refl === '2') this.post.reflection?.setDivisor(4);
    if (q.get('refldbg') === 'uv') this.world.water?.setReflectionDebug(1);
    if (q.get('refldbg') === 'uv2') this.world.water?.setReflectionDebug(2);
    if (q.get('stars') === '0') (this.env.sky.material as THREE.ShaderMaterial).uniforms.uStarsOn.value = 0;
    if (q.get('lampsdebug') === '1') localLights.debug = true;        // magenta lamps: spot materials that miss the hook
    if (q.has('clear')) this.renderer.setClearColor(new THREE.Color('#' + q.get('clear')));
    if (q.has('skydim')) { const u = (this.env.sky.material as THREE.ShaderMaterial).uniforms; u.uDim.value = parseFloat(q.get('skydim')!); console.log('sky uniforms', JSON.stringify({ dim: u.uDim.value, sun: u.sunPosition.value, turb: u.turbidity.value, ray: u.rayleigh.value, mie: u.mieCoefficient.value, night: this.env.night })); }
    // ?hide=far,eiffel,trees,buildings,terrain,water,bridges,furniture,sky  (debugging)
    for (const name of (q.get('hide') ?? '').split(',').filter(Boolean)) {
      const w = this.world as unknown as Record<string, { group?: THREE.Object3D } | undefined>;
      if (name === 'sky') this.env.sky.visible = false;
      else if (w[name]?.group) w[name]!.group!.visible = false;
    }
    const quality = q.get('quality'); if (quality === 'low' || quality === 'medium' || quality === 'high') this.post.setQuality(quality);
  }

  goTo(vp: { x: number; z: number; yaw?: number; key: string }) {
    const yaw = vp.yaw ?? yawTo(vp.x, vp.z);
    if (vp.key === 'Digit8') {
      const deck = this.tower.viewpoint();
      if (deck) {   // stand on the real 2nd-floor deck
        this.flying = false;
        this.player.place(deck.x, deck.z, yawTo(deck.x, deck.z, -480, -409), deck.y + 1);
        return;
      }
      this.flying = true;
      this.fly.position.set(-42, 121, -30);
      this.input.yaw = yawTo(-42, -30, -480, -409); this.input.pitch = -0.12;
      this.fly.apply();
      return;
    }
    if (this.flying) {
      this.fly.position.set(vp.x, this.world.groundY(vp.x, vp.z) + 1.7, vp.z);
      this.input.yaw = yaw; this.input.pitch = 0.03; this.fly.apply();
    } else this.player.place(vp.x, vp.z, yaw);
  }

  toggleFly() {
    this.flying = !this.flying;
    if (this.flying) { this.fly.position.copy(this.camera.position); this.fly.speed = 15; }
    else { const p = this.camera.position; this.player.position.set(p.x, Math.max(this.world.groundY(p.x, p.z), p.y - 1.7), p.z); }
  }

  private updateStatus() {
    const p = this.camera.position;
    const yawDeg = ((THREE.MathUtils.radToDeg(this.input.yaw) % 360) + 360) % 360;
    const w = this.world;
    const floor = !this.flying ? this.tower.floorAt(this.player.position.x, this.player.position.y, this.player.position.z) : null;
    this.hud.setStatus(`${this.flying ? 'FLY' : 'WALK'}${floor ? ' ' + floor : ''}  x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}\nyaw ${yawDeg.toFixed(0)}°  ground ${w.groundY(p.x, p.z).toFixed(1)}\nchunks ${w.buildings.loadedCount}/144  pending ${w.pending}  bvh ${this.collision.colliderCount} walk ${this.collision.walkableCount}/${this.collision.pendingWalkCount} lift ${(this.player.position.y - w.groundY(this.player.position.x, this.player.position.z)).toFixed(2)}${w.marks ? '  ' + w.marks.stats : ''}${w.streets ? '  streets ' + w.streets.count : ''}\n${w.buildings.detailStats}${w.life ? '\n' + w.life.stats : ''}${this.audio?.debug ? '\n' + this.audio.status() : ''}`);
  }
}
