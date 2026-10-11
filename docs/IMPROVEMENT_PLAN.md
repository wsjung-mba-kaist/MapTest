# MapTest 코드 리뷰 및 개선 계획

기준 커밋 `297a134`. `npm run typecheck` 통과, `npm test` 81/81 통과, `npm run build` 성공(메인 번들 1.13 MB, gzip 395 kB).
검토 범위: `scripts/` 전체(약 8.3k 줄), `src/` 전체(약 10k 줄), `shared/` 전체, `index.html`, 설정 파일. 파일은 수정하지 않았음.

---

## 0. 진행 현황 (브랜치 `ccr-d9f33420-2rx7wa`)

검증 상태: `npm run typecheck` 통과, `npm test` 108/108 (처음 81), `npm run lint` 0 오류, `npm run build` 통과(three/post/bvh 벤더 청크 분리, 앱 코드 344 kB), `npm run verify:data` 통과(커밋된 `public/data` 144/144 청크를 새 리더로 파싱), `npm run smoke` 통과(개발·프로덕션 빌드 모두: 부트, 144/144 스트리밍, 모달 계약, 예외·셰이더 오류 0).
이 환경에는 `cache/`(원본 다운로드)가 없어 **베이크는 재실행하지 않았다**. 베이크 쪽 변경은 테스트·코드 읽기로만 검증됐으므로, 다음 `npm run bake` 후 `git diff --stat public/data`로 분수(A11)·다리(A12)·DSM(A3) 외에 바뀐 것이 없는지 확인할 것.

| Phase | 상태 | 비고 |
|---|---|---|
| 0 안전망 | 완료 | CI(typecheck·lint·test·build + SwiftShader 스모크 잡), ESLint flat config(정확성 규칙만), `scripts/smoke.ts`, `.editorconfig`, 문서 수정 |
| 1 런타임 버그 | 완료 | A1·A4~A10·A14 + 오디오 wake, 반사 타깃 크기, 위키 링크 스킴, roundRect 폴리필 |
| 2 베이크 버그 | 완료 (리베이크 미실행) | A2(+재시도 테스트)·A3·A11·A12·A13·Overpass 테마별 summary |
| 3 shared 계약 | 완료 | 버전 상수+리더 검사, 매니페스트 대조, Style·변형 수·플래그 공용화, GLSL define 주입, PBM1 라운드트립·hash·셰이더 동기화 테스트, `verify:data` |
| 4 성능 | 완료 | World.load/Life 병렬, 로더 정렬, 핫루프 할당 제거, Traffic 캐시, 오디오 20 Hz, 터치 fullRadius 0, terrain_raw.bin 제거, Vite base·청크 분할·XR 지연 |
| 5 구조 | 완료 (소항목 4건 남음) | `shared/urlparams.ts`, `patch.ts`, `edgeHeadingInto`, `radii.ts`, prefs v2 + `storage.ts`; 2차: App 분해(`TimeController`·`QualityController`·`ModalManager`·`Keymap`, 733 → 647줄), `GlobalUniforms`(import 순환 해소), `ChunkRadius`·`AgentPool`(Cyclists도 카메라 콘 스폰 거부)·`gltf.ts`·Terrain 리스너·`fetchJson`·나무 피트 메시 청크당 1개, UI `dom.ts`·`strings.ts`·모달 포커스 트랩/복귀·메뉴 화살표 키 |
| 6 파이프라인 | 완료 (리베이크 미실행) | `Step.requires`·알 수 없는 step 거부, 원자적 writeJson·캐시 전 validate, landmarks 열화 가드+병합, ortho/deshadow 타임스탬프, 중복 헬퍼 통합, `ENV` 집중, LICENSES 생성, 죽은 코드 제거 |

### 남은 소항목 (각각 작은 PR)
1. **키 범례 세 번째 사본**: `index.html` 시작 화면의 `.keys` 격자는 아직 정적이다. `KeyRow`에 축약 라벨을 더해 `S.help.groups`에서 렌더하면 된다. `src/core/Keymap.ts`(바인딩·게임패드·라벨)와 `strings.ts`의 `HELP_GROUPS`(도움말 표 문장)는 역할이 달라 둘 다 두었다; 모든 바인딩 키가 도움말 표에 있는지 검사하는 테스트는 테스트 글롭이 `src/`를 포함하지 않아 미작성.
2. **GpuPanel** 포커스 트랩/복귀 (Modal 베이스가 아님).
3. **`ChunkRadius`·`AgentPool` 단위 테스트**: `src/world` 아래라 `npm test` 글롭 밖이다. 글롭을 `src/**/*.test.ts`로 넓히되 three.js를 import하는 파일은 node에서 로드되므로 순수 모듈만 테스트.
4. **SwiftShader 컨텍스트 손실**: 모든 레이어를 켠 프로덕션 스모크에서 144 청크 스트리밍 뒤 WebGL 컨텍스트 손실 오버레이가 뜬다(변경 전 기준 커밋에서도 동일, 소프트웨어 렌더러의 한계). 하네스는 실패로 보지 않지만, `webglcontextrestored`를 받아 PMREM 환경맵과 반사 타깃을 다시 만들면 실제 기기에서도 이득이다.

