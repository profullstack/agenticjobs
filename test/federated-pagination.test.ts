import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { federatedSearch, targetsFromUrls } from '../dist/directory/federate.js';
import { EMPTY_QUERY } from '../dist/schema/query.js';

type Page = { items: unknown[]; total?: number };
type Handler = (url: URL, requestNumber: number) => Page | Response | Promise<Page | Response>;

function installFetch(t: TestContext, handlers: Record<string, Handler>) {
  const requests: URL[] = [];
  const counts = new Map<string, number>();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push(url);
    const handler = handlers[url.origin];
    assert.ok(handler, `unexpected board ${url.origin}`);
    const requestNumber = (counts.get(url.origin) ?? 0) + 1;
    counts.set(url.origin, requestNumber);
    const result = await handler(url, requestNumber);
    return result instanceof Response ? result : Response.json(result);
  });
  return requests;
}

function rows(start: number, count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => {
    const id = start + index;
    return {
      slug: `job-${id}`,
      title: `Job ${id}`,
      publishedAt: new Date(Date.UTC(2026, 0, 1) - id * 1000).toISOString(),
    };
  });
}

function offsetOf(url: URL): number {
  return Number(url.searchParams.get('offset') ?? 0);
}

function limitOf(url: URL): number {
  return Number(url.searchParams.get('limit') ?? EMPTY_QUERY.limit);
}

test('a second directory page includes jobs beyond the first upstream page', async (t) => {
  const all = rows(1, 5);
  installFetch(t, {
    'https://first.example': (url) => ({
      items: all.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: all.length,
    }),
  });
  const result = await federatedSearch(
    targetsFromUrls(['https://first.example']),
    {
      ...EMPTY_QUERY,
      limit: 2,
      offset: 2,
    },
    { allowPrivate: true },
  );
  assert.deepEqual(
    result.jobs.map(({ job }) => job.slug),
    ['job-3', 'job-4'],
  );
  assert.equal(result.total, 5);
  assert.equal(result.sources[0]?.ok, true);
});

test('directory pagination merges enough jobs when boards have different result counts', async (t) => {
  const first = rows(1, 4);
  const second = rows(5, 2);
  installFetch(t, {
    'https://first.example': (url) => ({
      items: first.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: first.length,
    }),
    'https://second.example': (url) => ({
      items: second.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: second.length,
    }),
  });
  const slugs: string[] = [];
  for (const offset of [0, 2, 4]) {
    const result = await federatedSearch(
      targetsFromUrls(['https://first.example', 'https://second.example']),
      { ...EMPTY_QUERY, limit: 2, offset },
      { allowPrivate: true },
    );
    slugs.push(...result.jobs.map(({ job }) => job.slug));
    assert.equal(result.total, 6);
  }
  assert.deepEqual(slugs, ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']);
});

test('an explicit per-instance cap bounds the collected window', async (t) => {
  const all = rows(1, 4);
  const requests = installFetch(t, {
    'https://first.example': (url) => ({
      items: all.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: all.length,
    }),
  });
  const result = await federatedSearch(
    targetsFromUrls(['https://first.example']),
    { ...EMPTY_QUERY, limit: 2, offset: 1 },
    { allowPrivate: true, perInstance: 2 },
  );
  assert.deepEqual(
    result.jobs.map(({ job }) => job.slug),
    ['job-2'],
  );
  assert.equal(result.total, 4);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.searchParams.get('limit'), '2');
});

test('a large offset never exceeds the existing 100-row upstream request cap', async (t) => {
  const all = rows(1, 2);
  const requests = installFetch(t, {
    'https://first.example': (url) => ({ items: all, total: all.length }),
  });
  await federatedSearch(
    targetsFromUrls(['https://first.example']),
    {
      ...EMPTY_QUERY,
      limit: 75,
      offset: 50,
    },
    { allowPrivate: true },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.searchParams.get('limit'), '100');
  assert.equal(offsetOf(requests[0]!), 0);
});

test('fetches past the first 100 upstream rows for a large directory offset', async (t) => {
  const all = rows(0, 250);
  const requests = installFetch(t, {
    'https://board.example': (url) => ({
      items: all.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: all.length,
    }),
  });

  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    {
      ...EMPTY_QUERY,
      limit: 20,
      offset: 100,
    },
    { allowPrivate: true },
  );

  assert.deepEqual(
    result.jobs.map(({ job }) => job.slug),
    Array.from({ length: 20 }, (_, index) => `job-${100 + index}`),
  );
  assert.deepEqual(
    requests.map((url) => [offsetOf(url), limitOf(url)]),
    [
      [0, 100],
      [100, 20],
    ],
  );
  assert.equal(result.total, 250);
  assert.equal(result.sources[0]?.count, 120);
});

