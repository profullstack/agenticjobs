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

test('a configured-board search applies global pagination after merging boards', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const all = url.hostname === 'first.test'
      ? [
          { slug: 'first-new', createdAt: '2026-01-04' },
          { slug: 'first-old', createdAt: '2026-01-01' },
        ]
      : [
          { slug: 'second-new', createdAt: '2026-01-03' },
          { slug: 'second-old', createdAt: '2025-12-31' },
        ];
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 25);
    return Response.json({
      items: all.slice(offset, offset + limit),
      total: all.length,
    });
  });

  const result = await searchEverywhere(
    [
      { server: 'https://first.test', token: null },
      { server: 'https://second.test', token: null },
    ],
    { limit: 1, offset: 1 },
  );

  assert.deepEqual(result.jobs.map((hit) => hit.job.slug), ['second-new']);
  assert.equal(result.total, 4);
});

test('a single board receives a bounded prefix for a nonzero global offset', async (t) => {
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    const all = Array.from({ length: 5 }, (_, index) => ({
      slug: `job-${index + 1}`,
      createdAt: `2026-01-0${5 - index}`,
    }));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 25);
    return Response.json({ items: all.slice(offset, offset + limit), total: all.length });
  });

  const result = await searchEverywhere(
    [{ server: 'https://board.test', token: null }],
    { limit: 2, offset: 2 },
  );

  assert.deepEqual(result.jobs.map((hit) => hit.job.slug), ['job-3', 'job-4']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.searchParams.get('limit'), '4');
  assert.equal(requests[0]?.searchParams.get('offset') ?? '0', '0');
});

test('fanout uses the shared default page size after merging boards', async (t) => {
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const all = Array.from({ length: 30 }, (_, index) => ({
      slug: `${url.hostname}-job-${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
    }));
    return Response.json({ items: all.slice(0, limit), total: all.length });
  });

  const result = await searchEverywhere([
    { server: 'https://first.test', token: null },
    { server: 'https://second.test', token: null },
  ], {});

  assert.equal(result.jobs.length, 25);
  assert.deepEqual(requests.map((url) => url.searchParams.get('limit') ?? '25'), ['25', '25']);
});

test('fanout pagination never asks a board for more than 100 rows', async (t) => {
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const all = Array.from({ length: 250 }, (_, index) => ({
      slug: `job-${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
    }));
    return Response.json({ items: all.slice(offset, offset + limit), total: all.length });
  });

  const result = await searchEverywhere(
    [{ server: 'https://board.test', token: null }],
    { limit: 20, offset: 100 },
  );

  assert.equal(result.jobs.length, 20);
  assert.ok(requests.every((url) => Number(url.searchParams.get('limit')) <= 100));
  assert.deepEqual(
    requests.map((url) => [
      url.searchParams.get('offset') ?? '0',
      url.searchParams.get('limit'),
    ]),
    [['0', '100'], ['100', '20']],
  );
});

test('a fanout source shares one timeout budget across its paginated requests', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'slow.test') now += 6;
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const all = Array.from({ length: 150 }, (_, index) => ({
      slug: `${url.hostname}-job-${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
    }));
    return Response.json({ items: all.slice(offset, offset + limit), total: all.length });
  });

  const result = await searchEverywhere(
    [
      { server: 'https://slow.test', token: null },
      { server: 'https://fast.test', token: null },
    ],
    { limit: 20, offset: 100 },
    { timeoutMs: 10 },
  );

  assert.equal(result.sources[0]?.ok, false);
  assert.equal(result.sources[1]?.ok, true);
  assert.equal(result.jobs.every((hit) => hit.server === 'https://fast.test'), true);
});