### 베이크 운영자가 알아야 할 동작 변경
- `bake:<step>`은 선행 산출물이 없으면 생산 단계를 이름으로 알려 주며 즉시 실패하고, `--step=오타`는 exit 1.
- 검증에 실패한 다운로드(BIL 길이, 나무 JSON, WFS 페이지)는 캐시에 남지 않는다. 0건 WFS 레이어는 경고 후 캐시하지 않는다.
- `bake:landmarks --force`가 오프라인이면 exit 1에 기존 파일 유지; 부분 열화 온라인 실행은 id별로 풍부한 항목을 보존한다.
- `ground.json.generated`/`deshadow.json.orthoGenerated`로 ortho 재생성 뒤 deshadow가 자동 재실행된다(커밋된 데이터는 재실행 없음).
- `terrain_raw.bin`은 `cache/`에 쓰고 읽는다(구 위치 폴백 있음); 환경 변수는 `scripts/config.ts`의 `ENV`에서 한 번 파싱.
- 다음 `bake:assets`가 `LICENSES.md`를 섹션 구조와 올바른 탑 모델 크레딧(CC-BY Sketchfab)으로 다시 쓴다.

---

## 1. 전체 평가

### 잘 된 점
- **구조 분리가 명확하다.** `shared/`(포맷·좌표·공용 테이블) / `scripts/`(베이크) / `src/`(런타임)의 삼분할과, "파일 포맷이나 양쪽이 합의해야 하는 숫자는 `shared/`에" 라는 원칙이 CLAUDE.md에 적혀 있고 대체로 지켜진다.
- **레이어 패턴이 일관적이다.** 베이크 파일 하나 = 런타임 클래스 하나(`group` / `load()` / `update()`). `World`는 얇은 소유자이고, 파일이 없으면 경고만 내고 계속 뜬다(best-effort).
- **스트리밍 레이어의 GPU 수명 관리가 정확하다.** `Terrain`, `Streets`, `Markings`는 언로드 시 dispose하고 "떠나는 중에 도착한 요청" 레이스도 처리한다. CLAUDE.md가 경고하는 `PriorityLoader`의 `done` 집합 문제는 커밋 `a050339`에서 이미 고쳐졌다(문서가 낡음).
- **움직이는 도시의 설계가 좋다.** SoA 타입 배열, 종류별 `InstancedMesh` 하나, 해시 기반 결정성, 순수 규칙은 `shared/`(signals, crossings, nightlife)에 두고 테스트.
- **실측 숫자를 적은 주석**이 많아 휴리스틱을 검증할 수 있다.

### 취약한 점 (원칙 수준)
1. **계약이 관습으로만 지켜진다.** 스타일 ID, 플래그 임계값, `256` 스케일, 차량/사람 변형 수가 GLSL과 `scripts/`에 리터럴로 복제돼 있다. 버전 필드는 네 포맷 모두 "쓰기만 하고 읽는 쪽이 검사하지 않는다". 즉 낡은 `public/data`를 만나면 로더 깊숙한 곳의 `TypeError`가 유일한 방어선이다.
2. **조용한 열화(silent degradation)가 기본값이다.** 다운로드 바디를 검증 전에 캐시에 커밋, 지오메트리 헬퍼가 예외를 삼키고 빈 결과 반환, 오프라인 `landmarks`가 좋은 파일을 덮어쓰기, 셰이더 패치 앵커가 사라져도 무음. "실패는 크게, 열화는 명시적으로"가 필요하다.
3. **복사-붙여넣기로 자란 부분.** 도로 폭 테이블 4개, `toWorldPolys` 3개, `bufferLine` 2개(하나는 고친 버그가 남아 있음), 스캔 피터 2개(같음), 청크 거리 스캔 5개, "노드로 들어오는 방향" 계산 4개, glTF 채택 로직 2개.
4. **핫루프 할당.** CLAUDE.md가 "미리 할당한 Vector3 재사용"을 규약으로 적어 두었지만, `update()`들 안에서 매 프레임 수백 개의 소객체·배열이 생성된다.
5. **`App.ts`가 13가지 책임을 가진 god object**이고, 부트 순서 제약(`flushWalkables` → 첫 배치, `applyPrefs` → `applyUrlParams`)이 산문으로만 존재한다.
6. **도구 공백.** lint, 포맷 규칙, CI, 브라우저 스모크 테스트가 없다. CLAUDE.md에 헤드리스 Chrome 레시피가 있으니 비용은 낮다.

---

## 2. 발견 사항 (우선순위별)

범례: **[확인]** = 제가 코드를 직접 다시 읽어 재현/확정. 나머지는 영역별 정밀 검토에서 file:line과 함께 보고된 항목으로, 무작위로 뽑은 9건 모두 사실이었음.

### A. 지금 고쳐야 할 버그 (코드만, 리베이크 불필요)

