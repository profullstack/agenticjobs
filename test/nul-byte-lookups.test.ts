import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishConnect } from '../src/core/coinpay.ts';
import { counterpartyFrom } from '../src/core/inbox.ts';
import { getJobBySlug } from '../src/core/jobs.ts';
import { getOrgBySlug } from '../src/core/orgs.ts';
import {
  getPublicResume,
  getResume,
  getResumeById,
  getSharedResume,
  publicResumeSource,
} from '../src/core/resumes.ts';
import { boardLinkProblem, scopeFrom, userForCandidate } from '../src/core/updates.ts';

/**
 * A pool that remembers every parameter list it was handed.
 *
 * The point of these tests is what does *not* travel into the parameters, so
 * the pool answers nothing and the calls are the assertion.
 */
function recordingPool(): { pool: never; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const pool = {
    async query(_query: string, params: unknown[] = []) {
      calls.push(params);
      return { rows: [] };
    },
  };
  return { pool: pool as never, calls };
}

test('an org slug carrying a NUL byte is cleaned before the query', async () => {
  // `"org": "\u0000"` on POST /jobs or /updates, and `"as": "\u0000"` on
  // POST /inbox, answered 500 where an unknown slug answers "no such
  // employer": PostgreSQL refuses the byte in a parameter outright.
  const { pool, calls } = recordingPool();
  assert.equal(await getOrgBySlug(pool, 'ac\0me'), null);
  assert.deepEqual(calls, [['acme']]);
});

test('an org slug that is only a NUL byte never reaches the database', async () => {
  const { pool, calls } = recordingPool();
  assert.equal(await getOrgBySlug(pool, '\0'), null);
  assert.deepEqual(calls, []);
});

test('a job slug carrying a NUL byte is cleaned before the query', async () => {
  // `"job": "\u0000"` on POST /inbox was the live 500 this guards.
  const { pool, calls } = recordingPool();
  assert.equal(await getJobBySlug(pool, 'wri\0ter'), null);
  assert.deepEqual(calls, [['writer']]);
});

test('a job slug that is only a NUL byte never reaches the database', async () => {
  const { pool, calls } = recordingPool();
  assert.equal(await getJobBySlug(pool, '\0'), null);
  assert.deepEqual(calls, []);
});

test('every resume lookup drops the byte before the query', async () => {
  // `GET /inbox/new?candidate=%00` answered 500 through getPublicResume, and
  // `"resumeId": "\u0000"` / `"resumeSlug": "\u0000"` on POST
  // /jobs/:slug/apply through the shared, owned and by-id lookups.
  const { pool, calls } = recordingPool();
  assert.equal(await getPublicResume(pool, 'sa\0m'), null);
  assert.equal(await publicResumeSource(pool, 'sa\0m'), null);
  assert.equal(await getResume(pool, 'user-1', 'sa\0m'), null);
  assert.equal(await getResumeById(pool, 'res\0ume'), null);
  assert.equal(await getSharedResume(pool, 'res\0ume'), null);
  assert.deepEqual(calls, [['sam'], ['sam'], ['user-1', 'sam'], ['resume'], ['resume']]);
});

test('a resume lookup for only a NUL byte never reaches the database', async () => {
  const { pool, calls } = recordingPool();
  assert.equal(await getPublicResume(pool, '\0'), null);
  assert.equal(await getResume(pool, 'user-1', '\0'), null);
  assert.equal(await getResumeById(pool, '\0'), null);
  assert.equal(await getSharedResume(pool, '\0'), null);
  assert.deepEqual(calls, []);
});

test('a candidate slug carrying a NUL byte is cleaned in the follow lookup', async () => {
  const { pool, calls } = recordingPool();
  assert.equal(await userForCandidate(pool, 'sa\0m'), null);
  assert.deepEqual(calls, [['sam']]);
});

