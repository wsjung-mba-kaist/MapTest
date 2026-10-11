import type { GpuInfo, HpAdapter } from '../core/Renderer';
import { STORAGE_KEYS, storageGet, storageSet } from './storage';
import { required } from './dom';
import { S, fmt } from './strings';

const VENDOR_LABEL: Record<string, string> = S.gpu.vendor;
const G = S.gpu;

/**
 * "GPU 선택" panel. A web page cannot pick the GPU its WebGL context runs on (Windows browsers pin one adapter per GPU
 * process), so this panel shows which adapter WebGL got, which high-performance adapter the browser can see through
 * WebGPU, and the browser / OS switches that move the whole browser onto the discrete GPU. Opened automatically when
 * WebGL landed on an integrated or software device while a stronger one is around, or any time with G.
 */
export class GpuPanel {
  private readonly el = required<HTMLDivElement>('gpupanel');
  onOpen: () => void = () => {};
  /** after hide(): App grabs the pointer back unless another panel is up */
  onClose: () => void = () => {};

  get open() { return !this.el.hidden; }
  static get suppressed(): boolean { return storageGet(STORAGE_KEYS.gpuPanelNever) === '1'; }

  hide() { if (this.el.hidden) return; this.el.hidden = true; this.onClose(); }

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
    const hpLabel = hp === undefined ? G.checking : hp ? `${VENDOR_LABEL[hp.vendor] ?? hp.vendor}${hp.architecture ? ` (${hp.architecture})` : ''}${hp.description ? ` · ${hp.description}` : ''}` : G.noWebgpu;
    const better = !!hp && hp.vendor !== '' && hp.vendor !== info.vendor;
    const stuck = info.software || info.integrated;

    const h = (tag: string, cls: string | null, ...kids: (string | Node)[]) => { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; };
    const code = (t: string) => h('code', null, t);
    const copyBtn = (text: string, label: string = G.copy) => { const b = h('button', null, label) as HTMLButtonElement; b.type = 'button'; b.addEventListener('click', () => void copyText(text, b)); return b; };
    const badge = (t: string, ok: boolean) => h('span', ok ? 'badge ok' : 'badge', t);

    const out: HTMLElement[] = [];
    out.push(h('h2', null, G.title));
    out.push(h('div', 'kv',
      h('span', null, G.webglGpu), h('span', null, info.name, badge(info.software ? G.badge.software : info.integrated ? G.badge.integrated : G.badge.discrete, !stuck)),
      h('span', null, G.hpGpu), h('span', null, hpLabel, ...(better ? [badge(G.badge.unused, false)] : [])),
    ));

    if (info.software) out.push(h('p', 'verdict warn', G.verdictSoftware));
    else if (better) out.push(h('p', 'verdict warn', fmt(G.verdictBetter, { vendor: VENDOR_LABEL[hp!.vendor] ?? hp!.vendor, name: info.name })));
    else if (stuck) out.push(h('p', 'verdict', G.verdictStuck));
    else out.push(h('p', 'verdict', G.verdictOk));

    if (!isFirefox) out.push(h('div', 'method',
      h('b', null, fmt(G.flags.title, { browser: isEdge ? 'Edge' : 'Chrome' })),
      G.flags.s1, code(flagsUrl), copyBtn(flagsUrl), G.flags.s2, code(G.flags.enabled), G.flags.s3,
    ));
    if (isWin) {
      const link = h('a', 'btn', G.win.link) as HTMLAnchorElement; link.href = 'ms-settings:display-advancedgraphics';
      out.push(h('div', 'method',
        h('b', null, fmt(G.win.title, { n: isFirefox ? 1 : 2 })),
        link, G.win.s1, code(exe), copyBtn(exe), G.win.s2, code(G.win.perf), G.win.s3,
        ...(isFirefox ? [G.win.closeAll] : [G.win.quit1, code(quitUrl), copyBtn(quitUrl), G.win.quit2]), G.win.s4,
      ));
    }
    if (isMac) out.push(h('div', 'method', h('b', null, G.mac.title), G.mac.text));
    out.push(h('p', 'verdict', G.after.s1, code(G.after.key), G.after.s2, code(G.after.status), G.after.s3));

    const close = h('button', null, G.close) as HTMLButtonElement; close.type = 'button'; close.addEventListener('click', () => this.hide());
    const never = h('button', null, G.never) as HTMLButtonElement; never.type = 'button';
    never.addEventListener('click', () => { storageSet(STORAGE_KEYS.gpuPanelNever, '1'); this.hide(); });
    out.push(h('div', 'foot', never, close));
    return out;
  }
}

async function copyText(text: string, btn: HTMLButtonElement) {
  let ok: boolean;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const old = btn.textContent; btn.textContent = ok ? S.gpu.copied : S.gpu.copyFailed;
  window.setTimeout(() => { btn.textContent = old; }, 1500);
}