| # | 위치 | 문제 | 원칙 / 수정 |
|---|---|---|---|
| A1 **[확인]** | `src/world/life/Crowd.ts:157`, `:235` | 횡단보도 에지에서도 6 %의 보행자가 `walk=0`(서 있음)으로 생성되고, 점유 카운트 `crossOcc`는 정지 여부를 보지 않음. `Traffic.ts:283-286`은 점유 > 0이면 차를 세우므로, 그 보행자가 280 m 밖으로 사라질 때까지 교차점 차량이 정지. | 상태 기계의 "탈출 조건"이 없는 상태는 반드시 데드락. `seedEdge`에서 `f & EdgeFlag.CROSSING`이면 `walk=1` 강제. |
| A2 **[확인]** | `scripts/lib/http.ts:21-52` | `throw lastErr`가 자신의 `try` 안에 있어 `catch`에 잡힌다. 404/403도 전 횟수 재시도(WMTS 타일 하나 실패 = 약 223 s 대기). `retryable` 분류가 죽은 코드. | 제어 흐름 탈출용 throw는 try 밖에서. `res`를 try에서 반환하고 상태 검사는 밖에서. `fetch` 스텁으로 404 1회 호출 테스트 추가. |
| A3 **[확인]** | `scripts/lib/dsmroof.ts:417` | `MeshoptSimplifier.ready`를 await하지 않음(`eiffel.ts:69`, `model_fit.ts:24`는 함). `bake:build` 단독 실행 시 WASM 미초기화 → `TypeError`가 `catch`에 삼켜져 단순화 없는 원시 격자 출력 → DSM 1.2 M 삼각형 예산 초과를 "grid step 올려라"라는 오도된 메시지로 던짐. | 비동기 초기화 자원은 사용 직전 아니라 로드 단계에서 await. `DsmProvider.load()`에 `await MeshoptSimplifier.ready`. catch는 실패 카운트를 로그로. |
| A4 **[확인]** | `src/player/Input.ts:111` | `axes()`가 `active`(포인터 락/터치/게임패드)를 보지 않음. Esc로 일시정지 오버레이를 띄우거나 설정 패널을 열어 포커스가 body로 가면 W로 뒤에서 걷는다. 커밋 `03f55a0`이 고친 버그의 거울상. | 입력은 "소비자가 활성인가"를 한 곳에서 판정. `axes()`가 `!this.active`면 0 반환. `gamepadActive`는 XR 종료·언락 시 해제. |
| A5 **[확인]** | `src/core/App.ts:299` → `Environment.ts:297` | 시간 흐름 재생 중 매 프레임 `refreshClock()` → `todayParis()` → `new Intl.DateTimeFormat(...)`. `Environment.ts:116-119` 주석이 "루프에서 뺐다"고 적은 비용이 다른 경로로 돌아왔다. | 비싼 순수 함수는 입력이 바뀔 때만. `todayParis()`를 분 단위 캐시하거나 `ymd` 변경 시에만. |
| A6 **[확인]** | `src/world/LandmarkModel.ts:140` | `night * (uNight.value >= 0 ? 1 : 1)` 항상 `night`. 의도는 탑처럼 23:45 이후 투광등 소등(`towerLit`). 결과: 명소 모델은 밤새 켜짐. | `App.ts:293`이 계산한 `lit`를 `update`에 전달. |
| A7 | `src/world/life/Metro.ts:32, :72` | `emissive` 미설정(기본 검정)이라 `emissiveIntensity = night`는 `vec3(0)` 곱. "해 지면 전조등" 주석이 거짓. | `CarKit.ts:203-211`처럼 `aEmit` 속성 + `emissive: 0xffffff`. |
| A8 | `src/world/Buildings.ts:120-145` | 파사드 디테일이 `null`인 청크도 지붕 디테일 파일을 받아 오고, dispose가 `c.details` truthy에 묶여 세션 내내 남음. 플레이어가 떠난 뒤 도착한 지붕 메시도 추가됨. | 지붕 fetch를 `c.details !== null`에 게이트, `.then`에서 "이미 떠남" 체크 후 즉시 dispose. |
| A9 | `src/world/Furniture.ts:147`, `src/world/Eiffel.ts:293` | 폴백 자동차·절차적 탑 재질이 `withLamps` 없이 생성 → 가로등 무시(CLAUDE.md 규약 위반). | `withLamps(...)` 감싸기. `FarRing`은 의도적 예외라고 주석. |
| A10 | `src/world/LandmarkLabels.ts:89` | `ctx.roundRect`는 `World.load`에서 try 밖의 유일한 호출. 구형 Firefox/Safari에서 라벨 하나가 부트 실패로 번짐. | 다른 선택 레이어처럼 try/catch 또는 기능 감지 후 `fillRect`. |
| A11 | `scripts/lib/build.ts:182-185` | `buildWater`가 `hm.data`를 제자리에서 낮춘 뒤 `buildFountains(water, hm)`가 그 낮춰진 지형을 읽음. 분수 물줄기 시작점이 수조 수면보다 약 0.5 m 아래. | 공유 상태를 변이하는 함수 뒤에 "원본을 가정하는 소비자"를 두지 않기. 순서 교체 또는 `basins[].y` 전달. (리베이크 필요) |
| A12 | `scripts/lib/bridges.ts:52-67` | `polygons.ts:204`의 `bufferLine`(조인트 디스크 회전으로 polygon-clipping 예외 회피)과 다른 **옛 복사본**을 사용. union 실패 시 `unionAll`이 예외를 삼키고 미합집합 반환 → 데크·난간·교각 중복. | 복사본 삭제, import. |
| A13 | `scripts/lib/eiffel_scan.ts:49-56` | `model_fit.ts:33-38`이 "자유의 여신상 팔이 떠 있던 원인"이라며 고친 공유 접근자 키 충돌 패턴이 그대로 남음. | `flatten()` 방식으로 포팅하거나 `model_fit` 1단계를 공용화. |
| A14 | `shared/nightlife.ts:56` | `alwaysOn` 모드에서 자정 이후 `towerSparkle`이 0(`towerLit`은 켜져 있음). 테스트가 자정 전만 검사. | `towerLit`의 조건을 미러링, `sunrise` 전달. 테스트 추가. |

### B. 계약 드리프트: `shared/`가 단일 진실원이 되지 못하는 지점

**버전 필드가 쓰기 전용** — PBM1 `header.version`(`shared/binmesh.ts:26`), `manifest.version`(`build.ts:191`), `PATHS_VERSION`(`paths.ts:427`), `LandmarksData.version`(`landmarks.ts:270`) 모두 리더가 비교하지 않음. `parseBinMesh`는 길이·정렬 검사도 없어 잘린 다운로드가 `RangeError`로 터짐. 엔디언 가정(LE)이 포맷 주석에 없음.
→ `BINMESH_VERSION`/`MANIFEST_VERSION`/`LANDMARKS_VERSION` 상수를 `shared/`에 두고 writer·reader 모두 사용, `World.load`에서 `manifest.worldHalf/chunkSize/gridN/datumAlt/version`을 `shared` 상수와 대조해 **크게 실패**.