test('a scope of only NUL bytes reads as no filter at all', async () => {
  // `/api/v1/updates?org=%00`, `?candidate=%00`, the RSS feed and the
  // Markdown feed were the live 500s; a filter that cleans away to nothing
  // is absent, not a lookup for the empty slug.
  const { pool, calls } = recordingPool();
  const scope = await scopeFrom(pool, new URLSearchParams({ org: '\0', candidate: '\0' }));
  assert.deepEqual(scope, { kind: 'all' });
  assert.deepEqual(calls, []);
});

test('a candidate scope carrying a NUL byte is cleaned before the lookup', async () => {
  const { pool, calls } = recordingPool();
  const scope = await scopeFrom(pool, new URLSearchParams({ candidate: 'sa\0m' }));
  assert.deepEqual(scope, { kind: 'unknown', slug: 'sam' });
  assert.deepEqual(calls, [['sam']]);
});

test('an inbox body of only NUL bytes reads as nobody, not as a database error', async () => {
  // `"candidate": "\u0000"` and `"employer": "\u0000"` on POST /inbox were
  // the live 500s; "nobody here" is the 404 those slugs owe.
  const { pool, calls } = recordingPool();
  assert.equal(await counterpartyFrom(pool, { candidate: '\0', employer: null }), null);
  assert.deepEqual(calls, []);
});

test('a NUL byte in one inbox slug does not hide the other', async () => {
  const { pool, calls } = recordingPool();
  // The candidate slug cleans away to nothing, so the employer slug is the
  // one that decides. Before this the pair read as "both filters set".
  assert.equal(await counterpartyFrom(pool, { candidate: '\0', employer: 'ac\0me' }), null);
  assert.deepEqual(calls, [['acme']]);
});

test('a board link whose slug carries a NUL byte is cleaned, not sent raw', async () => {
  // `"link": "https://<board>/candidates/%00"` on POST /updates answered 500.
  const { pool, calls } = recordingPool();
  const problem = await boardLinkProblem(
    pool,
    'https://agenticjobs.pwa.pit.world/candidates/sa%00m',
    'https://agenticjobs.pwa.pit.world',
    'author-1',
    { kind: 'employer', orgId: 'org-1' },
  );
  assert.ok(typeof problem === 'string', 'the not-a-page sentence, not a crash');
  assert.deepEqual(calls, [['sam']]);
});

test('a board link with a malformed escape answers the sentence, not a crash', async () => {
  // `decodeURIComponent('%E0%A4%A')` throws, and the throw escaped as a 500
  // on POST /updates. The slug it cannot decode is not a page here either.
  const { pool, calls } = recordingPool();
  const problem = await boardLinkProblem(
    pool,
    'https://agenticjobs.pwa.pit.world/candidates/%E0%A4%A',
    'https://agenticjobs.pwa.pit.world',
    'author-1',
    { kind: 'employer', orgId: 'org-1' },
  );
  assert.ok(
    typeof problem === 'string' && problem.includes('not a page'),
    String(problem),
  );
  assert.deepEqual(calls, []);
});

test('a well-formed board link still reaches the lookup unchanged', async () => {
  const { pool, calls } = recordingPool();
  await boardLinkProblem(
    pool,
    'https://agenticjobs.pwa.pit.world/candidates/sam',
    'https://agenticjobs.pwa.pit.world',
    'author-1',
    { kind: 'employer', orgId: 'org-1' },
  );
  assert.deepEqual(calls, [['sam']]);
});

test('a callback state of only NUL bytes expires instead of erroring', async () => {
  // `?state=%00` on GET /api/v1/coinpay/callback answered 500 where every
  // state that matches no pending flow answers "expired".
  const { pool, calls } = recordingPool();
  const result = await finishConnect(pool, {} as never, {
    state: '\0',
    code: 'code',
    redirectUri: 'https://agenticjobs.pwa.pit.world/api/v1/coinpay/callback',
  });
  assert.equal(result, 'That connection attempt has expired. Start again.');
  assert.deepEqual(calls, [['']]);
});
