import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRetry } from './http.ts';

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
