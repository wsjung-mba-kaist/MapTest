/**
 * Headless smoke test: serve the app, open it in Chromium over the DevTools protocol, stream every chunk on
 * SwiftShader and fail on anything a `vite build` cannot catch — shader compile errors (`THREE.WebGLProgram: Shader
 * Error`), uncaught exceptions, a boot that never reaches the first frame, or a modal that breaks the pointer-lock
 * contract. No extra dependencies: node ships a global WebSocket and Chromium is driven by raw CDP messages.
 *
 *   tsx scripts/smoke.ts                 # vite dev server on :5199, chromium from $CHROME or $PLAYWRIGHT_BROWSERS_PATH
 *   SMOKE_QUERY='life=0&post=0' tsx scripts/smoke.ts   # extra URL flags (defaults keep everything on for coverage)
 *   SMOKE_DIST=1 tsx scripts/smoke.ts    # serve dist/ with `vite preview` instead (run `npm run build` first)
 *
 * Writes smoke/screenshot.png and smoke/console.log; exits 1 on failure.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.SMOKE_PORT ?? 5199);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT ?? 9333);
const OUT = path.resolve('smoke');
const TIMEOUT_S = Number(process.env.SMOKE_TIMEOUT ?? 300);
const EXTRA = process.env.SMOKE_QUERY ? `&${process.env.SMOKE_QUERY}` : '';
const URL_ = `http://127.0.0.1:${PORT}/?auto=1&gpu=0&status=1${EXTRA}`;

const SHADER_ERR = /THREE\.WebGLProgram: Shader Error|THREE\.WebGLShader|Program Info Log|GL_INVALID|Uncaught/;

async function findChrome(): Promise<string> {
  if (process.env.CHROME) return process.env.CHROME;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.HOME ?? '', '.cache/ms-playwright'), '/opt/pw-browsers'].filter(Boolean) as string[];
  for (const root of roots) {
    let names: string[];
    try { names = await readdir(root); } catch { continue; }
    for (const n of names.filter(n => n.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(root, n, rel);
        try { await stat(p); return p; } catch { /* next */ }
      }
    }
  }
  for (const c of ['google-chrome', 'chromium', 'chromium-browser']) {
    const ok = await new Promise<boolean>(r => { const p = spawn('sh', ['-c', `command -v ${c}`]); p.on('exit', code => r(code === 0)); p.on('error', () => r(false)); });
    if (ok) return c;
  }
  throw new Error('no Chromium found: set CHROME=/path/to/chrome');
}

async function waitHttp(url: string, seconds: number) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`${url} did not come up in ${seconds}s`);
}

/** Minimal CDP client over one page target. */
class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly events: ((method: string, params: any) => void)[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', ev => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
      else for (const h of this.events) h(m.method, m.params);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', () => rej(new Error('CDP websocket failed'))); });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  /** Runtime.evaluate with awaitPromise; throws on an exception in the page. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  close() { this.ws.close(); }
}

/** `npx vite` and Chromium both fork: kill the whole process group (they are spawned detached) or the run never exits. */
function kill(p: ChildProcess | undefined) { if (p?.pid) { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch { /* gone */ } } } }

