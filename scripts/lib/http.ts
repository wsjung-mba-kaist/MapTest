import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { CACHE_DIR } from '../config.ts';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface FetchOpts {
  retries?: number;
  backoffMs?: number[];
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Called when a retryable failure happens (for logging). */
  onRetry?: (attempt: number, reason: string) => void;
}

const UA = 'paris-eiffel-walk-bake/0.1 (local open-data bake)';

export async function fetchRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const retries = opts.retries ?? 4;
  const backoff = opts.backoffMs ?? [3000, 10000, 30000, 90000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        body: opts.body,
        headers: { 'User-Agent': UA, ...(opts.headers ?? {}) },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      const text = (await res.text().catch(() => '')).slice(0, 300);
      lastErr = new Error(`HTTP ${res.status} for ${url}\n${text}`);
      if (!retryable || attempt === retries) throw lastErr;
      opts.onRetry?.(attempt + 1, `HTTP ${res.status}`);
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt === retries) throw e;
      opts.onRetry?.(attempt + 1, e instanceof Error ? e.message : String(e));
    }
    await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
  }
  throw lastErr;
}

export async function ensureDir(p: string) { await fs.mkdir(p, { recursive: true }); }

export async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Fetch bytes with a disk cache under cache/<rel>. */
export async function cachedBytes(url: string, rel: string, opts: FetchOpts = {}): Promise<Buffer> {
  const file = path.join(CACHE_DIR, rel);
  if (await exists(file)) return fs.readFile(file);
  const res = await fetchRetry(url, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  await ensureDir(path.dirname(file));
  await fs.writeFile(file + '.part', buf);
  await fs.rename(file + '.part', file);
  return buf;
}

export async function cachedText(url: string, rel: string, opts: FetchOpts = {}): Promise<string> {
  return (await cachedBytes(url, rel, opts)).toString('utf8');
}

export async function cachedJson<T = unknown>(url: string, rel: string, opts: FetchOpts = {}): Promise<T> {
  return JSON.parse(await cachedText(url, rel, opts)) as T;
}

export const limit = (n: number) => pLimit(n);

export async function writeJson(file: string, data: unknown) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data));
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