**복제된 상수 (import로 바꿀 것)** — 핵심만:
- 스타일 ID: `scripts/lib/buildings.ts:17`의 `const enum Style`을 `shared/layout.ts`로. 런타임은 `BuildingDetails.ts:212,220,246`(`style !== 0 && style !== 4`), `facade.glsl:71,73,102,118,130,152,163-165`(`style == 4.0` 등), `scripts/lib/roofdetails.ts:33,59`에서 숫자로 비교.
- `meta.w` 패킹: `scripts/lib/bridges.ts:92,117,129,242`의 `2 * 256 + 17` → `packStyleSeed(Style.Stone, 17)`; `BuildingDetails.ts:173-174` → `unpackStyle/unpackSeed`; `facade.glsl:59,62,320`의 `256.0` → `#define STYLE_SCALE` 주입.
- `SurfaceFlag`/`MarkKind`/`StreetFlag` 임계값: `facade.glsl:102,106,322`, `Markings.ts:42`, `Streets.ts:91`, `scripts/lib/far.ts:75-76`.
- 차량 8 / 사람 4 변형 수: `scripts/lib/furniture.ts:167,191`, `src/world/Furniture.ts:124`, `assets.ts:170`, `shared/layout.test.ts:46`, `CarKit.ts:16`. → `CAR_VARIANT_COUNT`, `PERSON_VARIANT_COUNT`를 `FurnitureKind` 옆에 두고, 테스트가 그 상수를 import(지금은 8을 하드코딩해 `CAR_VARIANTS`가 9개가 돼도 테스트가 안 깨짐 — `Statue=18`과 충돌).
- 오르토 UV 상수: `FacadeMaterial.ts:176-177, 233-234`의 `32.0 / 320.0 / 1536.0 / 3072.0` vs `GroundMaterial.ts:81-83`은 `ORTHO_MARGIN/ORTHO_TILE_M/WORLD_HALF` 보간. 베이크 마진을 바꾸면 지붕만 깨짐.
- `1536`/`3072`/`144`: `App.ts:633,699`, `FarRing.ts:33`, `Terrain.ts:83`, `Minimap.ts:9`, `Hud.ts:187`, `streets.ts:360`.
- `DETAIL_STRIDE`: `build.ts:173`의 `/ 9`. `DATUM_ALT`: `terrain.ts:73`의 `33.8`, `far.ts:72`의 `33`.
- `shared/crossings.ts:10-11`이 `EdgeFlag.CROSSING(128)`/`NodeFlag.SIGNAL(1)`을 재선언.
- `MANSARD`(`extrude.ts:21`) vs `HAUSSMANN.mansard*`(`config.ts:150-152`, 미사용). `FAR_HALF_M=5000`/`BBOX_FAR`(config, 미사용) vs `far.ts:18`의 3400.
- 야간 점등 테이블 `LIT_ANCHORS`가 GLSL에 세 번 전사됨(`facade.glsl:10-13`, `RoofDetails.ts:73`, `FarRing.ts:384`). 모듈 로드 시 `shared/nightlife.ts`에서 문자열 생성으로 통일.

**heightmap 두 표면** — `Heightmap.meshY`의 `cellM=4` 기본값이 `CHUNK_SIZE/TERRAIN_MESH_SEGMENTS`와 독립. 런타임 발 높이(`World.groundY`, `FirstPersonController`)는 2 m `sample`, 보이는 지면·인도·나무는 4 m `meshY` → 최대 0.6 m 떠 있거나 묻힘. 발의 정식 지면을 하나로 정하고 문서화.

**import 확장자** — `shared/signals.ts:1`, `crossings.ts:1`, 테스트 4개가 `.js`(CLAUDE.md는 `.ts`).

### C. 베이크 파이프라인 견고성

