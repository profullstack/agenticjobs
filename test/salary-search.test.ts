import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchEverywhere } from '../dist/client/fanout.js';
import { federatedSearch, targetsFromUrls } from '../dist/directory/federate.js';
import { EMPTY_QUERY } from '../dist/schema/query.js';
import type { Job, Salary } from '../src/schema/job.ts';

function job(slug: string, salary: Partial<Salary>, publishedAt: string): Job {
  return {
    id: slug,
    slug,
    title: slug,
    description: 'A salary search fixture.',
    org: {
      id: 'org',
      slug: 'org',
      name: 'Employer',
      website: null,
      logoUrl: null,
      description: null,
      createdAt: publishedAt,
    },
    employmentType: 'full-time',
    workplace: 'remote',
    seniority: null,
    location: null,
    remoteRegions: [],
    tags: [],
    stack: [],
    requirements: [],
    responsibilities: [],
    salary: {
      min: null,
      max: null,
      currency: 'USD',
      period: 'year',
      equity: null,
      unpaid: false,
      ...salary,
    },
    agentPolicy: 'welcome',
    apply: { via: 'board', schema: { fields: [] } },
    status: 'published',
    publishedAt,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    expiresAt: null,
  };
}

const HOSTS = ['https://first.example', 'https://second.example'];
const PAGES = [
  [
    job('hourly', { min: 100, period: 'hour' }, '2026-01-01T00:00:00Z'),
    job('unstated', {}, '2026-01-04T00:00:00Z'),
  ],
  [
    job('monthly', { max: 18_000, period: 'month' }, '2026-01-02T00:00:00Z'),
    job('yearly', { max: 200_000 }, '2026-01-03T00:00:00Z'),
  ],
];

for (const kind of ['directory', 'configured boards'] as const) {
  test(`${kind} merge salary-sorted pages using annual amounts`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(url.searchParams.get('sort'), 'salary');
      const items = PAGES[HOSTS.indexOf(url.origin)];
      assert.ok(items, 'only the two fixture boards are queried');
      return new Response(JSON.stringify({ items, total: items.length, limit: 25, offset: 0 }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const query = { ...EMPTY_QUERY, sort: 'salary' as const };
    const result =
      kind === 'directory'
        ? await federatedSearch(targetsFromUrls(HOSTS), query)
        : await searchEverywhere(
            HOSTS.map((server) => ({ server, token: null })),
            query,
          );
    assert.deepEqual(
      result.jobs.map((entry) => entry.job.slug),
      ['monthly', 'hourly', 'yearly', 'unstated'],
    );
    assert.equal(
      result.sources.every((source) => source.ok),
      true,
    );
    assert.equal(result.total, 4);
  });
}
