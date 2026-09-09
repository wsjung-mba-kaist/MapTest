import * as THREE from 'three';
import Stats from 'stats-gl';
import { Loop } from './Loop';
import { setSignageDebug, setSignageEnabled } from '../world/Signage';
import { setShopLights } from '../world/BuildingDetails';
import { shopOpen, towerLit, towerSparkle } from '../../shared/nightlife';
import type { SpatialSource } from '../audio/Spatial';
import { setWet } from '../materials/GroundMaterial';
import { seasonState } from '../../shared/season';
import { Rain } from '../render/Rain';
import { XRMode } from './XR';
import { localHour, todayParis, type Weather } from '../render/Environment';
import { Minimap } from '../ui/Minimap';
import { TouchControls } from '../ui/TouchControls';
import { AudioEngine } from '../audio/Audio';
import { TowerAccess, type Hotspot } from '../world/TowerAccess';
import { createRenderer, gpuInfo, hpAdapter, probeHighPerfAdapter } from './Renderer';
import { GpuPanel } from '../ui/GpuPanel';
import { Hud, formatHour, type MenuAction } from '../ui/Hud';
import { HelpPanel, InfoPanel } from '../ui/Menu';
import { TimePanel, WEATHER_LABEL } from '../ui/TimePanel';
import { SettingsPanel } from '../ui/SettingsPanel';
import { clearPrefs, devicePrefs, loadPrefs, savePrefs } from '../ui/Prefs';
import { type Prefs } from '../../shared/prefs';
import { pickQuality, type QualityLevel } from '../../shared/quality';
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
import { Glide } from '../player/Glide';
import { PlacePanel, CATEGORY_COLOR } from '../ui/PlacePanel';
import { PlaceList } from '../ui/PlaceList';
import { Compass } from '../ui/Compass';
import { hasNum, queryNum, type Landmark } from '../../shared/layout';

/** yaw so that the camera at (x,z) faces (tx,tz); yaw 0 = north (-z), clockwise positive. */
export const yawTo = (x: number, z: number, tx = 0, tz = 0) => Math.atan2(tx - x, -(tz - z));