- **검증 전에 캐시 커밋**: `cachedBytes`가 바디를 쓴 뒤 호출자가 길이/JSON을 검사(`terrain.ts:289`, `wmsgrid.ts:361`, `trees.ts:40`, `bdtopo.ts:228`). IGN의 200 XML 예외, 캡티브 포털 HTML이 영구 캐시됨 → 손으로 지울 때까지 매 실행 실패. → `cachedBytes(url, rel, { validate })`, 통과 시에만 `.part` → rename.
- **비원자적 JSON 쓰기**: `writeJson`(`http.ts`)과 `overpass.ts:57,156`. `manifest.json`은 5개 단계가 읽고-수정하고-쓰는 공유 가변 파일. 중간에 죽으면 잘린 JSON. → `.part` + rename.
- **오프라인 `landmarks`가 좋은 파일을 덮어씀**(CLAUDE.md의 25/33 사고): `counts.failed`를 세고도 무조건 쓴다. → 이전 파일 로드, `ok`가 줄었거나 `osm.size===0`이면 거부, 또는 id별 병합(더 풍부한 항목 유지), `process.exitCode=1`.
- **단계 선행 조건 미선언**(`bake.ts:24-43`): 순서를 어기면 ENOENT. `--step=` 오타는 아무것도 안 하고 exit 0. → `Step.requires`, 알 수 없는 이름 거부.
- **`ortho --force` → `deshadow` 스킵**(stamp만 보고): 배포 타일은 미보정인데 메타는 보정됐다고 주장. → `ground.json.generated` 타임스탬프 비교.
- **Overpass 테마 하나 실패 시 `summary.json` 전체 미기록** → `manifest.osmTimestamp` undefined. → 테마별 try/catch, 즉시 기록.
- **`loadHeightmap()`의 raw/lowered 선택이 레이어마다 다름**(`trees.ts:38`, `deshadow.ts:135`는 lowered). `trees.bin`의 y가 "`build`가 먼저 돌았는가"에 의존 → 입력의 순수 함수가 아님.
- **중복 계산**: `collectBridges` 5회(`build`×2, `paths`, `markings`, `streets`), `loadTheme` 재파싱 6회, `makeFlowField` 2회. → `cache/bridges.json` 중간 산출물 + 프로세스 내 메모이즈. 레이어 간 일치도 보장됨.
- **성능**: `ortho.downloadRange`가 무변경 실행에서도 288타일을 `cachedBytes`로 "읽어서" 존재 확인(수백 MB I/O). `dsmroof` 캡 격자가 샘플당 8회 반복 ECEF 역변환(최대 4 M 샘플) → 윈도 단위 아핀 근사. `paths.deckAt`, `streets.inGrass`는 bbox 프리필터 없음. `estimateSun`은 결과를 버리는데도 실행.
- **환경 변수** 7개 모듈에 산재, `ORTHO_SUN_AUTO`는 문서 미기재. `DSM_BUDGET`(CLAUDE.md의 하드 제약)이 `build.ts` 리터럴. → `config.ts`에서 한 번 파싱.
- **라이선스 텍스트 드리프트**: `assets.ts:200`이 쓰는 `LICENSES.md`가 "3DMR #4 CC0"라고 하지만 `config.ts:132` 기본은 Sketchfab CC-BY 모델. HUD는 메타데이터에서 올바르게 크레딧함. → 레지스트리에서 생성.
- `void X;` 미사용 억제 9곳 → 삭제.

### D. 런타임 성능

**시작 시간** — `World.load`(`World.ts:83-101`)가 물→분수→다리→탑→모델→나무→시설물→원경→명판→명소→생활을 **순차 await**. 의존은 다리←terrain(동기), 나무/시설물/생활←surface(이미 로드), 라벨←명소뿐. → 두 그룹 `Promise.all`. `Life.load`의 동적 `import()` 7개도 순차. `PriorityLoader.pump`는 매번 전체 정렬(부트 시 144 작업 → O(n² log n)).

**배포 용량** — `far.bin` 28.8 MB를 시작 시 통째로 로드. `terrain_raw.bin` 4.7 MB는 베이크 중간물인데 `public/data`에 있어 `dist`(380 MB)에 포함. `Trees`는 (청크×수종×LOD×{캐노피,줄기}) 최대 약 4,000 메시. 풀해상도 지면 타일은 터치 프리셋에서도 `fullRadius=1` 그대로(최대 25장 × 약 9.4 MB).

**매 프레임 할당** (CLAUDE.md 규약 위반):
`Buildings.ts:118`(144 배열), `chunkOrigin()` 객체 반환이 레이어당 144회(`Buildings:72`, `Terrain:231`, `Streets:37`, `Markings:159`), `Boats.ts:81`·`Metro.ts:74`의 `new Vector3`, `Traffic.ts:237-243` `rebuildLanes` 매 프레임 배열 재생성, `Traffic.ts:328` 상수 색을 매 프레임 `setColorAt`, `Traffic.ts:350-367` `nearest/dynamicLights` 전체 정렬, `FirstPersonController.ts:318-319, 374`, `Collision.ts:206, 230`(`tmpBox.clone()`, `new Ray`), `Environment.ts:269-270`(`new Color`×4), `LocalLights.ts:458`, `App.ts:255-275`(소리 소스 수집·분수 정렬 매 프레임 → 4 Hz로), `Spatial.ts:63-73`(프레임당 약 100 오디오 자동화 이벤트 → 20 Hz).

**`Collision.ts:168`** BVH를 메인 스레드에서 빌드(스트리밍 중 프레임당 하나) → long task. 워커 또는 직렬화 캐시 검토.

**셰이더** — 샘플러 15/16 확인(커스텀 12 + map + shadow + envMap). 가드 없음. → `DataArrayTexture`로 디테일 맵 8장 통합(7개 여유) 또는 DEV에서 `uniform sampler` 수를 세어 16 이상이면 `console.error`. `onBeforeCompile` 패치 12곳이 `String.replace`로 앵커를 치환하되 `Environment.ts:61`만 존재 확인 → `replaceOrThrow` 헬퍼. `FacadeMaterial.ts:100` 프로그램 캐시 키가 `fragMain.length`(충돌 가능) → 이름/해시.

**Post/해상도** — `WaterReflection.setSize`가 CSS 픽셀을 받아 DPR 2에서 "반해상도"가 실제로는 1/4, 자동 품질 0.75 단계에도 안 줄어듦 → `getDrawingBufferSize()`. `applyPrefs('pixelRatio')`가 `Renderer.ts:76`의 `min(dpr,1.5)`를 죽은 코드로 만들고, `resize()`에서 DPR 재평가 없음. `setQuality('low')`는 AO만 끄고 SMAA HIGH·블룸 유지.

### E. 구조

