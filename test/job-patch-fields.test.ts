import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchJob, type JobInput } from '../src/core/jobs.ts';
import { DEFAULT_APPLY_SCHEMA } from '../src/schema/job.ts';

function jobRow(): Record<string, unknown> {
  return {
    id: 'job-1',
    slug: 'backend-engineer',
    title: 'Backend Engineer',
    description: 'A description long enough to pass the minimum.',
    employment_type: 'full-time',
    workplace: 'remote',
    seniority: null,
    location: 'Berlin',
    remote_regions: ['EU'],
    salary_min: 100000,
    salary_max: 150000,
    salary_currency: 'USD',
    salary_period: 'year',
    salary_equity: null,
    salary_unpaid: false,
    pay_lines: [{ type: 'salary', min: 100000, max: 150000, currency: 'USD', unit: 'year' }],
    pay_method: 'bank transfer',
    tags: ['backend'],
    stack: ['postgres'],
    requirements: ['ships'],
    responsibilities: ['owns'],
    agent_policy: 'disclose',
    apply_via: 'board',
    apply_url: null,
    apply_source_url: null,
    apply_email: null,
    apply_schema: null,
    status: 'draft',
    published_at: null,
    expires_at: '2027-01-01T00:00:00.000Z',
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
    org_id: 'org-1',
    org_slug: 'example-works',
    org_name: 'Example Works',
    org_website: null,
    org_logo_url: null,
    org_description: null,
    org_created_at: '2026-09-24T00:00:00.000Z',
  };
}

function input(overrides: Partial<JobInput> = {}): JobInput {
  return {
    orgId: 'org-1',
    title: 'Renamed Listing',
    description: 'A replacement description that is long enough.',
    employmentType: 'contract',
    workplace: 'onsite',
    seniority: 'senior',
    location: 'Lisbon',
    remoteRegions: ['US', 'EU'],
    pay: { lines: [], method: null, equity: null, unpaid: true },
    tags: ['new-tag'],
    stack: ['typescript'],
    requirements: ['new req'],
    responsibilities: ['new resp'],
    agentPolicy: 'welcome',
    apply: { via: 'board', schema: DEFAULT_APPLY_SCHEMA },
    expiresAt: '2027-06-01T00:00:00.000Z',
    sourceUrl: null,
    ...overrides,
  };
}

/**
 * A pool that applies `update jobs` assignments to the row, the way Postgres
 * would, and serves the row back to the post-write read.
 */
function fakePool(job: Record<string, unknown>, queries: string[] = []) {
  return {
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      const update = /^update jobs set (.+) where id = \$1\s*$/s.exec(sql.trim());
      if (update === null) return { rows: [{ ...job }], rowCount: 1 };
      for (const [, column, parameter] of (update[1] ?? '').matchAll(/(\w+) = \$(\d+)/g)) {
        job[column as string] = params[Number(parameter) - 1];
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

function updateSql(queries: string[]): string {
  const found = queries.filter((sql) => sql.trim().startsWith('update jobs'));
  assert.equal(found.length, 1, 'expected exactly one update');
  return found[0] ?? '';
}

test('a partial patch writes only the columns that were sent', async () => {
  const job = jobRow();
  const queries: string[] = [];
  await patchJob(fakePool(job, queries) as never, 'job-1', input(), new Set(['title']));

  const sql = updateSql(queries);
  assert.match(sql, /title = \$\d+/);
  for (const absent of [
    'description',
    'remote_regions',
    'expires_at',
    'tags',
    'salary_min',
    'pay_lines',
    'agent_policy',
  ]) {
    assert.ok(!sql.includes(`${absent} =`), `${absent} must not be rewritten by a title patch`);
  }
  assert.equal(job['title'], 'Renamed Listing');
  assert.equal(job['location'], 'Berlin');
  assert.equal(job['expires_at'], '2027-01-01T00:00:00.000Z');
});

test('independent concurrent listing patches keep both field changes', async () => {
  const job = jobRow();
  const queries: string[] = [];
  const pool = fakePool(job, queries);
  await Promise.all([
    patchJob(pool as never, 'job-1', input(), new Set(['title'])),
    patchJob(pool as never, 'job-1', input(), new Set(['tags'])),
  ]);

  assert.equal(job['title'], 'Renamed Listing');
  assert.deepEqual(job['tags'], ['new-tag']);
});

test('an explicit null expiresAt clears the expiry', async () => {
  const job = jobRow();
  const queries: string[] = [];
  await patchJob(
    fakePool(job, queries) as never,
    'job-1',
    input({ expiresAt: null }),
    new Set(['expiresAt']),
  );

  assert.match(updateSql(queries), /expires_at = \$\d+/);
  assert.equal(job['expires_at'], null);
});

test('any pay field rewrites the whole pay group', async () => {
  const job = jobRow();
  const queries: string[] = [];
  const pay = {
    lines: [{ type: 'per_task' as const, min: 25, max: null, currency: 'USD', unit: 'fix' }],
    method: 'SOL',
    equity: null,
    unpaid: false,
  };
  await patchJob(fakePool(job, queries) as never, 'job-1', input({ pay }), new Set(['pay']));

  const sql = updateSql(queries);
  for (const column of [
    'salary_min',
    'salary_max',
    'salary_currency',
    'salary_period',
    'salary_equity',
    'salary_unpaid',
    'pay_lines',
    'pay_method',
  ]) {
    assert.ok(sql.includes(`${column} =`), `pay patch must write ${column}`);
  }
  assert.equal(job['pay_method'], 'SOL');
  assert.equal(job['title'], 'Backend Engineer');
});

test('a patch with no recognised fields issues no update', async () => {
  const job = jobRow();
  const queries: string[] = [];
  const result = await patchJob(fakePool(job, queries) as never, 'job-1', input(), new Set());

  assert.ok(!queries.some((sql) => sql.trim().startsWith('update jobs')));
  assert.equal(result?.title, 'Backend Engineer');
});
