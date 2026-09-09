/**
 * Centred modal panels opened from the pause menu / shortcuts: the help (full shortcut table) and the info panel
 * (what this is, data sources, model and photo credits). Same pointer-lock contract as the landmark list: App
 * releases the pointer while one is open and grabs it back on close. One modal at a time (App.openModal).
 */
export class Modal {
  readonly root = document.createElement('div');
  readonly body = document.createElement('div');
  open = false;

  constructor(parent: HTMLElement, id: string, title: string, hint: string, private readonly onClose: () => void, wide = false) {
    const r = this.root;
    r.id = id; r.className = wide ? 'modal wide' : 'modal'; r.hidden = true;
    r.setAttribute('role', 'dialog'); r.setAttribute('aria-modal', 'true'); r.setAttribute('aria-label', title);
    const head = document.createElement('div'); head.className = 'head';
    const b = document.createElement('b'); b.textContent = title;
    const h = document.createElement('span'); h.className = 'hint'; h.innerHTML = hint;
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '✕'; close.className = 'close'; close.setAttribute('aria-label', '닫기');
    close.addEventListener('click', () => this.onClose());
    head.append(b, h, close);
    this.body.className = 'body';
    r.append(head, this.body);
    r.addEventListener('pointerdown', e => e.stopPropagation());
    parent.appendChild(r);
  }

  show() { this.root.hidden = false; this.open = true; (this.root.querySelector('.close') as HTMLElement | null)?.focus(); }
  hide() { this.root.hidden = true; this.open = false; }
}

const HELP: [string, [string, string][]][] = [
  ['이동', [['W A S D · ←↑↓→', '걷기'], ['마우스', '시점'], ['Shift', '달리기'], ['F', '비행 모드 켜기/끄기 · 비행 중 Q / E 하강·상승, Shift 5배속'], ['E', '에펠탑 승강기: 기둥 발치·각 층 승강장에서 안내가 뜨면 탑승 (1층 ↔ 2층 ↔ 꼭대기)']]],
  ['명소', [['1 – 8', '명소로 이동 (트로카데로 · 이에나 다리 · 탑 아래 · 샹드마르스 · 에콜 밀리테르 · 비르아켐 · 케 브랑리 · 탑 2층)'], ['L', '명소 목록 (33곳, 가까운 순)'], ['I', '명소 카드 펼치기/접기'], ['M', '미니맵: 숨김 → 320 m → 1.5 km']]],
  ['시간 · 날씨', [['T', '시간 패널 (슬라이더 · 프리셋)'], ['N', '시간대 순환: 새벽 → 낮 → 오후 → 노을 → 야경 → 심야'], [', .', '15분 뒤로 / 앞으로 (Shift 1시간)'], ['R', '날씨 순환: 맑음 → 흐림 → 비 → 안개']]],
  ['기타', [['Esc', '마우스 해제 · 메뉴'], ['H', '이 도움말 (열린 채 한 번 더: 진단 정보 표시)'], ['P', '현재 위치·시점·시각을 담은 링크 복사'], ['O', '스크린샷 PNG 저장'], ['V', '소리 끄기/켜기'], ['G', 'GPU 선택 안내']]],
  ['게임패드', [['왼스틱 · 오른스틱', '이동 · 시점'], ['RT · A · Y', '달리기 · 승강기 · 비행'], ['X · Back · Start', '야경 · 미니맵 · 시간 패널'], ['LB · RB', '명소 목록 · 명소 카드']]],
];

export class HelpPanel extends Modal {
  constructor(parent: HTMLElement, onClose: () => void, touch: boolean) {
    super(parent, 'helppanel', '도움말', '<kbd>H</kbd> 닫기', onClose, true);
    const table = document.createElement('table');
    for (const [group, rows] of HELP) {
      const th = document.createElement('tr'); const h = document.createElement('th'); h.colSpan = 2; h.textContent = group; th.appendChild(h); table.appendChild(th);
      for (const [keys, what] of rows) {
        const tr = document.createElement('tr'); const k = document.createElement('td'); const w = document.createElement('td');
        for (const key of keys.split(' · ')) { const kbd = document.createElement('kbd'); kbd.textContent = key; k.appendChild(kbd); k.append(' '); }
        w.textContent = what; tr.append(k, w); table.appendChild(tr);
      }
    }
    if (touch) {
      const th = document.createElement('tr'); const h = document.createElement('th'); h.colSpan = 2; h.textContent = '터치'; th.appendChild(h); table.prepend(th);
      const tr = document.createElement('tr'); tr.innerHTML = '<td>화면</td><td></td>'; (tr.lastChild as HTMLElement).textContent = '왼쪽 40 %를 누르면 그 자리에 조이스틱 · 오른쪽을 끌면 시점 · 오른쪽 아래 버튼 열'; th.after(tr);
    }
    const foot = document.createElement('div'); foot.className = 'foot';
    foot.textContent = '패널이 열려 있으면 마우스가 풀립니다. 화면을 클릭하면 계속 걷습니다.';
    this.body.append(table, foot);
  }
}

export class InfoPanel extends Modal {
  private readonly creditsEl = document.createElement('div');
  constructor(parent: HTMLElement, onClose: () => void) {
    super(parent, 'infopanel', '정보 · 출처', '', onClose, true);
    const p = document.createElement('p');
    p.textContent = '에펠탑을 중심으로 반경 약 1.5 km(트로카데로, 이에나 다리, 샹드마르스, 에콜 밀리테르, 앵발리드, 그랑 팔레)를 공개 데이터만으로 실제 배치·높이 그대로 재현한 1인칭 산책입니다. 건물 높이는 실측, 지붕은 LiDAR, 지면은 20 cm 항공사진이고 낮과 밤·계절·날씨가 실제 파리의 태양 경로를 따릅니다.';
    const ul = document.createElement('ul');
    for (const t of [
      '건물 윤곽 · 도로 · 다리 · 센강 · 공원 — OpenStreetMap (ODbL)',
      '건물 실측 높이 · 지붕 재질 · 원경 6.5 km — IGN BD TOPO (Etalab 2.0)',
      '20 cm 항공사진 · 1 m 지형 · 50 cm LiDAR 지붕 — IGN BD ORTHO / RGE ALTI / LiDAR HD (Etalab 2.0)',
      '가로수 21,000여 그루 — Ville de Paris open data (ODbL)',
      '명소 33곳의 이름 · 건축가 · 연도 · 요약 · 사진 — Wikidata · Wikipedia (CC BY-SA 4.0) · Wikimedia Commons (사진별 표시)',
      '차량 — Kenney Car Kit (CC0) · 텍스처 · HDRI — Poly Haven, ambientCG (CC0)',
      '보행자 · 가로등 · 파사드 디테일 · 소리 — 절차 생성',
    ]) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
    this.creditsEl.className = 'credits';
    const foot = document.createElement('div'); foot.className = 'foot';
    foot.textContent = '좌표계: 에펠탑 중심 ENU 미터 · 자세한 출처와 라이선스는 README에 있습니다.';
    this.body.append(p, ul, this.creditsEl, foot);
  }
  addCredit(text: string) { const d = document.createElement('div'); d.textContent = text; this.creditsEl.appendChild(d); }
}