**`App.ts` 13책임** → 제안 분해(App은 조합 루트로 유지, `window.app` 노출):
`core/UrlParams.ts`(한 번 파싱, 타입 있는 그룹, `Share.ts`의 쓰기 측과 라운드트립 테스트) · `core/Boot.ts`(이름 있는 단계, `flushWalkables()` → 첫 `goTo` → … → `applyPrefs` → `applyUrlParams` 순서를 코드와 assert로) · `ui/ModalManager.ts`(언락/리락 계약 한 곳; `GpuPanel`·시간 패널도 kind로 — 지금은 우회해 패널이 겹침) · `core/Keymap.ts`(키 테이블 하나 → `Input.onKey`, 게임패드 맵 `Input.ts:100`, 터치 버튼, 도움말 `Menu.ts:236`, `index.html:240` 범례 — 현재 4~5벌) · `core/TimeController.ts` · `player/Navigator.ts`(`goTo/goToPoint/landingY/toggleFly`, 매직 좌표 `-480,-409`, `-42,-30,121` 명명) · `audio/Soundscape.ts` · `render/QualityController.ts`(품질 로직이 5개 파일에 분산) · `ui/Diagnostics.ts`.

**URL 파라미터** — `App`에서 6회 파싱 + `SimClock`, `FacadeMaterial`, `WaterReflection`이 독자 파싱. README(권위 참조)에 없는 플래그 5개: `clear`, `fov`, `noshadow`, `refldbg`, `skydim`. → 파서 키가 README에 모두 있는지 regex 테스트.

**월드 레이어 공용화** — `ChunkRadius`(5개 레이어의 청크 거리 스캔·히스테리시스를 하나로; 지금은 Terrain만 체비셰프, 나머지 유클리드), `PathGraph.headingInto/Out`(4곳의 "노드로 들어오는 방향" — `Signals`와 `Traffic.buildSignalTable`이 어긋나면 신호와 차가 동기 깨짐), `AgentPool`(`Crowd/Cyclists/Traffic`의 swap-remove·despawn·카메라 콘 스폰 거부 — `Cyclists`는 콘 거부가 빠져 눈앞에 튐), `adoptGltfScene`(`Eiffel`/`LandmarkModel`), `fetchJson` 사용(5곳 재구현, 2곳은 `ok` 미검사), `terrain.onTileChanged` 리스너 목록화(`Streets`는 매 프레임 폴링).

**반경 테이블** — 서로 의존하는 숫자들이 각 클래스에 하드코딩: 건물 LOD 800 / 그림자 600 / 디테일 520(+350 언로드), 인도 620/900/330(+120), 노면 460/720, 나무 240(실효 ×√1.6≈304), 생활 220/350(+60), 원경 교통 260/420(= 350+60에 수동 맞춤), 지면 풀타일 체비셰프 1/2. 모바일 프리셋이 일부만 줄임. → `src/world/radii.ts` 한 표 + 모바일 스케일 한 곳.

**UI** — DOM id 조회 25곳(비널 캐스트 혼재) → `required(id)` 레지스트리. `PlacePanel.ts:50` `wiki.href`가 미검증(`javascript:` 사이트링크가 베이크로 들어오면 클릭 시 실행) → 베이크·런타임 모두 `^https?:` 강제. `Hud.ts:202`만 데이터→innerHTML 싱크(자체 베이크 데이터). localStorage 키 4종 산재, "기본값으로"가 음소거·GPU 패널·터치 힌트는 안 되돌림. `prefs` 버전 범프 시 전체 초기화(마이그레이션 없음). 한국어 카피가 TS 10여 파일 + `index.html`에 분산(키 범례 2벌). a11y: `user-scalable=no`, `#clock` div 버튼 tabindex 없음, 토스트 `aria-live` 없음, 모달 포커스 트랩/복귀 없음. 패널들의 `pointerdown.stopPropagation()`이 window 레벨 `audio.ensure()`를 막아 첫 제스처가 패널이면 AudioContext가 깨어나지 않음 → wake 리스너를 `{capture:true}`.

**입력** — 300 px 워프 휴리스틱이 프레임레이트 의존(30 fps에서 정당한 플릭이 버려지고 회전 속도 상한). px/s 기준 또는 직전 이벤트 대비 스파이크 판정으로.

### F. 테스트·도구·문서

- **없는 테스트**: PBM1 `encodeBinMesh → parseBinMesh` 라운드트립(가장 중요한 계약; u16/u32 인덱스 전환, u8 섹션 뒤 4바이트 정렬, 헤더 길이 수렴), `hash.ts` 값 고정(리팩터 시 모든 신호 위상·차색이 바뀌어도 테스트 통과), `polygons.ts`, `http.fetchRetry`, `binmesh.ts`(writer), `dsmroof` 순수 함수들, `eiffel_walk.analyseTower`, `surfacegrid`.
- **GLSL 동기화 테스트가 자기 재구현**: `layout.test.ts:29-38`은 `floor(w/256)`을 TS로 다시 써서 검사 → `facade.glsl`을 바꿔도 안 깨짐. → 테스트가 `.glsl`을 `readFileSync`로 읽어 `256.0`, `hs[]/ps[]` 배열을 regex로 추출해 `STYLE_SCALE`/`LIT_ANCHORS`와 비교.
- **약한 테스트**: `quality.test.ts`는 `minSamples` 기본 60만(App은 30 사용), `nightlife.test.ts`는 `towerSparkle alwaysOn` 미검사(A14를 못 잡음), `heightmap.test.ts`는 경계 클램프·`normal()` 미검사, `buildings.test.ts`는 BD TOPO 투표·`floating`·`ROOF_OVERRIDES` 미검사(CLAUDE.md의 "보트가 6층 건물" 함정이 테스트로 고정되지 않음).
- **도구**: ESLint flat config(`typescript-eslint` type-checked, `import-x/no-cycle`(Environment↔FacadeMaterial↔GroundMaterial 순환), `shared/**`에서 `three`/DOM import 금지, `UrlParams.ts` 밖 `new URLSearchParams(location.search)` 금지, `storage.ts` 밖 `localStorage` 금지, `no-floating-promises`; dense 스타일과 싸우는 규칙은 끔). Prettier는 **도입하지 않음**(단일행 스타일을 통째로 다시 씀) — `.editorconfig`만. GitHub Actions: Node 22, `npm ci`, typecheck, test, eslint, build. 스모크 테스트 `scripts/smoke.ts`: CLAUDE.md의 CDP 레시피로 `vite preview` + 헤드리스 Chrome, `Shader Error`/미처리 예외 시 실패, `loadedCount===144` 폴링, `openModal/closeModal` 후 `input.locked` 단언, 스크린샷 아티팩트. 의존성 추가 0.
- **빌드**: `base` 미설정(모든 자산 URL 절대경로 → 서브패스 배포 불가) → `import.meta.env.BASE_URL`. `manualChunks`(three / postprocessing+n8ao / three-mesh-bvh), `XRMode`·`GpuPanel`·도움말 지연 import. `lil-gui` 미사용 의존성, `clipper-lib`는 베이크 전용인데 `dependencies`. `engines` 없음(Vite 8은 Node ≥ 20.19).
- **문서**: CLAUDE.md의 `PriorityLoader` 단락 삭제, `build/paths/markings/streets`는 "출력 있으면 스킵" 예외라고 명시, `ORTHO_SUN_AUTO` 추가, README에 플래그 5개 추가, `targetTris 220_000` vs README "12만" 정리.

