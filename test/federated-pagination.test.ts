import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { federatedSearch, targetsFromUrls } from '../dist/directory/federate.js';
import { EMPTY_QUERY } from '../dist/schema/query.js';

function board(t: TestContext, pages: Record<string, number[]>) {
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push(url);
    const ranks = pages[url.origin];
    assert.ok(ranks, 'only fixture boards are queried');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const items = ranks.slice(offset, offset + limit).map((rank) => ({
      slug: `job-${rank}`,
      title: `Job ${rank}`,
      publishedAt: new Date(Date.UTC(2026, 0, 1) - rank * 1000).toISOString(),
    }));
    return Response.json({ items, total: ranks.length });
  });
  return { targets: targetsFromUrls(Object.keys(pages)), requests };
}

test('a second directory page includes jobs beyond the first upstream page', async (t) => {
  const { targets } = board(t, { 'https://first.example': [1, 2, 3, 4, 5] });
  const result = await federatedSearch(targets, { ...EMPTY_QUERY, limit: 2, offset: 2 });
  assert.deepEqual(
    result.jobs.map(({ job }) => job.slug),
    ['job-3', 'job-4'],
  );
  assert.equal(result.total, 5);
  assert.equal(result.sources[0]?.ok, true);
});

test('directory pagination merges enough jobs even when one board has the newest results', async (t) => {
  const { targets } = board(t, {
    'https://first.example': [1, 2, 3, 4],
    'https://second.example': [5, 6],
  });
  const slugs: string[] = [];
  for (const offset of [0, 2, 4]) {
    const result = await federatedSearch(targets, { ...EMPTY_QUERY, limit: 2, offset });
    slugs.push(...result.jobs.map(({ job }) => job.slug));
    assert.equal(result.total, 6);
  }
  assert.deepEqual(slugs, ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']);
});

test('an explicit per-instance cap still bounds the collected window', async (t) => {
  const { targets, requests } = board(t, { 'https://first.example': [1, 2, 3, 4] });
  const result = await federatedSearch(
    targets,
    { ...EMPTY_QUERY, limit: 2, offset: 1 },
    { perInstance: 2 },
  );
  assert.deepEqual(
    result.jobs.map(({ job }) => job.slug),
    ['job-2'],
  );
  assert.equal(result.total, 4);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.searchParams.get('limit'), '2');
});

test('a large offset does not exceed the existing 100-job upstream request cap', async (t) => {
  const { targets, requests } = board(t, { 'https://first.example': [1, 2] });
  await federatedSearch(targets, { ...EMPTY_QUERY, limit: 75, offset: 50 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.searchParams.get('limit'), '100');
  assert.equal(Number(requests[0]?.searchParams.get('offset') ?? 0), 0);
});
