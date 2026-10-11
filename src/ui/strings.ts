/**
 * Every Korean string the HUD and its panels show, in one typed catalogue (`S`), so copy is edited or translated in
 * one place and the modules keep only structure. Inside a string `[X]` marks a key cap: `kbdNodes` in dom.ts turns it
 * into <kbd>X</kbd>, so no module builds HTML out of copy. `{name}` is a `fmt` placeholder. Static copy in index.html
 * (start screen, time-panel caption) and the toasts App raises stay where they are.
 */
/**
 * One row of the key legend, the single source for the help table (H) and the bottom-left hint bar: `keys` is boxed
 * by the table (split on ' · '); the rows with a `hint` are the bar's entries, in this order, already in kbd notation.
 */
export type KeyRow = { keys: string; what: string; hint?: string };
const HELP_GROUPS: readonly { group: string; rows: readonly KeyRow[] }[] = [
  { group: '이동', rows: [
    { keys: 'W A S D · ←↑↓→', what: '걷기', hint: '[W][A][S][D] 이동' },
    { keys: '마우스', what: '시점', hint: '마우스 시점' },
    { keys: 'Shift', what: '달리기', hint: '[Shift] 달리기' },
    { keys: 'F', what: '비행 모드 켜기/끄기 · 비행 중 Q / E 하강·상승, Shift 5배속' },
    { keys: 'E', what: '에펠탑 승강기: 기둥 발치·각 층 승강장에서 안내가 뜨면 탑승 (1층 ↔ 2층 ↔ 꼭대기)' },
  ] },
  { group: '명소', rows: [
    { keys: '1 – 8', what: '명소로 이동 (트로카데로 · 이에나 다리 · 탑 아래 · 샹드마르스 · 에콜 밀리테르 · 비르아켐 · 케 브랑리 · 탑 2층)', hint: '[1]–[8] 명소' },
    { keys: 'L', what: '명소 목록 (33곳, 가까운 순)' },
    { keys: 'I', what: '명소 카드 펼치기/접기' },
    { keys: 'M', what: '미니맵: 숨김 → 320 m → 1.5 km' },
  ] },
  { group: '시간 · 날씨', rows: [
    { keys: 'T', what: '시간 패널 (슬라이더 · 프리셋)' },
    { keys: 'N', what: '시간대 순환: 새벽 → 낮 → 오후 → 노을 → 야경 → 심야' },
    { keys: ', .', what: '15분 뒤로 / 앞으로 (Shift 1시간)' },
    { keys: 'R', what: '날씨 순환: 맑음 → 흐림 → 비 → 안개' },
  ] },
  { group: '기타', rows: [
    { keys: 'Esc', what: '마우스 해제 · 메뉴', hint: '[Esc] 메뉴' },
    { keys: 'H', what: '이 도움말 (열린 채 한 번 더: 진단 정보 표시)', hint: '[H] 도움말' },
    { keys: 'P', what: '현재 위치·시점·시각을 담은 링크 복사' },
    { keys: 'O', what: '스크린샷 PNG 저장' },
    { keys: 'V', what: '소리 끄기/켜기' },
    { keys: 'G', what: 'GPU 선택 안내' },
  ] },
  { group: '게임패드', rows: [
    { keys: '왼스틱 · 오른스틱', what: '이동 · 시점' },
    { keys: 'RT · A · Y', what: '달리기 · 승강기 · 비행' },
    { keys: 'X · Back · Start', what: '야경 · 미니맵 · 시간 패널' },
    { keys: 'LB · RB', what: '명소 목록 · 명소 카드' },
  ] },
];

