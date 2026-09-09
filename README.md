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
| 명소 33곳의 이름(한·불·영)·건축가·연도·높이·요약·사진 (`landmarks.json`, `landmarks/*.jpg`) | OSM 태그 → Wikidata → Wikipedia 요약(ko > fr > en) → Wikimedia Commons (CC0/PD/CC BY(-SA)만, 저작자·라이선스는 카드에 표시), `npm run bake:landmarks` | CC BY-SA 4.0 (텍스트) / 사진별 |
| 랜드마크 실제 지붕 형상 (앵발리드 돔·그랑팔레 유리 볼트·샤요 궁·에콜 밀리테르 등, 50 cm LiDAR 표면모델을 발자국 안에서 격자화) | IGN LiDAR HD MNS (WMS-R `IGNF_LIDAR-HD_MNS_…`), `npm run bake:dsm` → 청크 `dsm` 섹션 | Licence Ouverte / Etalab 2.0 |
| 돔·양파돔·원뿔·배럴 볼트·방향 있는 박공 지붕, 구리·납·유리·도금 지붕 재질 | OSM `roof:shape`, `roof:height`, `roof:direction`, `roof:material`, `roof:colour` (+ `scripts/config.ts`의 `ROOF_OVERRIDES`: 앵발리드 돔 도금) | ODbL |
| 자유의 여신상 (백조의 섬) | Sketchfab "Statue of Liberty" (Maurice Svay). 원작은 프레데리크 오귀스트 바르톨디의 1889년 1/4 축소 복제상. `public/models/statue_of_liberty.glb`를 `npm run bake:models`가 실측 높이 11.5 m로 맞춰 `statue-liberte.glb`(12만 삼각형)로 만듭니다 | CC BY 4.0 (화면 도움말에 자동 표기) |
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
`bake:trees`, `bake:assets`, `bake:eiffel`, `bake:towerwalk`, `bake:build`, `bake:paths`, `bake:deshadow`, `bake:markings`, `bake:streets`, `bake:masks`, `bake:far`, `bake:landmarks`.
`bake:landmarks`는 `scripts/lib/landmarks_registry.ts`의 명소 목록을 OSM(위치·태그) → Wikidata(이름·건축가·연도·높이) → Wikipedia 요약 → Commons 사진(480 px)으로 채워 `landmarks.json`을 만듭니다(키 없음, 약 1분, `cache/landmarks/`에 캐시되어 재실행은 요청 없음).
`bake:dsm`은 기념물(`landmark`로 분류된 건물군)마다 IGN LiDAR HD 표면모델 창(50 cm float32)을 받아 `cache/dsm/`에 두고, `bake:build`가 그 창으로 발자국 안의 실제 지붕면(돔·큐폴라·망사르 꺾임·유리 볼트)을 격자화·단순화(경계 고정)해 청크의 `dsm` 섹션에 씁니다(해석적 지붕은 `roofs_alt`/`tops_alt`로 함께 저장되어 `?dsm=0`·모바일에서 대신 쓰임). `DSM=0`으로 건너뛰고 `DSM_IDS=way/…`로 창을 추가합니다.
`bake:models`는 `scripts/landmarks_models.ts`의 히어로 모델 레지스트리(기본은 에펠탑뿐)를 OSM 발자국에 맞춰 `public/models/{id}.glb`·`_lod.glb`·`.json`과 인덱스 `landmarks.json`을 만듭니다. CC0/CC BY 모델만 자동으로 받아들이고 NC·ND·불명확 라이선스는 `ALLOW_NONFREE=1`을 줘야 처리합니다. 레지스트리에 있는 발자국은 압출에서 빠지고 항공사진에서 지워지며 그림자를 드리웁니다.
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
| `Esc` | 마우스 해제 → 장면이 보이는 일시정지 메뉴(계속 · 명소 목록 · 시간·날씨 · 링크 복사 · 스크린샷 · 도움말 · 정보·출처). 화면을 클릭하면 계속 |
| `W A S D` / 마우스 | 이동 / 시점 |
| `Shift` | 달리기 |
| `1`–`8` | 명소 이동 (트로카데로, 이에나 다리, 탑 아래, 샹드마르스, 에콜 밀리테르, 비르아켐, 케 브랑리, 탑 2층) — 1.2~2.6초 비행으로 이동하고 착지하면 명소 카드(사진·한/불 이름·건축가·연도·설명·거리와 방향·위키백과 링크)가 8초간 열렸다가 `현재 위치 · …` 칩으로 접힘 (`?glide=0` 즉시 이동) |
| `L` | 명소 목록 (33곳, 가까운 순, 방향 화살표) — 클릭하면 그곳으로 비행. 걷는 중이면 마우스 잠금이 풀리고 닫으면 복귀 |
| `I` | 명소 카드 펼치기/접기. 걷다가 명소 반경에 들어가면 카드가 5초간 뜨고(같은 곳은 1분에 한 번) 칩은 늘 `현재 위치 · X` 또는 `가까운 명소 · X 320 m · 오른쪽 앞`을 보여줌. `Esc` 뒤에는 카드의 `W 위키백과` 링크를 클릭할 수 있음 |
| `F` | 비행 모드 토글 (`Q`/`E` 상승·하강) |
| `T` | 시간 패널(오른쪽 위 시계 칩 `17:30 · 맑음` 클릭도 같음, 기본은 접힘 · `?timepanel=1`): 걷는 중 누르면 마우스 잠금이 풀려 슬라이더·프리셋 버튼을 조작할 수 있고, 다시 `T`(패널 숨김) 또는 화면 클릭으로 복귀 |
| `N` | 시간대 순환 (새벽 → 낮 → 오후 → 노을 → 야경 → 심야) |
| `,` / `.` | 15분 뒤로/앞으로 (`Shift`와 함께 1시간) — 태양 위치·창문 조명·가로등·탑 조명 연동 |
| `P` | 현재 위치·시점·시각을 담은 링크 복사 (`walk=1` 또는 `fly=1`) |
| `O` | 스크린샷 PNG 저장 |
| `M` | 미니맵 순환: 숨김 → 320 m → 1.5 km → 숨김 (항공사진, 북쪽 위, 명소 점·이름·단축키 번호, 탑, 진행 방향) |
| `V` | 소리 끄기/켜기 — 도로 소음·공원 새소리·강물·바람·발소리는 전부 합성음 (`?audio=0` 끔, `?audio=debug` 상태 표시) |
| `E` | 승강기: 탑 기둥 발치 또는 각 층 승강장 3 m 안에서 안내 문구가 뜨면 탑승 (1층 ↔ 2층 ↔ 꼭대기; `8`은 실제 2층 데크에 내려 줌) |
| 게임패드 | 왼스틱 이동 · 오른스틱 시점 · RT 달리기 · A 승강기 · Y 비행 · X 야경 · Back 미니맵 · Start 시간 패널 · LB 명소 목록 · RB 명소 카드 |
| 터치 | 왼쪽 40 % 가상 조이스틱 · 오른쪽 드래그 시점 · 버튼 열(달리기·비행·E·명소·ⓘ·지도·시간·야경); `pointer: coarse` 기기에서 자동, `?touch=1`로 강제. 모바일 프리셋(해상도 1x, AO·반사 끔). 명소 카드는 칩으로 시작하고 탭하면 펼쳐짐 |
| `R` | 날씨 순환 (맑음 → 흐림 → 비 → 안개) |
| `H` | 도움말 패널(단축키 전체 표). 열린 채 한 번 더 누르면 진단 정보(FPS 패널 · 좌표 · 청크 수 · 입력 통계)를 켜고 끔 — `?status=1`로도 켬. 왼쪽 아래 한 줄 힌트는 시작 20초 뒤 사라짐 |

