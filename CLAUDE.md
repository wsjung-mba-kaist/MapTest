# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A first-person walk around the Eiffel Tower (≈1.5 km radius) built only from open data (OSM, IGN BD TOPO / BD ORTHO / RGE ALTI / LiDAR HD, Paris open data, Wikidata). Two halves that share one coordinate frame and one binary format:

- **`scripts/`** – an offline *bake* pipeline (Node, run with `tsx`) that downloads sources into `cache/` and writes runtime assets into `public/data/` and `public/models/`.
- **`src/`** – the browser runtime (Vite + three.js ~0.185) that streams those assets.
- **`shared/`** – code imported by both: geodesy, chunk layout, binary mesh container, heightmap, and the small pure tables (night lighting, signals, season, crossings). Anything that defines a *file format* or a *number both sides must agree on* lives here, not in `scripts/` or `src/`.

The README is in Korean and is the authoritative feature/URL-parameter reference; UI strings are Korean.

## Commands

```bash
npm run dev            # Vite dev server on :5173 (serves raw public/data)
npm run dev:lan        # same, exposed on the LAN for phones
npm run build          # production bundle to dist/
npm run build:compressed   # build + .br files next to every .bin/.json/.glb/.hdr
npm run preview        # serves dist/ with Content-Encoding: br (vite.config.ts plugin)

npm run typecheck      # tsc on tsconfig.json (src+shared) AND tsconfig.scripts.json (scripts+shared)
npm test               # node --test over shared/**/*.test.ts and scripts/**/*.test.ts
node --import tsx --test shared/season.test.ts     # a single test file

npm run lint           # eslint (correctness rules only; the dense style is deliberate)
npm run smoke          # headless Chromium (SwiftShader) streams the whole square, fails on shader errors / exceptions

npm run bake           # every step in order; download steps skip when their outputs exist (build/paths/markings/streets always rebuild)
npm run bake:<step>    # one step (osm, bdtopo, terrain, ortho, masks, trees, assets, eiffel, towerwalk,
                       #           models, dsm, build, paths, deshadow, markings, streets, far, landmarks)
npm run bake:<step> -- --force   # ignore cache/outputs for that step
```

Tests use `node:test` + `node:assert/strict`, import `.ts` files with explicit extensions, and only cover pure code in `shared/` and `scripts/lib/`; a few read source files to pin contracts (`shared/shaders.test.ts` checks `facade.glsl` against the shared enums, `shared/urlparams.test.ts` checks the README documents every URL flag). `npm run smoke` is the only browser check (headless Chromium over CDP: shader compile errors, uncaught exceptions, the modal contract) and `npm run verify:data` parses the committed `public/data` with the current readers — run it after touching anything in `shared/`, since a rebake needs `cache/`. A step that fails under `npm run bake` logs and continues; under `bake:<step>` it throws.

Two tsconfigs exist because `scripts/` uses `NodeNext` resolution (imports need `.ts` extensions) while `src/` uses `Bundler` resolution (no extensions). `shared/` is compiled under both, so keep its imports extension-qualified (`./geo.ts`) and free of DOM/three.js types.

## Coordinate frame and data layout (read `shared/geo.ts` and `shared/layout.ts` first)

