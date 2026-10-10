import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMessage } from '../src/mcp/server.ts';
import type { Caller } from '../src/mcp/tools.ts';

const info = { name: 'notification-test', version: '0' };
const caller: Caller = {
  server: 'https://board.invalid',
  authenticated: false,
  call: async () => {
    throw new Error('A list notification should not call the API.');
  },
};

test('known methods do not reply to messages without an id', async () => {
  for (const method of ['tools/list', 'resources/list', 'prompts/list', 'initialize']) {
    const response = await handleMessage({ jsonrpc: '2.0', method }, caller, info);
    assert.equal(response === null, true, `${method} replied to a notification`);
  }
});

test('an invalid tools/call notification produces no error response', async () => {
  const response = await handleMessage(
    { jsonrpc: '2.0', method: 'tools/call', params: {} },
    caller,
    info,
  );
  assert.equal(response, null);
});

test('a tool notification still dispatches exactly once without replying', async () => {
  const calls: unknown[] = [];
  const toolCaller: Caller = {
    ...caller,
    call: async (method, path) => {
      calls.push({ method, path });
      return { status: 200, body: { items: [], total: 0 } };
    },
  };
  const response = await handleMessage(
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'search_jobs' } },
    toolCaller,
    info,
  );
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/v1/jobs' }]);
  assert.equal(response === null, true, 'the tool result was returned to a notification');
});

test('a failing tool notification produces no internal error response', async () => {
  const response = await handleMessage(
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'search_jobs' } },
    caller,
    info,
  );
  assert.equal(response, null);
});

test('a request with a numeric zero id receives the tool list', async () => {
  const response = await handleMessage(
    { jsonrpc: '2.0', id: 0, method: 'tools/list' },
    caller,
    info,
  );
  assert.equal(response?.id, 0);
  assert.ok(Array.isArray((response?.result as { tools: unknown[] }).tools));
});

test('a request with a string id retains its dispatched tool result', async () => {
  const calls: unknown[] = [];
  const body = { items: [], total: 0 };
  const toolCaller: Caller = {
    ...caller,
    call: async (method, path) => {
      calls.push({ method, path });
      return { status: 200, body };
    },
  };
  const response = await handleMessage(
    { jsonrpc: '2.0', id: 'request-1', method: 'tools/call', params: { name: 'search_jobs' } },
    toolCaller,
    info,
  );
  assert.equal(response?.id, 'request-1');
  assert.deepEqual((response?.result as { structuredContent: unknown }).structuredContent, body);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/v1/jobs' }]);
});

test('a failing tool request retains its id and internal error response', async () => {
  const response = await handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_jobs' } },
    caller,
    info,
  );
  assert.equal(response?.id, 3);
  assert.equal(response?.error?.code, -32603);
});

test('standard, ping and unknown notifications remain silent', async () => {
  for (const method of [
    'notifications/initialized',
    'notifications/cancelled',
    'ping',
    'unknown',
  ]) {
    assert.equal(await handleMessage({ jsonrpc: '2.0', method }, caller, info), null);
  }
});