URL 파라미터로 디버그 시점을 지정할 수 있습니다:
`?auto=1&fly=1&x=-480&z=-409&y=28&yaw=130&pitch=2&hour=19.5&quality=medium&post=0&tower=lattice&hide=trees,furniture&details=0&timepanel=0&facadetex=0&noenv=1`
(`facadetex=0`은 사진 텍스처 없이 절차 파사드만, `noenv=1`은 환경맵 없이 렌더링해 비교할 때 씁니다.)
움직이는 도시: `life=0`(끄기) / `life=crowd,traffic,boats`(선택) / `lifedebug=1`(활성 경로 그래프 표시) / `sim=0`(정지, `sim=4` 4배속) / `simt=240`(시뮬레이션 시각 고정 → 재현 가능한 스크린샷).
빛·물: `lamps=0`(가로등 광원 끄기) / `lampsdebug=1`(광원 마젠타) / `refl=0|1|2`(반사 끄기·절반·1/4 해상도) / `stars=0` / `glow=0`(광공해 끄기) / `headlights=0` / `shoplights=0` / `signals=0`(신호등 끄기) / `fartraffic=0`(원경 차량 불빛 끄기) / `wet=1`(비 온 뒤 노면) / `tower=lit`(탑 조명 밤새 유지) / `ao=0`(AO 끄기) / `clouds=0`(구름 끄기) / `crossings=0`(횡단보도 신호·양보 끄기) / `carlights=0`(브레이크등·방향지시등 끄기).
움직이는 도시 추가 토글: `metro=0`(6호선 열차 끄기) / `cyclists=0`(자전거 끄기).
날씨·계절: `weather=overcast|rain|fog`(기본 맑음, `R`로 순환) / `date=2026-10-25`처럼 날짜를 주면 가로수가 그 계절(4월 중순 발아 → 10월 단풍 → 11월 낙엽 → 겨울 나목)을 따릅니다.
거리·간판: `marks=0`(노면 표시 끄기) / `marksdebug=1`(마젠타) / `streets=0`(인도 슬래브 끄기) / `streetsdebug=1`(법선 색) / `signs=0`(간판·거리명판 끄기) / `signsdebug=1`(간판 마젠타 + 콘솔에 명판 위치·카메라 URL).
날짜·시각: 기본은 파리 기준 오늘 날짜이며 태양 경로·낮 길이·시간 프리셋(새벽·노을·야경은 그날의 일출·일몰 기준)이 따라갑니다. `date=2026-12-21&hour=16.5`처럼 다른 날을 볼 수 있고, `P`로 복사한 링크에도 오늘이 아니면 `date`가 들어갑니다.
명소: `at=invalides`(그 명소에 착지하고 카드를 엶, id는 `landmarks.json`; `P`로 복사한 링크에도 현재 명소가 들어감) / `glide=0`(비행 이동 대신 즉시 이동, OS의 "동작 줄이기" 설정도 같음) / `labels=1`(공중에 떠 있는 명소 이름표 켜기, 기본 꺼짐; 260 m부터 보이고 150 m 안에서 선명) / `dsm=0|1`(LiDAR 표면모델 지붕 끄기/켜기; 기본은 데스크톱 켬·터치 기기 끔) / `hide=models`(에펠탑 외 히어로 모델 숨김) / `gpu=0`(GPU 안내 패널·토스트 생략, 헤드리스 스크린샷용).
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

