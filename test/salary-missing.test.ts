import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchEverywhere } from '../dist/client/fanout.js';
import { federatedSearch, targetsFromUrls } from '../dist/directory/federate.js';
import { EMPTY_QUERY } from '../dist/schema/query.js';

for (const surface of ['configured', 'directory'] as const) {
  for (const salary of [undefined, null]) {
    test(`${surface} salary search retains results when a listing has ${salary} salary metadata`, async (t) => {
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const job =
          url.hostname === 'older.example'
            ? { slug: 'no-salary', title: 'No stated salary', salary, createdAt: '2026-01-02' }
            : {
                slug: 'paid',
                title: 'Paid role',
                createdAt: '2026-01-01',
                salary: { min: 50, max: null, period: 'hour', currency: 'USD', unpaid: false },
              };
        return Response.json({ items: [job], total: 1, limit: 25, offset: 0 });
      });
      const urls = ['https://older.example', 'https://healthy.example'];
      const query = { ...EMPTY_QUERY, sort: 'salary' as const };
      const result =
        surface === 'configured'
          ? await searchEverywhere(
              urls.map((server) => ({ server, token: null })),
              query,
            )
          : await federatedSearch(targetsFromUrls(urls), query);
      assert.deepEqual(
        result.jobs.map((hit) => hit.job.slug),
        ['paid', 'no-salary'],
      );
      assert.equal(result.total, 2);
      assert.ok(result.sources.every((source) => source.ok));
    });
  }
}
