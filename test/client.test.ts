/**
 * The shared HTTP client.
 *
 * Two things here were easy to get wrong and expensive when they were:
 * treating the first timeout as a dead board, and reporting every success as
 * HTTP 200 so MCP tools that expect 201 rejected a write that had already
 * landed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, BoardClient } from '../dist/client/client.js';

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('a GET that times out once is retried, and the second answer is kept', async () => {
  let calls = 0;
  const client = new BoardClient('https://board.test', {
    timeoutMs: 20,
    fetch: async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      }
      return jsonResponse(200, { ok: true, calls });
    },
  });

  const body = await client.applySchema('a-role');
  assert.equal(calls, 2);
  assert.deepEqual(body, { ok: true, calls: 2 });
});

test('a POST that times out is not retried, because the write may have landed', async () => {
  let calls = 0;
  const client = new BoardClient('https://board.test', {
    timeoutMs: 20,
    fetch: async (_url, init) => {
      calls += 1;
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    },
  });

  await assert.rejects(
    () => client.apply('a-role', { name: 'Ada' }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'timeout');
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('requestWithStatus keeps a 201, so the stdio MCP host can tell a create from a read', async () => {
  const client = new BoardClient('https://board.test', {
    fetch: async () => jsonResponse(201, { applicationId: 'app-1' }),
  });

  const result = await client.requestWithStatus('POST', '/api/v1/jobs/a-role/apply', {
    name: 'Ada',
  });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { applicationId: 'app-1' });
});

for (const scenario of [
  { label: 'HTML with HTTP 200', method: 'GET', status: 200, body: '<html>Maintenance</html>' },
  { label: 'truncated JSON with HTTP 200', method: 'GET', status: 200, body: '{"items":[' },
  { label: 'truncated JSON with HTTP 201', method: 'POST', status: 201, body: '{"applicationId":' },
] as const) {
  test(`the client rejects ${scenario.label} without repeating the request`, async () => {
    let calls = 0;
    const client = new BoardClient('https://board.test', {
      fetch: async () => {
        calls += 1;
        return new Response(scenario.body, { status: scenario.status });
      },
    });

    await assert.rejects(
      () => client.requestWithStatus(scenario.method, '/api/v1/jobs'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError, 'a malformed response must not become a null success');
        assert.equal(error.status, scenario.status);
        assert.match(error.message, /not JSON/);
        assert.match(error.message, /https:\/\/board\.test/);
        return true;
      },
    );
    assert.equal(calls, 1, 'a parse failure is not a timeout, and a write may have landed');
  });
}

test('an empty 204 response remains a successful delete', async () => {
  const client = new BoardClient('https://board.test', {
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.deepEqual(await client.requestWithStatus('DELETE', '/api/v1/orgs/acme'), {
    status: 204,
    body: null,
  });
});

test('a JSON API error retains its status, code and field details', async () => {
  const fields = [{ field: 'title', message: 'A title is required.' }];
  const client = new BoardClient('https://board.test', {
    fetch: async () =>
      jsonResponse(422, {
        error: { message: 'Invalid listing.', code: 'invalid_job', fields },
      }),
  });
  await assert.rejects(
    () => client.request('POST', '/api/v1/jobs', {}),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'invalid_job');
      assert.equal(error.message, 'Invalid listing.');
      assert.deepEqual(error.fields, fields);
      return true;
    },
  );
});