## 낮·거리 사실감 (4차)

- **하늘·빛**: 값 노이즈 fbm 구름층(맑음 30 %, 흐림·비 전면, 태양 쪽 은빛 가장자리, 밤엔 도시 불빛에 물듦)과 구름 틈 햇빛(태양광 ±75 % 변조). 낮 환경맵(HDRI)은 가장 밝은 텍셀로 태양 방위를 찾아 실제 태양에 맞춰 회전하므로 유리·도장·수면 반사 방향이 맞습니다. 노출은 태양 고도에 따라 0.8 → 0.95(저녁), 비네트는 0.12로 낮춤. 그림자는 `normalBias` 0.15·거리 200 m 박스(높이 오르면 320 m)로 연석·볼라드에 붙고, 인도 슬래브와 원거리 나무도 그림자를 드리웁니다.
- **횡단보도**: 횡단 엣지는 도로와 노드를 공유하므로(`shared/crossings.ts`) 신호 교차로의 팔 위상을 물려받습니다. 보행자는 차량 팔이 초록·황색이면 연석에서 대기(느슨한 줄)하고 빨강이 되면 건너며, 차량은 사람이 있는 횡단보도 3 m 앞에서 멈춥니다. 비신호 횡단보도는 보행자 우선.
- **플레이어와 사람·차**: 사람(반경 0.3 m)과 차(길이 방향 원 2개)에 부딪히면 밀려나고, 3 m 안의 보행자는 옆으로 비켜 걷습니다. 차는 감속·정차 시 브레이크등, 교차로 25 m 전부터 회전 방향 지시등(1.25 Hz 점멸), 주행거리로 바퀴가 돕니다.
- **노면·지물**: OSM `surface`(sett·cobblestone·paving_stones 도로 1,300여 개)를 포석 클래스로 구워 자갈돌 텍스처·거칠기를 쓰고, 디테일 텍스처는 11 m 노이즈로 두 배율을 섞어 반복이 안 보이며 300 m까지 유지됩니다. 인도 가로수 밑에는 주철 뿌리덮개(1.5 m), 다리 데크는 청크별 21 cm 항공사진 타일을 씁니다.
- **지물(OSM points)**: 월리스 분수·음수대, 지하철 입구(기마르풍), 버스 정류장 쉘터, 자전거 거치대, 쓰레기통, 국기 게양대를 절차 메시로 배치합니다(`npm run bake:osm` 후 `bake:build`).
- **위치 기반 음향**: HRTF 패너 12개(가까운 차 4·유람선 2·카페 테라스 4·분수 2)가 카메라 방향을 따르고, 경적·2음 사이렌(옆을 지나감)·정각 종소리(멀리서)·승강기 모터와 도착 벨·빗소리가 더해졌습니다. `?audio=debug`에 패너 수가 표시됩니다.
- **계단·다리**: 590개 `highway=steps` 중 고저차 30 cm 이상인 227개를 실제 계단(챌판 16.5 cm, 디딤판 26 cm 이상)으로 구워 인도 슬래브와 같은 재질·보행 판정을 씁니다. 석조 다리는 교각 사이에 타원 아치 개구부가 있는 측벽을 갖고, 6호선 고가(비르아켐·그르넬 대로)는 도로/지면 위 8.5 m에 강철빛 얇은 데크와 7 m 간격 기둥으로 올라갑니다.
- **원경 6.5 km**: BD TOPO를 3.4 km까지는 전부, 그 밖 6.5 km까지는 22 m 이상 건물만(WFS `CQL_FILTER`) 가져와 라데팡스·몽파르나스·사크레쾨르 실루엣이 탑에서 보이고, 지평선까지 지면 스커트를 깝니다.
- **트로카데로 분수**: `Fontaine de Varsovie` 수조에 양쪽 물대포 20문(축과 탑 방향으로 32°)과 축 위 대형 분수 4기를, 다른 수조 27곳엔 면적에 맞는 분수를 GPU 포물선 파티클로 넣었습니다(`fountains.json`, 밤엔 조명받은 듯 밝음, 물소리는 공간 음향).
- **6호선 열차**: 고가 선형(`rail.json`, 4개 5.8 km)마다 MP73 도색 5량 열차가 시뮬레이션 시각에 따라 가속·주행·제동·정차(28 s)·회차하며, 260 m 안에서는 굴림음이 들립니다. `?metro=0`.
- **보행자 외형**: 피부(밝음 62 %·중간 23 %·어두움 15 %), 머리색(금발·갈색·검정·회색), 바지(진청·청바지·베이지·검정)를 인스턴스별로 고르고 키 범위를 1.48~1.96 m로 넓혔습니다.
- **버스**: 간선(trunk~tertiary) 도로의 연석 차로에서 차량의 12 %는 RATP 도색(흰 차체·옥색 띠·검은 창 띠)의 12 m 표준 버스입니다. 승용차와 같은 브레이크등·방향지시등·바퀴 회전 상태를 쓰고 속도는 15 % 느립니다.
- **자전거**: 공원 산책로(폭 2.5 m 이상)와 보행자 전용·자전거 도로(폭 3.5 m 이상)에서 사람 메시를 안장에 올린 자전거가 4.2~6.5 m/s로 달립니다(횡단보도·계단 제외, 플레이어와 충돌). `?cyclists=0`.
- **진단**: 진단 정보(`?status=1` 또는 `H` 두 번)에 마우스 최대 Δ·워프 폐기 수, 컴파일된 프로그램 수, 롱태스크 수가 표시됩니다. 지면 셰이더는 프래그먼트 샘플러 16개 한도 안에 있어야 합니다(현재 15개: 타일·오버뷰·마스크·디테일 5세트 중 색상 3장+노멀 5장·그림자·환경맵). 넘으면 일반 GPU에서 지면이 통째로 사라집니다. 포인터 락은 `unadjustedMovement`로 요청하고 300 px 넘는 이동은 커서 워프로 보고 버립니다.

