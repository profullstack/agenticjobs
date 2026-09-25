/**
 * POST /api/v1/jobs under an idempotency key.
 *
 * The question, asked on r/coolgithubprojects the day after 0.19.0: a
 * `post --publish` succeeds server-side, the client loses the answer and
 * retries. Does that make a second listing? It did. Now a key names the
 * request and the row carries it, so the answer to a repeat is the row.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Hono } from 'hono';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://agenticjobs:agenticjobs@localhost:5432/agenticjobs';

let app: Hono<never> | null = null;
let pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>;
} | null = null;
let closePool: (() => Promise<void>) | null = null;
let reason = '';
let ready = false;

try {
  const db = await import('../dist/db/pool.js');
  const { migrate } = await import('../dist/db/migrate.js');
  const { createApp } = await import('../dist/server/app.js');
  const { loadConfig } = await import('../dist/config.js');
  const created = db.getPool(DATABASE_URL);
  await created.query('select 1');
  await migrate(created);
  pool = created as never;
  closePool = db.closePool;
  const config = loadConfig({
    ...process.env,
    DATABASE_URL,
    PUBLIC_URL: 'http://board.test',
    SECRET: 'test-secret',
  });
  app = createApp(created, config, { send: async () => true }) as never;
  ready = true;
} catch (error) {
  reason = error instanceof Error ? error.message : String(error);
}

after(async () => {
  if (closePool !== null) await closePool();
});

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  if (app === null) throw new Error('no app');
  return app.fetch(
    new Request(`http://board.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const employer = async (name: string) => {
  const { createSession, ensureUser } = await import('../dist/core/auth.js');
  const { createOrg } = await import('../dist/core/orgs.js');
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const user = await ensureUser(pool as never, `idem+${stamp}@example.com`, name);
  const token = await createSession(pool as never, user.id, { label: 't' });
  const org = await createOrg(pool as never, user.id, {
    name: `${name} ${stamp}`,
    website: 'https://example.com',
  });
  if (typeof org === 'string') throw new Error(org);
  return { org, stamp, auth: { authorization: `Bearer ${token}` } };
};

type Answer = { job: { id: string; slug: string; status: string }; replayed?: boolean };

async function countJobs(orgId: string): Promise<number> {
  if (pool === null) throw new Error('no pool');
  const rows = await pool.query(`select count(*)::text as count from jobs where org_id = $1`, [
    orgId,
  ]);
  return Number(rows.rows[0]?.['count'] ?? '0');
}

describe('idempotent posting', { skip: ready ? false : `no database: ${reason || 'setup failed'}` }, () => {
  test('a repeat under the same key returns the listing already made, not a second one', async () => {
    const { org, stamp, auth } = await employer('Retry Co');
    const listing = {
      org: org.slug,
      title: `Retried ${stamp}`,
      description: 'A listing whose first answer was lost on the way back.',
      agentPolicy: 'welcome',
    };
    const key = `deploy-${stamp}`;

    const first = await post('/api/v1/jobs', listing, { ...auth, 'idempotency-key': key });
    const firstBody = await first.text();
    assert.equal(first.status, 201, firstBody);
    const a = JSON.parse(firstBody) as Answer;
    assert.equal(a.replayed, undefined);
    assert.equal(first.headers.get('idempotent-replayed'), null);

    const second = await post('/api/v1/jobs', listing, { ...auth, 'idempotency-key': key });
    assert.equal(second.status, 201, 'still a 201, so a client checking for one keeps working');
    const b = (await second.json()) as Answer;
    assert.equal(b.job.id, a.job.id);
    assert.equal(b.job.slug, a.job.slug);
    assert.equal(b.replayed, true);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');

    // The body field is the same thing as the header, for a form or a model.
    const third = await post('/api/v1/jobs', { ...listing, idempotencyKey: key }, auth);
    assert.equal(((await third.json()) as Answer).job.id, a.job.id);

    assert.equal(await countJobs(org.id), 1);

    // A different key is a different request.
    const other = await post('/api/v1/jobs', listing, { ...auth, 'idempotency-key': `${key}-2` });
    assert.equal(other.status, 201);
    assert.notEqual(((await other.json()) as Answer).job.id, a.job.id);
    assert.equal(await countJobs(org.id), 2);
  });

  test('a retried publish finishes the publish and does not duplicate the listing', async () => {
    const { org, stamp, auth } = await employer('Publish Co');
    const listing = {
      org: org.slug,
      title: `Published ${stamp}`,
      description: 'A paid listing posted with publish: true and then retried.',
      agentPolicy: 'welcome',
      pay: ['$1 per task'],
      payMethod: 'SOL',
      publish: true,
    };
    const key = `publish-${stamp}`;

    const first = (await (
      await post('/api/v1/jobs', listing, { ...auth, 'idempotency-key': key })
    ).json()) as Answer;
    assert.equal(first.job.status, 'published');

    const again = (await (
      await post('/api/v1/jobs', listing, { ...auth, 'idempotency-key': key })
    ).json()) as Answer;
    assert.equal(again.job.id, first.job.id);
    assert.equal(again.job.status, 'published');
    assert.equal(again.replayed, true);
    assert.equal(await countJobs(org.id), 1);

    // The crash-between-insert-and-publish case: the row exists as a draft
    // under the key, and the retry asked for it live.
    if (pool === null) throw new Error('no pool');
    await pool.query(`update jobs set status = 'draft', published_at = null where id = $1`, [
      first.job.id,
    ]);
    const finished = (await (
      await post('/api/v1/jobs', listing, { ...auth, 'idempotency-key': key })
    ).json()) as Answer;
    assert.equal(finished.job.id, first.job.id);
    assert.equal(finished.job.status, 'published');
    assert.equal(await countJobs(org.id), 1);
  });

  test('keys are per employer, and a key that cannot be stored is refused', async () => {
    const one = await employer('One Co');
    const two = await employer('Two Co');
    const key = `shared-${one.stamp}`;
    const body = (slug: string) => ({
      org: slug,
      title: `Shared key ${one.stamp}`,
      description: 'Two employers happen to pick the same key.',
      agentPolicy: 'welcome',
    });
    const a = (await (
      await post('/api/v1/jobs', body(one.org.slug), { ...one.auth, 'idempotency-key': key })
    ).json()) as Answer;
    const b = (await (
      await post('/api/v1/jobs', body(two.org.slug), { ...two.auth, 'idempotency-key': key })
    ).json()) as Answer;
    assert.notEqual(a.job.id, b.job.id);

    const long = await post('/api/v1/jobs', body(one.org.slug), {
      ...one.auth,
      'idempotency-key': 'k'.repeat(201),
    });
    assert.equal(long.status, 400);
    assert.equal(await countJobs(one.org.id), 1);
  });

  test('two identical requests that overlap make one row', async () => {
    const { org, stamp, auth } = await employer('Race Co');
    const listing = {
      org: org.slug,
      title: `Raced ${stamp}`,
      description: 'Two copies of the same request in flight at once.',
      agentPolicy: 'welcome',
    };
    const headers = { ...auth, 'idempotency-key': `race-${stamp}` };
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => post('/api/v1/jobs', listing, headers)),
    );
    const ids = new Set<string>();
    for (const answer of answers) {
      assert.equal(answer.status, 201, await answer.clone().text());
      ids.add(((await answer.json()) as Answer).job.id);
    }
    assert.equal(ids.size, 1);
    assert.equal(await countJobs(org.id), 1);
  });
});
