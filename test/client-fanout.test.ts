import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchEverywhere } from '../dist/client/fanout.js';

test('a failed board does not leave partial hits in the combined result', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    return Response.json(url.hostname === 'broken.test'
      ? { items: [{ slug: 'partial', createdAt: '2026-01-02' }, null], total: 2 }
      : { items: [{ slug: 'good', createdAt: '2026-01-01' }], total: 1 });
  });
  const result = await searchEverywhere([
    { server: 'https://broken.test', token: null },
    { server: 'https://healthy.test', token: null },
  ], {});
  assert.deepEqual(result.jobs.map(hit => hit.job.slug), ['good']);
  assert.equal(result.total, 1);
  assert.equal(result.sources[0]?.ok, false);
  assert.equal(result.sources[0]?.count, 0);
  assert.ok(result.sources[0]?.error);
  assert.equal(result.sources[1]?.ok, true);
});

test('an invalid page total fails only that board rather than corrupting the combined total', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    return Response.json(url.hostname === 'broken.test'
      ? { items: [], total: '2' }
      : { items: [], total: 1 });
  });
  const result = await searchEverywhere([
    { server: 'https://broken.test', token: null },
    { server: 'https://healthy.test', token: null },
  ], {});
  assert.equal(result.total, 1);
  assert.equal(result.sources[0]?.ok, false);
  assert.equal(result.sources[1]?.ok, true);
});
