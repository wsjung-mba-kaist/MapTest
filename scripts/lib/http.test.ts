import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CACHE_DIR } from '../config.ts';
import { cachedBytes, exists, fetchRetry, writeJson } from './http.ts';

// fetchRetry resolves the global fetch at call time, so swapping globalThis.fetch per test drives it offline.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Answer the n-th call with the n-th status (the last one repeats). */
function stub(statuses: number[]): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    const status = statuses[Math.min(state.calls, statuses.length - 1)];
    state.calls++;
    return new Response(`body ${status}`, { status });
  }) as typeof fetch;
  return state;
}

test('a 404 is not retried: one fetch, then the error', async () => {
  const s = stub([404]);
  await assert.rejects(fetchRetry('http://x/missing', { retries: 3, backoffMs: [0] }), /HTTP 404/);
  assert.equal(s.calls, 1);
});

test('a 400 fails at once by default but is retried when listed in retryOn (IGN WMS bursts)', async () => {
  let s = stub([400, 200]);
  await assert.rejects(fetchRetry('http://x/wms', { retries: 3, backoffMs: [0] }), /HTTP 400/);
  assert.equal(s.calls, 1);
  s = stub([400, 400, 200]);
  const res = await fetchRetry('http://x/wms', { retries: 3, backoffMs: [0], retryOn: [400] });
  assert.equal(res.status, 200);
  assert.equal(s.calls, 3);
});

test('retryOn does not turn other 4xx into retries', async () => {
  const s = stub([404]);
  await assert.rejects(fetchRetry('http://x/missing', { retries: 3, backoffMs: [0], retryOn: [400] }), /HTTP 404/);
  assert.equal(s.calls, 1);
});

test('a 500 is retried and the following 200 succeeds', async () => {
  const s = stub([500, 200]);
  const reasons: string[] = [];
  const res = await fetchRetry('http://x/flaky', { retries: 3, backoffMs: [0], onRetry: (_n, r) => reasons.push(r) });
  assert.equal(res.status, 200);
  assert.equal(s.calls, 2);
  assert.deepEqual(reasons, ['HTTP 500']);
});

test('a 429 is retried until the budget runs out', async () => {
  const s = stub([429]);
  await assert.rejects(fetchRetry('http://x/busy', { retries: 2, backoffMs: [0] }), /HTTP 429/);
  assert.equal(s.calls, 3);
});

test('a network error is retried and the last one is thrown', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new TypeError('fetch failed'); }) as typeof fetch;
  await assert.rejects(fetchRetry('http://x/down', { retries: 2, backoffMs: [0] }), /fetch failed/);
  assert.equal(calls, 3);
});

test('writeJson lands atomically: content round-trips and no .part is left behind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-test-'));
  try {
    const file = path.join(dir, 'nested', 'out.json');
    await writeJson(file, { a: 1, b: [2, 3] });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 1, b: [2, 3] });
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['out.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// cachedBytes writes under the real cache/ (config.ts fixes CACHE_DIR), so each test uses its own throw-away subfolder.
const testRel = (name: string) => `test-http-${process.pid}/${name}`;
const rmTestCache = () => fs.rm(path.join(CACHE_DIR, `test-http-${process.pid}`), { recursive: true, force: true });

test('cachedBytes: a rejected validate throws its reason and caches nothing', async () => {
  globalThis.fetch = (async () => new Response('<ServiceExceptionReport/>', { status: 200 })) as typeof fetch;
  const rel = testRel('bad.bin');
  try {
    await assert.rejects(cachedBytes('http://x/bil', rel, { validate: b => b.length === 16 ? true : `unexpected ${b.length} bytes` }), /unexpected 25 bytes/);
    assert.equal(await exists(path.join(CACHE_DIR, rel)), false);
    assert.equal(await exists(path.join(CACHE_DIR, rel + '.part')), false);
  } finally { await rmTestCache(); }
});

test('cachedBytes: an accepted validate caches the bytes and the second call reads them without fetching', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(Buffer.alloc(16, 7), { status: 200 }); }) as typeof fetch;
  const rel = testRel('good.bin');
  try {
    const a = await cachedBytes('http://x/bil', rel, { validate: b => b.length === 16 ? true : 'short' });
    const b = await cachedBytes('http://x/bil', rel, { validate: () => 'would reject, but the cache is not re-validated' });
    assert.equal(a.length, 16); assert.ok(a.equals(b));
    assert.equal(calls, 1);
    assert.equal(await exists(path.join(CACHE_DIR, rel + '.part')), false);
  } finally { await rmTestCache(); }
});