test('advances independent offsets across two very differently sized boards', async (t) => {
  const first = rows(0, 235);
  const second = rows(1000, 13);
  const requests = installFetch(t, {
    'https://large.example': (url) => ({
      items: first.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: first.length,
    }),
    'https://small.example': (url) => ({
      items: second.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: second.length,
    }),
  });

  const result = await federatedSearch(
    targetsFromUrls(['https://large.example', 'https://small.example']),
    { ...EMPTY_QUERY, limit: 50, offset: 100 },
    { allowPrivate: true },
  );

  assert.deepEqual(
    result.jobs.map(({ job }) => job.slug),
    Array.from({ length: 50 }, (_, index) => `job-${100 + index}`),
  );
  assert.deepEqual(
    requests
      .filter((url) => url.origin === 'https://large.example')
      .map((url) => [offsetOf(url), limitOf(url)]),
    [
      [0, 100],
      [100, 50],
    ],
  );
  assert.deepEqual(
    requests
      .filter((url) => url.origin === 'https://small.example')
      .map((url) => [offsetOf(url), limitOf(url)]),
    [[0, 100]],
  );
  assert.equal(result.total, 248);
  assert.equal(
    result.sources.every((source) => source.ok),
    true,
  );
});

test('an explicit per-instance cap remains cumulative and is still limited to one page', async (t) => {
  const all = rows(0, 150);
  const requests = installFetch(t, {
    'https://board.example': (url) => ({
      items: all.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: all.length,
    }),
  });

  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    { ...EMPTY_QUERY, limit: 20, offset: 0 },
    { allowPrivate: true, perInstance: 75 },
  );

  assert.equal(result.jobs.length, 20);
  assert.equal(result.sources[0]?.count, 75);
  assert.deepEqual(
    requests.map((url) => [offsetOf(url), limitOf(url)]),
    [[0, 75]],
  );
});

test('a 75-row page crossing the upstream boundary returns rows 75 through 124', async (t) => {
  const all = rows(0, 150);
  const requests = installFetch(t, {
    'https://board.example': (url) => ({
      items: all.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: all.length,
    }),
  });
  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    {
      ...EMPTY_QUERY,
      limit: 50,
      offset: 75,
    },
    { allowPrivate: true },
  );
  assert.deepEqual(
    result.jobs.map(({ job }) => job.slug),
    Array.from({ length: 50 }, (_, index) => `job-${75 + index}`),
  );
  assert.deepEqual(
    requests.map((url) => [offsetOf(url), limitOf(url)]),
    [
      [0, 100],
      [100, 25],
    ],
  );
});

test('an explicit per-instance cap above 100 still stops at 100 rows', async (t) => {
  const all = rows(0, 150);
  const requests = installFetch(t, {
    'https://board.example': (url) => ({
      items: all.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: all.length,
    }),
  });
  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    { ...EMPTY_QUERY, limit: 10, offset: 0 },
    { allowPrivate: true, perInstance: 200 },
  );
  assert.equal(result.sources[0]?.count, 100);
  assert.deepEqual(
    requests.map((url) => [offsetOf(url), limitOf(url)]),
    [[0, 100]],
  );
});

test('continues after a short nonterminal page and stops at an empty terminal page', async (t) => {
  const firstFour = rows(0, 4);
  const requests = installFetch(t, {
    'https://board.example': (url) => ({
      items: offsetOf(url) === 0 ? firstFour : [],
      total: 5,
    }),
  });

  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    {
      ...EMPTY_QUERY,
      limit: 20,
      offset: 0,
    },
    { allowPrivate: true },
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(offsetOf), [0, 4]);
  assert.equal(result.sources[0]?.ok, true);
  assert.equal(result.sources[0]?.count, 4);
  assert.equal(result.total, 5);
});

test('stops early when the reported source total is reached', async (t) => {
  const all = rows(0, 3);
  const requests = installFetch(t, {
    'https://board.example': (url) => ({ items: all, total: all.length }),
  });

  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    {
      ...EMPTY_QUERY,
      limit: 20,
      offset: 0,
    },
    { allowPrivate: true },
  );

  assert.equal(requests.length, 1);
  assert.equal(result.sources[0]?.ok, true);
  assert.equal(result.sources[0]?.total, 3);
});

test('uses raw item counts to advance offsets even when a row is malformed', async (t) => {
  const requests = installFetch(t, {
    'https://board.example': (url) =>
      offsetOf(url) === 0
        ? { items: [{ slug: 42, title: 'bad row' }, ...rows(0, 1)], total: 3 }
        : { items: rows(1, 1), total: 3 },
  });

  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    {
      ...EMPTY_QUERY,
      limit: 3,
      offset: 0,
    },
    { allowPrivate: true },
  );

  assert.deepEqual(requests.map(offsetOf), [0, 2]);
  assert.deepEqual(
    result.jobs.map(({ job }) => job.slug),
    ['job-0', 'job-1'],
  );
});