- World frame: ENU metres centred on the Eiffel Tower, **x = east, z = south (north is −z), y = up**, `y = NGF altitude − 33.8`. Convert lon/lat with `frame.toWorld` / `frame.fromWorld`; never with a Mercator approximation.
- The baked square is `[-1536, 1536]²` split into a 12×12 grid of 256 m chunks (`chunkIndexOf`, `chunkOrigin`, `chunkKey` → `"i_j"`). Chunk meshes store vertices relative to their chunk origin; the runtime places each chunk group at that origin.
- `shared/layout.ts` holds every stride/enum/flag the two sides share: `TREE_STRIDE`, `FURNITURE_STRIDE`, `DETAIL_STRIDE`, `SurfaceFlag` (packed into building `COLOR_0` alpha), `SurfaceClass`, `MarkKind`, `FurnitureKind`, the `Manifest` and `Landmark` shapes. Changing any of them requires re-baking and updating the reader.
- `shared/binmesh.ts` defines the `PBM1` container (magic, JSON header, 4-byte-aligned attribute arrays, index array). Writer: `scripts/lib/binmesh.ts` (`GeomBuilder`, `encodeBinMesh`). Reader: `src/world/DataLoader.ts` (`binMeshToGeometries`, optional `skip` set of section names).
- Per-chunk building files (`public/data/chunks/{i}_{j}.bin`) contain sections `walls`, `roofs`, `tops`, `lod`, and when a landmark has a LiDAR roof cap also `dsm`, `roofs_alt`, `tops_alt`. The runtime loads either `dsm` or the `*_alt` pair depending on `dsmEnabled` (desktop on, touch devices off, `?dsm=`).

## Bake pipeline (`scripts/bake.ts` + `scripts/lib/*.ts`)

- `bake.ts` is a thin orchestrator: an ordered `steps` array, each lazily importing `lib/<name>.ts` and calling `run(ctx)` with `{ force, only }`. Add a step by appending to that array and to the `bake:*` scripts in `package.json`.
- Step order matters: `osm`/`bdtopo`/`terrain`/`ortho` download; `build` is the big one (buildings → chunks, water, bridges, furniture, fountains, rail, and `manifest.json`); `paths`, `markings`, `streets`, `masks`, `far`, `landmarks` read `build`'s outputs and add their own files/counts to the manifest (`build` preserves previous `counts`/`files` when re-run).
- Caching convention: raw downloads go through `cachedBytes/cachedJson` in `scripts/lib/http.ts` (atomic `.part` rename, retry with backoff on 429/5xx; other 4xx fail at once unless the call lists them in `retryOn`, which the IGN WMS BIL requests do for 400). Each step's `run` begins with `if (!ctx.force && await exists(out)) return`. Overpass `points` is fetched as 3×3 tiles with a `coverage` record and resumes missing cells on re-run.
- All endpoints, bboxes, roof overrides, Haussmann defaults, and asset lists are in `scripts/config.ts`. Env knobs are parsed once into the `ENV` object in `scripts/config.ts` (one comment each; modules import it rather than reading `process.env`): `DSM=0`, `DSM_IDS`, `DESHADOW=0`, `ORTHO_SUN_AZ/ELEV`, `ORTHO_SUN_AUTO=1` (estimate the capture sun instead of the configured one), `EIFFEL_SOURCE`, `EIFFEL_TEXTURE`, `ALLOW_NONFREE=1`, `PATHS_DEBUG=1`.
- Two heightmaps: `cache/terrain_raw.bin` is the untouched DTM (a bake intermediate, not served), `terrain.bin` has river beds and basins lowered by `build`. In bake code `loadHeightmap(true)` = raw (used by `build`/`dsm`; it throws when the raw copy is missing rather than reading the already-lowered `terrain.bin`, and `bake:terrain` rebuilds just that copy from `cache/bil/`), `loadHeightmap()` = lowered (paths, markings, streets). The runtime only ever sees the lowered one, and `Heightmap.meshY` (4 m anti-diagonal split) is the height of the *rendered* ground, while `sample` is the 2 m bilinear DTM.
- Cache layout under `cache/`: `overpass/` (raw JSON, tiled `points` carries `coverage`), `osm/*.geojson` + `summary.json`, `bdtopo/`, `bil/` (elevation quads), `wmts/{z}/{x}/{y}.jpg`, `dsm/`, `paris/` (trees), `assets/`, `models/`, `landmarks/`, `ortho_raw/` (pre-deshadow originals). `--force` bypasses the *output-exists* check of a step but not `cachedBytes`; to re-download something, delete it from `cache/`.
- Hero models: `scripts/landmarks_models.ts` is the registry; `bake:models` fits GLBs to OSM footprints. The Eiffel Tower keeps its own pipeline (`eiffel.ts` → `eiffel_walk.ts` for deck/lift detection).
- `public/data/` and `public/models/` are committed outputs; `cache/` is gitignored. Vite ignores both `public/data` and `public/models` in its watcher on purpose.