---

## 3. 개선 계획

원칙: **(1) 안전망 먼저, (2) 출력이 바뀌지 않는 변경과 리베이크가 필요한 변경을 분리, (3) 각 단계는 독립 PR로, 검증 방법을 명시.** `public/data`가 커밋돼 있으므로 "바이트 동일 리베이크"가 리팩터링의 회귀 테스트가 된다.

### Phase 0 — 안전망 (0.5~1일, 코드 출력 변화 없음)
1. `.github/workflows/ci.yml`: typecheck + test + build.
2. ESLint flat config(위 규칙), 기존 위반은 경고로 시작해 단계적으로 에러 승격.
3. `scripts/smoke.ts` CDP 스모크 테스트를 CI에 추가(SwiftShader, 약 2분).
4. CLAUDE.md/README 낡은 문구 수정(PriorityLoader, 스킵 예외, 플래그 5개, `ORTHO_SUN_AUTO`).
검증: CI 녹색, 스모크 스크린샷 아티팩트 생성.

### Phase 1 — 버그 수정 (1~2일, 런타임 코드만)
A1(횡단보도 데드락), A4(입력 게이트), A5(Intl 매 프레임), A6(명소 투광등), A7(메트로 전조등), A8(지붕 디테일 누수), A9(`withLamps`), A10(`roundRect`), A14(`towerSparkle`), 오디오 wake 캡처, `WaterReflection` 드로잉 버퍼 크기, `wiki.href` 스킴 검증.
각 수정에 가능한 곳은 `node:test` 추가(A14, 반경·점유 규칙을 `shared/`로 옮기면 A1도).
검증: 테스트, 스모크, `?lampsdebug=1` 스크린샷에 마젠타 없음.

### Phase 2 — 베이크 버그 (1일, 리베이크 동반 → 코드 커밋과 데이터 커밋 분리)
A2(`fetchRetry`) + 404 단일 호출 테스트, A3(`MeshoptSimplifier.ready`), A11(분수 순서), A12(`bufferLine` 복사본), A13(`eiffel_scan` 접근자), Overpass 테마별 summary 기록.
검증: `bake:build --force` 후 `git diff --stat public/data`로 변화가 분수/다리/DSM에 국한되는지 확인; DSM 삼각형 수 로그.

### Phase 3 — `shared/` 계약 강화 (2~3일, 출력 바이트 동일해야 함)
1. `BINMESH_VERSION`/`MANIFEST_VERSION`/`LANDMARKS_VERSION` + 리더 검사, `parseBinMesh` 경계·정렬 검사와 LE 명시, `World.load` 매니페스트 대조.
2. `Style` enum, `CAR/PERSON_VARIANT_COUNT`, `MANSARD`, `DSM_BUDGET`을 `shared`/`config`로; 복제 리터럴 전부 import로 교체(위 표).
3. GLSL `#define` 주입(`STYLE_SCALE`, `SurfaceFlag.*`, `MarkKind.*`, 오르토 UV 상수), `LIT_ANCHORS` 문자열 생성 한 곳.
4. 테스트: PBM1 라운드트립, `hash` 값 고정, GLSL 파일을 읽는 동기화 테스트, `layout.test`가 변형 수 상수를 import, `buildings.test`에 `floating` 케이스, `quality.test`에 `minSamples:30`.
5. `.js` → `.ts` import 통일, `crossings.ts` 플래그 재선언 제거.
검증: 전체 리베이크 후 `public/data` **바이트 동일**(`git status` 깨끗). 셰이더는 스모크 테스트.

### Phase 4 — 런타임 성능·시작 시간 (2~3일)
1. `World.load` 두 그룹 `Promise.all`, `Life.load` import 병렬, `PriorityLoader` 지연 정렬/힙.
2. 핫루프 할당 제거 목록(D절) 일괄 처리; `chunkOrigin` 스칼라 버전 또는 청크 중심 `Float32Array` 사전 계산.
3. `Traffic` 색상 캐시, 레인 배열 재사용, `nearest/dynamicLights` 삽입 버퍼; `Spatial` 20 Hz; 소리 소스 수집 4 Hz.
4. 터치 프리셋에서 `Terrain.fullRadius=0`; `Trees` 피트 메시 청크당 1개로.
5. `terrain_raw.bin`을 `public/data` 밖(`cache/`)으로; `far.bin` 분할(코어 + 창문 포인트 지연) 검토.
6. Vite `base`, `manualChunks`, XR/GPU 패널 지연 import, `lil-gui` 제거, `engines`.
검증: `?status=1` 프레임 시간·long task 수 비교(전/후 스크린샷), 네트워크 패널의 TTI, 번들 크기.