## 명소 사실감 (5차)

- **실제 지붕 형상**: 기념물로 분류된 건물(`landmark`: 교회·궁전·박물관·`wikidata`가 있는 대형 건물과 그 `building:part`)은 IGN LiDAR HD 표면모델(50 cm)을 발자국 안에서 격자화한 지붕 캡을 씁니다. 앵발리드의 황금 돔과 첨탑, 그랑팔레의 유리 볼트, 샤요 궁의 곡선 날개, 에콜 밀리테르의 사각 돔이 실제 실루엣으로 서고, 평평한 부분에는 항공사진이, 가파른 부분에는 절차적 지붕 재질이 법선에 따라 섞입니다. 벽 상단은 표면모델 가장자리를 따라가고(중앙값 필터), 캡의 경계 정점은 벽 상단에 맞춰 틈 없이 봉합됩니다. 단순화(경계 고정)로 평지붕은 수백 삼각형으로 줄고 돔은 살아남습니다(총 상한 120만 삼각형). `?dsm=0`이면 해석적 지붕(`roofs_alt`/`tops_alt`)이 대신 그려지고, 모바일 프리셋은 `dsm` 섹션을 GPU에 올리지 않습니다.
- **OSM 지붕 형상**: `roof:shape`의 dome·onion·cone은 발자국을 위도 0으로 삼아 타원으로 둥글어지는 회전면(LOD1은 거친 돔), round는 배럴 볼트, `roof:direction`/`roof:orientation`이 있는 gabled와 skillion은 실제 용마루 방향의 프로파일 지붕이 되고 박공 끝 벽은 지붕선까지 올라갑니다. 순수 돔 파트(`roof:height` = `height` − `min_height`)가 땅에서 벽을 세우던 버그를 고쳤습니다. 지붕 재질은 정점 `meta.z`(0 아연, 1 슬레이트, 2 기와, 3 구리 녹청, 4 납, 5 유리(야간 내부 발광), 6 도금(야간 투광 반사), 7 도색)로 셰이더가 분기하며, 돔(`RoofCurved` 플래그)은 도머 대신 자오선 리브를 갖습니다.
- **기념물 분류**: `building=church|palace|museum|…`, `tourism=attraction|museum`, `amenity=place_of_worship|townhall|theatre`, `historic`, `wikidata`/`heritage`(주거 제외), 이름 정규식(palais·musée·hôtel des·école militaire·unesco…)으로 Monument 스타일이 되고, 기념물 외곽선 안의 파트는 스타일·이름·석재색을 상속합니다(앵발리드 돔이 오스만 파사드로 그려지던 문제 해결).
- **기념물 파사드**: 0.9 m 코스의 큰 애슐러, 1층 채널 러스티케이션과 플린스, 베이 경계마다 0.9 m 필라스터(사이 벽은 0.25 m 시차 후퇴, 플루팅·주두), 1층 아치창(키스톤), 덴틸이 있는 프리즈, 2단 코니스, 처마 위 석재 발러스트레이드와 코핑(`BuildingDetails`의 인스턴스 박스·알파 시트).
- **히어로 모델 레지스트리**: `scripts/landmarks_models.ts`에 GLB와 OSM 발자국을 등록하면 `bake:models`가 발자국 사각형·높이·배율로 맞추고 크롭·압축해 `public/models/{id}.glb`(+LOD)로 만들며 런타임(`LandmarkModel`)이 거리별로 교체합니다. 에펠탑은 기존 전용 파이프라인을 유지합니다.

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

