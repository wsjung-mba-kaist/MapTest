# Paris · Tour Eiffel — 오픈데이터로 만든 1인칭 가상 도시

에펠탑을 중심으로 반경 약 1.5 km(트로카데로, 이에나 다리, 샹드마르스, 에콜 밀리테르, 비르아켐)를
실제 배치·스케일 그대로 재현하고 1인칭으로 걸어 다니는 웹 페이지입니다.
Google 3D Tiles나 유료 API 키 없이, 공개 데이터만으로 빌드합니다.

| 레이어 | 출처 | 라이선스 |
|---|---|---|
| 건물 윤곽·안뜰·도로·다리·센강·공원 | OpenStreetMap (Overpass) | ODbL |
| 건물 실측 높이(처마)·층수·용도 | IGN BD TOPO (WFS) | Licence Ouverte / Etalab 2.0 |
| 20 cm 항공사진 (지면·평지붕에 투영) | IGN BD ORTHO (WMTS) | Licence Ouverte / Etalab 2.0 |
| 1 m LiDAR 지형 | IGN RGE ALTI (WMS) | Licence Ouverte / Etalab 2.0 |
| 가로수 21,000여 그루 (위치·높이·수종) | Ville de Paris open data `les-arbres` | ODbL |
| 에펠탑 (기본) | Sketchfab "Eiffel Tower model 3D with best quality" (shatlykxfree). `public/models/eiffel_tower_model_3d_with_best_quality.glb`를 베이크가 실측 크기(다리 간격 기준)·OSM 발자국 방향으로 맞추고 메시를 합쳐 `eiffel.glb`(4 MB, 51만 삼각형)로 만듭니다. 도료는 런타임에서 높이별 3단 "에펠 브라운", 야간 호박색 발광 | CC-BY 4.0 (화면 도움말에 자동 표기) |
| 에펠탑 (대체 1) | 절차 생성 투과 격자 철골(약 2만 인스턴스). URL에 `?tower=lattice` | 자체 제작 |
| 에펠탑 (대체 2) | 다른 glb를 쓰려면 `scripts/config.ts`의 `EIFFEL_SOURCE_GLB` 또는 환경변수 `EIFFEL_SOURCE`로 파일명을 지정하고 `npm run bake:eiffel -- --force`. 사진 텍스처가 있는 스캔은 자동으로 주변 지물을 잘라내고, 텍스처 없는 CAD 모델은 그대로 씁니다 (Brian Trepanier 포토그래메트리 스캔, 3DMR #4 CC0 모델 모두 지원) | 각 모델의 라이선스 |
| 지붕 재질(아연·슬레이트·기와) | IGN BD TOPO `materiaux_de_la_toiture`(MAJIC 2자리 코드: 주재료+부재료, 예 `23` = 슬레이트+아연) + OSM `roof:material` | Etalab 2.0 / ODbL |
| 파사드 미세 디테일(2K 회반죽 그레인, 2K 러스티케이션 석재 트림시트), 슬레이트 지붕, 지면 디테일, HDRI | Poly Haven, ambientCG | CC0 |
| 주차·주행 차량 8종 (팔레트 텍스처 그대로: 유리·범퍼·등·타이어, 차체 도장 스와치만 파리 거리 배색으로 교체) | Kenney Car Kit | CC0 |
| 보행자·가로등·발코니·코니스·차양·가로수 | 절차 생성 (OSM 도로/파리시 가로수 위치 기반) | 자체 제작 |
| 움직이는 도시: 보행자(정점 셰이더 보행), 차량(우측통행·차선·추종·교차로), 유람선 | OSM 도로·보도·횡단보도·강 중심선으로 만든 경로 그래프 `paths.bin` (`npm run bake:paths`) | ODbL / 자체 제작 |
| 가로등 실광원, 밤하늘(별·달·광공해), 센강 평면 반사, 항공사진 그림자 완화 | 런타임 셰이더 / `npm run bake:deshadow` | 자체 제작 |
| 노면 표시(횡단보도·차선·정지선), 인도 슬래브·연석(14 cm, 걸어 올라감), 2 m 표면 격자 `surface.bin` | OSM 도로·`footway=sidewalk`·`footway=crossing`·광장·주차장 → `npm run bake:markings`, `bake:streets` (Clipper 폴리곤 연산) | ODbL / 자체 제작 |
| 지붕 굴뚝·도머(그림과 일치), 상점 간판(일반 업종어 40종, 야간 발광), 거리명판(교차로 모서리, 구 번호 추정) | 베이크 `details/`·`plaques.json` + 런타임 캔버스 아틀라스 | ODbL / 자체 제작 |
| 탑 탑승(1·2층 데크 보행, 기둥 승강기 `E`, 꼭대기), 미니맵 `M`, 합성 사운드스케이프 `V`, 게임패드·터치 | `npm run bake:towerwalk`(모델에서 층 검출) + 런타임 | 자체 제작 |

## 실행

```bash
npm install
npm run bake      # 데이터 다운로드 + 베이크 (최초 15~25분, 이후 캐시로 수 초)
npm run dev       # http://localhost:5173
```

베이크 단계는 개별 실행할 수 있습니다: `npm run bake:osm`, `bake:bdtopo`, `bake:terrain`, `bake:ortho`,
`bake:trees`, `bake:assets`, `bake:eiffel`, `bake:towerwalk`, `bake:build`, `bake:paths`, `bake:deshadow`, `bake:markings`, `bake:streets`, `bake:masks`, `bake:far`.
`bake:markings`는 횡단보도·차선·정지선 데칼과 거리명판 앵커(`plaques.json`)를, `bake:streets`는 인도 슬래브(`streets/`)와 2 m 표면 격자(`surface.bin`)를 만듭니다.
`bake:towerwalk`는 `eiffel.glb`에서 상향면 면적 히스토그램으로 세 층의 높이·크기와 네 기둥 위치를 찾아 `eiffel_walk.json`에 씁니다(탑 모델을 바꾸면 다시 실행).
`bake:deshadow`는 항공사진에 구워진 촬영 당시 그림자를 에펠탑 그림자로 태양을 추정해 걷어냅니다(원본은 `cache/ortho_raw/`, `DESHADOW=0`으로 건너뜀).
`-- --force`로 캐시를 무시하고 다시 만듭니다. 원본 다운로드는 `cache/`, 산출물은 `public/data/`에 저장됩니다.

`points` 테마(가로등·벤치·볼라드 노드)는 공개 게이트웨이의 60초 제한 때문에 3×3 셀로 나눠 받으며, 429/타임아웃으로 빠진 셀은
`npm run bake:osm`을 다시 실행할 때마다 이어서 채웁니다(`cache/overpass/points.json`의 `coverage`). 받은 셀 안에서는 OSM 가로등이
쓰이고 18 m 안의 절차적 가로등은 빠지며, 나머지 구역은 도로를 따라 절차적으로 배치됩니다(`bake:build` 재실행 시 반영).

## 모바일에서 보기

```bash
npm run dev:lan   # LAN에 공개 (vite --host); 터미널에 뜨는 Network 주소를 폰에서 엽니다
```

같은 Wi-Fi의 폰·태블릿에서 `http://<PC-IP>:5173`을 열면 터치 UI가 자동으로 켜집니다(`pointer: coarse`). 화면을 탭해 시작하고,
왼쪽 40 % 영역 아무 곳이나 누르면 그 자리에 조이스틱이 생기며, 오른쪽을 드래그하면 시점이 돕니다. 오른쪽 아래 버튼 열:
달리기(토글) · 비행 · ▲▼(비행 고도) · E(승강기) · 지도 · 시간 · 야경 · ?(도움말). 모바일 프리셋(해상도 1x, AO·반사 끔,
그림자 2048, 파사드 디테일 320 m)이 자동 적용됩니다. 첫 로딩은 청크 91 MB + 텍스처를 받으므로 Wi-Fi에서 1~2분 걸립니다.
데스크톱에서 터치 UI를 강제로 보려면 `?touch=1`, 상태 줄까지 보려면 `&status=1`, 조이스틱을 앞으로 민 상태를 흉내 내려면 `&drive=1`.

## 조작

| 키 | 동작 |
|---|---|
| 클릭 | 마우스 잠금 시작 |
| `W A S D` / 마우스 | 이동 / 시점 |
| `Shift` | 달리기 |
| `1`–`8` | 명소 이동 (트로카데로, 이에나 다리, 탑 아래, 샹드마르스, 에콜 밀리테르, 비르아켐, 케 브랑리, 탑 2층) |
| `F` | 비행 모드 토글 (`Q`/`E` 상승·하강) |
| `T` | 시간 패널: 걷는 중 누르면 마우스 잠금이 풀려 슬라이더·프리셋 버튼을 조작할 수 있고, 다시 `T`(패널 숨김) 또는 화면 클릭으로 복귀 |
| `N` | 시간대 순환 (새벽 → 낮 → 오후 → 노을 → 야경 → 심야) |
| `,` / `.` | 15분 뒤로/앞으로 (`Shift`와 함께 1시간) — 태양 위치·창문 조명·가로등·탑 조명 연동 |
| `P` | 현재 위치·시점·시각을 담은 링크 복사 (`walk=1` 또는 `fly=1`) |
| `O` | 스크린샷 PNG 저장 |
| `M` | 미니맵 (항공사진 320 m, 북쪽 위, 명소·탑·진행 방향) |
| `V` | 소리 끄기/켜기 — 도로 소음·공원 새소리·강물·바람·발소리는 전부 합성음 (`?audio=0` 끔, `?audio=debug` 상태 표시) |
| `E` | 승강기: 탑 기둥 발치 또는 각 층 승강장 3 m 안에서 안내 문구가 뜨면 탑승 (1층 ↔ 2층 ↔ 꼭대기; `8`은 실제 2층 데크에 내려 줌) |
| 게임패드 | 왼스틱 이동 · 오른스틱 시점 · RT 달리기 · A 승강기 · Y 비행 · X 야경 · Back 미니맵 · Start 시간 패널 |
| 터치 | 왼쪽 40 % 가상 조이스틱 · 오른쪽 드래그 시점 · 버튼 열(달리기·비행·E·지도·시간·야경); `pointer: coarse` 기기에서 자동, `?touch=1`로 강제. 모바일 프리셋(해상도 1x, AO·반사 끔) |
| `R` | 날씨 순환 (맑음 → 흐림 → 비 → 안개) |
| `H` | 도움말 토글 |

URL 파라미터로 디버그 시점을 지정할 수 있습니다:
`?auto=1&fly=1&x=-480&z=-409&y=28&yaw=130&pitch=2&hour=19.5&quality=medium&post=0&tower=lattice&hide=trees,furniture&details=0&timepanel=0&facadetex=0&noenv=1`
(`facadetex=0`은 사진 텍스처 없이 절차 파사드만, `noenv=1`은 환경맵 없이 렌더링해 비교할 때 씁니다.)
움직이는 도시: `life=0`(끄기) / `life=crowd,traffic,boats`(선택) / `lifedebug=1`(활성 경로 그래프 표시) / `sim=0`(정지, `sim=4` 4배속) / `simt=240`(시뮬레이션 시각 고정 → 재현 가능한 스크린샷).
빛·물: `lamps=0`(가로등 광원 끄기) / `lampsdebug=1`(광원 마젠타) / `refl=0|1|2`(반사 끄기·절반·1/4 해상도) / `stars=0` / `glow=0`(광공해 끄기) / `headlights=0` / `shoplights=0` / `signals=0`(신호등 끄기) / `fartraffic=0`(원경 차량 불빛 끄기) / `wet=1`(비 온 뒤 노면) / `tower=lit`(탑 조명 밤새 유지) / `ao=0`(AO 끄기).
날씨·계절: `weather=overcast|rain|fog`(기본 맑음, `R`로 순환) / `date=2026-10-25`처럼 날짜를 주면 가로수가 그 계절(4월 중순 발아 → 10월 단풍 → 11월 낙엽 → 겨울 나목)을 따릅니다.
거리·간판: `marks=0`(노면 표시 끄기) / `marksdebug=1`(마젠타) / `streets=0`(인도 슬래브 끄기) / `streetsdebug=1`(법선 색) / `signs=0`(간판·거리명판 끄기) / `signsdebug=1`(간판 마젠타 + 콘솔에 명판 위치·카메라 URL).
날짜·시각: 기본은 파리 기준 오늘 날짜이며 태양 경로·낮 길이·시간 프리셋(새벽·노을·야경은 그날의 일출·일몰 기준)이 따라갑니다. `date=2026-12-21&hour=16.5`처럼 다른 날을 볼 수 있고, `P`로 복사한 링크에도 오늘이 아니면 `date`가 들어갑니다.
UX: `minimap=1`(미니맵 켠 채 시작) / `audio=0|debug` / `touch=1`(터치 UI 강제) / `xr=1`(실험적 WebXR: VR 버튼 표시, 왼스틱 이동·오른스틱 45° 스냅 회전, 헤드셋에서 미검증) / `walk=1&x=&z=&y=`(y를 주면 그 높이 근처의 데크(다리·탑 층)에 올려 놓음, 예 `walk=1&x=-12.6&z=-0.7&y=120.5&yaw=-49` = 탑 2층).

## 야경

22시 전후의 실제 파리 밤을 기준으로 맞춰져 있습니다 (`?hour=22.75`; 프리셋 `야경`은 일몰 후 첫 정각 직후라 탑 반짝임이 바로 보입니다).

- 하늘: 도심 광공해(지평선의 회주황 글로우, 동북동 도심 쪽이 더 밝음), 밝은 별 몇십 개만, 은하수 없음. 밤에는 분석 하늘을 환경맵으로 구워 유리·차 도장·젖은 돌에 도시 글로우가 비칩니다.
- 창문: 시각별 점등률(21시 40 % → 01시 15 % → 03시 7 %, `shared/nightlife.ts`), 전구색 60 %·주백색 25 %·TV 청색 15 %, 커튼·덧문, 밝기 분포(8 %만 블룸). 상점 진열창은 20시까지, 식당은 01시까지 밝습니다. 도머와 원경 스카이라인도 같은 규칙을 따릅니다.
- 거리: 3000 K 가로등(램프 글레어, 위쪽 빛은 갓이 막음), 진열창이 인도를 비추는 광원, 가까운 차량 5대의 전조등·후미등 스포트, 유람선 뱃머리 투광등, 기념물·다리 석재 업라이트, 신호등(적 14 s·녹 15 s·황 3 s). 광원 배열은 정적 32 + 동적 16 슬롯입니다.
- 에펠탑: 내부 투광기처럼 아랫면·안쪽 면이 밝은 금색, 일몰 후 매시 정각 5분간 흰 반짝임(6000개 전구), 23:45 소등 후 비콘만. `?tower=lit`로 밤새 켤 수 있습니다.
- 노면: 밤에는 아스팔트가 살짝 축축해 램프 반사가 늘어지고, `?wet=1`이면 비 온 뒤 웅덩이가 생깁니다.
- 후처리: 밤에 노출 0.8 → 1.25(암순응), 블룸 문턱 0.8, 비네트 강화.
- 원경: 실제 차량이 있는 350 m 밖 도로에는 흐르는 전조등·후미등 점(3200개)이 달리고, 가로등 빛웅덩이는 멀수록 진해져 탑에서 보면 거리가 주황 사슬로 읽힙니다.
- 신호등: 교차로 팔을 방위로 두 그룹으로 나눠 반주기 엇갈리게 하고(`shared/signals.ts`), 차량은 정지선 5 m 앞에서 빨간불에 멈춥니다. 황색은 8 m 밖의 차만 세웁니다.
- 시간대별 밀도: 차량·보행자 수가 시각을 따릅니다(새벽 4시 차 8 %·사람 3 %, 출퇴근·점심 100 %, 23시 40 %·30 %). 시간 슬라이더를 움직이면 즉시 솎아지거나 채워집니다.
- 간판·테라스: 켜진 간판의 1/6은 네온(분홍·파랑·주홍)으로 빛나고, 카페 앞에는 17시~01시에 따뜻한 전구 줄이 켜집니다.

## 계절·날씨

- 계절은 날짜에서 옵니다(`shared/season.ts`): 4월 중순 발아(연두), 5월 중순 만엽, 10월 단풍(카드마다 물드는 시기가 다름), 11월 낙엽, 12~3월 나목. 잎 카드는 GPU에서 접히므로 데이터는 그대로입니다.
- 날씨는 `?weather=` 또는 `R` 키: **흐림**은 회색 돔 하늘·그림자 없음·부드러운 반구광·안개 2배, **비**는 흐림 + 젖은 노면·웅덩이 + 카메라를 따라오는 빗줄기 + 바람, **안개**는 시정 600 m 안팎의 회백색 안개. 밤에는 구름이 도시 빛을 되비춰 하늘이 더 주황빛이 되고 별·달은 사라집니다.

## 구조

```
shared/      geo.ts(ECEF↔ENU, WebMercator), layout.ts(청크 격자), heightmap.ts, binmesh.ts  — 베이크/런타임 공용
scripts/     bake.ts 오케스트레이터 + lib/*.ts 단계별 모듈 (Node, tsx)
src/core     App(부트스트랩·입력·뷰포인트), Loop, Renderer
src/world    Terrain(항공사진+마스크 지면), Buildings(청크 스트리밍+LOD), Water(평면 반사), Bridges, Trees, Furniture, Eiffel, FarRing
             Markings(노면 표시 데칼), Streets(인도 슬래브+연석, 걸을 수 있는 면), BuildingDetails/Signage(발코니·차양·간판·거리명판), RoofDetails(굴뚝·도머), TowerAccess(탑 데크·승강기)
src/audio    Audio(사운드스케이프 엔진·발소리), Synth(노이즈·새소리 합성)
src/ui       Hud, Share, Minimap, TouchControls
src/world/life PathGraph(paths.bin), Life(활성 에지 관리), Crowd(보행자), Traffic(차량), Boats(유람선), PersonMesh/CarKit(공용 지오메트리)
src/materials FacadeMaterial(절차적 오스만 파사드 + PBR 그레인/1층 석재/시차 창문, 아연·슬레이트·기와 지붕, 항공사진 지붕), GroundMaterial(표면별 디테일)
src/player   FirstPersonController(캡슐 충돌, 지면 클램프), Collision(three-mesh-bvh), FlyControls, Input
src/render   Environment(태양·하늘·HDRI·안개·야간), NightSky(별·달·광공해), LocalLights(가로등 광원 배열), WaterReflection(센강 반사 패스), Post(N8AO·Bloom·AgX·SMAA)
```

좌표계: 에펠탑 중심을 원점으로 하는 ENU 미터 좌표(x 동, z 남, y 위), y = NGF 고도 − 33.8 m.

## 검증

```bash
npm test          # 좌표 변환, 압출 지오메트리 방향, 야간·신호·계절·활동량 테이블 테스트
npm run typecheck # 런타임 + 스크립트 타입 검사
npm run build     # 프로덕션 번들
```

## 배포 용량

정적 데이터가 약 190 MB(청크 92·지면 83·원경 20·인도 19 MB, 탑 모델 28 MB)입니다. 대부분 float32라 Brotli로 72 % 줄어듭니다.

```bash
npm run build:compressed   # vite build 뒤 dist/**/*.bin|json|glb|hdr 옆에 .br 생성 (192 MB → 54 MB, 약 10 s)
npm run preview            # .br을 Content-Encoding: br로 서빙해 실제 전송량을 확인
```

호스트가 미리 압축된 파일을 지원하면 그대로 올리면 됩니다(nginx `brotli_static on;`, Caddy `file_server { precompressed br }`, Cloudflare Pages는 자동). 개발 서버는 원본을 그대로 서빙합니다.