### Phase 5 — 구조 리팩터링 (1~2주, 기능 변화 없음, PR 여러 개)
1. `UrlParams` 단일 파서 + `Share` 라운드트립 테스트 + README 커버리지 테스트.
2. `ModalManager`(GPU·시간 패널 포함), `Keymap` 단일 테이블.
3. `radii.ts` 반경 표 + 모바일 스케일 한 곳; `ChunkRadius` 헬퍼로 5개 레이어 교체.
4. `PathGraph.headingInto/Out` → `Signals`/`Traffic`/`crossings` 소비; `AgentPool`; `adoptGltfScene`.
5. `App.ts` 분해(Boot/TimeController/Navigator/Soundscape/QualityController/Diagnostics). 부트 순서는 코드 순서 + DEV assert.
6. `GlobalUniforms`로 `uNight/uHour/uTime/uWet` 소유권 정리(순환 import 해소), `replaceOrThrow` 셰이더 패치 헬퍼, 샘플러 카운트 DEV 가드.
7. UI: DOM 레지스트리, `storage.ts`(prefs v2에 mute 포함 + migrate 체인), `strings.ts` 카탈로그, a11y 기본(tabindex, aria-live, 포커스 복귀).
검증: 스모크 테스트 + `?lampsdebug`/`?status` 스크린샷 비교, `npm test`.

### Phase 6 — 파이프라인 견고성 (1주, 리베이크 동반)
1. `Step.requires` 선행 조건, 알 수 없는 `--step` 거부.
2. `cachedBytes` `validate` 옵션(길이·content-type·JSON 형태), 통과 후 커밋; `writeJson` 원자화.
3. `landmarks` 열화 가드(이전 파일과 비교/병합, exitCode).
4. `ortho`/`deshadow` 입력 타임스탬프 기반 무효화.
5. `cache/bridges.json` 중간 산출물 + `loadTheme` 메모이즈; `geomToWorld`, `distToSegment`, `densify`, `CellGrid<T>`, 도로 폭 테이블(`roadnet.ts`만) 공용화.
6. 환경 변수 `config.ts` 집중, `LICENSES.md`를 레지스트리에서 생성.
7. `dsmroof` 윈도 아핀 근사, `ortho` 존재 확인을 `exists()`로, `estimateSun` 조건부.
검증: `npm run bake`(무변경) 시간 전/후, 단계 순서 어긋남 테스트, 404 캐시 미생성 테스트, 전체 리베이크 후 diff 검토.

---

## 4. 이 코드베이스에 적용되는 핵심 원칙 (개념 정리)

1. **단일 진실원(Single Source of Truth)**: 두 프로그램(베이크·런타임)과 두 언어(TS·GLSL)가 같은 숫자를 알아야 할 때, 그 숫자는 한 곳에 정의되고 나머지는 *import 또는 생성*되어야 한다. 복사한 리터럴은 "지금은 같다"일 뿐 "항상 같다"가 아니다. GLSL처럼 import가 불가능하면 `#define` 주입이나 문자열 생성으로, 그것도 안 되면 *원본 파일을 읽는* 테스트로 묶는다.
2. **크게 실패하기(Fail loudly) vs 명시적 열화(Explicit degradation)**: 선택 레이어가 없으면 경고 후 계속(현재 잘 함). 그러나 *잘못된* 데이터(버전 불일치, 잘린 파일, 오프라인 빈 결과)는 삼키지 말고 이름 있는 오류로 즉시 멈춰야 한다. 버전 필드는 읽는 쪽이 검사할 때만 의미가 있다.
3. **쓰기 전 검증, 원자적 쓰기(Validate-then-commit, atomic write)**: 캐시와 산출물은 "검증 통과한 바이트만 `.part` → rename". 그렇지 않으면 일시적 서버 오류가 영구적 로컬 오류가 된다.
4. **입력 기반 캐시 무효화**: "출력이 존재하면 스킵"은 입력이 바뀐 걸 모른다. 최소한 상류 산출물의 타임스탬프/해시를 기록하고 비교해야 `--force` 연쇄가 조용히 깨지지 않는다.
5. **핫루프 무할당(Zero-allocation hot loop)**: 60 fps 루프에서 매 프레임 생기는 소객체는 GC 압력이 되어 간헐적 프레임 드롭으로 나타난다. 임시 벡터·배열은 필드/모듈 상수로 미리 만들고, 상수 값은 변할 때만 다시 쓴다. 비싼 순수 함수(`Intl`, 정렬)는 입력이 바뀌는 빈도(4 Hz, 분 단위)로 낮춘다.
6. **상태 기계의 탈출 조건**: 어떤 상태가 다른 에이전트를 막는다면(횡단 점유 → 차 정지), 그 상태에서 반드시 벗어나는 경로가 있어야 데드락이 없다.
7. **제어 흐름과 예외 처리의 범위**: `try` 안에서 던진 예외는 그 `try`의 `catch`가 받는다. "재시도 불가" 판정을 재시도 루프의 `catch` 안쪽에서 던지면 판정이 무효가 된다.
8. **조합 루트는 얇게**: `App`은 객체를 만들고 연결만 하고, 각 관심사(시간, 품질, 내비게이션, 모달, 입력 맵)는 자기 모듈이 가진다. 순서 제약은 산문이 아니라 코드 순서와 assert로 표현한다.