## GPU 확인 · 선택

WebGL2 컨텍스트는 `powerPreference: 'high-performance'` + `failIfMajorPerformanceCaveat`로 먼저 요청해 브라우저가 소프트웨어 렌더러(SwiftShader·WARP)를 조용히 내주지 못하게 하고, 실패했을 때만 새 캔버스에서 소프트웨어 컨텍스트로 물러납니다(`src/core/Renderer.ts`). 시작 클릭 뒤 토스트로 감지된 GPU 이름이 뜨고, 진단 정보(`?status=1`)의 마지막 줄(`gpu …`)과 콘솔의 `[gpu]` 줄에도 나옵니다.

- **`G` 키 = GPU 선택 패널**: WebGL이 받은 GPU와, 브라우저가 WebGPU로 볼 수 있는 고성능 GPU를 나란히 보여 주고, 브라우저를 외장 GPU로 옮기는 스위치를 복사 버튼과 함께 안내합니다. WebGL이 내장·소프트웨어 GPU에 있고 더 센 GPU가 보이면 첫 클릭 뒤 자동으로 열립니다(`다시 보지 않기`로 끌 수 있고, `?gpu=1`로 강제로 엽니다). 웹 페이지는 자기 WebGL 컨텍스트가 돌 GPU를 고를 수 없으므로(Windows의 Chrome/Edge는 GPU 프로세스 하나에 어댑터 하나) 선택은 브라우저·OS 단에서 합니다.
  - **가장 간단**: `chrome://flags/#force-high-performance-gpu`(Edge는 `edge://flags/...`)를 `Enabled`로 바꾸고 Relaunch. Chrome 문서(WebGPU troubleshooting)가 안내하는 공식 스위치로, 브라우저 전체를 고성능 GPU로 옮깁니다.
  - **OS 단**: 패널의 "Windows 그래픽 설정 열기"(`ms-settings:display-advancedgraphics`) → 데스크톱 앱 → 브라우저 exe 추가 → 고성능 → `chrome://quit` 후 재시작.
