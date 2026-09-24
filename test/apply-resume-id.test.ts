/**
 * POST /api/v1/jobs/:slug/apply carrying `resumeId`.
 *
 * `resumeId` names a stored resume - a shared one from anyone, a private one
 * from its owner - and the column is a uuid. A value that is not one makes
 * Postgres raise `invalid input syntax for type uuid` rather than match
 * nothing, the same failure decideApplication and the inbox routes already
 * guard against. Without the guard a mistyped id answered 500, a crash, where
 * the route means to answer invalid_resume.
 *
 * The fake pool applies the semantics Postgres would: `where id = $1` on a
 * uuid column raises 22P02 for anything that is not a uuid.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A live listing, the row getJobBySlug's select returns.
const JOB = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'test-job',
  title: 'Test Job',
  description: 'A listing to apply to.',
  employment_type: 'full-time',
  workplace: 'remote',
  seniority: null,
  location: null,
  remote_regions: [],
  salary_min: 100_000,
  salary_max: 120_000,
  salary_currency: 'USD',
  salary_period: 'year',
  salary_equity: null,
  salary_unpaid: null,
  pay_lines: [],
  pay_method: null,
  tags: [],
  stack: [],
  requirements: [],
  responsibilities: [],
  agent_policy: 'welcome',
  apply_via: 'board',
  apply_url: null,
  apply_email: null,
  apply_schema: null,
  apply_source_url: null,
  status: 'published',
  published_at: '2020-01-01T00:00:00Z',
  expires_at: null,
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2020-01-01T00:00:00Z',
  org_id: '22222222-2222-4222-8222-222222222222',
  org_slug: 'test-co',
  org_name: 'Test Co',
  org_website: 'https://example.com',
  org_logo_url: null,
  org_description: null,
  org_created_at: '2020-01-01T00:00:00Z',
};

function makePool() {
  const resumeLookups: unknown[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('from jobs')) return { rows: [JOB], rowCount: 1 };
    if (sql.includes('from applications')) return { rows: [{ count: 0 }], rowCount: 1 };
    if (sql.includes('from resumes') && sql.includes('id = $1')) {
      resumeLookups.push(params[0]);
      if (typeof params[0] !== 'string' || !UUID.test(params[0])) {
        const error = new Error(`invalid input syntax for type uuid: "${String(params[0])}"`);
        (error as { code?: string }).code = '22P02';
        throw error;
      }
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { query, resumeLookups };
}

const body = {
  name: 'Test Candidate',
  email: 'candidate@example.com',
  cover: 'I read the listing.',
};

async function post(pool: { query: unknown }, resumeId: string): Promise<Response> {
  const { createApp } = await import('../dist/server/app.js');
  const { loadConfig } = await import('../dist/config.js');
  const config = loadConfig({ PUBLIC_URL: 'http://board.test', SECRET: 'test-secret' });
  const app = createApp(pool as never, config, {
    send: async () => true,
  }) as Hono<never>;
  return app.fetch(
    new Request('http://board.test/api/v1/jobs/test-job/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, resumeId }),
    }),
  );
}

test('a resumeId that is not a uuid is a miss, not a database error', async () => {
  const pool = makePool();
  const response = await post(pool, 'not-a-uuid');
  const answer = (await response.json()) as { error?: { code: string; message: string } };
  assert.equal(response.status, 400, JSON.stringify(answer));
  assert.equal(answer.error?.code, 'invalid_resume');
  assert.equal(
    pool.resumeLookups.length,
    0,
    'a malformed id never reaches the database',
  );
});

test('a well-formed resumeId still reaches the lookup', async () => {
  const pool = makePool();
  const missing = '33333333-3333-4333-8333-333333333333';
  const response = await post(pool, missing);
  const answer = (await response.json()) as { error?: { code: string } };
  assert.equal(response.status, 400, JSON.stringify(answer));
  assert.equal(answer.error?.code, 'invalid_resume');
  assert.deepEqual(pool.resumeLookups, [missing]);
});