async function main() {
  await mkdir(OUT, { recursive: true });
  const log: string[] = [];
  const failures: string[] = [];
  const note = (s: string) => { console.log(s); log.push(s); };

  const serverArgs = process.env.SMOKE_DIST ? ['vite', 'preview', '--port', String(PORT), '--strictPort'] : ['vite', '--port', String(PORT), '--strictPort'];
  const server = spawn('npx', serverArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  server.stdout?.on('data', d => log.push(`[vite] ${String(d).trim()}`));
  server.stderr?.on('data', d => log.push(`[vite:err] ${String(d).trim()}`));
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    await waitHttp(`http://127.0.0.1:${PORT}/`, 60);
    const bin = await findChrome();
    note(`chromium: ${bin}`);
    const profile = path.join(OUT, 'profile');
    chrome = spawn(bin, [
      '--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-gpu-sandbox',
      '--disable-dev-shm-usage', '--window-size=1280,720', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    chrome.stderr?.on('data', d => log.push(`[chrome] ${String(d).trim()}`));
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30);
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('no page target');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Page.enable');
    cdp.events.push((method, params) => {
      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args as { value?: unknown; description?: string }[]).map(a => a.value !== undefined ? String(a.value) : a.description ?? '').join(' ');
        log.push(`[console.${params.type}] ${text}`);
        if (params.type === 'error' && SHADER_ERR.test(text)) failures.push(`console.error: ${text.slice(0, 400)}`);
      } else if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails;
        const text = d.exception?.description ?? d.text;
        log.push(`[exception] ${text}`);
        failures.push(`uncaught exception: ${String(text).slice(0, 400)}`);
      } else if (method === 'Log.entryAdded') {
        const e = params.entry;
        log.push(`[log.${e.level}] ${e.text}${e.url ? ` (${e.url})` : ''}`);
        if (e.level === 'error' && SHADER_ERR.test(e.text)) failures.push(`log: ${e.text.slice(0, 400)}`);
      }
    });
    note(`open ${URL_}`);
    await cdp.send('Page.navigate', { url: URL_ });

    // boot: window.app exists and the world has a manifest
    const t0 = Date.now();
    const deadline = t0 + TIMEOUT_S * 1000;
    let booted = false;
    while (Date.now() < deadline) {
      booted = await cdp.eval<boolean>('!!(window.app && window.app.world && window.app.world.manifest && window.app.player)').catch(() => false);
      if (booted) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!booted) failures.push(`boot did not finish in ${TIMEOUT_S}s`);
    else {
      note(`booted after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      // stream every building chunk (SwiftShader: 1-2 min)
      let loaded = 0, total = 0;
      while (Date.now() < deadline) {
        [loaded, total] = await cdp.eval<[number, number]>('[window.app?.world?.buildings?.loadedCount ?? 0, window.app?.world?.buildings?.chunks?.size ?? 0]');
        if (total > 0 && loaded >= total) break;
        await new Promise(r => setTimeout(r, 2000));
      }
      note(`chunks ${loaded}/${total} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (total === 0 || loaded < total) failures.push(`only ${loaded}/${total} chunks streamed in ${TIMEOUT_S}s`);
      // a few frames with everything resident, then the UI contract: a modal releases the pointer and closes cleanly
      await new Promise(r => setTimeout(r, 3000));
      const ui = await cdp.eval<string>(`(() => {
        const app = window.app;
        app.hud.markStarted();
        app.openModal('settings'); const a = app.modal;
        app.closeModal(false); const b = app.modal;
        app.openModal('places'); const c = app.modal; app.closeModal(false);
        app.toggleTimePanel(true); const d = app.hud.timePanelOpen; app.toggleTimePanel(false);
        return JSON.stringify({ a, b, c, d, pending: app.world.pending, status: app.hud.statusText ?? null });
      })()`).catch(e => `error: ${e.message}`);
      note(`ui: ${ui}`);
      if (!ui.includes('"a":"settings"') || !ui.includes('"b":null') || !ui.includes('"c":"places"') || !ui.includes('"d":true')) failures.push(`modal contract broken: ${ui}`);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(OUT, 'screenshot.png'), Buffer.from(shot.data, 'base64'));
      note(`screenshot: ${path.join(OUT, 'screenshot.png')}`);
    }
  } catch (e) {
    failures.push(`smoke harness: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    cdp?.close();
    kill(chrome); kill(server);
    await writeFile(path.join(OUT, 'console.log'), log.join('\n') + '\n');
  }
  if (failures.length) { console.error(`\nSMOKE FAILED (${failures.length}):\n - ${failures.join('\n - ')}\n(see smoke/console.log)`); process.exit(1); }
  console.log('\nSMOKE OK');
  process.exit(0);   // the killed children may still hold the event loop for a moment
}

void main();