export class App {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly loop = new Loop();
  readonly hud = new Hud();
  readonly input: Input;
  readonly world = new World();
  private stats?: Stats;
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
  weather: Weather = 'clear';
  timePanel!: TimePanel;
  /** time-lapse rate (sim seconds per real second), 0 = off */
  private timeRate = 0;
  private carLights = true;
  private wetFlag = false;
  private rain?: Rain;
  private xr?: XRMode;
  private longTasks = 0;
  private longTaskMax = 0;
  private readonly feetTmp = new THREE.Vector3();
  private readonly fwdTmp = new THREE.Vector3();
  towerAlwaysOn = false;
  private hotspot: Hotspot | null = null;
  flying = false;
  private captureRequested = false;
  // landmarks: camera flight, the info card, the list, and proximity bookkeeping
  glide!: Glide;
  placePanel!: PlacePanel;
  placeList!: PlaceList;
  /** the site the player is standing in (or just landed at); drives the share link and the world labels */
  currentLandmark: Landmark | null = null;
  private noGlide = false;
  private placeCheckAt = 0;
  private placeCandidate: Landmark | null = null;
  private placeCandidateHits = 0;
  private readonly placeShownAt = new Map<string, number>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    this.canvas = this.renderer.domElement;   // createRenderer may have swapped in a fresh canvas
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.2, 9000);
    this.input = new Input(this.canvas);
    this.gpuPanel.onOpen = () => this.input.unlock();
    this.fly = new FlyControls(this.camera, this.input);
    this.scene.add(this.world.group);
    this.env = new Environment(this.scene, this.renderer);
    this.post = new Post(this.renderer, this.scene, this.camera);
    // diagnostics (FPS panel + status readout) are opt-in: ?status=1, H twice, or the settings switch
    this.hud.onDiagnostics = on => {
      if (on && !this.stats) { this.stats = new Stats({ trackGPU: false, horizontal: true }); this.stats.dom.style.cssText = 'position:fixed;left:16px;bottom:190px;opacity:.8;z-index:10'; document.body.appendChild(this.stats.dom); this.stats.init(this.renderer); }
      if (this.stats) this.stats.dom.style.display = on ? '' : 'none';
    };
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
      else if (life) { const set = new Set(life.split(',')); this.world.lifeOptions = { crowd: set.has('crowd'), traffic: set.has('traffic'), boats: set.has('boats'), signals: set.has('signals') || set.has('traffic'), farTraffic: set.has('traffic'), crossings: set.has('crowd'), metro: set.has('traffic'), cyclists: set.has('crowd'), debug: q.get('lifedebug') === '1' }; }
      else if (this.world.lifeOptions) this.world.lifeOptions.debug = q.get('lifedebug') === '1';
      // ?marks=0 road markings, ?streets=0 sidewalk slabs, ?signs=0 shop signs + plaques; *debug=1 variants paint them magenta / log placements
      if (q.get('marks') === '0') this.world.marksEnabled = false;
      if (q.get('streets') === '0') this.world.streetsEnabled = false;
      if (q.get('marksdebug') === '1') this.world.marksDebug = true;
      if (q.get('streetsdebug') === '1') this.world.streetsDebug = true;
      if (q.get('signs') === '0') setSignageEnabled(false);
      if (q.get('glow') === '0') this.env.setGlow(false);
      if (q.get('headlights') === '0') this.headlights = false;
      if (q.get('wet') === '1') { setWet(1); this.wetFlag = true; }
      const wq = q.get('weather'); if (wq === 'overcast' || wq === 'rain' || wq === 'fog') this.weather = wq;
      if (q.get('signals') === '0' && this.world.lifeOptions) this.world.lifeOptions.signals = false;
      if (q.get('fartraffic') === '0' && this.world.lifeOptions) this.world.lifeOptions.farTraffic = false;
      if (q.get('crossings') === '0' && this.world.lifeOptions) this.world.lifeOptions.crossings = false;
      if (q.get('metro') === '0' && this.world.lifeOptions) this.world.lifeOptions.metro = false;
      if (q.get('cyclists') === '0' && this.world.lifeOptions) this.world.lifeOptions.cyclists = false;
      this.forceGpuPanel = q.get('gpu') === '1';
      this.carLights = q.get('carlights') !== '0';
      if (q.get('shoplights') === '0') setShopLights(false);
      if (tower === 'lit') this.towerAlwaysOn = true;
      if (q.get('signsdebug') === '1') setSignageDebug(true);
      this.world.labelsEnabled = q.get('labels') === '1';   // floating name tags read as grey bars from afar: opt-in
      // LiDAR surface-model landmark roofs: default on, off on phones (the section is skipped at parse time); ?dsm=0|1 overrides
      const coarse = q.get('touch') === '1' || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
      this.world.dsmEnabled = q.get('dsm') === '1' ? true : q.get('dsm') === '0' ? false : !coarse;
      this.world.heroLodOnly = coarse;
      this.noGlide = q.get('glide') === '0' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.prefs = loadPrefs(coarse);
      if (!this.prefs.life && !life) this.world.lifeOptions = null;
      if (q.get('labels') !== '1') this.world.labelsEnabled = this.prefs.labels;
    }
    void this.env.loadHdri('/textures/hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr');
    await this.world.load((f, m) => this.hud.progress(f, m));
    if (this.world.furniture) localLights.setLamps(this.world.furniture.lampPositions);
    this.world.eiffel.enableReflection();
    if (this.world.water) {
      const refl = new WaterReflection(this.renderer, this.world.manifest.waterLevelY + 0.3, window.innerWidth, window.innerHeight);
      this.reflection = refl;
      this.post.reflection = refl;
      this.world.water.setReflection(refl.target.texture, refl.textureMatrix);
    }
    this.world.buildings.onChunkLoaded = c => { if (c.walls) this.collision.registerChunk(c.i, c.j, c.walls.geometry); };
    for (const c of this.world.buildings.chunks.values()) if (c.loaded && c.walls) this.collision.registerChunk(c.i, c.j, c.walls.geometry);

    if (this.world.bridges) for (const [key, d] of this.world.bridges.decks) this.collision.registerWalkable(`bridges:${key}`, d.mesh.geometry);
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
    for (const m of this.world.heroModels) { const fl = m.floodlights(); if (fl.length) localLights.addLights(`hero:${m.meta.id}`, fl); }
    this.glide = new Glide(this.camera, this.input);
    const hudEl = document.getElementById('hud') as HTMLElement;
    const q = new URLSearchParams(location.search);
    const touchUi = q.get('touch') === '1' || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    this.placePanel = new PlacePanel(hudEl, touchUi);
    this.placeList = new PlaceList(hudEl, lm => { this.closeModal(false); this.goTo(lm); if (!this.input.touchMode) this.input.lock(); }, () => this.closeModal());
    this.helpPanel = new HelpPanel(hudEl, () => this.closeModal(), touchUi);
    this.infoPanel = new InfoPanel(hudEl, () => this.closeModal());
    this.hud.onCredit = t => this.infoPanel.addCredit(t);
    this.hud.onMenu = a => this.menuAction(a);
    this.hud.onClock = () => this.toggleTimePanel();
    this.timePanel = new TimePanel(document.getElementById('timepanel')!);
    this.timePanel.onNow = () => { const t = todayParis(); this.timePanel.stop(); this.env.setDate(t); this.applyDayPresets(); this.setHour(localHour(new Date(), t)); this.hud.toast(`지금 · ${formatHour(this.env.hour)}`, 1500); };
    this.timePanel.onPlay = rate => { this.timeRate = rate; this.audio.chime = rate === 0; };
    this.timePanel.onWeather = w => this.setWeather(w);
    this.timePanel.onSeason = s => { const t = todayParis(); this.env.setDate(s ? [t[0], s.month, s.day] : t); this.applyDayPresets(); this.hud.toast(s ? `${s.label} · ${s.month}월 ${s.day}일` : '오늘', 1500); };
    { const first = this.world.landmarks.byHotkey(1) ?? this.world.landmarks.list[0]; if (first) this.goTo(first, { instant: true, quiet: true }); }

    // ---- Phase D: minimap, soundscape, touch / gamepad
    this.minimap = new Minimap(hudEl, this.world.landmarks.visible.filter(l => l.id !== 'eiffel').map(l => ({ x: l.x, z: l.z, name: l.name.fr, short: l.short, category: l.category, hotkey: l.hotkey, weight: l.radius })));
    this.minimap.colors = CATEGORY_COLOR;
    this.minimap.onPick = (x, z) => this.goToPoint(x, z);
    window.addEventListener('wheel', e => { if (this.input.locked && this.minimap.visible) this.minimap.cycleSpan(e.deltaY > 0 ? 1 : -1); }, { passive: true });
    this.compass = new Compass(hudEl, this.world.landmarks.visible);
    this.compass.colors = CATEGORY_COLOR;
    this.placePanel.onGo = lm => { this.goTo(lm); if (!this.input.touchMode) this.input.lock(); };
    this.audio = new AudioEngine(q.get('audio'));
    const wake = () => this.audio.ensure();
    window.addEventListener('pointerdown', wake); window.addEventListener('keydown', wake);
    this.player.onStep = s => {
      const p = this.player.position;
      this.audio.step(AudioEngine.kindAt(this.world.surface, p.x, p.z, p.y - this.world.groundY(p.x, p.z)), s);
    };
    this.touch = new TouchControls(this.input, hudEl, q.get('touch') === '1');
    if (this.touch.enabled) {
      // mobile preset (the 1x / no AO / no reflection part lives in the device defaults of shared/prefs.ts): smaller
      // shadow map, facade details only nearby, half the lamp slots
      this.env.sun.shadow.mapSize.set(2048, 2048);
      if (this.env.sun.shadow.map) { this.env.sun.shadow.map.dispose(); this.env.sun.shadow.map = null; }
      this.world.buildings.detailDistance = 320;
      if (this.world.trees) this.world.trees.lodDistance = 160;
      localLights.setBudget(16, 8);   // half the lamp slots: the per-fragment loop is the main mobile cost
    }
    this.settingsPanel = new SettingsPanel(hudEl, () => this.closeModal(),
      (p, key) => { this.prefs = p; savePrefs(p); this.applyPrefs(p, [key]); if (key === 'life') this.hud.toast('움직이는 도시: 다음 시작부터 적용됩니다'); },
      () => { clearPrefs(); this.prefs = devicePrefs(this.touch.enabled); this.applyPrefs(this.prefs); this.settingsPanel.set(this.prefs); this.hud.toast('설정을 기본값으로 되돌렸습니다'); });
    this.hud.enableMenu('settings', true);
    this.hud.enableMenu('night', this.touch.enabled);
    this.applyPrefs(this.prefs);
    this.settingsPanel.set(this.prefs);
    if (q.get('minimap') === '1' && !this.minimap.visible) this.minimap.toggle(true);   // URL wins over the stored default
    if (q.get('status') === '1') this.hud.setDiagnostics(true);
    if (this.noGlide) this.player.headBob = false;   // prefers-reduced-motion (or ?glide=0): no head bob either
    this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.loop.stop(); this.hud.fail('그래픽 장치 연결이 끊겼습니다. 다른 탭을 닫고 다시 시도해 보세요.', true); });
    if (q.get('drive') === '1') this.input.touchF = 1;   // headless self-test: hold the virtual stick forward

    this.loop.add(dt => {
      this.input.update(dt);
      const p = this.camera.position;
      this.collision.update(p.x, p.z);
      if (this.glide.active) this.glide.update(dt);
      else if (this.flying) this.fly.update(dt); else this.player.update(dt);
      if (this.xr?.presenting) this.xr.update(dt, this.flying ? this.feetTmp.copy(this.fly.position).setY(this.fly.position.y - 1.6) : this.player.position);
    });
    this.loop.add((dt, t) => {
      const p = this.camera.position;
      this.minimap.update(p.x, p.z, this.input.yaw, performance.now());
      this.compass.update(p.x, p.z, this.input.yaw, this.currentLandmark?.id ?? null, performance.now());
      // positional sources: nearest cars / boats, open café terraces (17-01h)
      const src: SpatialSource[] = [];
      const life = this.world.life;
      if (life?.traffic) for (const c of life.traffic.nearest(p.x, p.z, 4)) src.push({ kind: 'car', x: c.x, y: c.y, z: c.z, level: 0.6, speed: c.v });
      if (life?.boats) for (const b of life.boats.nearest(p.x, p.z, 2)) src.push({ kind: 'boat', x: b.x, y: b.y, z: b.z, level: 0.5 });
      if (shopOpen(this.env.hour, true) > 0.3) for (const l of localLights.nearestOfKind('restaurant', p.x, p.z, 3)) src.push({ kind: 'terrace', x: l.x, y: l.y, z: l.z, level: 0.35 });
      // fountains: the big basins (jets) first, then Wallace / drinking fountains, nearest two within earshot
      const fps: { x: number; y: number; z: number; level: number; reach: number }[] = [];
      for (const st of this.world.fountains?.sites ?? []) fps.push({ x: st.x, y: st.y, z: st.z, level: st.jets >= 10 ? 0.8 : 0.45, reach: st.jets >= 10 ? 140 : 60 });
      const fp = this.world.furniture?.fountainPositions;
      if (fp) for (let i = 0; i < fp.length / 3; i++) fps.push({ x: fp[i * 3], y: fp[i * 3 + 1], z: fp[i * 3 + 2], level: 0.35, reach: 40 });
      fps.sort((a, b) => ((a.x - p.x) ** 2 + (a.z - p.z) ** 2) / (a.reach * a.reach) - ((b.x - p.x) ** 2 + (b.z - p.z) ** 2) / (b.reach * b.reach));
      for (const f of fps.slice(0, 2)) if (Math.hypot(f.x - p.x, f.z - p.z) < f.reach) src.push({ kind: 'fountain', x: f.x, y: f.y, z: f.z, level: f.level });
      if (life?.metro) for (const h of life.metro.heads) if (Math.hypot(h.x - p.x, h.z - p.z) < 260 && h.v > 0.5) src.push({ kind: 'train', x: h.x, y: h.y, z: h.z, level: 0.25 + 0.55 * Math.min(1, h.v / 11.5) });
      this.camera.getWorldDirection(this.fwdTmp);
      this.audio.setListener(p.x, p.y, p.z, this.fwdTmp.x, this.fwdTmp.y, this.fwdTmp.z);
      this.audio.update(dt, p.x, p.z, this.env.hour, p.y - this.world.groundY(p.x, p.z), this.world.surface, src);
      // lift prompt (walking only)
      const feet = this.player.position;
      this.hotspot = !this.flying && !this.player.riding && !this.glide.active && this.tower.ready ? this.tower.nearest(feet.x, feet.y, feet.z) : null;
      this.hud.prompt(this.hotspot ? `E · ${this.hotspot.label}` : null);
      if (t - this.placeCheckAt > 0.25 && !this.glide.active) { this.placeCheckAt = t; this.updatePlace(t); this.hud.streaming(this.world.buildings.loadedCount, this.world.buildings.chunks.size); if (this.modal === 'places') { const f = this.flying ? this.camera.position : this.player.position; this.placeList.update(f.x, f.z, this.input.yaw); } }
      this.world.labels?.update(p.x, p.z, this.currentLandmark?.id ?? null);
    });
    const camDir = new THREE.Vector3();
    this.loop.add((dt, t) => { this.camera.getWorldDirection(camDir); this.world.update(this.camera.position.x, this.camera.position.z, t, this.env.night, dt, camDir, this.env.hour, this.camera.position.y); });
    this.rain = new Rain(); this.scene.add(this.rain.points);
    this.loop.add((dt, t) => { this.rain?.update(t, this.camera.position, this.env.night, dt); this.world.trees?.setSeason(seasonState(this.env.dayOfYear())); });
    this.loop.add((_dt, t) => { this.env.follow(this.camera.position); this.env.tick(t, this.camera.position); this.post.setNight(this.env.night, this.env.sunElev); buildingUniforms.uHour.value = this.env.hour; });
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
    this.loop.add(dt => { if (this.timeRate) { this.env.setHour((this.env.hour + this.timeRate * dt / 3600) % 24); this.hud.setTimeDisplay(this.env.hour); this.refreshClock(); } });
    this.loop.add(() => this.updateStatus());
    this.loop.add((dt, t) => {
      if (this.autoQualityDone || this.prefs.quality !== 'auto' || !this.post.enabled || !this.input.active) return;
      if (!this.autoQualityAt) { this.autoQualityAt = t; return; }
      const settled = this.world.pending === 0 || t - this.autoQualityAt > 25;
      if (!settled || t - this.autoQualityAt < 3) return;
      this.frameSamples.push(dt * 1000);
      if (this.frameSamples.length < 30 || t - this.autoQualityAt < 8) return;
      const d = pickQuality(this.frameSamples, this.autoLevel, { minSamples: 30 });
      this.autoQualityDone = true;
      if (!d.changed) return;
      this.autoLevel = d.quality;
      this.post.setQuality(d.quality);
      if (d.pixelRatio) { this.renderer.setPixelRatio(this.renderer.getPixelRatio() * d.pixelRatio); this.resize(); }
      this.hud.toast(`화면이 느려 품질을 '${{ high: '높음', medium: '보통', low: '낮음' }[d.quality]}'${d.pixelRatio ? ' · 해상도 0.75×' : ''}으로 낮췄습니다 · 설정에서 변경`, 5000);
    });
    this.loop.onRender = () => {
      if (this.xr?.presenting) { this.xr.render(); return; }
      this.post.render(1 / 60);
      if (this.captureRequested) { // same task as the render: the drawing buffer is still valid
        this.captureRequested = false;
        const p = this.camera.position;
        const name = `paris-eiffel_${formatHour(this.env.hour).replace(':', '-')}_${Math.round(p.x)}_${Math.round(p.z)}.png`;
        saveCanvas(this.canvas, name);
        this.hud.toast(`스크린샷 저장 · ${name}`, 3000);
      }
      if (this.hud.diagnostics) this.stats?.update();
    };
    this.loop.start(cb => this.renderer.setAnimationLoop(cb));

    this.input.onKey((code, e) => {
      // Esc reaches the page only while the pointer is free (locked, the browser eats it): close the top modal first
      if (code === 'Escape') { if (this.gpuPanel.open) this.gpuPanel.hide(); else if (this.modal) this.closeModal(false); }
      if (code === 'KeyH') this.toggleHelp();
      if (code === 'Menu') this.hud.showOverlay(true);   // touch "...": the pause menu (no pointer lock to release)
      if (code === 'KeyG') this.toggleGpuPanel();
      if (code === 'KeyF') this.toggleFly();
      if (code === 'KeyT') this.toggleTimePanel();
      if (code === 'KeyN') this.cycleTime();
      if (code === 'KeyR') this.cycleWeather();
      if (code === 'KeyP') void this.share();
      if (code === 'KeyO') this.captureRequested = true;
      if (code === 'KeyM') this.toggleMinimap();
      if (code === 'KeyL') this.toggleModal('places');
      if (code === 'KeyI') this.placePanel.toggle();
      if (code === 'KeyE' && !this.flying && this.hotspot && !this.player.riding) { this.player.startRide(this.hotspot.to, this.hotspot.seconds); this.audio.lift(this.hotspot.seconds); this.hud.prompt(null); }
      if (code === 'KeyV') this.hud.toast(this.audio.toggleMute() ? '소리 끔' : '소리 켬');
      if (code === 'Comma' || code === 'Period') { this.stepTime((code === 'Comma' ? -1 : 1) * (e.shiftKey ? 1 : 0.25)); this.hud.toast(formatHour(this.env.hour), 1200); }
      const digit = /^Digit([1-8])$/.exec(code);
      if (digit) { const lm = this.world.landmarks.byHotkey(Number(digit[1])); if (lm) this.goTo(lm); }
    });
    this.hud.onTimeChange = h => { this.timePanel.stop(); this.env.setHour(h); this.refreshClock(); };
    this.applyDayPresets();
    this.applyWeather(false);
    if (this.world.life?.traffic) this.world.life.traffic.lightFx = this.carLights;
    this.player.obstacles = (x, z, r, out) => this.world.life?.pushOut(x, z, r, out);
    // compile the programs of everything already in the scene off the first frames (KHR_parallel_shader_compile)
    void this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
    try {
      new PerformanceObserver(list => { for (const e of list.getEntries()) { this.longTasks++; this.longTaskMax = Math.max(this.longTaskMax, e.duration); } }).observe({ entryTypes: ['longtask'] });
    } catch { /* not supported */ }
    const em = this.world.eiffel.meta;
    if (em.author) this.hud.addCredit(`Eiffel Tower model: "${em.title ?? 'Eiffel Tower'}" by ${em.author.replace(/\s*\(.*\)\s*$/, '')} (${(em.license ?? '').split(' ')[0]})`);
    else this.hud.addCredit(em.title === 'procedural lattice' ? 'Eiffel Tower: procedural lattice generated from published dimensions' : 'Eiffel Tower model: 3DMR #4 (CC0)');
    for (const m of this.world.heroModels) { const c = m.meta.credits; if (c) this.hud.addCredit(`${c.title}${c.author ? ` by ${c.author}` : ''} (${c.license.split(' ')[0]})`); }
    this.hud.addCredit('Map data © OpenStreetMap contributors · IGN BD TOPO / BD ORTHO / RGE ALTI · Ville de Paris');
    if (this.world.landmarks.baked) this.hud.addCredit('명소 설명: Wikipedia · Wikidata (CC BY-SA 4.0) · 사진: Wikimedia Commons (저작자·라이선스는 카드에 표시)');
    this.hud.setTimeDisplay(this.env.hour);
    this.refreshClock();
    document.addEventListener('pointerlockchange', () => { if (!this.input.touchMode) this.hud.showOverlay(!this.input.locked); });
    this.hud.onStart = () => {
      this.gpuNotice();
      this.audio.ensure();
      this.hud.markStarted(this.touch.enabled ? '탭하면 계속 걷습니다' : undefined);
      if (this.touch.enabled) {   // phones: no pointer lock
        this.input.touchMode = true; this.hud.showOverlay(false);
        try { if (!localStorage.getItem('paris.touchHint')) { localStorage.setItem('paris.touchHint', '1'); this.hud.toast('왼쪽을 눌러 이동 · 끝까지 밀면 달리기 · 오른쪽을 끌어 시점 · ⋯ 메뉴', 7000); } } catch { /* no storage */ }
      }
      else this.input.lock();
    };
    this.hud.setReady(this.touch.enabled ? '왼쪽 조이스틱 이동 · 오른쪽 드래그 시점 · 오른쪽 아래 버튼' : undefined);
    this.applyUrlParams();
  }

  /** T while walking: release the pointer (and show the panel) so the slider can be dragged; T again hides it and grabs the pointer back. */
  toggleTimePanel(open = this.input.locked || !this.hud.timePanelOpen) {
    this.hud.toggleTimePanel(open);
    if (open && this.touch?.enabled) this.placePanel.fold();   // phones: one bottom sheet at a time
    if (open) this.input.unlock();
    else if (!this.input.locked) this.input.lock();
  }
  helpPanel!: HelpPanel;
  infoPanel!: InfoPanel;
  /** the one centred modal that may be open (landmark list, help, info); same pointer-lock contract as the time panel */
  modal: 'places' | 'help' | 'info' | 'settings' | null = null;
  settingsPanel!: SettingsPanel;
  compass!: Compass;
  prefs!: Prefs;
  private reflection?: WaterReflection;
  private readonly frameSamples: number[] = [];
  private autoQualityAt = 0;
  private autoQualityDone = false;
  private autoLevel: QualityLevel = 'high';
  openModal(kind: NonNullable<App['modal']>) {
    if (this.modal) this.closeModal(false);
    if (kind === 'places') {
      const p = this.flying ? this.camera.position : this.player.position;
      this.placeList.show(this.world.landmarks.sorted(p.x, p.z), p.x, p.z, this.input.yaw, this.currentLandmark?.id ?? null);
    } else if (kind === 'help') this.helpPanel.show(); else if (kind === 'settings') this.settingsPanel.show(); else this.infoPanel.show();
    this.modal = kind;
    this.hud.setModal(true, { places: '명소를 고르면 그곳으로 날아갑니다 · L 목록 닫기', help: 'H 도움말 닫기 · 한 번 더 누르면 진단 정보', info: '닫으면 계속 걷습니다', settings: '바뀐 설정은 바로 적용되고 저장됩니다 · 닫으면 계속 걷습니다' }[kind]);
    this.input.unlock();
  }
  /** close the open modal; `relock` grabs the pointer back (false when another panel or the menu takes over) */
  closeModal(relock = true) {
    if (this.modal === 'places') this.placeList.hide(); else if (this.modal === 'help') this.helpPanel.hide(); else if (this.modal === 'info') this.infoPanel.hide(); else if (this.modal === 'settings') this.settingsPanel.hide();
    this.modal = null;
    this.hud.setModal(false);
    this.canvas.focus();   // keyboard focus leaves the closed panel
    if (relock && !this.input.locked && !this.input.touchMode) this.input.lock();
  }
  /** L / H / menu: open while walking or closed, close when it is the open one */
  toggleModal(kind: NonNullable<App['modal']>) { if (this.modal === kind && !this.input.locked) this.closeModal(); else this.openModal(kind); }
  /** H: the help panel; H again while it is open flips the diagnostics readout ("H twice") and closes it. */
  toggleHelp() {
    if (this.modal === 'help') { const on = !this.hud.diagnostics; this.hud.setDiagnostics(on); this.settingsPanel.set({ ...this.prefs, diagnostics: on }); this.closeModal(); this.hud.toast(on ? '진단 정보 표시 (H 두 번: 숨김)' : '진단 정보 숨김'); }
    else this.openModal('help');
  }
  toggleMinimap() {
    this.minimap.toggle();
    this.hud.toast(this.minimap.visible ? `미니맵 ${this.minimap.spanM >= 1000 ? `${(this.minimap.spanM / 1000).toFixed(1)} km` : `${this.minimap.spanM} m`}` : '미니맵 숨김', 1500);
  }
  /** pause-menu buttons run the same code as their shortcuts */
  private menuAction(a: MenuAction) {
    if (a === 'continue') this.hud.onStart();
    else if (a === 'places') this.openModal('places');
    else if (a === 'time') this.toggleTimePanel(true);
    else if (a === 'share') void this.share();
    else if (a === 'shot') { this.captureRequested = true; }
    else if (a === 'help') this.openModal('help');
    else if (a === 'info') this.openModal('info');
    else if (a === 'settings') this.openModal('settings');
    else if (a === 'night') this.cycleTime();
  }
  /** Push preferences into the runtime; `keys` limits it to what changed (a panel edit) — default: everything. */
  applyPrefs(p: Prefs, keys: (keyof Prefs)[] = Object.keys(p) as (keyof Prefs)[]) {
    const touch = this.touch?.enabled ?? false;
    for (const k of keys) {
      if (k === 'quality') { if (p.quality !== 'auto') this.post.setQuality(p.quality); else if (this.autoQualityDone) { this.autoQualityDone = false; this.autoQualityAt = 0; this.frameSamples.length = 0; } }
      else if (k === 'ao') this.post.setAo(p.ao);
      else if (k === 'shadows') { this.renderer.shadowMap.enabled = p.shadows; this.renderer.shadowMap.needsUpdate = true; }
      else if (k === 'reflection') {
        const r = this.reflection;
        if (r) { r.enabled = p.reflection; this.post.reflection = p.reflection ? r : undefined; if (p.reflection) this.world.water?.setReflection(r.target.texture, r.textureMatrix); else this.world.water?.setReflection(null, null, 0); }
      }
      else if (k === 'pixelRatio') { this.renderer.setPixelRatio(p.pixelRatio === 'auto' ? Math.min(window.devicePixelRatio || 1, touch ? 1 : 2) : p.pixelRatio); this.resize(); }
      else if (k === 'sensitivity') this.input.lookScale = p.sensitivity;
      else if (k === 'fov') { this.camera.fov = p.fov; this.camera.updateProjectionMatrix(); }
      else if (k === 'headBob') this.player.headBob = p.headBob && !this.noGlide;
      else if (k === 'volume') this.audio?.setVolume(p.volume);
      else if (k === 'minimap') { if (this.minimap && this.minimap.visible !== p.minimap) this.minimap.toggle(p.minimap); }
      else if (k === 'labels') this.world.setLabels(p.labels);
      else if (k === 'compass') this.compass?.setVisible(p.compass);
      else if (k === 'diagnostics') this.hud.setDiagnostics(p.diagnostics);
    }
  }
  /** the top-right chip: time · weather (· date when it is not today) */
  refreshClock() {
    const [y, m, d] = this.env.ymd, t = todayParis();
    const today = y === t[0] && m === t[1] && d === t[2];
    this.hud.setClock(`${formatHour(this.env.hour)} · ${WEATHER_LABEL[this.weather]}${today ? '' : ` · ${this.env.dateLabel()}`}`);
  }
  /** sunrise / sunset ticks, the highlighted weather and season buttons */
  private refreshTimePanel() {
    if (!this.timePanel) return;
    const { sunrise, sunset } = this.env.sunTimes();
    this.timePanel.setSun(sunrise, sunset);
    this.timePanel.setWeather(this.weather);
    const [y, m, d] = this.env.ymd, t = todayParis();
    this.timePanel.setDate(m, d, y === t[0] && m === t[1] && d === t[2]);
  }

  /** 4 Hz: which site the feet are in (with hysteresis + a 0.5 s dwell), the chip text, and a card on entering a new one. */
  private updatePlace(t: number) {
    const p = this.flying ? this.camera.position : this.player.position;
    const lms = this.world.landmarks;
    let cur = lms.at(p.x, p.z);
    const prev = this.currentLandmark;
    // stay with the current site while inside it (plus 15 %); a smaller site nested in it takes over only when the player is well inside it
    if (prev && !prev.hidden && Math.hypot(prev.x - p.x, prev.z - p.z) < prev.radius * 1.15 && (!cur || cur.radius >= prev.radius || Math.hypot(cur.x - p.x, cur.z - p.z) > cur.radius * 0.6)) cur = prev;
    if (cur !== prev) {
      if (cur === this.placeCandidate) this.placeCandidateHits++; else { this.placeCandidate = cur; this.placeCandidateHits = 1; }
      if (this.placeCandidateHits < 2) cur = prev;
    }
    if (cur !== prev) {
      this.currentLandmark = cur;
      if (cur && t - (this.placeShownAt.get(cur.id) ?? -1e9) > 60) { this.placeShownAt.set(cur.id, t); this.placePanel.show(cur, 'enter'); }
    }
    const live = cur ?? lms.nearest(p.x, p.z)?.landmark ?? null;
    this.placePanel.setLive(live, !!cur, p.x, p.z, this.input.yaw);
  }
  private readonly gpuPanel = new GpuPanel();
  private forceGpuPanel = false;
  private gpuNoticed = false;
  /** G: the "GPU 선택" panel (which adapter WebGL got, which one the browser could use, how to switch). */
  private toggleGpuPanel(force = false) {
    if (this.gpuPanel.open && !force) { this.gpuPanel.hide(); return; }
    this.gpuPanel.show(gpuInfo(), hpAdapter());
    void probeHighPerfAdapter().then(hp => { if (this.gpuPanel.open) this.gpuPanel.show(gpuInfo(), hp); });
  }
  /** One-time GPU readout after the first click; opens the panel when WebGL is on a weaker adapter than the browser can see. */
  private gpuNotice() {
    if (this.gpuNoticed) return;
    this.gpuNoticed = true;
    if (new URLSearchParams(location.search).get('gpu') === '0') return;   // headless screenshots: no panel / toast

    const g = gpuInfo();
    void probeHighPerfAdapter().then(hp => {
      const better = !!hp && hp.vendor !== '' && hp.vendor !== 'unknown' && hp.vendor !== g.vendor;
      const wrongGpu = g.software || (g.integrated && better);
      if (this.forceGpuPanel || (wrongGpu && !GpuPanel.suppressed)) this.toggleGpuPanel(true);
      else if (g.software || g.integrated) this.hud.toast(`GPU: ${g.name}${g.software ? ' · 소프트웨어 렌더링' : ' · 내장 GPU'} · G 키: GPU 선택 안내`, 8000);
      else this.hud.toast(`GPU: ${g.name}`, 5000);
    });
  }

  setHour(h: number) { this.env.setHour(h); this.hud.setTimeDisplay(this.env.hour); this.refreshClock(); }
  /** Preset hours follow the day's real sunrise / sunset (a June sunset is 21:58, a December one 16:56). */
  applyDayPresets() {
    const { sunrise, sunset } = this.env.sunTimes();
    const r = (h: number) => Math.round(h * 4) / 4;
    this.hud.setPresets([
      { label: '새벽', hour: r(sunrise - 0.25) }, { label: '낮', hour: 13 }, { label: '오후', hour: r(Math.max(14, sunset - 3.2)) },
      { label: '노을', hour: r(sunset - 0.35) }, { label: '야경', hour: Math.ceil(sunset + 1.4) % 24 + 0.02 }, { label: '심야', hour: 1 },
    ]);
    this.hud.setDateLabel(`${this.env.dateLabel()} · 파리`);
    this.refreshClock();
    this.refreshTimePanel();
  }
  /** P: copy a link that reproduces this view. */
  async share() {
    const url = shareUrl(this);
    const ok = await copyText(url);
    this.hud.toast(ok ? '링크를 복사했습니다' : '복사 실패 · 콘솔에 링크를 출력했습니다');
    if (!ok) console.log(url);
  }
  stepTime(dh: number) { this.timePanel.stop(); this.setHour(this.env.hour + dh); }
  /** N: jump to the next preset after the current time (dawn, noon, afternoon, sunset, night, late night). */
  /** Weather: sky/sun/fog in Environment, plus wet streets, rain and wind here. */
  applyWeather(toast = true) {
    const w = this.weather;
    this.env.setWeather(w);
    setWet(w === 'rain' || this.wetFlag ? 1 : 0);
    this.world.trees?.setWind(w === 'rain' ? 1.6 : w === 'overcast' ? 1.1 : 0.7);
    if (this.rain) this.rain.on = w === 'rain';
    this.audio.setRain(w === 'rain' ? 1 : 0);
    if (toast) this.hud.toast(WEATHER_LABEL[w]);
    this.refreshClock();
    this.timePanel?.setWeather(w);
  }
  setWeather(w: Weather, toast = true) { this.weather = w; this.applyWeather(toast); }
  cycleWeather() {
    const order: Weather[] = ['clear', 'overcast', 'rain', 'fog'];
    this.setWeather(order[(order.indexOf(this.weather) + 1) % order.length]);
  }

  cycleTime() {
    const sorted = [...this.hud.presets].sort((a, b) => a.hour - b.hour);
    const h = this.env.hour;
    const next = sorted.find(p => p.hour > h + 0.05) ?? sorted[0];
    this.timePanel.stop();
    this.setHour(next.hour);
    this.hud.toast(`${next.label} · ${formatHour(next.hour)}`, 1500);
  }

  /** Debug helpers: ?auto=1 skips the overlay; ?fly=1&x=..&y=..&z=..&yaw=deg&pitch=deg places the camera; ?hour=19.5 sets the time. */
  private applyUrlParams() {
    const q = new URLSearchParams(location.search);
    // Every number here is clamped: a malformed share link (or `?hour=` with no value) used to put NaN into the
    // camera, the sun and the sky shader, and the whole frame went black with nothing in the console.
    const HALF = 4000;   // generous: the world square is +/-1536 m but the fly camera may sit outside it
    if (q.get('walk') === '1' && hasNum(q, 'x')) {
      // Walk-mode placement (share links): feet at (x,z), optional y to probe a deck at that height.
      this.flying = false;
      const x = queryNum(q, 'x', 0, -HALF, HALF), z = queryNum(q, 'z', -409, -HALF, HALF);
      const yaw = hasNum(q, 'yaw') ? THREE.MathUtils.degToRad(queryNum(q, 'yaw', 0, -3600, 3600)) : yawTo(x, z);
      this.player.place(x, z, yaw, hasNum(q, 'y') ? queryNum(q, 'y', 0, -100, 1000) : undefined);
      if (hasNum(q, 'pitch')) { this.input.pitch = THREE.MathUtils.degToRad(queryNum(q, 'pitch', 0, -89, 89)); this.player.apply(); }
    } else if (hasNum(q, 'x') || q.has('fly')) {
      this.flying = true;
      const x = queryNum(q, 'x', -480, -HALF, HALF), z = queryNum(q, 'z', -409, -HALF, HALF);
      const y = hasNum(q, 'y') ? queryNum(q, 'y', 0, -100, 3000) : this.world.groundY(x, z) + 1.7;
      this.fly.position.set(x, y, z);
      this.input.yaw = hasNum(q, 'yaw') ? THREE.MathUtils.degToRad(queryNum(q, 'yaw', 0, -3600, 3600)) : yawTo(x, z);
      this.input.pitch = THREE.MathUtils.degToRad(queryNum(q, 'pitch', 0, -89, 89));
      this.fly.apply();
    }
    // ?at=<landmark id>: land there (unless x/z were given) and open its card
    const at = q.get('at') ? this.world.landmarks.byId.get(q.get('at')!) : undefined;
    if (at) { if (!q.has('x')) this.goTo(at, { instant: true, quiet: true }); this.currentLandmark = at.hidden ? null : at; this.placePanel.show(at, 'manual'); }   // a shared link keeps the card open until I
    if (hasNum(q, 'hour')) this.setHour(queryNum(q, 'hour', 12, 0, 24));
    if (q.has('timepanel')) this.hud.toggleTimePanel(q.get('timepanel') !== '0');
    if (q.get('auto') === '1') { this.hud.showOverlay(false); this.gpuNotice(); }
    if (hasNum(q, 'fov')) { this.camera.fov = queryNum(q, 'fov', 70, 20, 130); this.camera.updateProjectionMatrix(); }
    if (q.get('xr') === '1' && 'xr' in navigator) this.xr = new XRMode(this.renderer, this.scene, this.camera, this.input);   // experimental WebXR
    if (q.get('post') === '0') this.post.enabled = false;
    if (q.get('ao') === '0') this.post.setAo(false);                          // no ambient occlusion (A/B)
    if (q.get('clouds') === '0') this.env.setClouds(false);
    if (q.get('noshadow') === '1') this.renderer.shadowMap.enabled = false;
    if (q.get('noenv') === '1') { this.scene.environment = null; this.env.disableHdri = true; }
    if (q.get('details') === '0') this.world.buildings.detailDistance = 0;
    if (q.get('lamps') === '0') localLights.enabled = false;           // no local lamp lighting (A/B)
    const refl = q.get('refl');                                          // ?refl=0 off, 1 half res (default), 2 quarter res
    if (refl === '0' && this.post.reflection) { this.post.reflection.enabled = false; this.world.water?.setReflection(null, null); }
    else if (refl === '2') this.post.reflection?.setDivisor(4);
    if (q.get('refldbg') === 'uv') this.world.water?.setReflectionDebug(1);
    if (q.get('refldbg') === 'uv2') this.world.water?.setReflectionDebug(2);
    if (q.get('stars') === '0') { this.env.starsOn = false; (this.env.sky.material as THREE.ShaderMaterial).uniforms.uStarsOn.value = 0; }
    if (q.get('lampsdebug') === '1') localLights.debug = true;        // magenta lamps: spot materials that miss the hook
    if (q.has('clear')) this.renderer.setClearColor(new THREE.Color('#' + q.get('clear')));
    if (q.has('skydim')) { const u = (this.env.sky.material as THREE.ShaderMaterial).uniforms; u.uDim.value = queryNum(q, 'skydim', 1, 0, 10); console.log('sky uniforms', JSON.stringify({ dim: u.uDim.value, sun: u.sunPosition.value, turb: u.turbidity.value, ray: u.rayleigh.value, mie: u.mieCoefficient.value, night: this.env.night })); }
    // ?hide=far,eiffel,trees,buildings,terrain,water,bridges,furniture,sky  (debugging)
    for (const name of (q.get('hide') ?? '').split(',').filter(Boolean)) {
      const w = this.world as unknown as Record<string, { group?: THREE.Object3D } | undefined>;
      if (name === 'sky') this.env.sky.visible = false;
      else if (w[name]?.group) w[name]!.group!.visible = false;
    }
    const quality = q.get('quality'); if (quality === 'low' || quality === 'medium' || quality === 'high') this.post.setQuality(quality);
  }

  /** Minimap click: glide to that point (walking: onto the ground / a deck there; flying: same height), keep the heading. */
  goToPoint(x: number, z: number) {
    x = Math.max(-1536, Math.min(1536, x)); z = Math.max(-1536, Math.min(1536, z));
    const yaw = this.input.yaw;
    let target: THREE.Vector3, land: () => void;
    if (this.flying) {
      const y = Math.max(this.camera.position.y, this.world.groundY(x, z) + 1.7);
      target = new THREE.Vector3(x, y, z); land = () => { this.fly.position.set(x, y, z); this.fly.apply(); };
    } else {
      const feetY = this.landingY(x, z);
      target = new THREE.Vector3(x, feetY + 1.7, z); land = () => { this.player.place(x, z, yaw, feetY + 1); this.input.pitch = 0.02; this.player.apply(); };
    }
    this.hud.prompt(null);
    if (this.noGlide) { this.glide.cancel(); land(); } else this.glide.start(target, yaw, this.flying ? this.input.pitch : 0.02, land);
    if (!this.input.touchMode) this.input.lock();
  }

  /** Feet height for a landing at (x,z): a bridge deck over the river when there is one, else the terrain / nearby deck. */
  private landingY(x: number, z: number): number {
    const g = this.world.groundY(x, z);
    if (g < this.world.manifest.waterLevelY + 0.15) {
      const w = this.collision.walkableY(x, this.world.manifest.waterLevelY + 12, z, 8, 25);
      if (Number.isFinite(w)) return w;
    }
    return this.player.groundAt(x, z, g + 1);
  }

  /** Go to a landmark: a short camera flight (or an instant hop), then the walking / flying controller takes over and the card opens. */
  goTo(lm: Landmark, opts: { instant?: boolean; quiet?: boolean } = {}) {
    const v = lm.view;
    let tx = v.x, tz = v.z, yaw = THREE.MathUtils.degToRad(v.yaw), pitch = this.flying ? 0.03 : 0.02;
    let feetY: number | undefined, flyY: number | undefined;
    if (v.deck != null) {
      const deck = this.tower.viewpoint();
      if (deck) { this.flying = false; tx = deck.x; tz = deck.z; feetY = deck.y; yaw = yawTo(deck.x, deck.z, -480, -409); }
      else { this.flying = true; tx = -42; tz = -30; flyY = 121; yaw = yawTo(-42, -30, -480, -409); pitch = -0.12; }
    }
    if (feetY == null && !this.flying) feetY = this.landingY(tx, tz);
    const camY = this.flying ? (flyY ?? this.world.groundY(tx, tz) + 1.7) : feetY! + 1.7;
    const land = () => {
      if (this.flying) { this.fly.position.set(tx, camY, tz); this.input.yaw = yaw; this.input.pitch = pitch; this.fly.apply(); }
      else { this.player.place(tx, tz, yaw, feetY! + 1); this.input.pitch = pitch; this.player.apply(); }
      this.hud.prompt(null);
      this.currentLandmark = lm.hidden ? null : lm;
      this.placeCandidate = null; this.placeCandidateHits = 0;
      if (!opts.quiet) { this.placeShownAt.set(lm.id, performance.now() / 1000); this.placePanel.show(lm, 'arrival'); }
    };
    const dist = Math.hypot(tx - this.camera.position.x, tz - this.camera.position.z);
    if (opts.instant || this.noGlide || dist < 3) { this.glide.cancel(); land(); return; }
    this.glide.start(new THREE.Vector3(tx, camY, tz), yaw, pitch, land);
  }

  toggleFly() {
    this.flying = !this.flying;
    this.touch?.setFlying(this.flying);
    this.hud.toast(this.flying ? '비행 모드 · Q/E 하강·상승 · F 걷기' : '걷기 모드', 1800);
    if (this.flying) { this.fly.position.copy(this.camera.position); this.fly.speed = 15; }
    // Landing from flight has to find bridge decks and tower floors too: over the river the raw terrain is the
    // sunken river bed, so groundY alone drops the player through the deck into the water.
    else { const p = this.camera.position; this.player.position.set(p.x, Math.max(this.landingY(p.x, p.z), p.y - 1.7), p.z); }
  }

  private updateStatus() {
    if (!this.hud.diagnostics) return;
    const p = this.camera.position;
    const yawDeg = ((THREE.MathUtils.radToDeg(this.input.yaw) % 360) + 360) % 360;
    const w = this.world;
    const floor = !this.flying ? this.tower.floorAt(this.player.position.x, this.player.position.y, this.player.position.z) : null;
    this.hud.setStatus(`${this.flying ? 'FLY' : 'WALK'}${floor ? ' ' + floor : ''}  x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}\nyaw ${yawDeg.toFixed(0)}°  ground ${w.groundY(p.x, p.z).toFixed(1)}\nchunks ${w.buildings.loadedCount}/144  pending ${w.pending}  bvh ${this.collision.colliderCount} walk ${this.collision.walkableCount}/${this.collision.pendingWalkCount} lift ${(this.player.position.y - w.groundY(this.player.position.x, this.player.position.z)).toFixed(2)}${w.marks ? '  ' + w.marks.stats : ''}${w.streets ? '  streets ' + w.streets.count : ''}\n${w.buildings.detailStats}${w.trees ? '  ' + w.trees.stats : ''}${w.life ? '\n' + w.life.stats : ''}${this.audio?.debug ? '\n' + this.audio.status() : ''}\ninput maxΔ ${this.input.maxDelta.toFixed(0)}px spikes ${this.input.spikes}  programs ${this.renderer.info.programs?.length ?? 0}  longtasks ${this.longTasks} (max ${this.longTaskMax.toFixed(0)} ms)\ngpu ${gpuInfo().name}${gpuInfo().software ? ' (SOFTWARE)' : gpuInfo().integrated ? ' (integrated)' : ''}  hp-adapter ${hpAdapter() === undefined ? '…' : hpAdapter()?.vendor ?? 'n/a'}`);
  }
}
