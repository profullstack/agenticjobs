import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { fetchText, FetchProblem } from '../src/directory/fetch.ts';

// Headers arrive immediately, but the body remains open. No external requests.
function delayedBody(t: TestContext, delayMs: number) {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const signal = init.signal!;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => {
            clearTimeout(timer);
            controller.error(new DOMException('Aborted', 'AbortError'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            controller.enqueue(new TextEncoder().encode('complete'));
            controller.close();
          }, delayMs);
          signal.addEventListener('abort', abort, { once: true });
          t.after(() => clearTimeout(timer));
        },
      }),
    );
  });
}

test('the timeout covers reading the body after headers arrive', async (t) => {
  delayedBody(t, 200);
  await assert.rejects(
    fetchText('https://example.com', { timeoutMs: 20, allowPrivate: true }),
    (error: unknown) => error instanceof FetchProblem && /timed out/.test(error.message),
  );
});

test('caller cancellation still interrupts an in-progress body', async (t) => {
  delayedBody(t, 200);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    fetchText('https://example.com', {
      timeoutMs: 1000,
      signal: controller.signal,
      allowPrivate: true,
    }),
    FetchProblem,
  );
});

test('a body completed before the deadline is returned', async (t) => {
  delayedBody(t, 5);
  assert.equal(
    await fetchText('https://example.com', { timeoutMs: 1000, allowPrivate: true }),
    'complete',
  );
});
