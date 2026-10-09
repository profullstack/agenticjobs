import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchEverywhere } from '../dist/client/fanout.js';

test('fanout does not restart an exhausted board timeout budget', async (t) => {
  let slowCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).hostname === 'healthy.test') {
      return Response.json({ items: [{ slug: 'healthy-job', createdAt: '2026-01-01' }], total: 1 });
    }
    slowCalls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  });

  const result = await searchEverywhere(
    [
      { server: 'https://slow.test', token: null },
      { server: 'https://healthy.test', token: null },
    ],
    {},
    { timeoutMs: 1_000 },
  );

  assert.equal(slowCalls, 1, 'a timed-out board must not receive a new full timeout budget');
  assert.equal(result.sources[0]?.ok, false);
  assert.match(result.sources[0]?.error ?? '', /did not answer in time/);
  assert.equal(result.sources[1]?.ok, true);
  assert.deepEqual(
    result.jobs.map((hit) => hit.job.slug),
    ['healthy-job'],
  );
  assert.equal(result.total, 1);
});
