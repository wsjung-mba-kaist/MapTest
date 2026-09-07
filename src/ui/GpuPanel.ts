import type { GpuInfo, HpAdapter } from '../core/Renderer';

const NEVER_KEY = 'paris.gpuPanel.never';
const VENDOR_LABEL: Record<string, string> = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm', software: '소프트웨어', unknown: '알 수 없음' };

/**
 * "GPU 선택" panel. A web page cannot pick the GPU its WebGL context runs on (Windows browsers pin one adapter per GPU
 * process), so this panel shows which adapter WebGL got, which high-performance adapter the browser can see through
 * WebGPU, and the browser / OS switches that move the whole browser onto the discrete GPU. Opened automatically when
 * WebGL landed on an integrated or software device while a stronger one is around, or any time with G.
 */
export class GpuPanel {
  private readonly el: HTMLDivElement;
  onOpen: () => void = () => {};

  constructor() {
    let el = document.getElementById('gpupanel') as HTMLDivElement | null;
    if (!el) { el = document.createElement('div'); el.id = 'gpupanel'; el.hidden = true; (document.getElementById('hud') ?? document.body).appendChild(el); }
    this.el = el;
  }

  get open() { return !this.el.hidden; }
  static get suppressed(): boolean { try { return localStorage.getItem(NEVER_KEY) === '1'; } catch { return false; } }

  hide() { this.el.hidden = true; }

  show(info: GpuInfo, hp: HpAdapter | null | undefined) {
    this.el.replaceChildren(...this.build(info, hp));
    this.el.hidden = false;
    this.onOpen();
  }

  private build(info: GpuInfo, hp: HpAdapter | null | undefined): HTMLElement[] {
    const ua = navigator.userAgent;
    const isEdge = /Edg\//.test(ua), isFirefox = /Firefox\//.test(ua), isWin = /Windows/.test(ua), isMac = /Mac OS X/.test(ua);
    const flagsUrl = `${isEdge ? 'edge' : 'chrome'}://flags/#force-high-performance-gpu`;
    const exe = isEdge ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : isFirefox ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const quitUrl = isEdge ? 'edge://quit' : 'chrome://quit';
    const hpLabel = hp === undefined ? '확인 중…' : hp ? `${VENDOR_LABEL[hp.vendor] ?? hp.vendor}${hp.architecture ? ` (${hp.architecture})` : ''}${hp.description ? ` · ${hp.description}` : ''}` : '확인 불가 (WebGPU 없음)';
    const better = !!hp && hp.vendor !== '' && hp.vendor !== info.vendor;
    const stuck = info.software || info.integrated;

    const h = (tag: string, cls: string | null, ...kids: (string | Node)[]) => { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; };
    const code = (t: string) => h('code', null, t);
    const copyBtn = (text: string, label = '복사') => { const b = h('button', null, label) as HTMLButtonElement; b.type = 'button'; b.addEventListener('click', () => void copyText(text, b)); return b; };
    const badge = (t: string, ok: boolean) => h('span', ok ? 'badge ok' : 'badge', t);

    const out: HTMLElement[] = [];
    out.push(h('h2', null, 'GPU 선택'));
    out.push(h('div', 'kv',
      h('span', null, 'WebGL이 쓰는 GPU'), h('span', null, info.name, badge(info.software ? '소프트웨어' : info.integrated ? '내장' : '고성능', !stuck)),
      h('span', null, '브라우저가 보는 고성능 GPU'), h('span', null, hpLabel, ...(better ? [badge('미사용', false)] : [])),
    ));

    if (info.software) out.push(h('p', 'verdict warn', '하드웨어 GPU 없이 소프트웨어로 그리고 있습니다. 브라우저 설정에서 그래픽 가속을 켜고, chrome://gpu 에서 WebGL이 Hardware accelerated 인지, 드라이버가 차단 목록에 있지 않은지 확인하세요.'));
    else if (better) out.push(h('p', 'verdict warn', `${VENDOR_LABEL[hp!.vendor] ?? hp!.vendor} 외장 GPU가 있지만 이 페이지의 WebGL은 ${info.name}에서 실행되고 있습니다. 웹 페이지는 GPU를 직접 고를 수 없어 브라우저 전체를 외장 GPU로 옮겨야 합니다. 아래 방법 중 하나를 적용한 뒤 브라우저를 완전히 다시 시작하세요.`));
    else if (stuck) out.push(h('p', 'verdict', '내장 GPU에서 실행 중입니다. 외장 GPU가 있는 PC라면 아래 방법으로 브라우저를 옮길 수 있습니다.'));
    else out.push(h('p', 'verdict', '고성능 GPU에서 실행 중입니다.'));

    if (!isFirefox) out.push(h('div', 'method',
      h('b', null, `방법 1 · ${isEdge ? 'Edge' : 'Chrome'} 플래그 (가장 간단)`),
      '주소창에 ', code(flagsUrl), copyBtn(flagsUrl), ' 를 열어 ', code('Enabled'), ' 로 바꾸고 아래의 Relaunch 버튼으로 다시 시작합니다. 브라우저 전체(WebGL 포함)가 고성능 GPU에서 실행됩니다.',
    ));
    if (isWin) {
      const link = h('a', 'btn', 'Windows 그래픽 설정 열기') as HTMLAnchorElement; link.href = 'ms-settings:display-advancedgraphics';
      out.push(h('div', 'method',
        h('b', null, `방법 ${isFirefox ? 1 : 2} · Windows 그래픽 설정`),
        link, ' → "데스크톱 앱" 선택 → 찾아보기 → ', code(exe), copyBtn(exe), ' 추가 → 목록의 브라우저 → 옵션 → ', code('고성능'), ' → 저장. 그 다음 ',
        ...(isFirefox ? ['브라우저를 모두 닫고'] : ['주소창에 ', code(quitUrl), copyBtn(quitUrl), ' 로 완전히 종료한 뒤']), ' 다시 엽니다. NVIDIA 제어판의 "3D 설정 관리 → 프로그램 설정"도 같은 역할이지만 Windows 설정이 우선합니다.',
      ));
    }
    if (isMac) out.push(h('div', 'method', h('b', null, 'macOS'), '듀얼 GPU MacBook에서는 이 페이지의 high-performance 요청이 그대로 적용됩니다. 시스템 설정 → 배터리 → "자동 그래픽 전환"이 켜져 있는지 확인하세요.'));
    out.push(h('p', 'verdict', '다시 시작한 뒤 이 패널(', code('G'), ')이나 시작 토스트에 외장 GPU 이름이 뜨면 성공입니다. ', code('?status=1'), ' 의 gpu 줄에서도 볼 수 있습니다.'));

    const close = h('button', null, '닫기 (G)') as HTMLButtonElement; close.type = 'button'; close.addEventListener('click', () => this.hide());
    const never = h('button', null, '다시 보지 않기') as HTMLButtonElement; never.type = 'button';
    never.addEventListener('click', () => { try { localStorage.setItem(NEVER_KEY, '1'); } catch { /* private mode */ } this.hide(); });
    out.push(h('div', 'foot', never, close));
    return out;
  }
}

async function copyText(text: string, btn: HTMLButtonElement) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const old = btn.textContent; btn.textContent = ok ? '복사됨' : '복사 실패';
  window.setTimeout(() => { btn.textContent = old; }, 1500);
}