## Runtime (`src/`)

Bootstrap is `src/main.ts` → `App.boot()` in `src/core/App.ts`, in this order: parse URL flags into `World`/`Environment` options → `world.load()` (manifest, heightmap, terrain, building streamer, water, bridges, tower, hero models, trees, furniture, far ring, markings, streets, landmarks, life) → wire collision (`Collision` wraps three-mesh-bvh; chunk walls register on load, bridge decks/tower floors/sidewalk slabs are "walkables") → `TowerAccess.load` → controllers → minimap/audio/touch → register `Loop` ticks → key bindings → `applyUrlParams()`. Anything that must exist before a URL placement probes the ground must be registered before `collision.flushWalkables()`.

- `World` (`src/world/World.ts`) owns every baked layer as an optional field and calls their `update(...)` each frame. Independent layers load in one `Promise.all`; most are best-effort: a missing file logs a warning and the field stays `undefined`. Check for `undefined` rather than assuming a layer exists. Shared helpers: `ChunkRadius` (enter/leave callbacks over the 12×12 grid with hysteresis — `Streets`, `Markings`, facade-detail drop in `Buildings`), `gltf.ts` (`adoptGltfScene` / `adaptGltfMaterial` for the tower and hero models), `Terrain.onTileChanged/onMask/onOverview` listener lists (`Buildings.attachTerrain`, `Bridges.attachTerrain`, `Streets` subscribe themselves), `fetchJson` for every JSON fetch.
- `App` is the composition root; the concerns it used to hold live beside it: `TimeController` (hour, date, weather, presets, time-lapse → clock chip and time panel), `QualityController` (quality / AO / shadows / reflection / pixel ratio preferences and the automatic step-down), `ModalManager` (`src/ui/ModalManager.ts`: one panel at a time, the pointer-lock contract; the time panel and GPU panel are `light` kinds), `Keymap` (the shortcut table App binds and Input's gamepad map derives from). UI copy is in `src/ui/strings.ts` (`S`, `fmt`), DOM lookups go through `src/ui/dom.ts` `required(id)`.
- Streaming: `Buildings` enqueues all 144 chunks in a `PriorityLoader` (nearest-first, concurrency 4). LOD0 ↔ LOD1 swap at `lodDistance`, shadows off past `shadowDistance`, facade details (`BuildingDetails`, `RoofDetails`) are built lazily one chunk per frame within `detailDistance` and disposed when far. `Terrain` streams per-chunk ortho tiles the same way and notifies `Buildings`/`Bridges` through `onTileChanged`.
- Frame loop: `Loop` runs registered ticks then `onRender`; the driver is `renderer.setAnimationLoop` so WebXR can take over. Tick order as registered in `App.boot`: input/collision/controller → audio + minimap + landmark proximity → `world.update` (streaming + life) → rain/season → environment + `post.setNight` → local lights → status line → render. `Post` (postprocessing EffectComposer: RenderPass → N8AO → bloom/vignette/AgX → SMAA) renders; `WaterReflection` is a pre-pass owned by `Post`. Tone mapping lives in the composer, so `renderer.toneMapping` is `NoToneMapping` while `Post` is enabled.
- `PriorityLoader` (`DataLoader.ts`) rejects a key only while a request for it is queued or in flight and forgets finished keys, so layers that unload chunks (`Terrain` full tiles, `Streets`, `Markings`) can reload them; `cancel(key)` drops a queued request that has not started. Each of those layers checks "dropped while in flight" in its job before adding meshes — keep that check when adding a streaming layer.
- Materials are `MeshStandardMaterial` + `onBeforeCompile` patches (the facade shader is `src/materials/shaders/facade.glsl` imported with `?raw`; FacadeMaterial prepends `STYLE_*` / `FLAG_*` / `STYLE_SCALE` defines and the generated `litProbability()` from `shared/`, so the GLSL never carries those literals). Each patch starts with `assertAnchors(...)` from `src/materials/patch.ts` listing the `#include` anchors it replaces (dev throws, prod logs once); add the anchor there when you add a `.replace('#include <…>')`. Global singletons they hook into: `buildingUniforms` (`FacadeMaterial`), `localLights` (`LocalLights`, fixed 32 static + 16 dynamic light slots injected via `withLamps`), `setWet` (`GroundMaterial`). Any new lit material must go through `withLamps` or it will ignore street lamps (`?lampsdebug=1` paints those magenta).
- Streaming radii live in `src/world/radii.ts` (one table: buildings LOD 800 m / shadows 600 / details 520+350, streets 620/900 with walkables 330+120, markings 460/720, trees 240, life edges 220–350 + 60 m despawn, far traffic derived from those, hero LOD 900) and the mobile preset in `MOBILE_RADII`; the classes read their defaults from there. Per-frame chunk scans use `chunkCentreX/Z` (scalars) and call `loader.reprioritise()` once per update.
- Moving city (`src/world/life/`): `PathGraph` loads `paths.bin`; `Life` activates edges near the player and owns `Crowd`, `Traffic`, `Boats`, `Metro`, `Cyclists`, `Signals`, `FarTraffic`. The structure-of-arrays agent sets extend `AgentPool` (register every column in the constructor — `remove(i)` swap-copies the registered columns, so a new per-agent array that is not registered silently desyncs on despawn; `despawnFar`, `seedNew`, the camera-cone `vetoSpawn` are shared). `PathGraph.headingInto` (shared/paths.ts `edgeHeadingInto`) is the one "direction into a node" used by signals, the car signal table, junction turns and the crossings table. Densities and light states come from pure functions in `shared/nightlife.ts` (incl. `activity`), `shared/signals.ts`, `shared/crossings.ts` so they are testable without three.js. `SimClock` decouples sim time from wall time (`?sim=`, `?simt=`).
- Quality: the touch/mobile preset is applied in `App.boot` (pixel ratio 1, AO and reflection off, 2048 shadow map, smaller detail/LOD distances, half the lamp slots). `?quality=low|medium|high` goes to `Post.setQuality`.
- UI: `index.html` holds the DOM and CSS in fixed HUD zones (top-left landmark card, top-centre compass + streaming counter, top-right clock chip + time panel, bottom-left hint bar + diagnostics, bottom-centre prompt/toast, bottom-right minimap, centred `.modal` panels). `#overlay` is the start screen until the first start and the translucent pause menu afterwards (`Hud.markStarted`). One modal at a time through `App.openModal/closeModal` (releases / re-grabs the pointer). User settings live in `shared/prefs.ts` (pure, tested, versioned: bump `PREFS_VERSION` and add a `migratePrefs` step, never reset) + `src/ui/Prefs.ts` and are pushed by `App.applyPrefs`; every localStorage key is registered in `src/ui/storage.ts` (ESLint forbids `localStorage` elsewhere) so "reset to defaults" clears them all. URL parameters are applied afterwards so they win for that session without being saved. Diagnostics (stats-gl + status line) are off unless `?status=1`, `H` twice or the setting. `window.app` is exposed for console / screenshot automation.
- Debug/feature flags are URL parameters parsed once by `App` through `shared/urlparams.ts` (`UrlParams`: typed, clamped accessors; `URL_PARAM_NAMES` is the registry). Modules never read `location.search` themselves (ESLint rule) — App passes the value in (`SimClock`, `FacadeMaterial.setFacadeTextures`, `WaterReflection`). Adding a flag = add the name to `URL_PARAM_NAMES`, read it in `App`, document it in the README; `urlparams.test.ts` fails otherwise. Share links are built/parsed by `buildShareQuery`/`parseShareState` in the same module.

## Hard constraints

- **Fragment sampler budget**: the ground shader (`GroundMaterial`) sits at 15 of the 16-sampler WebGL2 limit. Adding a texture there makes the ground disappear on ordinary GPUs. Count samplers before adding uniforms to it or to `FacadeMaterial`.
- **DSM triangle budget**: `bake:build` throws if LiDAR roof caps exceed 1.2 M triangles; adjust grid step / simplification in `scripts/lib/dsmroof.ts` rather than raising the budget casually.
- **Pointer lock**: requested with `unadjustedMovement`; mouse deltas over 300 px are treated as cursor warps and dropped (`src/player/Input.ts`). Panels that need the mouse (`T`, `L`, `G`) must go through the `input.unlock()` / re-lock contract used by `toggleTimePanel`.
- Renderer creation (`src/core/Renderer.ts`) first requests `high-performance` + `failIfMajorPerformanceCaveat` and only then falls back to a software context on a fresh canvas. `App.canvas` is the renderer's canvas, which may differ from the one in `index.html`.
- Licences matter: every data/model/texture source is credited in the README table and in the HUD (`hud.addCredit`). New assets must be CC0/CC BY/ODbL-compatible or gated behind `ALLOW_NONFREE`.

## Traps that have already cost a rebake

- **`FurnitureKind` has two ranges, not just values.** Parked cars occupy `Car + variant` (10..17, one per `CAR_VARIANTS` entry) and idle people occupy `Person + variant` (20..23). A single kind placed inside either range is silently read back as a car or a person. `shared/layout.test.ts` pins this.
- **`meta.w` packs style and seed** as `style * 256 + seed`. Decode with the helpers in `shared/layout.ts`; never round the quotient. `src/materials/shaders/facade.glsl` mirrors the same arithmetic and must be kept in step.
- **Bridge supports assume the axis centre is the deck centre.** `principalAxis` in `scripts/lib/bridges.ts` returns a re-centred point for exactly that reason; piers and arch springings are laid out across `[-half, +half]` about it.
- **Buildings with no height tag fall through to the Haussmann default** (18.5 m eave, mansard roof). Anything that is not a Paris apartment block — moored boats, pontoons, piers — needs an explicit branch, or it becomes a six-storey block. See the `floating` flag in `scripts/lib/buildings.ts`.
- **Only some bake steps work offline.** `build`, `paths`, `markings`, `streets`, `masks`, `far` run entirely from `cache/`. `osm` and `landmarks` fetch from Overpass / Wikidata and produce degraded output if the network is unavailable — a forced `bake:landmarks` without a network rewrote `landmarks.json` with 25 of 33 entries empty. Check `git diff` on `public/data` after any forced bake.
- **`public/data` is committed.** Keep the code commit and the regenerated-output commit separate.

## Verifying a visual change

There is no browser test setup, but Chrome can be driven over the DevTools protocol without extra dependencies (node has a global `WebSocket`): launch it with `--headless=new --use-gl=swiftshader --enable-unsafe-swiftshader --remote-debugging-port=9222`, navigate a page target, wait, then `Page.captureScreenshot`. Software rendering takes 1-2 minutes to stream all 144 chunks, so pass `&life=0&post=0&refl=0&ao=0` to cut the cost, and `&auto=1&gpu=0` to skip the overlay and the GPU panel. `Log.enable` plus `Runtime.enable` surface three.js shader compile errors, which a `vite build` cannot catch. UI states can be driven through `window.app` from `Runtime.evaluate` (e.g. `app.hud.markStarted(); app.hud.showOverlay(true)` for the pause menu, `app.openModal('settings')`); give the page ~70 s on SwiftShader before evaluating or `applyUrlParams` may still run afterwards.

## Conventions

- Dense single-line style with doc comments explaining *why* (real-world numbers, source quirks). Match it; do not reformat.
- Runtime files use `import * as THREE from 'three'`, hot-loop code reuses preallocated `Vector3`s (see `feetTmp`/`fwdTmp` in `App`).
- Extending the world usually means one new bake module under `scripts/lib/`, one runtime class under `src/world/` exposing `group`, `async load()`, `update(...)` (and disposal of GPU resources if it streams), wired in `World.load`, plus a `files`/`counts` entry in the manifest.