export const S = {
  hud: {
    ready: '마우스 잠금 · Esc 메뉴',
    pause: '화면을 클릭하면 계속 걷습니다',
    timePanelPause: '시간을 맞춘 뒤 화면을 클릭하면 계속 걷습니다 · T 패널 닫기',
    streaming: '거리 불러오는 중 {loaded}/{total}',
    /** pause-menu entries, keyed by MenuAction */
    menu: { continue: '계속 걷기', places: '명소 목록', time: '시간 · 날씨', night: '시간대 순환', settings: '설정', share: '링크 복사', shot: '스크린샷 저장', help: '도움말', info: '정보 · 출처' },
  },
  modal: { close: '닫기' },
  help: {
    title: '도움말', hint: '[H] 닫기',
    groups: HELP_GROUPS,
    touch: { group: '터치', keys: '화면', what: '왼쪽 40 %를 누르면 그 자리에 조이스틱 · 오른쪽을 끌면 시점 · 오른쪽 아래 버튼 열' },
    foot: '패널이 열려 있으면 마우스가 풀립니다. 화면을 클릭하면 계속 걷습니다.',
  },
  info: {
    title: '정보 · 출처',
    intro: '에펠탑을 중심으로 반경 약 1.5 km(트로카데로, 이에나 다리, 샹드마르스, 에콜 밀리테르, 앵발리드, 그랑 팔레)를 공개 데이터만으로 실제 배치·높이 그대로 재현한 1인칭 산책입니다. 건물 높이는 실측, 지붕은 LiDAR, 지면은 20 cm 항공사진이고 낮과 밤·계절·날씨가 실제 파리의 태양 경로를 따릅니다.',
    sources: [
      '건물 윤곽 · 도로 · 다리 · 센강 · 공원 — OpenStreetMap (ODbL)',
      '건물 실측 높이 · 지붕 재질 · 원경 6.5 km — IGN BD TOPO (Etalab 2.0)',
      '20 cm 항공사진 · 1 m 지형 · 50 cm LiDAR 지붕 — IGN BD ORTHO / RGE ALTI / LiDAR HD (Etalab 2.0)',
      '가로수 21,000여 그루 — Ville de Paris open data (ODbL)',
      '명소 33곳의 이름 · 건축가 · 연도 · 요약 · 사진 — Wikidata · Wikipedia (CC BY-SA 4.0) · Wikimedia Commons (사진별 표시)',
      '차량 — Kenney Car Kit (CC0) · 텍스처 · HDRI — Poly Haven, ambientCG (CC0)',
      '보행자 · 가로등 · 파사드 디테일 · 소리 — 절차 생성',
    ],
    foot: '좌표계: 에펠탑 중심 ENU 미터 · 자세한 출처와 라이선스는 README에 있습니다.',
  },
  settings: {
    title: '설정', hint: '바로 적용 · 이 브라우저에 저장',
    quality: { auto: '자동', low: '낮음', medium: '보통', high: '높음' },
    auto: '자동',
    /** row labels keyed by Prefs key */
    rows: {
      quality: '품질', shadows: '그림자', reflection: '센강 반사', ao: '주변광 차폐 (AO)', pixelRatio: '해상도 배율', sensitivity: '시점 감도', fov: '시야각',
      headBob: '걸을 때 머리 흔들림', volume: '소리 크기', minimap: '미니맵 켜고 시작', compass: '나침반 띠', labels: '명소 이름표 (공중)', life: '움직이는 도시', diagnostics: '진단 정보 (FPS · 좌표)',
    },
    notes: { quality: '자동: 느리면 한 단계 낮춤', life: '다음 시작부터' },
    reset: '기본값으로',
    urlNote: 'URL 파라미터(?quality= 등)가 있으면 그 세션에서는 그것이 우선합니다.',
  },
  time: {
    weather: { clear: '맑음', overcast: '흐림', rain: '비', fog: '안개' },
    presets: { dawn: '새벽', day: '낮', afternoon: '오후', sunset: '노을', night: '야경', lateNight: '심야' },
    seasons: { spring: '봄', summer: '여름', autumn: '가을', winter: '겨울' },
    now: '지금', nowTitle: '파리의 현재 날짜와 시각',
    play: '▶ ×{rate}', playTitle: '시간 흐름 재생 ({scale})', playScale: { 60: '1분 = 1시간', 600: '6초 = 1시간' },
    weatherTitle: '날씨 · {label}', seasonTitle: '{month}월 {day}일',
    today: '오늘', todayTitle: '오늘 날짜',
    weatherRow: '날씨', seasonRow: '계절',
    sunrise: '일출', sunset: '일몰',
  },
  /** landmark card */
  place: {
    /** one-line hints for places with something to do there, keyed by landmark id */
    tips: {
      eiffel: '기둥 발치에서 E · 승강기로 1층 → 2층 → 꼭대기 (각 층에서 걸어 다닐 수 있음)',
      'eiffel-deck': '난간을 따라 걸으며 사방을 볼 수 있음 · 승강장에서 E · 꼭대기 또는 지상으로',
    },
    wiki: 'W 위키백과', fold: '접기 [I]', foldTouch: '접기', foldAria: '카드 접기', go: '여기로 이동',
    architect: '건축 {names}', year: '{year}년', height: '높이 {height} m',
    lang: { fr: '프랑스어', en: '영어' },
    photo: '사진: {artist}', photoDefault: 'Wikimedia Commons',
    here: '현재 위치 · {name}', near: '가까운 명소 · {name} {dist} · {dir}',
    standing: '이곳에 있습니다', from: '여기서 {dist} · {dir}',
  },
  /** landmark list */
  places: {
    title: '명소 목록', head: '명소', hint: '[1]–[8] 바로 이동 · [↑][↓] [Enter] · [L] 닫기',
    search: '이름 검색 (한 · 불 · 영)', searchAria: '명소 검색', all: '전체',
  },
  gpu: {
    title: 'GPU 선택',
    vendor: { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm', software: '소프트웨어', unknown: '알 수 없음' },
    checking: '확인 중…', noWebgpu: '확인 불가 (WebGPU 없음)',
    copy: '복사', copied: '복사됨', copyFailed: '복사 실패',
    webglGpu: 'WebGL이 쓰는 GPU', hpGpu: '브라우저가 보는 고성능 GPU',
    badge: { software: '소프트웨어', integrated: '내장', discrete: '고성능', unused: '미사용' },
    verdictSoftware: '하드웨어 GPU 없이 소프트웨어로 그리고 있습니다. 브라우저 설정에서 그래픽 가속을 켜고, chrome://gpu 에서 WebGL이 Hardware accelerated 인지, 드라이버가 차단 목록에 있지 않은지 확인하세요.',
    verdictBetter: '{vendor} 외장 GPU가 있지만 이 페이지의 WebGL은 {name}에서 실행되고 있습니다. 웹 페이지는 GPU를 직접 고를 수 없어 브라우저 전체를 외장 GPU로 옮겨야 합니다. 아래 방법 중 하나를 적용한 뒤 브라우저를 완전히 다시 시작하세요.',
    verdictStuck: '내장 GPU에서 실행 중입니다. 외장 GPU가 있는 PC라면 아래 방법으로 브라우저를 옮길 수 있습니다.',
    verdictOk: '고성능 GPU에서 실행 중입니다.',
    // sentence fragments (s1, s2, …): the panel inserts <code> / copy buttons between them
    flags: { title: '방법 1 · {browser} 플래그 (가장 간단)', s1: '주소창에 ', s2: ' 를 열어 ', enabled: 'Enabled', s3: ' 로 바꾸고 아래의 Relaunch 버튼으로 다시 시작합니다. 브라우저 전체(WebGL 포함)가 고성능 GPU에서 실행됩니다.' },
    win: {
      title: '방법 {n} · Windows 그래픽 설정', link: 'Windows 그래픽 설정 열기',
      s1: ' → "데스크톱 앱" 선택 → 찾아보기 → ', s2: ' 추가 → 목록의 브라우저 → 옵션 → ', perf: '고성능', s3: ' → 저장. 그 다음 ',
      closeAll: '브라우저를 모두 닫고', quit1: '주소창에 ', quit2: ' 로 완전히 종료한 뒤',
      s4: ' 다시 엽니다. NVIDIA 제어판의 "3D 설정 관리 → 프로그램 설정"도 같은 역할이지만 Windows 설정이 우선합니다.',
    },
    mac: { title: 'macOS', text: '듀얼 GPU MacBook에서는 이 페이지의 high-performance 요청이 그대로 적용됩니다. 시스템 설정 → 배터리 → "자동 그래픽 전환"이 켜져 있는지 확인하세요.' },
    after: { s1: '다시 시작한 뒤 이 패널(', key: 'G', s2: ')이나 시작 토스트에 외장 GPU 이름이 뜨면 성공입니다. ', status: '?status=1', s3: ' 의 gpu 줄에서도 볼 수 있습니다.' },
    close: '닫기 (G)', never: '다시 보지 않기',
  },
  touch: {
    up: '상승 (비행 중)', down: '하강 (비행 중)',
    fly: '비행', flyTitle: '비행 모드 (F)', places: '명소', placesTitle: '명소 목록 (L)', map: '지도', mapTitle: '미니맵 (M)',
    more: '⋯', moreTitle: '메뉴: 시간 · 날씨 · 설정 · 도움말',
  },
  minimap: { title: '클릭: 그곳으로 이동 · 휠: 축척' },
} as const;

/** `fmt('{loaded}/{total}', { loaded: 3, total: 144 })`; an unknown name is left as written so a typo shows on screen. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