- **`(SOFTWARE)`가 보이면** Chrome 설정 → 시스템 → "가능한 경우 그래픽 가속 사용"을 켜고, `chrome://gpu`에서 WebGL/WebGL2가 `Hardware accelerated`인지, 그래픽 드라이버가 차단 목록에 있지 않은지 확인합니다(드라이버 업데이트 또는 `chrome://flags/#ignore-gpu-blocklist`).
- **`(integrated)`가 보이면** 내장 GPU로 돌고 있습니다(예: `chrome://gpu`에 `GPU0 … AMD Radeon(TM) 610M *ACTIVE*`, `GPU1 … NVIDIA GeForce RTX 5070`처럼 외장이 놀고 있는 하이브리드 노트북). Windows의 Chrome은 GPU 프로세스 하나가 OS가 정해 준 GPU를 쓰므로 페이지 쪽 `powerPreference`로는 바뀌지 않습니다. 순서: Windows 설정 → 시스템 → 디스플레이 → 그래픽 → "데스크톱 앱" 선택 후 찾아보기로 `C:\Program Files\Google\Chrome\Application\chrome.exe` 추가 → 목록의 Google Chrome → 옵션 → **고성능**(외장 GPU 이름 표시) → 저장 → 주소창에 `chrome://quit`로 완전히 종료 → 다시 실행 → `chrome://gpu`의 `GL_RENDERER`와 이 앱의 시작 토스트에 외장 GPU 이름이 뜨는지 확인합니다. NVIDIA 제어판의 "3D 설정 관리 → 프로그램 설정"으로도 지정할 수 있지만 Windows 그래픽 설정이 우선합니다.
- 헤드리스 검증(SwiftShader)에서는 첫 요청이 거부되고 소프트웨어 폴백 경로가 실행되므로 스크린샷에 경고 토스트가 함께 찍힙니다.

## 검증

```bash
npm test          # 좌표 변환, 압출 지오메트리 방향, 야간·신호·계절·활동량 테이블 테스트
npm run typecheck # 런타임 + 스크립트 타입 검사
npm run build     # 프로덕션 번들
```

## 배포 용량

정적 데이터가 약 220 MB(청크 123 — LiDAR 지붕 캡·대체 지붕 포함 —, 지면 83, 원경 20, 인도 19 MB, 탑 모델 28 MB, 명소 사진 2 MB)입니다. 대부분 float32라 Brotli로 72 % 줄어듭니다.

```bash
npm run build:compressed   # vite build 뒤 dist/**/*.bin|json|glb|hdr 옆에 .br 생성 (192 MB → 54 MB, 약 10 s)
npm run preview            # .br을 Content-Encoding: br로 서빙해 실제 전송량을 확인
```

호스트가 미리 압축된 파일을 지원하면 그대로 올리면 됩니다(nginx `brotli_static on;`, Caddy `file_server { precompressed br }`, Cloudflare Pages는 자동). 개발 서버는 원본을 그대로 서빙합니다.