test('discards a source that fails on page two but preserves another source', async (t) => {
  const healthy = rows(1000, 120);
  const requests = installFetch(t, {
    'https://broken.example': (url, requestNumber) =>
      requestNumber === 1
        ? { items: rows(0, 100), total: 150 }
        : new Response('unavailable', { status: 503 }),
    'https://healthy.example': (url) => ({
      items: healthy.slice(offsetOf(url), offsetOf(url) + limitOf(url)),
      total: healthy.length,
    }),
  });

  const result = await federatedSearch(
    targetsFromUrls(['https://broken.example', 'https://healthy.example']),
    { ...EMPTY_QUERY, limit: 25, offset: 100 },
    { allowPrivate: true },
  );

  const broken = result.sources.find((source) => source.instance === 'https://broken.example');
  const good = result.sources.find((source) => source.instance === 'https://healthy.example');
  assert.equal(broken?.ok, false);
  assert.equal(broken?.count, 0);
  assert.match(broken?.error ?? '', /503/);
  assert.equal(good?.ok, true);
  assert.deepEqual(
    requests
      .filter((url) => url.origin === 'https://healthy.example')
      .map((url) => [offsetOf(url), limitOf(url)]),
    [
      [0, 100],
      [100, 25],
    ],
  );
  assert.equal(good?.count, 120);
  assert.equal(result.total, 120);
  assert.deepEqual(
    result.jobs.map(({ job }) => job.slug),
    Array.from({ length: 20 }, (_, i) => `job-${1100 + i}`),
  );
  assert.equal(requests.filter((url) => url.origin === 'https://broken.example').length, 2);
});

test('shares one timeout budget across all pages of a source', async (t) => {
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const requests = installFetch(t, {
    'https://board.example': (url) => {
      clock += 8000;
      return { items: rows(0, 100), total: 150 };
    },
  });

  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    {
      ...EMPTY_QUERY,
      limit: 25,
      offset: 100,
    },
    { allowPrivate: true },
  );

  assert.equal(requests.length, 1);
  assert.equal(result.sources[0]?.ok, false);
  assert.match(result.sources[0]?.error ?? '', /timed out/);
  assert.equal(result.sources[0]?.count, 0);
});

test('fails a source if its final page completes after the shared time budget', async (t) => {
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const requests = installFetch(t, {
    'https://board.example': () => {
      clock += 8001;
      return { items: rows(0, 20), total: 20 };
    },
  });
  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    {
      ...EMPTY_QUERY,
      limit: 20,
      offset: 0,
    },
    { allowPrivate: true },
  );
  assert.equal(requests.length, 1);
  assert.equal(result.sources[0]?.ok, false);
  assert.equal(result.sources[0]?.count, 0);
  assert.equal(result.total, 0);
});

test('does not start another page after the caller aborts', async (t) => {
  const controller = new AbortController();
  const requests = installFetch(t, {
    'https://board.example': () => {
      controller.abort();
      return { items: rows(0, 100), total: 150 };
    },
  });

  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    { ...EMPTY_QUERY, limit: 25, offset: 100 },
    { allowPrivate: true, signal: controller.signal },
  );

  assert.equal(requests.length, 1);
  assert.equal(result.sources[0]?.ok, false);
  assert.match(result.sources[0]?.error ?? '', /cancelled/);
  assert.equal(result.sources[0]?.count, 0);
});

test('does not fetch any page when the caller is already aborted', async (t) => {
  const controller = new AbortController();
  controller.abort();
  const requests = installFetch(t, {
    'https://board.example': () => ({ items: rows(0, 1), total: 1 }),
  });
  const result = await federatedSearch(
    targetsFromUrls(['https://board.example']),
    { ...EMPTY_QUERY, limit: 10, offset: 0 },
    { allowPrivate: true, signal: controller.signal },
  );
  assert.equal(requests.length, 0);
  assert.equal(result.sources[0]?.ok, false);
  assert.match(result.sources[0]?.error ?? '', /cancelled/);
});

test('null, zero, and missing totals fall back to at least the raw rows received', async (t) => {
  const all = rows(0, 2);
  installFetch(t, {
    'https://null.example': () => ({ items: all, total: null }) as unknown as Page,
    'https://zero.example': () => ({ items: all, total: 0 }),
    'https://missing.example': () => ({ items: all }),
  });
  const result = await federatedSearch(
    targetsFromUrls(['https://null.example', 'https://zero.example', 'https://missing.example']),
    { ...EMPTY_QUERY, limit: 2, offset: 0 },
    { allowPrivate: true },
  );
  assert.deepEqual(
    result.sources.map((source) => source.total),
    [2, 2, 2],
  );
  assert.deepEqual(
    result.sources.map((source) => source.count),
    [2, 2, 2],
  );
  assert.equal(result.total, 6);
});
