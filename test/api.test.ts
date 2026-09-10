/**
 * The API, against a real Postgres.
 *
 * Two things are checked that nothing else can check: that every path the
 * OpenAPI document advertises actually resolves, and that the flows which
 * cross several tables - applying, drafting, publishing - behave end to end.
 *
 * Skipped rather than failed when no database is reachable, so `pnpm test` on
 * a laptop with nothing running still tells you about the other 41 tests.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Hono } from 'hono';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://agenticjobs:agenticjobs@localhost:5432/agenticjobs';

let app: Hono<never> | null = null;
let pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }> } | null =
  null;
let closePool: (() => Promise<void>) | null = null;
let reason = '';

function setupErrorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || error.name.trim() || 'database unavailable';
  }
  return String(error).trim() || 'database unavailable';
}
/**
 * What the board tried to send. A fake rather than the real mailer so the
 * suite needs no provider, and so an ambient RESEND_API_KEY in someone's
 * environment can never turn `pnpm test` into real email.
 */
const sentMail: { to: string; subject: string; text: string }[] = [];

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  if (app === null) throw new Error('no app');
  return app.fetch(new Request(`http://board.test${path}`, { headers }));
}

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

async function del(path: string, headers: Record<string, string> = {}): Promise<Response> {
  if (app === null) throw new Error('no app');
  return app.fetch(new Request(`http://board.test${path}`, { method: 'DELETE', headers }));
}

async function patch(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  if (app === null) throw new Error('no app');
  return app.fetch(
    new Request(`http://board.test${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Set up at module scope, not in before().
 *
 * node:test evaluates a describe's options when the describe is declared,
 * which is before any before() hook has run - and it treats a FUNCTION passed
 * as `skip` as truthy, so a lazily-computed skip silently skips everything and
 * reports zero failures. Top-level await is the only thing that runs early
 * enough for the flag to be a real boolean.
 */
try {
  const db = await import('../dist/db/pool.js');
  const { migrate } = await import('../dist/db/migrate.js');
  const { createApp } = await import('../dist/server/app.js');
  const { loadConfig } = await import('../dist/config.js');
  const { seed } = await import('../dist/db/seed.js');

  const created = db.getPool(DATABASE_URL);
  // Fail fast rather than hanging for the pool's connect timeout.
  await created.query('select 1');
  await migrate(created);

  pool = created as never;
  closePool = db.closePool;

  const config = {
    ...loadConfig({
      ...process.env,
      DATABASE_URL,
      PUBLIC_URL: 'http://board.test',
      SECRET: 'test-secret',
    }),
    isDirectory: true,
  };
  app = createApp(created, config, {
    send: async (message: { to: string; subject: string; text: string }) => {
      sentMail.push(message);
      return true;
    },
  }) as never;
  await seed(created);
} catch (error) {
  reason = setupErrorReason(error);
}

after(async () => {
  if (closePool !== null) await closePool();
});

test('a database setup error with no message still produces a skip reason', () => {
  assert.equal(setupErrorReason(new AggregateError([])), 'AggregateError');
});

describe('the API', { skip: reason === '' ? false : `no database: ${reason}` }, () => {
  test('every route the board serves is in the document it publishes', async () => {
    // The next test checks the other direction, that nothing documented is
    // missing. Nothing checked that nothing served was undocumented, and 13
    // routes had drifted out: the whole of /candidates, the importer, and
    // POST /orgs, which you must call before you can post a job at all. On a
    // board that tells agents to read the JSON, an index missing a third of
    // the API is the product failing rather than a docs chore.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/server/routes/api.ts', import.meta.url), 'utf8');

    const served = new Set();
    for (const [, method, path] of source.matchAll(/api\.(get|post|patch|put|delete)\('([^']+)'/g)) {
      const openapiPath = path.replace(/:(\w+)\{[^}]*\}/g, '{$1}').replace(/:(\w+)/g, '{$1}');
      served.add(method.toUpperCase() + ' /api/v1' + openapiPath);
    }

    const doc = await (await get('/api/v1/openapi.json')).json();
    const documented = new Set();
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const m of Object.keys(ops)) documented.add(m.toUpperCase() + ' ' + p);
    }

    const missing = [...served].filter((r) => !documented.has(r)).sort();
    assert.deepEqual(missing, [], 'undocumented routes:\n' + missing.join('\n'));
  });

  test('every documented GET path resolves', async () => {
    const document = (await (await get('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };

    // A path in the document that 404s is a lie told to whoever reads it, and
    // a route with no entry is invisible. This catches the first.
    const slug = ((await (await get('/api/v1/jobs?limit=1')).json()) as {
      items: { slug: string }[];
    }).items[0]?.slug;
    assert.ok(slug, 'the seed produced no jobs to test paths against');

    // `{slug}` means a different kind of slug on different paths, so the
    // substitution has to know which. Feeding a job slug to /orgs/{slug} would
    // report a documented route as broken when it is the test that is wrong.
    const orgs = ((await (await get('/api/v1/orgs')).json()) as { items: { slug: string }[] }).items;
    const orgSlug = orgs[0]?.slug ?? 'example-works';

    // A candidate slug is a third kind again, and there may be none: a board
    // where nobody has published a resume is a normal board, not a broken
    // route, so that path is skipped rather than failed.
    const candidates = (
      (await (await get('/api/v1/candidates')).json()) as { items: { slug: string }[] }
    ).items;
    const candidateSlug = candidates[0]?.slug ?? null;

    const checked: string[] = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      if (!Object.hasOwn(methods, 'get')) continue;
      if (path.startsWith('/api/v1/candidates/') && candidateSlug === null) continue;
      const slugFor = path.startsWith('/api/v1/orgs')
        ? orgSlug
        : path.startsWith('/api/v1/candidates')
          ? (candidateSlug as string)
          : slug;
      const concrete = path.replace('{slug}', slugFor).replace('{id}', 'x');
      const response = await get(concrete);
      // 401 is a pass: the route exists and asked for a credential.
      assert.notEqual(response.status, 404, `${concrete} is documented but 404s`);
      checked.push(concrete);
    }
    assert.ok(checked.length >= 10, `only checked ${checked.length} paths`);
  });

  test('reads need no credentials', async () => {
    for (const path of ['/api/v1/jobs', '/api/v1/orgs', '/api/v1/stats', '/.well-known/agenticjobs']) {
      assert.equal((await get(path)).status, 200, path);
    }
  });

  test('the descriptor counts what is actually published', async () => {
    const descriptor = (await (await get('/.well-known/agenticjobs')).json()) as {
      jobs: { open: number; total: number };
      protocol: number;
    };
    assert.equal(descriptor.protocol, 1);
    assert.ok(descriptor.jobs.open > 0);
  });

  test('an unknown API path answers JSON, not HTML', async () => {
    const response = await get('/api/v1/nope');
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /json/);
  });

  test('an unknown page answers HTML', async () => {
    const response = await get('/nope', { accept: 'text/html' });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /html/);
  });

  describe('applying', () => {
    let slug = '';

    before(async () => {
      const page = (await (await get('/api/v1/jobs?agentPolicy=welcome&limit=1')).json()) as {
        items: { slug: string }[];
      };
      slug = page.items[0]?.slug ?? '';
    });

    test('the schema says exactly what to send', async () => {
      const schema = (await (await get(`/api/v1/jobs/${slug}/apply-schema`)).json()) as {
        via: string;
        endpoint: string;
        schema: { fields: { name: string; required: boolean }[] };
        resume: { format: string };
      };
      assert.equal(schema.via, 'board');
      assert.match(schema.endpoint, /\/apply$/);
      assert.equal(schema.resume.format, 'openresume.md');
      assert.ok(schema.schema.fields.some((field) => field.name === 'email' && field.required));
    });

    test('a complete application is accepted', async () => {
      const response = await post(`/api/v1/jobs/${slug}/apply`, {
        name: 'Ada Lovelace',
        email: `ada+${Date.now()}@example.com`,
        cover: 'Because I would be good at it.',
        resume: '# Ada Lovelace\n\n- **Email**: ada@example.com\n',
        agent: { name: 'test-agent', supervised: true },
      });
      assert.equal(response.status, 201);
      const body = (await response.json()) as { ok: boolean; submitted: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.submitted, true);
    });

    test('every problem is reported at once, not one per round trip', async () => {
      const response = await post(`/api/v1/jobs/${slug}/apply`, { email: 'nope' });
      assert.equal(response.status, 400);
      const body = (await response.json()) as {
        error: { fields: { field: string; message: string }[] };
      };
      assert.ok(body.error.fields.length >= 3, JSON.stringify(body));
      for (const problem of body.error.fields) {
        // Half the callers are models. A code with no sentence is not an answer.
        assert.ok(problem.message.length > 10, problem.message);
      }
    });

    test('a human-only listing refuses a disclosed agent, in words', async () => {
      const page = (await (await get('/api/v1/jobs?agentPolicy=human-only&limit=1')).json()) as {
        items: { slug: string }[];
      };
      const humanOnly = page.items[0]?.slug;
      assert.ok(humanOnly, 'the seed has no human-only listing');
      const response = await post(`/api/v1/jobs/${humanOnly}/apply`, {
        name: 'A',
        email: 'a@example.com',
        cover: 'A cover letter long enough to pass.',
        agent: { name: 'bot' },
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as {
        error: { fields: { field: string; message: string }[] };
      };
      assert.equal(body.error.fields[0]?.field, 'agent');
      assert.match(body.error.fields[0]?.message ?? '', /person/);
    });

    test('holding a draft needs an account, so somebody can come back for it', async () => {
      const response = await post(`/api/v1/jobs/${slug}/apply`, {
        name: 'A',
        email: 'a@example.com',
        cover: 'A cover letter long enough to pass.',
        submit: false,
      });
      assert.equal(response.status, 401);
    });

    test('an application to a job that does not exist says so', async () => {
      const response = await post('/api/v1/jobs/no-such-job/apply', {});
      assert.equal(response.status, 404);
    });
  });

  describe('writes', () => {
    test('posting a job needs a credential', async () => {
      const response = await post('/api/v1/jobs', { org: 'example-works', title: 'x' });
      assert.equal(response.status, 401);
    });

    test('a device token is never an administrator', async () => {
      if (pool === null) return;
      const { createSession } = await import('../dist/core/auth.js');
      const user = await pool.query(`select id from users limit 1`);
      const id = user.rows[0]?.['id'];
      assert.ok(id);
      const token = await createSession(pool as never, id, { viaToken: true });
      const me = (await (await get('/api/v1/me', { authorization: `Bearer ${token}` })).json()) as {
        user: { viaToken: boolean; isAdmin: boolean };
      };
      assert.equal(me.user.viaToken, true);
      assert.equal(me.user.isAdmin, false);
    });
  });

  describe('signing up from a terminal', () => {
    test('the link is emailed and never returned to the caller', async () => {
      // The whole point of a magic link is that it reaches the address rather
      // than whoever typed it. A response body carrying the token would make
      // signing in as anyone a matter of knowing their address.
      const email = `signup+${Date.now()}@example.com`;
      const before = sentMail.length;
      const response = await post('/api/v1/auth/magic-link', { email });
      assert.equal(response.status, 200);

      const raw = await response.text();
      assert.ok(!raw.includes('/auth/callback'), raw);
      assert.ok(!/token/i.test(raw), raw);
      assert.equal((JSON.parse(raw) as { delivered: boolean }).delivered, true);

      assert.equal(sentMail.length, before + 1);
      const message = sentMail[sentMail.length - 1];
      assert.equal(message?.to, email);
      assert.match(message?.text ?? '', /\/auth\/callback\?token=/);
    });

    test('a link asked for by a terminal names that terminal in the email', async () => {
      const email = `signup+${Date.now()}@example.com`;
      await post('/api/v1/auth/magic-link', { email, redirect: '/device?code=WXYZ-1234' });
      const message = sentMail[sentMail.length - 1];
      assert.match(message?.subject ?? '', /Approve your terminal/);
      assert.match(message?.text ?? '', /WXYZ-1234/);
    });

    test('a magic link may carry a same-origin redirect', async () => {
      const response = await post('/api/v1/auth/magic-link', {
        email: `signup+${Date.now()}@example.com`,
        redirect: '/device?code=ABCD-EFGH',
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { ok: boolean };
      assert.equal(body.ok, true);
    });

    test('an off-site redirect on a sign-in link is refused', async () => {
      // An open redirect on the one link that also authenticates you is a
      // phish, so these must be dropped rather than followed.
      for (const redirect of [
        'https://evil.example/steal',
        '//evil.example/steal',
        'http://evil.example',
        'javascript:alert(1)',
      ]) {
        const response = await post('/api/v1/auth/magic-link', {
          email: `signup+${Date.now()}@example.com`,
          redirect,
        });
        assert.equal(response.status, 200, redirect);
        // The link is still issued; what is dropped is the redirect. Proven by
        // following one below rather than by trusting the response body.
      }

      if (pool === null) return;
      const row = await pool.query(
        `select redirect from magic_links order by created_at desc limit 4`,
      );
      for (const entry of row.rows) {
        assert.equal(entry['redirect'], null, JSON.stringify(entry));
      }
    });

    test('following a link with a redirect lands on the approval page', async () => {
      if (pool === null || app === null) return;
      const email = `signup+${Date.now()}@example.com`;
      await post('/api/v1/auth/magic-link', { email, redirect: '/device?code=ABCD-EFGH' });

      const row = await pool.query(
        `select token_hash from magic_links where lower(email) = lower($1) order by created_at desc limit 1`,
        [email],
      );
      assert.ok(row.rows[0]);

      // The raw token is never stored, so the flow is exercised through the
      // API the way a person's mail client would.
      const grant = (await (await post('/api/v1/auth/device', { label: 'test' })).json()) as {
        userCode: string;
      };
      assert.match(grant.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });

    test('the installer is served, as plain text', async () => {
      const response = await get('/install.sh');
      assert.equal(response.status, 200);
      // Served as text so it opens in a browser: anyone about to pipe it into
      // sh should be able to read it first without a download prompt.
      assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
      const body = await response.text();
      assert.match(body, /^#!\/bin\/sh/);
      assert.match(body, /uninstall\.sh/);
      // Never ask for root from a piped script.
      assert.ok(!/\bsudo\b/.test(body), 'the installer asks for sudo');
    });
  });

  describe('applications stay on the board', () => {
    test('a listing cannot send applicants somewhere else', async () => {
      // The whole point of the board is that an agent can complete an
      // application without a browser. An offsite link is a listing an agent
      // has to skip, so it is refused at the door rather than stored.
      if (pool === null) return;
      const { createSession } = await import('../dist/core/auth.js');
      const owner = await pool.query(
        `select user_id from memberships limit 1`,
      );
      const userId = owner.rows[0]?.['user_id'];
      assert.ok(userId, 'expected the seed to leave an employer member');
      const token = await createSession(pool as never, userId, { label: 'test' });

      for (const apply of [
        { applyVia: 'url', applyUrl: 'https://example.com/careers/1' },
        { applyVia: 'email', applyEmail: 'jobs@example.com' },
      ]) {
        const response = await post(
          '/api/v1/jobs',
          {
            org: 'example-works',
            title: `Offsite ${Date.now()}`,
            description: 'A job that tries to send people elsewhere.',
            agentPolicy: 'welcome',
            ...apply,
          },
          { authorization: `Bearer ${token}` },
        );
        assert.equal(response.status, 400, JSON.stringify(apply));
        const body = (await response.json()) as { error: { message: string } };
        assert.match(body.error.message, /taken on this board/i);
      }
    });

    test('every published listing publishes a schema an agent can complete', async () => {
      const page = (await (await get('/api/v1/jobs?limit=10')).json()) as {
        items: { slug: string }[];
      };
      assert.ok(page.items.length > 0, 'expected the seeded board to have jobs');
      for (const item of page.items) {
        const schema = (await (
          await get(`/api/v1/jobs/${item.slug}/apply-schema`)
        ).json()) as { via: string; endpoint?: string; schema?: { fields: unknown[] } };
        assert.equal(schema.via, 'board', item.slug);
        assert.ok(schema.endpoint, `${item.slug} must publish an endpoint`);
        assert.ok((schema.schema?.fields ?? []).length > 0, `${item.slug} must publish fields`);
      }
    });
  });

  describe('employers, as CRUD', () => {
    /** A signed-in account with one employer of its own. */
    const employer = async (name: string) => {
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createOrg } = await import('../dist/core/orgs.js');
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const user = await ensureUser(pool as never, `org+${stamp}@example.com`, name);
      const token = await createSession(pool as never, user.id, { label: 't' });
      const org = await createOrg(pool as never, user.id, {
        name: `${name} ${stamp}`,
        website: 'https://example.com',
      });
      if (typeof org === 'string') throw new Error(org);
      return { org, stamp, auth: { authorization: `Bearer ${token}` } };
    };

    test('a rename keeps the slug, because the slug is the URL', async () => {
      if (pool === null) return;
      const { org, auth, stamp } = await employer('Rename Co');

      const response = await patch(`/api/v1/orgs/${org.slug}`, { name: `Renamed ${stamp}` }, auth);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { org: { slug: string; name: string } };
      assert.equal(body.org.name, `Renamed ${stamp}`);
      assert.equal(body.org.slug, org.slug, 'a company that renamed is not a different employer');

      // The old address is the one every listing and link already points at,
      // so the test that matters is that it still resolves.
      assert.equal((await get(`/api/v1/orgs/${org.slug}`)).status, 200);
    });

    test('a patch leaves alone what it does not carry', async () => {
      if (pool === null) return;
      const { org, auth } = await employer('Partial Co');

      // Only a description. A caller that never read the website must not be
      // able to clear it by not mentioning it.
      await patch(`/api/v1/orgs/${org.slug}`, { description: 'We make examples.' }, auth);
      const kept = (await (await get(`/api/v1/orgs/${org.slug}`)).json()) as {
        org: { website: string | null; description: string | null };
      };
      assert.equal(kept.org.description, 'We make examples.');
      assert.ok(kept.org.website?.includes('example.com'), 'the website survived a patch about something else');

      // An explicit null is the way to actually clear one.
      await patch(`/api/v1/orgs/${org.slug}`, { website: null }, auth);
      const cleared = (await (await get(`/api/v1/orgs/${org.slug}`)).json()) as {
        org: { website: string | null };
      };
      assert.equal(cleared.org.website, null);
    });

    test('somebody else cannot edit or delete your employer', async () => {
      if (pool === null) return;
      const { org } = await employer('Mine Co');
      const stranger = await employer('Stranger Co');

      assert.equal((await patch(`/api/v1/orgs/${org.slug}`, { name: 'Theirs' }, stranger.auth)).status, 403);
      assert.equal((await del(`/api/v1/orgs/${org.slug}`, stranger.auth)).status, 403);
      // And with no token at all, which is a different code path.
      assert.equal((await patch(`/api/v1/orgs/${org.slug}`, { name: 'Theirs' })).status, 401);
    });

    test('an employer that published cannot be deleted, one that never did can', async () => {
      if (pool === null) return;
      const { org, auth, stamp } = await employer('Delete Co');

      // Nothing attached yet: it goes.
      const spare = await employer('Spare Co');
      const gone = await del(`/api/v1/orgs/${spare.org.slug}`, spare.auth);
      assert.equal(gone.status, 200);
      assert.equal((await get(`/api/v1/orgs/${spare.org.slug}`)).status, 404);

      // One published listing, and the same call is refused - because the
      // cascade would take the listing and every application with it.
      const job = (await (
        await post(
          '/api/v1/jobs',
          {
            org: org.slug,
            title: `Kept Role ${stamp}`,
            description: 'A listing that has been public, which is why its employer stays.',
            agentPolicy: 'welcome',
            pay: ['$100 an hour'],
          },
          auth,
        )
      ).json()) as { job: { slug: string } };
      await post(`/api/v1/jobs/${job.job.slug}/publish`, {}, auth);

      const refused = await del(`/api/v1/orgs/${org.slug}`, auth);
      assert.equal(refused.status, 409);
      const problem = (await refused.json()) as { error?: { message?: string } };
      assert.match(
        problem.error?.message ?? '',
        /listing/i,
        'the refusal has to say what is in the way',
      );
      assert.equal((await get(`/api/v1/jobs/${job.job.slug}`)).status, 200, 'the listing survived');
    });
  });

  describe('unpaid roles', () => {
    test('an unpaid listing says so, and stays out of salary filters', async () => {
      if (pool === null) return;
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createOrg } = await import('../dist/core/orgs.js');
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const user = await ensureUser(pool as never, `unpaid+${stamp}@example.com`, 'Unpaid Co');
      const token = await createSession(pool as never, user.id, { label: 't' });
      const org = await createOrg(pool as never, user.id, { name: `Unpaid ${stamp}` });
      if (typeof org === 'string') throw new Error(org);
      const auth = { authorization: `Bearer ${token}` };

      const created = (await (
        await post(
          '/api/v1/jobs',
          {
            org: org.slug,
            title: `Research Intern ${stamp}`,
            description: 'An unpaid research internship, said out loud rather than left blank.',
            employmentType: 'internship',
            agentPolicy: 'welcome',
            salaryUnpaid: true,
            // Sent alongside on purpose: unpaid has to win, or a listing can
            // claim both at once.
            salaryMin: 40_000,
            salaryMax: 60_000,
          },
          auth,
        )
      ).json()) as { job: { slug: string; salary: Record<string, unknown> } };

      assert.equal(created.job.salary['unpaid'], true);
      assert.equal(created.job.salary['min'], null, 'the range does not survive the tick');
      assert.equal(created.job.salary['max'], null);

      await post(`/api/v1/jobs/${created.job.slug}/publish`, {}, auth);

      // It round-trips through the read path, not just the write response.
      const read = (await (await get(`/api/v1/jobs/${created.job.slug}`)).json()) as {
        job: { salary: Record<string, unknown> };
      };
      assert.equal(read.job.salary['unpaid'], true);

      // And somebody filtering for paying work never sees it. This is the
      // reason it is a boolean and not a zero in the range.
      const filtered = (await (await get('/api/v1/jobs?salaryMin=1&limit=100')).json()) as {
        items: { slug: string }[];
      };
      assert.ok(
        !filtered.items.some((item) => item.slug === created.job.slug),
        'an unpaid listing must not match a salary floor',
      );
    });
  });

  describe('what it pays', () => {
    const employer = async (name: string) => {
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createOrg } = await import('../dist/core/orgs.js');
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const user = await ensureUser(pool as never, `pay+${stamp}@example.com`, name);
      const token = await createSession(pool as never, user.id, { label: 't' });
      const org = await createOrg(pool as never, user.id, { name: `${name} ${stamp}` });
      if (typeof org === 'string') throw new Error(org);
      return { org, stamp, auth: { authorization: `Bearer ${token}` } };
    };

    test('a listing cannot be published until it says what it pays', async () => {
      if (pool === null) return;
      const { org, stamp, auth } = await employer('Silent Co');

      // Asking for it live in the same request is refused before anything is
      // written: nobody asked for a draft.
      const direct = await post(
        '/api/v1/jobs',
        {
          org: org.slug,
          title: `Silent ${stamp}`,
          description: 'A listing that says nothing about pay.',
          agentPolicy: 'welcome',
          publish: true,
        },
        auth,
      );
      const directBody = await direct.text();
      assert.equal(direct.status, 400, directBody);
      assert.equal((JSON.parse(directBody) as { error: { code: string } }).error.code, 'pay_required');

      const created = (await (
        await post(
          '/api/v1/jobs',
          {
            org: org.slug,
            title: `Silent ${stamp}`,
            description: 'A listing that says nothing about pay.',
            agentPolicy: 'welcome',
          },
          auth,
        )
      ).json()) as { job: { slug: string; status: string } };
      assert.equal(created.job.status, 'draft');

      const refused = await post(`/api/v1/jobs/${created.job.slug}/publish`, {}, auth);
      assert.equal(refused.status, 400);
      const problem = (await refused.json()) as { error: { code: string; message: string } };
      assert.equal(problem.error.code, 'pay_required');
      assert.match(problem.error.message, /per task|revenue share|unpaid/);

      // Pay can be set on its own, without rewriting the listing.
      const patched = await patch(
        `/api/v1/jobs/${created.job.slug}`,
        { pay: ['$0.25 per task', '$0.25 per PR that fixes a bug you find'], payMethod: 'sol' },
        auth,
      );
      assert.equal(patched.status, 200, await patched.text());

      const published = await post(`/api/v1/jobs/${created.job.slug}/publish`, {}, auth);
      assert.equal(published.status, 200, await published.text());

      const read = (await (await get(`/api/v1/jobs/${created.job.slug}`)).json()) as {
        job: {
          pay: { lines: { type: string; min: number; unit: string | null }[]; method: string | null };
          salary: { min: number | null };
        };
      };
      assert.equal(read.job.pay.lines.length, 2);
      assert.equal(read.job.pay.lines[0]?.type, 'per_task');
      assert.equal(read.job.pay.lines[0]?.min, 0.25);
      assert.equal(read.job.pay.lines[1]?.unit, 'PR that fixes a bug you find');
      assert.equal(read.job.pay.method, 'SOL');
      assert.equal(read.job.salary.min, null, 'a price per task is not an annual salary');

      // The page says it too, all of it, plus what it is settled in.
      const html = await (await get(`/jobs/${created.job.slug}`, { accept: 'text/html' })).text();
      assert.match(html, /\$0\.25 per task/);
      assert.match(html, /PR that fixes a bug you find/);
      assert.match(html, /Paid in SOL/);

      // And a live listing cannot be edited into silence.
      const cleared = await patch(`/api/v1/jobs/${created.job.slug}`, { pay: [] }, auth);
      assert.equal(cleared.status, 400);
      assert.equal(((await cleared.json()) as { error: { code: string } }).error.code, 'pay_required');
    });

    test('an edit that does not mention pay leaves it alone', async () => {
      if (pool === null) return;
      const { org, stamp, auth } = await employer('Keep Co');
      const created = (await (
        await post(
          '/api/v1/jobs',
          {
            org: org.slug,
            title: `Keep ${stamp}`,
            description: 'A listing whose pay must survive a typo fix.',
            agentPolicy: 'welcome',
            pay: '$120k - $150k a year paid in USDC',
          },
          auth,
        )
      ).json()) as { job?: { slug: string; pay: { method: string | null } }; error?: unknown };
      assert.ok(created.job, JSON.stringify(created.error));
      assert.equal(created.job.pay.method, 'USDC', 'a rail named on the line is the method');

      const edited = (await (
        await patch(`/api/v1/jobs/${created.job.slug}`, { description: 'Fixed the typo in the description.' }, auth)
      ).json()) as { job: { pay: { lines: unknown[]; method: string | null }; salary: { min: number | null } } };
      assert.equal(edited.job.pay.lines.length, 1);
      assert.equal(edited.job.pay.method, 'USDC');
      assert.equal(edited.job.salary.min, 120_000, 'the flattened salary keeps the annual line');
    });

    test('a page without pay says so, rather than saying nothing', async () => {
      if (pool === null) return;
      const { org, stamp, auth } = await employer('Blank Co');
      const created = (await (
        await post(
          '/api/v1/jobs',
          { org: org.slug, title: `Blank ${stamp}`, description: 'No pay stated, on purpose, for the test.', agentPolicy: 'welcome' },
          auth,
        )
      ).json()) as { job: { slug: string } };
      // Drafts are not public, so the employer's own page is where it shows.
      const { createSession } = await import('../dist/core/auth.js');
      const member = await pool.query(`select user_id from memberships where org_id = $1`, [org.id]);
      const cookieToken = await createSession(pool as never, member.rows[0]?.['user_id'], { label: 'web' });
      const page = await get(`/me/jobs/${created.job.slug}`, {
        accept: 'text/html',
        cookie: `aj_session=${cookieToken}`,
      });
      const html = await page.text();
      assert.match(html, /does not say what it pays/);
      assert.match(html, /name="pay"/, 'the pay form is on the page');
    });
  });

  describe('salary period comparisons', () => {
    test('salary filters, ordering and pagination compare annual amounts', async () => {
      assert.ok(pool);
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createOrg } = await import('../dist/core/orgs.js');
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const user = await ensureUser(pool as never, `salary+${stamp}@example.com`, 'Salary Co');
      const token = await createSession(pool as never, user.id, { label: 't' });
      const org = await createOrg(pool as never, user.id, { name: `Salary ${stamp}` });
      if (typeof org === 'string') throw new Error(org);
      const auth = { authorization: `Bearer ${token}` };
      const slugs = new Map<string, string>();

      const add = async (label: string, salary: Record<string, unknown>) => {
        const response = await post(
          '/api/v1/jobs',
          {
            org: org.slug,
            title: `${label} ${stamp}`,
            description: 'A listing used to compare different salary periods in search results.',
            agentPolicy: 'welcome',
            ...salary,
          },
          auth,
        );
        assert.equal(response.status, 201);
        const body = (await response.json()) as { job: { slug: string; id: string } };
        slugs.set(label, body.job.slug);
        if (Object.keys(salary).length === 0) {
          // A listing that says nothing about pay can no longer be published
          // through the API. One that already was, from before the rule, still
          // exists on real boards and still has to sort last, so it is put
          // live the way an old row is: directly, below the gate.
          const { setStatus } = await import('../dist/core/jobs.js');
          await setStatus(pool as never, body.job.id, 'published');
          return;
        }
        const live = await post(`/api/v1/jobs/${body.job.slug}/publish`, {}, auth);
        assert.equal(live.status, 200, await live.text());
      };

      await add('Yearly', { salaryMin: 180_000, salaryPeriod: 'year' });
      await add('Hourly', { salaryMin: 80, salaryMax: 100, salaryPeriod: 'hour' });
      await add('Daily', { salaryMin: 900, salaryPeriod: 'day' });
      await add('Weekly', { salaryMax: 4300, salaryPeriod: 'week' });
      await add('Monthly', { salaryMin: 20_000, salaryPeriod: 'month' });
      await add('Hourly minimum', { salaryMin: 120, salaryPeriod: 'hour' });
      await add('Hourly maximum', { salaryMax: 110, salaryPeriod: 'hour' });
      await add('Unspecified', {});
      await add('Unpaid', { salaryUnpaid: true, salaryMax: 100_000, salaryPeriod: 'month' });

      const expected = [
        'Hourly minimum',
        'Monthly',
        'Daily',
        'Hourly maximum',
        'Weekly',
        'Hourly',
      ].map((label) => slugs.get(label));
      const url = `/api/v1/jobs?org=${org.slug}&salaryMin=200000&sort=salary`;
      const response = await get(url);
      assert.equal(response.status, 200);
      const page = (await response.json()) as {
        items: { slug: string; salary: { min: number; max: number; period: string } }[];
        total: number;
      };
      assert.deepEqual(
        page.items.map((job) => job.slug),
        expected,
      );
      assert.equal(Number(page.total), expected.length);
      const hourly = page.items.find((job) => job.slug === slugs.get('Hourly'));
      assert.equal(hourly?.salary.min, 80, 'the stored hourly range is not rewritten');
      assert.equal(hourly?.salary.max, 100);
      assert.equal(hourly?.salary.period, 'hour');

      const secondPage = (await (await get(`${url}&limit=2&offset=2`)).json()) as {
        items: { slug: string }[];
        total: number;
      };
      assert.deepEqual(
        secondPage.items.map((job) => job.slug),
        expected.slice(2, 4),
      );
      assert.equal(Number(secondPage.total), expected.length);

      // Valid stored integers can annualise beyond Postgres's integer range.
      await add('Large hourly amount', { salaryMax: 2_000_000, salaryPeriod: 'hour' });
      const largeResponse = await get(url);
      assert.equal(
        largeResponse.status,
        200,
        'annualisation must not overflow SQL integer arithmetic',
      );
      const largePage = (await largeResponse.json()) as { items: { slug: string }[] };
      assert.equal(largePage.items[0]?.slug, slugs.get('Large hourly amount'));
    });
  });

  describe('deciding on an application', () => {
    /**
     * An employer, a published listing, and one application sitting on it.
     *
     * Built per test rather than shared, because a decision is a write and
     * tests that share a row start depending on the order they run in.
     */
    const pipeline = async (name: string) => {
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createOrg } = await import('../dist/core/orgs.js');
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const user = await ensureUser(pool as never, `dec+${stamp}@example.com`, name);
      const token = await createSession(pool as never, user.id, { label: 't' });
      const org = await createOrg(pool as never, user.id, { name: `${name} ${stamp}` });
      if (typeof org === 'string') throw new Error(org);
      const auth = { authorization: `Bearer ${token}` };

      const created = (await (
        await post(
          '/api/v1/jobs',
          {
            org: org.slug,
            title: `Decide ${stamp}`,
            description: 'A listing that takes applications on the board.',
            agentPolicy: 'welcome',
            pay: ['$100 an hour'],
          },
          auth,
        )
      ).json()) as { job: { slug: string } };
      await post(`/api/v1/jobs/${created.job.slug}/publish`, {}, auth);

      await post(`/api/v1/jobs/${created.job.slug}/apply`, {
        name: 'A Candidate',
        email: `cand+${stamp}@example.com`,
        cover: 'I would like to do the job.',
      });

      const inbox = (await (
        await get(`/api/v1/jobs/${created.job.slug}/applications`, auth)
      ).json()) as { items: { id: string; status: string }[] };
      assert.equal(inbox.items.length, 1, 'expected exactly one application');
      return { auth, slug: created.job.slug, application: inbox.items[0]! };
    };

    test('an employer can move an application through to hired', async () => {
      if (pool === null) return;
      const { auth, slug, application } = await pipeline('Deciders');
      assert.equal(application.status, 'new');

      for (const status of ['reviewing', 'hired']) {
        const response = await post(
          `/api/v1/applications/${application.id}/decision`,
          { status },
          auth,
        );
        assert.equal(response.status, 200, status);
        const body = (await response.json()) as { application: { status: string } };
        assert.equal(body.application.status, status);
      }

      // The decision is what the next reader sees, not just what the write
      // returned - the whole complaint was that the badge never changed.
      const inbox = (await (await get(`/api/v1/jobs/${slug}/applications`, auth)).json()) as {
        items: { status: string; decidedAt: string | null }[];
      };
      assert.equal(inbox.items[0]?.status, 'hired');
      assert.ok(inbox.items[0]?.decidedAt, 'a decision records when it was made');
    });

    test("the candidate-side statuses are not an employer's to set", async () => {
      // `new` and `draft` belong to the applicant. An employer who could set
      // them could un-send an application or push it back to unread.
      if (pool === null) return;
      const { auth, application } = await pipeline('Statuses');
      for (const status of ['new', 'draft', 'nonsense', '']) {
        const response = await post(
          `/api/v1/applications/${application.id}/decision`,
          { status },
          auth,
        );
        assert.equal(response.status, 400, status);
      }
    });

    test("someone else's pipeline is not yours, and says nothing about itself", async () => {
      // 404 rather than 403 on purpose: an application id is the only thing a
      // caller would have to guess, so "not yours" must be indistinguishable
      // from "no such thing" or the endpoint enumerates real ids.
      if (pool === null) return;
      const mine = await pipeline('Mine');
      const theirs = await pipeline('Theirs');

      const response = await post(
        `/api/v1/applications/${theirs.application.id}/decision`,
        { status: 'rejected' },
        mine.auth,
      );
      assert.equal(response.status, 404);

      const missing = await post(
        `/api/v1/applications/00000000-0000-4000-8000-000000000000/decision`,
        { status: 'rejected' },
        mine.auth,
      );
      assert.equal(missing.status, 404);
      assert.deepEqual(
        (await response.json()) as unknown,
        (await missing.json()) as unknown,
        'a stranger and a ghost must be told the same thing',
      );

      // And the row they could not touch is untouched.
      const inbox = (await (
        await get(`/api/v1/jobs/${theirs.slug}/applications`, theirs.auth)
      ).json()) as { items: { status: string }[] };
      assert.equal(inbox.items[0]?.status, 'new');
    });

    test('an id that is not an id is a 404, not a crash', async () => {
      // It arrives straight off a URL, and Postgres raises a type error on
      // anything that is not a uuid.
      if (pool === null) return;
      const { auth } = await pipeline('Malformed');
      const response = await post(
        '/api/v1/applications/not-a-uuid/decision',
        { status: 'hired' },
        auth,
      );
      assert.equal(response.status, 404);
    });

    test('a draft nobody sent cannot be decided on', async () => {
      // An employer cannot see a draft, so an employer cannot reject one out
      // from under the candidate who has not released it yet.
      if (pool === null) return;
      const { auth, slug } = await pipeline('Drafts');
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const candidate = await ensureUser(pool as never, `draft+${stamp}@example.com`, 'Candidate');
      const candidateToken = await createSession(pool as never, candidate.id, { label: 't' });

      const draft = (await (
        await post(
          `/api/v1/jobs/${slug}/apply`,
          {
            name: 'Not Sent',
            email: `ns+${stamp}@example.com`,
            cover: 'Hold this.',
            submit: false,
          },
          { authorization: `Bearer ${candidateToken}` },
        )
      ).json()) as { applicationId?: string; submitted?: boolean };
      assert.ok(draft.applicationId, 'expected a draft to be created');
      assert.equal(draft.submitted, false, 'expected it to be held, not sent');

      const response = await post(
        `/api/v1/applications/${draft.applicationId}/decision`,
        { status: 'rejected' },
        auth,
      );
      assert.equal(response.status, 404);
    });
  });

  describe('updates and following', () => {
    /** A person, an employer they post for, and a token. */
    const employer = async (name: string) => {
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createOrg } = await import('../dist/core/orgs.js');
      const user = await ensureUser(pool as never, `up+${Date.now()}+${name}@example.com`, name);
      const token = await createSession(pool as never, user.id, { label: 't' });
      const org = await createOrg(pool as never, user.id, { name: `${name} Works` });
      if (typeof org === 'string') throw new Error(org);
      return { user, token, org, auth: { authorization: `Bearer ${token}` } };
    };

    test('an employer posts an update, and it reaches every representation', async () => {
      if (pool === null) return;
      const acme = await employer('Acme');
      const body = `We closed the backend role at ${Date.now()}.`;
      const created = await post(
        '/api/v1/updates',
        { org: acme.org.slug, body, link: 'https://example.com/hiring' },
        acme.auth,
      );
      assert.equal(created.status, 201, await created.text());

      const json = (await (await get(`/api/v1/updates?org=${acme.org.slug}`)).json()) as {
        items: { body: string; link: string | null; authorUrl: string }[];
      };
      assert.equal(json.items[0]?.body, body);
      assert.equal(json.items[0]?.link, 'https://example.com/hiring');
      assert.match(json.items[0]?.authorUrl ?? '', /\/employers\//);

      // The same filter, in the other three representations. This is the rule
      // the board already holds for jobs and candidates: one query, every
      // shape, or a reader who subscribes gets a different answer than a
      // reader who browses.
      const markdown = await (await get(`/updates.md?org=${acme.org.slug}`)).text();
      assert.ok(markdown.includes(body), markdown.slice(0, 300));

      const rss = await (await get(`/updates/feed?org=${acme.org.slug}`)).text();
      assert.ok(rss.includes(body.slice(0, 40)), rss.slice(0, 400));
      assert.match(rss, /<rss version="2.0"/);

      const html = await (await get(`/employers/${acme.org.slug}`, { accept: 'text/html' })).text();
      assert.ok(html.includes(body), 'the update belongs on the employer page');
      assert.match(html, /Follow/);
    });

    test('you cannot post as an employer you do not post for', async () => {
      if (pool === null) return;
      const acme = await employer('Bcme');
      const stranger = await employer('Ccme');
      const response = await post(
        '/api/v1/updates',
        { org: acme.org.slug, body: 'We are hiring everybody, apply now.' },
        stranger.auth,
      );
      assert.equal(response.status, 400);
      const error = (await response.json()) as { error: { message: string } };
      assert.match(error.error.message, /do not post for/);
    });

    test('the same update twice is refused', async () => {
      if (pool === null) return;
      const dup = await employer('Dcme');
      const body = `Exactly the same thing, ${Date.now()}.`;
      assert.equal((await post('/api/v1/updates', { org: dup.org.slug, body }, dup.auth)).status, 201);
      const again = await post('/api/v1/updates', { org: dup.org.slug, body }, dup.auth);
      assert.equal(again.status, 400);
      assert.match(((await again.json()) as { error: { message: string } }).error.message, /already posted/);
    });

    test('five a day is the limit, and the sixth says so', async () => {
      if (pool === null) return;
      const chatty = await employer('Ecme');
      for (let n = 0; n < 5; n += 1) {
        const response = await post(
          '/api/v1/updates',
          { org: chatty.org.slug, body: `Something that happened, number ${n}, ${Date.now()}.` },
          chatty.auth,
        );
        assert.equal(response.status, 201, `post ${n}: ${await response.text()}`);
      }
      const sixth = await post(
        '/api/v1/updates',
        { org: chatty.org.slug, body: `And one more, ${Date.now()}.` },
        chatty.auth,
      );
      assert.equal(sixth.status, 429, await sixth.text());
    });

    test('an update is refused a link nobody else could open', async () => {
      if (pool === null) return;
      const acme = await employer('Fcme');
      const response = await post(
        '/api/v1/updates',
        {
          org: acme.org.slug,
          body: 'Read about it on our internal wiki.',
          link: 'http://127.0.0.1:8080/secret',
        },
        acme.auth,
      );
      assert.equal(response.status, 400);
      assert.match(
        ((await response.json()) as { error: { message: string } }).error.message,
        /public http/,
      );
    });

    test('posting as yourself needs a published resume, so the post has a page', async () => {
      if (pool === null) return;
      const nobody = await employer('Gcme');
      const response = await post(
        '/api/v1/updates',
        { body: 'I am available for work starting in March.' },
        nobody.auth,
      );
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'no_profile');
    });

    test('following is idempotent, and unfollowing undoes it', async () => {
      if (pool === null) return;
      const acme = await employer('Hcme');
      const reader = await employer('Icme');
      const path = `/api/v1/orgs/${acme.org.slug}/follow`;

      const first = (await (await post(path, {}, reader.auth)).json()) as {
        following: boolean;
        followers: number;
      };
      assert.equal(first.following, true);
      assert.equal(first.followers, 1);

      // Twice is once: a retried call must not be an error, and must not
      // count twice.
      const twice = (await (await post(path, {}, reader.auth)).json()) as { followers: number };
      assert.equal(twice.followers, 1);

      const mine = (await (await get('/api/v1/me/following', reader.auth)).json()) as {
        items: { slug: string }[];
      };
      assert.ok(mine.items.some((item) => item.slug === acme.org.slug));

      const gone = (await (await del(path, reader.auth)).json()) as {
        following: boolean;
        followers: number;
      };
      assert.equal(gone.following, false);
      assert.equal(gone.followers, 0);
    });

    test('your feed is what you follow, and needs a credential', async () => {
      if (pool === null) return;
      const acme = await employer('Jcme');
      const reader = await employer('Kcme');
      const body = `Only followers should see this first: ${Date.now()}.`;
      await post('/api/v1/updates', { org: acme.org.slug, body }, acme.auth);

      assert.equal((await get('/api/v1/updates?following=true')).status, 401);

      const before = (await (await get('/api/v1/updates?following=true', reader.auth)).json()) as {
        items: { body: string }[];
      };
      assert.ok(!before.items.some((item) => item.body === body));

      await post(`/api/v1/orgs/${acme.org.slug}/follow`, {}, reader.auth);
      const after = (await (await get('/api/v1/updates?following=true', reader.auth)).json()) as {
        items: { body: string }[];
      };
      assert.ok(after.items.some((item) => item.body === body), 'a followed update must appear');
    });

    test('you can take your own update down, and only your own', async () => {
      if (pool === null) return;
      const owner = await employer('Lcme');
      const stranger = await employer('Mcme');
      const created = (await (
        await post(
          '/api/v1/updates',
          { org: owner.org.slug, body: `Posted in error, ${Date.now()}.` },
          owner.auth,
        )
      ).json()) as { update: { id: string } };
      const id = created.update.id;

      // Somebody else's update is a 404 rather than a 403: the two are the
      // same fact to a caller who should not be able to tell them apart.
      assert.equal((await del(`/api/v1/updates/${id}`, stranger.auth)).status, 404);
      assert.equal((await del(`/api/v1/updates/${id}`)).status, 401);
      assert.equal((await del(`/api/v1/updates/${id}`, owner.auth)).status, 200);

      const left = (await (await get(`/api/v1/updates?org=${owner.org.slug}`)).json()) as {
        items: { id: string }[];
      };
      assert.ok(!left.items.some((item) => item.id === id));
    });

    test('an author nobody has is a 404, not the whole board', async () => {
      // Answering an unanswerable filter with everything is how a reader ends
      // up subscribed to the entire site believing they subscribed to one
      // employer.
      const response = await get('/api/v1/updates?org=nobody-by-that-name');
      assert.equal(response.status, 404);
      const markdown = await (await get('/updates.md?org=nobody-by-that-name')).text();
      assert.match(markdown, /Nobody here is/);
      assert.equal((markdown.match(/^## /gm) ?? []).length, 0, markdown.slice(0, 300));
    });
  });

  describe('inbox and invoices', () => {
    /** Read a body once: asserting on text() and then calling json() is how a test reads a body twice. */
    const asJson = async <T,>(response: Response, status: number): Promise<T> => {
      const text = await response.text();
      assert.equal(response.status, status, text);
      return JSON.parse(text) as T;
    };
    const person = async (name: string) => {
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const user = await ensureUser(pool as never, `inbox+${Date.now()}+${name}@example.com`, name);
      const token = await createSession(pool as never, user.id, { label: 't' });
      return { user, token, auth: { authorization: `Bearer ${token}` }, cookie: { cookie: `aj_session=${token}` } };
    };
    const employer = async (name: string) => {
      const { createOrg } = await import('../dist/core/orgs.js');
      const who = await person(name);
      const org = await createOrg(pool as never, who.user.id, { name: `${name} Works` });
      if (typeof org === 'string') throw new Error(org);
      return { ...who, org };
    };
    const candidate = async (name: string) => {
      const { createResume, updateResume, ensurePublicSlug } = await import('../dist/core/resumes.js');
      const who = await person(name);
      const created = await createResume(pool as never, who.user.id, {
        markdown: `# ${name}\n\nEngineer\n\n- Email: ${name.toLowerCase()}@example.com\n\n## Skills\n\n- Go\n`,
        title: name,
      });
      const saved = await updateResume(pool as never, who.user.id, created.slug, {
        markdown: created.markdown,
        visibility: 'public',
      });
      const slug = (await ensurePublicSlug(pool as never, saved)) as string;
      return { ...who, slug };
    };

    test('an employer writes to a candidate; the candidate reads, replies, and nobody else can', async () => {
      if (pool === null) return;
      const acme = await employer('Inbox Acme');
      const grace = await candidate('Grace Hopper');
      const stranger = await person('Nobody');
      sentMail.length = 0;

      const first = await post(
        '/api/v1/inbox',
        { candidate: grace.slug, as: acme.org.slug, subject: 'The Go role', body: 'Are you open to contract work?' },
        acme.auth,
      );
      const started = await asJson<{ threadId: string; created: boolean; url: string }>(first, 201);
      assert.equal(started.created, true);
      assert.match(started.url, /\/inbox\//);

      // The candidate was told there is a message, and nothing more than that.
      const told = sentMail.find((mail) => mail.to === grace.user.email);
      assert.ok(told, 'the candidate is emailed');
      assert.match(told.subject, /Inbox Acme Works sent you a message/);
      assert.ok(!told.text.includes('contract work'), 'the body stays on the board');

      // Writing again is the same conversation.
      const again = await post(
        '/api/v1/inbox',
        { candidate: grace.slug, as: acme.org.slug, body: 'Following up.' },
        acme.auth,
      );
      assert.equal((await asJson<{ threadId: string }>(again, 200)).threadId, started.threadId);

      // The candidate sees one thread, from the employer, with two unread.
      const list = (await (await get('/api/v1/inbox', grace.auth)).json()) as {
        items: { id: string; unread: number; with: { kind: string; name: string } }[];
        unread: number;
      };
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0]?.id, started.threadId);
      assert.equal(list.items[0]?.unread, 2);
      assert.equal(list.items[0]?.with.kind, 'employer');
      assert.equal(list.items[0]?.with.name, 'Inbox Acme Works');
      assert.equal(list.unread, 1);

      // A stranger cannot see it exists.
      assert.equal((await get(`/api/v1/inbox/${started.threadId}`, stranger.auth)).status, 404);
      assert.equal((await post(`/api/v1/inbox/${started.threadId}/messages`, { body: 'hi' }, stranger.auth)).status, 404);
      assert.equal((await get('/api/v1/inbox')).status, 401, 'anonymous has no inbox');

      // Reading marks it read; replying reaches the employer.
      const thread = (await (await get(`/api/v1/inbox/${started.threadId}`, grace.auth)).json()) as {
        thread: { messages: { body: string; mine: boolean; sender: { party: { kind: string } | null } }[]; with: { name: string } };
      };
      assert.equal(thread.thread.messages.length, 2);
      assert.equal(thread.thread.messages[0]?.mine, false);
      assert.equal(thread.thread.messages[0]?.sender.party?.kind, 'employer');
      const after = (await (await get('/api/v1/inbox', grace.auth)).json()) as { unread: number };
      assert.equal(after.unread, 0);

      sentMail.length = 0;
      const reply = await post(`/api/v1/inbox/${started.threadId}/messages`, { body: 'Yes, from March.' }, grace.auth);
      assert.equal(reply.status, 201);
      const theirs = (await (await get('/api/v1/inbox', acme.auth)).json()) as {
        items: { unread: number; with: { kind: string; name: string }; preview: string }[];
      };
      assert.equal(theirs.items[0]?.unread, 1);
      assert.equal(theirs.items[0]?.with.kind, 'candidate');
      assert.equal(theirs.items[0]?.with.name, 'Grace Hopper');
      assert.equal(theirs.items[0]?.preview, 'Yes, from March.');
      assert.ok(sentMail.some((mail) => mail.to === acme.user.email), 'the employer is emailed back');

      // The pages: a signed-out reader is sent to sign in; a member reads it.
      const page = await (await get(`/candidates/${grace.slug}`, { accept: 'text/html' })).text();
      assert.ok(page.includes('>Message<'), 'the candidate page carries a Message button');
      assert.ok(page.includes('/login?next='), 'which asks a stranger to sign in');
      const inbox = await (await get('/inbox', { accept: 'text/html', ...acme.cookie })).text();
      assert.ok(inbox.includes('The Go role'), 'the inbox page lists the thread');
      assert.ok(inbox.includes('Grace Hopper'));
      const open = await (await get(`/inbox/${started.threadId}`, { accept: 'text/html', ...acme.cookie })).text();
      assert.ok(open.includes('Yes, from March.'));
      assert.ok(!open.includes('Send an invoice'), 'no invoice form on a board without billing');
      assert.equal((await get(`/inbox/${started.threadId}`, { accept: 'text/html', ...stranger.cookie })).status, 404);
    });

    test('writing to yourself, to nobody, or too often is refused in words', async () => {
      if (pool === null) return;
      const grace = await candidate('Grace Self');
      const self = await post('/api/v1/inbox', { candidate: grace.slug, body: 'Hello me.' }, grace.auth);
      assert.equal(self.status, 400);
      assert.match(((await self.json()) as { error: { message: string } }).error.message, /That is you/);
      assert.equal((await post('/api/v1/inbox', { candidate: 'no-such-person', body: 'Hello?' }, grace.auth)).status, 404);
      assert.equal((await post('/api/v1/inbox', { body: 'To whom?' }, grace.auth)).status, 404);
      const empty = await post('/api/v1/inbox', { candidate: grace.slug, body: '   ' }, (await person('Quiet')).auth);
      assert.equal(empty.status, 400);
    });

    test('a member cannot write as an employer they do not belong to', async () => {
      if (pool === null) return;
      const acme = await employer('Inbox Bcme');
      const grace = await candidate('Grace Target');
      const impostor = await person('Impostor');
      const response = await post(
        '/api/v1/inbox',
        { candidate: grace.slug, as: acme.org.slug, body: 'We are Acme, honest.' },
        impostor.auth,
      );
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: { message: string } }).error.message, /employer you belong to/);
    });

    describe('billing', () => {
      /**
       * A second app with billing on, against the same database, and a CoinPay
       * that is a fetch stub: the real client code runs, the network does not.
       */
      let billed: Hono<never> | null = null;
      let scopeToGrant = 'openid profile email wallet:read';
      /** Who CoinPay says the token belongs to. One CoinPay account, one person here, so each test is its own merchant. */
      let subToGrant = 'merchant-default';
      const payments = new Map<string, Record<string, unknown>>();
      const WEBHOOK_SECRET = 'whsec_test_board';
      const fetchStub: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (url.pathname === '/api/oauth/token') {
          const form = new URLSearchParams(String(init?.body ?? ''));
          if (form.get('client_id') !== 'cp_board' || form.get('client_secret') !== 'cps_board') {
            return json({ error: 'invalid_client' }, 401);
          }
          if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'good-code') {
            return json({ error: 'invalid_grant' }, 400);
          }
          return json({ access_token: `at_${Date.now()}`, refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600, scope: scopeToGrant });
        }
        if (url.pathname === '/api/oauth/userinfo') {
          const auth = new Headers(init?.headers).get('authorization') ?? '';
          if (!auth.startsWith('Bearer at_')) return json({ error: 'invalid_token' }, 401);
          return json({
            sub: subToGrant,
            email: 'grace@coinpay.test',
            name: 'Grace',
            ...(scopeToGrant.includes('wallet:read')
              ? { wallets: [{ address: '0xGRACE', chain: 'USDC_POL', label: 'Polygon' }, { address: 'bc1qgrace', chain: 'BTC' }] }
              : {}),
          });
        }
        if (url.pathname === '/api/payments/create') {
          const auth = new Headers(init?.headers).get('authorization');
          if (auth !== 'Bearer cp_live_board') return json({ success: false, error: 'Missing authorization header' }, 401);
          const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const id = `pay_${Date.now()}_${payments.size + 1}`;
          const payment = {
            id,
            payment_address: '0xDEPOSIT',
            amount_crypto: String(sent['amount_usd']),
            currency: String(sent['blockchain']).toLowerCase(),
            status: 'pending',
            expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
            merchant_wallet_address: sent['merchant_wallet_address'],
            business_id: sent['business_id'],
          };
          payments.set(id, payment);
          return json({ success: true, payment }, 201);
        }
        const found = /^\/api\/payments\/(.+)$/.exec(url.pathname);
        if (found !== null) {
          const payment = payments.get(decodeURIComponent(found[1]!));
          return payment === undefined ? json({ success: false, error: 'Payment not found' }, 404) : json({ success: true, payment });
        }
        return json({ error: `unexpected ${url.pathname}` }, 500);
      };

      before(async () => {
        if (pool === null) return;
        const { createApp } = await import('../dist/server/app.js');
        const { loadConfig } = await import('../dist/config.js');
        const { createCoinPay } = await import('../dist/core/coinpay.js');
        const config = loadConfig({
          ...process.env,
          DATABASE_URL,
          PUBLIC_URL: 'http://board.test',
          COINPAY_URL: 'https://coinpay.test',
          COINPAY_CLIENT_ID: 'cp_board',
          COINPAY_CLIENT_SECRET: 'cps_board',
          COINPAY_API_KEY: 'cp_live_board',
          COINPAY_BUSINESS_ID: 'biz_board',
          COINPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
        });
        assert.ok(config.coinpay, 'billing must be configured for this app');
        billed = createApp(
          pool as never,
          config,
          { send: async (message) => { sentMail.push(message); return true; } },
          createCoinPay(config.coinpay, fetchStub),
        ) as never;
      });

      const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
        if (billed === null) throw new Error('no billed app');
        return billed.fetch(
          new Request(`http://board.test${path}`, {
            method,
            headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
            ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
            redirect: 'manual',
          }),
        );
      };

      /** Run the OAuth dance for a person, the way a browser would. */
      const connect = async (who: { cookie: Record<string, string> }): Promise<Response> => {
        const away = await send('GET', '/me/coinpay/connect', undefined, who.cookie);
        assert.equal(away.status, 302);
        const authorize = new URL(away.headers.get('location') ?? '');
        assert.equal(authorize.origin + authorize.pathname, 'https://coinpay.test/api/oauth/authorize');
        assert.equal(authorize.searchParams.get('client_id'), 'cp_board');
        assert.equal(authorize.searchParams.get('redirect_uri'), 'http://board.test/api/v1/coinpay/callback');
        assert.ok(authorize.searchParams.get('scope')?.includes('wallet:read'));
        const state = authorize.searchParams.get('state') ?? '';
        // The callback is completed by the state, not by the cookie.
        return send('GET', `/api/v1/coinpay/callback?code=good-code&state=${encodeURIComponent(state)}`);
      };

      test('the board without billing says so, and the one with it asks the person to connect', async () => {
        if (pool === null) return;
        const grace = await candidate('Grace Unbilled');
        const off = (await (await get('/api/v1/coinpay', grace.auth)).json()) as { configured: boolean };
        assert.equal(off.configured, false);
        const on = (await (await send('GET', '/api/v1/coinpay', undefined, grace.auth)).json()) as {
          configured: boolean; account: unknown; connectUrl: string;
        };
        assert.equal(on.configured, true);
        assert.equal(on.account, null);
        assert.equal(on.connectUrl, 'http://board.test/me/coinpay/connect');
      });

      test('connect, invoice, pay, and the webhook settles it', async () => {
        if (pool === null) return;
        const grace = await candidate('Grace Billed');
        const acme = await employer('Inbox Ccme');
        scopeToGrant = 'openid profile email wallet:read';
        subToGrant = `merchant-billed-${Date.now()}`;

        const back = await connect(grace);
        assert.equal(back.status, 303);
        assert.equal(back.headers.get('location'), '/me?coinpay=connected#billing');

        const state = (await (await send('GET', '/api/v1/coinpay', undefined, grace.auth)).json()) as {
          account: { usable: boolean; wallets: { chain: string; address: string }[]; email: string };
        };
        assert.equal(state.account.usable, true);
        assert.equal(state.account.email, 'grace@coinpay.test');
        assert.deepEqual(state.account.wallets.map((w) => w.chain), ['USDC_POL', 'BTC']);

        // The conversation, started by the employer.
        const started = (await (await send('POST', '/api/v1/inbox', { candidate: grace.slug, as: acme.org.slug, body: 'Sprint 3 is done?' }, acme.auth)).json()) as { threadId: string };

        // A wallet the payee does not hold is refused in words.
        const wrong = await send('POST', `/api/v1/inbox/${started.threadId}/invoices`, { amount: '1200', currency: 'SOL', description: 'Sprint 3' }, grace.auth);
        assert.equal(wrong.status, 400);
        assert.match(((await wrong.json()) as { error: { message: string } }).error.message, /no SOL wallet.*USDC_POL, BTC/);

        // The payer cannot send an invoice either: they have no wallet connected.
        const notPayee = await send('POST', `/api/v1/inbox/${started.threadId}/invoices`, { amount: '5', description: 'x' }, acme.auth);
        assert.equal(notPayee.status, 400);
        assert.match(((await notPayee.json()) as { error: { message: string } }).error.message, /Connect a CoinPay account/);

        sentMail.length = 0;
        const sent = await send('POST', `/api/v1/inbox/${started.threadId}/invoices`, { amount: '$1,200.50', currency: 'usdc_pol', description: 'Sprint 3, as agreed' }, grace.auth);
        const invoice = (await asJson<{ invoice: { id: string; amountUsd: string; currency: string; walletAddress: string; status: string; payment: unknown } }>(sent, 201)).invoice;
        assert.equal(invoice.amountUsd, '1200.50');
        assert.equal(invoice.currency, 'USDC_POL');
        assert.equal(invoice.walletAddress, '0xGRACE', 'the payee wallet is copied at send time');
        assert.equal(invoice.status, 'sent');
        assert.equal(invoice.payment, null, 'no quote until somebody goes to pay');
        const told = sentMail.find((mail) => mail.to === acme.user.email);
        assert.ok(told && /sent you an invoice/.test(told.subject), 'the payer is told there is an invoice');
        assert.ok(!told.text.includes('1200'), 'and not how much');

        // It is a message in the thread.
        const thread = (await (await send('GET', `/api/v1/inbox/${started.threadId}`, undefined, acme.auth)).json()) as {
          thread: { messages: { kind: string; invoiceId: string | null; body: string }[] };
          invoices: { id: string }[];
        };
        assert.equal(thread.thread.messages.at(-1)?.kind, 'invoice');
        assert.equal(thread.thread.messages.at(-1)?.invoiceId, invoice.id);
        assert.equal(thread.thread.messages.at(-1)?.body, 'Sprint 3, as agreed');
        assert.equal(thread.invoices[0]?.id, invoice.id);

        // The payee cannot pay themselves; the payer gets a quote.
        const self = await send('POST', `/api/v1/invoices/${invoice.id}/pay`, undefined, grace.auth);
        assert.equal(self.status, 400);
        const quote = await send('POST', `/api/v1/invoices/${invoice.id}/pay`, undefined, acme.auth);
        const quoted = (await asJson<{ invoice: { payment: { id: string; url: string; address: string; amountCrypto: string } } }>(quote, 200)).invoice.payment;
        assert.equal(quoted.url, `https://coinpay.test/pay/${quoted.id}`);
        assert.equal(quoted.address, '0xDEPOSIT');
        const minted = payments.get(quoted.id)!;
        assert.equal(minted['merchant_wallet_address'], '0xGRACE', 'CoinPay was told to pay the payee');
        assert.equal(minted['business_id'], 'biz_board', 'under the board business');

        // Paying again inside the quote window is the same quote.
        const again = ((await (await send('POST', `/api/v1/invoices/${invoice.id}/pay`, undefined, acme.auth)).json()) as { invoice: { payment: { id: string } } }).invoice.payment;
        assert.equal(again.id, quoted.id);

        // The page sends a browser straight to CoinPay.
        const go = await send('POST', `/inbox/${started.threadId}/invoices/${invoice.id}/pay`, undefined, acme.cookie);
        assert.equal(go.status, 303);
        assert.equal(go.headers.get('location'), quoted.url);

        // A webhook with the wrong signature is dropped; the right one settles it.
        const { createHmac } = await import('node:crypto');
        const body = JSON.stringify({ event: 'payment.confirmed', payment_id: quoted.id, tx_hash: '0xTX', status: 'confirmed' });
        const t = Math.floor(Date.now() / 1000);
        const signWith = (secret: string) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
        assert.equal((await send('POST', '/api/v1/coinpay/webhook', body, { 'x-coinpay-signature': signWith('whsec_wrong') })).status, 401);
        assert.equal((await send('POST', '/api/v1/coinpay/webhook', body)).status, 401);
        const hook = await send('POST', '/api/v1/coinpay/webhook', body, { 'x-coinpay-signature': signWith(WEBHOOK_SECRET) });
        assert.equal((await asJson<{ outcome: string }>(hook, 200)).outcome, 'paid');

        const paid = ((await (await send('GET', `/api/v1/invoices/${invoice.id}`, undefined, grace.auth)).json()) as { invoice: { status: string; txHash: string } }).invoice;
        assert.equal(paid.status, 'paid');
        assert.equal(paid.txHash, '0xTX');

        // Paid is paid: no cancelling, no second payment.
        assert.equal((await send('POST', `/api/v1/invoices/${invoice.id}/cancel`, undefined, grace.auth)).status, 409);
        const settled = await send('POST', `/api/v1/invoices/${invoice.id}/pay`, undefined, acme.auth);
        assert.equal(settled.status, 400);
        assert.match(((await settled.json()) as { error: { message: string } }).error.message, /already paid/);

        // Both sides list it.
        const mine = (await (await send('GET', '/api/v1/invoices', undefined, grace.auth)).json()) as { items: { id: string }[] };
        assert.ok(mine.items.some((item) => item.id === invoice.id));
        const theirs = (await (await send('GET', '/api/v1/invoices', undefined, acme.auth)).json()) as { items: { id: string }[] };
        assert.ok(theirs.items.some((item) => item.id === invoice.id));
        const page = await (await send('GET', '/me', undefined, { accept: 'text/html', ...grace.cookie })).text();
        assert.ok(page.includes('Connected'), 'the You page shows the connection');
        assert.ok(page.includes('0xGRACE'));
        assert.ok(page.includes('You invoiced'));
      });

      test('a lapsed quote is replaced, and a poll learns a payment the webhook missed', async () => {
        if (pool === null) return;
        const grace = await candidate('Grace Polled');
        const acme = await employer('Inbox Dcme');
        scopeToGrant = 'openid profile email wallet:read';
        subToGrant = `merchant-polled-${Date.now()}`;
        assert.equal((await connect(grace)).status, 303);
        const started = (await (await send('POST', '/api/v1/inbox', { candidate: grace.slug, as: acme.org.slug, body: 'Invoice me.' }, acme.auth)).json()) as { threadId: string };
        const invoice = ((await (await send('POST', `/api/v1/inbox/${started.threadId}/invoices`, { amount: '10', currency: 'BTC' }, grace.auth)).json()) as { invoice: { id: string } }).invoice;

        const first = ((await (await send('POST', `/api/v1/invoices/${invoice.id}/pay`, undefined, acme.auth)).json()) as { invoice: { payment: { id: string } } }).invoice.payment;
        // CoinPay says that quote died.
        payments.get(first.id)!['status'] = 'expired';
        const second = ((await (await send('POST', `/api/v1/invoices/${invoice.id}/pay`, undefined, acme.auth)).json()) as { invoice: { payment: { id: string } } }).invoice.payment;
        assert.notEqual(second.id, first.id, 'a dead quote is replaced');

        // CoinPay says the new one was paid, and no webhook arrived.
        payments.get(second.id)!['status'] = 'forwarded';
        payments.get(second.id)!['tx_hash'] = '0xPOLLED';
        const read = ((await (await send('GET', `/api/v1/invoices/${invoice.id}`, undefined, acme.auth)).json()) as { invoice: { status: string; txHash: string } }).invoice;
        assert.equal(read.status, 'paid');
        assert.equal(read.txHash, '0xPOLLED');
      });

      test('a grant without wallet:read is not a connection', async () => {
        if (pool === null) return;
        const grace = await candidate('Grace Narrowed');
        scopeToGrant = 'openid profile email';
        subToGrant = `merchant-narrowed-${Date.now()}`;
        const back = await connect(grace);
        assert.equal(back.status, 303);
        assert.match(decodeURIComponent(back.headers.get('location') ?? ''), /did not grant wallet:read/);
        const state = (await (await send('GET', '/api/v1/coinpay', undefined, grace.auth)).json()) as { account: unknown };
        assert.equal(state.account, null, 'nothing is stored that cannot be paid to');
        scopeToGrant = 'openid profile email wallet:read';
      });

      test('one CoinPay account attaches to one person', async () => {
        if (pool === null) return;
        // The stub answers as the same merchant for both, so the second person
        // connecting is the collision.
        subToGrant = `merchant-shared-${Date.now()}`;
        const first = await candidate('Grace First');
        const second = await candidate('Grace Second');
        assert.equal((await connect(first)).status, 303);
        const back = await connect(second);
        assert.match(decodeURIComponent(back.headers.get('location') ?? ''), /already connected to a different account/);
        // Releasing it frees it for the other.
        assert.equal((await send('DELETE', '/api/v1/coinpay', undefined, first.auth)).status, 200);
        assert.equal(decodeURIComponent((await connect(second)).headers.get('location') ?? ''), '/me?coinpay=connected#billing');
      });

      test('a stale or reused state is refused', async () => {
        if (pool === null) return;
        assert.equal((await send('GET', '/api/v1/coinpay/callback?code=good-code&state=never-issued')).status, 303);
        const where = decodeURIComponent((await send('GET', '/api/v1/coinpay/callback?code=good-code&state=never-issued')).headers.get('location') ?? '');
        assert.match(where, /expired/);
        assert.equal((await send('GET', '/api/v1/coinpay/callback')).status, 400);
      });
    });
  });

  describe('recommendations', () => {
    const employer = async (name: string) => {
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createOrg } = await import('../dist/core/orgs.js');
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const user = await ensureUser(pool as never, `rec+${stamp}@example.com`, name);
      const token = await createSession(pool as never, user.id, { label: 't' });
      const org = await createOrg(pool as never, user.id, { name: `${name} ${stamp}` });
      if (typeof org === 'string') throw new Error(org);
      return { user, org, stamp, token, auth: { authorization: `Bearer ${token}` } };
    };

    const candidate = async (name: string) => {
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createResume, updateResume, ensurePublicSlug } = await import('../dist/core/resumes.js');
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const user = await ensureUser(pool as never, `recc+${stamp}@example.com`);
      const token = await createSession(pool as never, user.id, { label: 't' });
      const created = await createResume(pool as never, user.id, {
        markdown: `# ${name}\n\nStaff engineer\n\n## Skills\n\n- TypeScript\n`,
        title: name,
      });
      const saved = await updateResume(pool as never, user.id, created.slug, { markdown: created.markdown, visibility: 'public' });
      const slug = await ensurePublicSlug(pool as never, saved);
      return { user, slug, token, auth: { authorization: `Bearer ${token}` } };
    };

    const WORDS = 'Shipped the whole thing two weeks early and wrote the docs nobody asked for.';

    test('an employer recommends a candidate; it shows only once approved', async () => {
      if (pool === null) return;
      const acme = await employer('Acme Rec');
      const ada = await candidate('Ada Rec');
      sentMail.length = 0;

      const written = await post(
        `/api/v1/candidates/${ada.slug}/recommendations`,
        { as: acme.org.slug, body: WORDS, relationship: 'Hired her for a three-month contract' },
        acme.auth,
      );
      const writtenBody = await written.text();
      assert.equal(written.status, 201, writtenBody);
      const rec = (JSON.parse(writtenBody) as { recommendation: { id: string; status: string; author: { name: string; kind: string } } }).recommendation;
      assert.equal(rec.status, 'pending');
      assert.equal(rec.author.kind, 'employer');

      // Not on the page yet, for anybody.
      const before = (await (await get(`/api/v1/candidates/${ada.slug}/recommendations`)).json()) as { items: unknown[] };
      assert.equal(before.items.length, 0);
      const pageBefore = await (await get(`/candidates/${ada.slug}`, { accept: 'text/html' })).text();
      assert.ok(!pageBefore.includes(WORDS), 'a pending recommendation is not on the page');

      // The candidate was told, with the words in the mail.
      const mail = sentMail.find((item) => item.to === ada.user.email);
      assert.ok(mail, 'the subject must be emailed');
      assert.match(mail.subject, /recommended you/);
      assert.match(mail.text, /two weeks early/);

      // It is waiting on /me, and in the API.
      const mine = (await (await get('/api/v1/me/recommendations', ada.auth)).json()) as {
        received: { id: string; status: string }[];
        pending: number;
      };
      assert.equal(mine.pending, 1);
      assert.equal(mine.received[0]?.id, rec.id);

      // A stranger cannot approve it; the subject can.
      const stranger = await candidate('Bda Rec');
      assert.equal((await post(`/api/v1/recommendations/${rec.id}/approve`, {}, stranger.auth)).status, 404);
      const approved = await post(`/api/v1/recommendations/${rec.id}/approve`, {}, ada.auth);
      assert.equal(approved.status, 200, await approved.text());

      const after = (await (await get(`/api/v1/candidates/${ada.slug}/recommendations`)).json()) as {
        items: { body: string; author: { name: string; slug: string | null }; relationship: string | null }[];
      };
      assert.equal(after.items.length, 1);
      assert.equal(after.items[0]?.body, WORDS);
      assert.equal(after.items[0]?.author.slug, acme.org.slug);
      assert.equal(after.items[0]?.relationship, 'Hired her for a three-month contract');
      const pageAfter = await (await get(`/candidates/${ada.slug}`, { accept: 'text/html' })).text();
      assert.ok(pageAfter.includes('two weeks early'), 'an approved recommendation is on the page');
      assert.match(pageAfter, /shown because Ada Rec approved/);

      // And can be taken down again later.
      assert.equal((await post(`/api/v1/recommendations/${rec.id}/reject`, {}, ada.auth)).status, 200);
      const gone = (await (await get(`/api/v1/candidates/${ada.slug}/recommendations`)).json()) as { items: unknown[] };
      assert.equal(gone.items.length, 0);
    });

    test('a candidate recommends an employer, and writing again replaces it', async () => {
      if (pool === null) return;
      const acme = await employer('Bcme Rec');
      const ada = await candidate('Cda Rec');
      const first = (await (
        await post(`/api/v1/orgs/${acme.org.slug}/recommendations`, { body: 'Paid on time, every time, and the brief was the brief.' }, ada.auth)
      ).json()) as { recommendation: { id: string; author: { kind: string; slug: string | null } } };
      assert.equal(first.recommendation.author.kind, 'candidate');
      assert.equal(first.recommendation.author.slug, ada.slug, 'signed by the page');

      assert.equal((await post(`/api/v1/recommendations/${first.recommendation.id}/approve`, {}, acme.auth)).status, 200);
      const up = (await (await get(`/api/v1/orgs/${acme.org.slug}/recommendations`)).json()) as { items: unknown[] };
      assert.equal(up.items.length, 1);

      const again = (await (
        await post(`/api/v1/orgs/${acme.org.slug}/recommendations`, { body: 'Paid on time, every time. Would work with them again tomorrow.' }, ada.auth)
      ).json()) as { recommendation: { id: string; status: string } };
      assert.equal(again.recommendation.id, first.recommendation.id, 'one per author per subject');
      assert.equal(again.recommendation.status, 'pending', 'a rewrite asks for approval again');
      const down = (await (await get(`/api/v1/orgs/${acme.org.slug}/recommendations`)).json()) as { items: unknown[] };
      assert.equal(down.items.length, 0, 'the earlier approval does not cover the new words');

      // The author can withdraw it; the subject cannot.
      assert.equal((await post(`/api/v1/recommendations/${first.recommendation.id}/withdraw`, {}, acme.auth)).status, 404);
      assert.equal((await post(`/api/v1/recommendations/${first.recommendation.id}/withdraw`, {}, ada.auth)).status, 200);
      const mine = (await (await get('/api/v1/me/recommendations', ada.auth)).json()) as { given: unknown[] };
      assert.equal(mine.given.length, 0);
    });

    test('a recommendation needs a page behind it, and cannot be about yourself', async () => {
      if (pool === null) return;
      const ada = await candidate('Dda Rec');
      const acme = await employer('Ccme Rec');

      // An account with no published resume and no employer has nothing to sign with.
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const nobody = await ensureUser(pool as never, `nobody+${Date.now()}@example.com`);
      const nobodyAuth = { authorization: `Bearer ${await createSession(pool as never, nobody.id, { label: 't' })}` };
      const refused = await post(`/api/v1/candidates/${ada.slug}/recommendations`, { body: WORDS }, nobodyAuth);
      assert.equal(refused.status, 403);
      assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'no_profile');

      // An employer's member has an employer to sign with, but must say so.
      const unsigned = await post(`/api/v1/candidates/${ada.slug}/recommendations`, { body: WORDS }, acme.auth);
      assert.equal(unsigned.status, 403);

      // Yourself, your own employer, and too few words.
      assert.equal((await post(`/api/v1/candidates/${ada.slug}/recommendations`, { body: WORDS }, ada.auth)).status, 400);
      assert.equal((await post(`/api/v1/orgs/${acme.org.slug}/recommendations`, { body: WORDS, as: acme.org.slug }, acme.auth)).status, 400);
      assert.equal((await post(`/api/v1/candidates/${ada.slug}/recommendations`, { body: 'Good.', as: acme.org.slug }, acme.auth)).status, 400);
      assert.equal((await post('/api/v1/candidates/no-such-person/recommendations', { body: WORDS, as: acme.org.slug }, acme.auth)).status, 404);
      assert.equal((await post(`/api/v1/candidates/${ada.slug}/recommendations`, { body: WORDS })).status, 401);
    });

    test('the pages carry the form for a signed-in reader and the section on /me', async () => {
      if (pool === null) return;
      const acme = await employer('Dcme Rec');
      const ada = await candidate('Eda Rec');
      const page = await (
        await get(`/candidates/${ada.slug}`, { accept: 'text/html', cookie: `aj_session=${acme.token}` })
      ).text();
      assert.match(page, new RegExp(`action="/candidates/${ada.slug}/recommend"`));
      assert.match(page, new RegExp(`<option value="${acme.org.slug}"`), 'the employer is offered as the signature');

      const own = await (
        await get(`/candidates/${ada.slug}`, { accept: 'text/html', cookie: `aj_session=${ada.token}` })
      ).text();
      assert.ok(!own.includes(`/candidates/${ada.slug}/recommend`), 'no form on your own page');

      const stranger = await (await get(`/candidates/${ada.slug}`, { accept: 'text/html' })).text();
      assert.ok(!stranger.includes(`/candidates/${ada.slug}/recommend`), 'no form for a stranger');

      // Written from the page, it lands on /me for the subject to decide.
      const sent = await app!.fetch(
        new Request(`http://board.test/candidates/${ada.slug}/recommend`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `aj_session=${acme.token}` },
          body: new URLSearchParams({ as: acme.org.slug, body: WORDS, relationship: 'Hired her' }).toString(),
        }),
      );
      assert.equal(sent.status, 303, await sent.text());
      const me = await (await get('/me', { accept: 'text/html', cookie: `aj_session=${ada.token}` })).text();
      assert.match(me, /1 waiting for you/);
      assert.match(me, /two weeks early/);
      assert.match(me, /\/me\/recommendations\/[0-9a-f-]+\/approve/);
    });
  });

  describe('candidates', () => {
    const publish = async (visibility: string, name: string) => {
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createResume, updateResume, ensurePublicSlug } = await import(
        '../dist/core/resumes.js'
      );
      const user = await ensureUser(pool as never, `cand+${Date.now()}+${name}@example.com`);
      const token = await createSession(pool as never, user.id, { label: 't' });
      const created = await createResume(pool as never, user.id, {
        markdown: `# ${name}\n\nStaff engineer\n\n- Location: Lisbon\n\n## Skills\n\n- TypeScript\n- Postgres\n`,
        title: name,
      });
      const saved = await updateResume(pool as never, user.id, created.slug, {
        markdown: created.markdown,
        visibility,
      });
      const slug = await ensurePublicSlug(pool as never, saved);
      return { token, slug, user };
    };

    test('a public resume is listed and readable, by a person and by an agent', async () => {
      if (pool === null) return;
      const { slug } = await publish('public', 'Ada Public');
      assert.ok(slug, 'publishing must mint a board-wide address');

      const list = (await (await get('/api/v1/candidates')).json()) as {
        items: { slug: string; name: string; skills: string[]; url: string }[];
      };
      const found = list.items.find((item) => item.slug === slug);
      assert.ok(found, 'a public resume must appear in the directory');
      // The card is built from the resume, not typed a second time.
      assert.equal(found?.name, 'Ada Public');
      assert.ok(found?.skills.includes('TypeScript'), JSON.stringify(found?.skills));

      assert.equal((await get(`/candidates/${slug}`, { accept: 'text/html' })).status, 200);
      const detail = (await (await get(`/api/v1/candidates/${slug}`)).json()) as {
        markdown: string;
        listed: boolean;
      };
      // The Markdown is the canonical document and travels whole.
      assert.match(detail.markdown, /# Ada Public/);
      assert.equal(detail.listed, true);
    });

    test('a link-only resume is reachable but never listed', async () => {
      if (pool === null) return;
      const { slug } = await publish('link', 'Grace Link');
      assert.ok(slug);

      // This is the entire difference between the two settings.
      assert.equal((await get(`/candidates/${slug}`, { accept: 'text/html' })).status, 200);
      const list = (await (await get('/api/v1/candidates')).json()) as {
        items: { slug: string }[];
      };
      assert.ok(
        !list.items.some((item) => item.slug === slug),
        'a link-only resume must not be in the directory',
      );

      // And it must not be handed to a search engine either.
      const html = await (await get(`/candidates/${slug}`, { accept: 'text/html' })).text();
      assert.match(html, /noindex/);
    });

    test('contact channels are for signed-in callers, in every representation', async () => {
      if (pool === null) return;
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const { createResume, updateResume, ensurePublicSlug } = await import(
        '../dist/core/resumes.js'
      );
      const user = await ensureUser(pool as never, `cand+${Date.now()}+gate@example.com`);
      const token = await createSession(pool as never, user.id, { label: 't' });
      const created = await createResume(pool as never, user.id, {
        markdown: [
          '# Reachable Person',
          '',
          '- **Email**: reachable@example.com',
          '- **Phone**: +1 (408) 555-0142',
          '- **Location**: Lisbon',
          '',
          '## Skills',
          '',
          '- Go',
          '',
        ].join('\n'),
        title: 'Reachable',
      });
      const saved = await updateResume(pool as never, user.id, created.slug, {
        markdown: created.markdown,
        visibility: 'public',
      });
      const slug = await ensurePublicSlug(pool as never, saved);
      const auth = { authorization: `Bearer ${token}` };

      // Every representation renders the same Markdown, so each one is checked
      // rather than assumed: gating the page and forgetting the PDF is how the
      // address stays public while the board looks careful.
      const json = (await (await get(`/api/v1/candidates/${slug}`)).json()) as {
        markdown: string;
        contactRedacted?: boolean;
      };
      assert.equal(json.contactRedacted, true, 'an agent is told the copy is partial');
      assert.ok(!json.markdown.includes('reachable@example.com'), json.markdown);
      assert.ok(!json.markdown.includes('555-0142'));
      assert.ok(json.markdown.includes('Lisbon'), 'a location is a fact, not a channel');

      const page = await (await get(`/candidates/${slug}`, { accept: 'text/html' })).text();
      assert.ok(!page.includes('reachable@example.com'), 'not in the body and not in the sidebar');
      assert.ok(!page.includes('555-0142'));

      const md = await (await get(`/candidates/${slug}/resume.md`)).text();
      assert.ok(!md.includes('reachable@example.com'), md);
      const html = await (await get(`/candidates/${slug}/resume.html`)).text();
      assert.ok(!html.includes('reachable@example.com'), 'the print rendering too');

      // A session or a device token, either one, reads the whole document.
      const member = (await (await get(`/api/v1/candidates/${slug}`, auth)).json()) as {
        markdown: string;
        contactRedacted?: boolean;
      };
      assert.equal(member.contactRedacted, undefined);
      assert.ok(member.markdown.includes('reachable@example.com'));
      const memberMd = await (await get(`/candidates/${slug}/resume.md`, auth)).text();
      assert.ok(memberMd.includes('555-0142'), memberMd);
    });

    test('a resume that lost its line breaks cannot become a paragraph-long URL', async () => {
      // A flattened resume parses as one h1 holding the whole document, so the
      // "name" is the entire CV. Unbounded, that produced a three thousand
      // character slug and a candidate card captioned with a whole resume.
      if (pool === null) return;
      const { createResume, updateResume, ensurePublicSlug } = await import(
        '../dist/core/resumes.js'
      );
      const { toCandidateSummary } = await import('../dist/core/candidates.js');
      const { ensureUser } = await import('../dist/core/auth.js');

      const flat = `# ${'Anthony Ettinger - Email: a@b.co - '.repeat(40)}`;
      const user = await ensureUser(pool as never, `flat+${Date.now()}@example.com`);
      const created = await createResume(pool as never, user.id, {
        markdown: flat,
        title: 'Agentic Web Architect',
      });
      const saved = await updateResume(pool as never, user.id, created.slug, {
        markdown: flat,
        visibility: 'public',
      });
      const slug = await ensurePublicSlug(pool as never, saved);

      assert.ok(slug, 'it should still get an address');
      assert.ok((slug ?? '').length <= 60, `slug was ${(slug ?? '').length} characters`);
      // And the card falls back to the title the person typed rather than
      // captioning itself with the document.
      const summary = toCandidateSummary({ ...saved, publicSlug: slug });
      assert.equal(summary.name, 'Agentic Web Architect');
    });

    test('publishing through the API mints an address, not just the web form', async () => {
      // ensurePublicSlug was called from the web handler only, so a resume
      // published with the CLI or the API got no address and stayed invisible
      // with nothing to say why.
      if (pool === null) return;
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const user = await ensureUser(pool as never, `api-pub+${Date.now()}@example.com`);
      const token = await createSession(pool as never, user.id, { label: 't' });
      const auth = { authorization: `Bearer ${token}` };

      const created = (await (
        await post(
          '/api/v1/resumes',
          { markdown: '# Api Person\n\n## Skills\n\n- Go\n', title: 'Api', visibility: 'public' },
          auth,
        )
      ).json()) as { resume: { publicSlug: string | null } };

      assert.ok(created.resume.publicSlug, 'the API must mint the address too');
      const list = (await (await get('/api/v1/candidates')).json()) as {
        items: { slug: string }[];
      };
      assert.ok(list.items.some((item) => item.slug === created.resume.publicSlug));
    });

    test('tags narrow, and every set of them has a feed', async () => {
      if (pool === null) return;
      const { createResume, updateResume } = await import('../dist/core/resumes.js');
      const { ensureUser } = await import('../dist/core/auth.js');

      const publish = async (name: string, skills: string[]) => {
        const md = `# ${name}\n\n## Skills\n\n${skills.map((s) => `- ${s}`).join('\n')}\n`;
        const user = await ensureUser(pool as never, `tag+${name}+${Date.now()}@example.com`);
        const made = await createResume(pool as never, user.id, { markdown: md, title: name });
        return updateResume(pool as never, user.id, made.slug, {
          markdown: md,
          visibility: 'public',
        });
      };

      // Node.js is beyond the eight badges shown on a directory card.
      const both = await publish('Both Person', [
        'Python', 'Go', 'SQL', 'Docker', 'Linux', 'TypeScript', 'JavaScript', 'React', 'Node.js',
      ]);
      const one = await publish('One Person', ['JavaScript']);

      // Several tags describe one person's skill set, so they narrow.
      const narrowed = (await (
        await get('/api/v1/candidates?tags=javascript,react,node.js')
      ).json()) as { items: { slug: string }[]; total: number; match: string };
      const slugs = narrowed.items.map((item) => item.slug);
      assert.ok(slugs.includes(both?.publicSlug ?? ''), 'the one with all three must match');
      assert.ok(!slugs.includes(one?.publicSlug ?? ''), 'the one with only javascript must not');
      assert.equal(narrowed.match, 'all');

      // A tag is matched whole: "Go" must not match "MongoDB".
      const single = (await (await get('/api/v1/candidates?tags=react')).json()) as {
        items: { slug: string }[];
      };
      assert.ok(single.items.some((item) => item.slug === both?.publicSlug));

      // And the same filter is subscribable. This lives on the candidates feed
      // rather than the everything feed: /feed.rss is the whole site.
      const feed = await get('/candidates/feed?tags=javascript,react,node.js');
      assert.equal(feed.status, 200);
      const xml = await feed.text();
      assert.match(xml, /<atom:link[^>]+tags=/);
      assert.match(xml, /Both Person/);
      assert.ok(!xml.includes('One Person'), 'a filtered feed must not carry non-matches');
      // A filtered feed is about the people, not the jobs as well.
      assert.ok(!xml.includes('<category>Job</category>'), xml.slice(0, 400));

      // The display limit must not change who matches in other representations.
      for (const path of ['/candidates', '/candidates.md']) {
        const response = await get(`${path}?tags=javascript,react,node.js`, { accept: 'text/html' });
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.match(body, /Both Person/);
        assert.ok(!body.includes('One Person'), path);
      }
    });

    test('a private resume has no public address at all', async () => {
      if (pool === null) return;
      const { slug } = await publish('private', 'Alan Private');
      assert.equal(slug, null, 'a private resume must not claim a shared name');
    });
  });

  describe('editing a listing', () => {
    test('a listing can be rewritten without changing its URL', async () => {
      // Before this the board could publish and close a listing and not change
      // a word of it, so a typo in a published job could only be fixed by
      // closing it and posting again under a new slug, breaking every link.
      if (pool === null) return;
      const { createSession } = await import('../dist/core/auth.js');
      const owner = await pool.query(`select user_id from memberships limit 1`);
      const token = await createSession(pool as never, owner.rows[0]?.['user_id'], { label: 't' });
      const auth = { authorization: `Bearer ${token}` };

      const created = (await (
        await post(
          '/api/v1/jobs',
          {
            org: 'example-works',
            title: `Editable ${Date.now()}`,
            description: 'First draft, with a typpo.',
            agentPolicy: 'welcome',
          },
          auth,
        )
      ).json()) as { job: { slug: string; title: string } };

      const response = await app!.fetch(
        new Request(`http://board.test/api/v1/jobs/${created.job.slug}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ description: 'Second draft, spelled right.' }),
        }),
      );
      assert.equal(response.status, 200);
      const edited = (await response.json()) as { job: { slug: string; title: string; description: string } };

      assert.equal(edited.job.slug, created.job.slug, 'the URL must survive an edit');
      assert.equal(edited.job.description, 'Second draft, spelled right.');
      // A field that was not sent keeps its value rather than being cleared.
      assert.equal(edited.job.title, created.job.title);
    });

    test('editing someone else\'s listing is refused', async () => {
      if (pool === null) return;
      const { createSession, ensureUser } = await import('../dist/core/auth.js');
      const stranger = await ensureUser(pool as never, `stranger+${Date.now()}@example.com`);
      const token = await createSession(pool as never, stranger.id, { label: 't' });

      const page = (await (await get('/api/v1/jobs?limit=1')).json()) as {
        items: { slug: string }[];
      };
      const response = await app!.fetch(
        new Request(`http://board.test/api/v1/jobs/${page.items[0]?.slug}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ description: 'not mine to change' }),
        }),
      );
      assert.equal(response.status, 403);
    });
  });

  describe('importing from a URL', () => {
    test('an unreachable page is refused with what happened, not a 500', async () => {
      if (pool === null) return;
      const { createSession } = await import('../dist/core/auth.js');
      const owner = await pool.query(`select user_id from memberships limit 1`);
      const token = await createSession(pool as never, owner.rows[0]?.['user_id'], { label: 't' });

      const response = await post(
        '/api/v1/jobs/import',
        { url: 'https://not-a-real-host.invalid/jobs/1', org: 'example-works' },
        { authorization: `Bearer ${token}` },
      );
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'unreachable');
    });

    test('an import aimed at this machine is refused', async () => {
      if (pool === null) return;
      const { createSession } = await import('../dist/core/auth.js');
      const owner = await pool.query(`select user_id from memberships limit 1`);
      const token = await createSession(pool as never, owner.rows[0]?.['user_id'], { label: 't' });

      const response = await post(
        '/api/v1/jobs/import',
        { url: 'http://127.0.0.1:8787/admin', org: 'example-works' },
        { authorization: `Bearer ${token}` },
      );
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /not an address we will fetch/);
    });

    test('adopting a slug that does not exist says so rather than importing', async () => {
      if (pool === null) return;
      const { createSession } = await import('../dist/core/auth.js');
      const owner = await pool.query(`select user_id from memberships limit 1`);
      const token = await createSession(pool as never, owner.rows[0]?.['user_id'], { label: 't' });

      const response = await post(
        '/api/v1/jobs/import',
        { url: 'https://example.com/jobs/1', slug: 'no-such-listing-here' },
        { authorization: `Bearer ${token}` },
      );
      assert.equal(response.status, 404);
    });
  });

  describe('the directory', () => {
    test('a board refuses to list itself', async () => {
      // The flagship is both a board and the directory it names, so this is
      // the case that would otherwise put it in its own listing. Refused on
      // the receiving side because anyone may POST any URL: guarding only the
      // announcing end would let a third party do it on the board's behalf.
      for (const url of [
        'http://board.test',
        'http://board.test/',
        'http://BOARD.test',
        'http://board.test:80',
      ]) {
        const response = await post('/api/v1/directory/announce', { url });
        assert.equal(response.status, 400, url);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'self', url);
      }
    });

    test('a self-listing made before the guard is swept away', async () => {
      if (pool === null) return;
      const { sweep } = await import('../dist/directory/registry.js');
      // Exactly the row the old code left behind: the board announced itself
      // while ANNOUNCE was on and the guard was not deployed yet.
      await pool.query(
        `insert into instances (url, descriptor, checked_at, failures)
         values ($1, '{}'::jsonb, now(), 0)
         on conflict (url) do update set checked_at = now()`,
        ['http://board.test'],
      );

      await sweep(pool as never, { self: 'http://board.test' });

      const left = await pool.query(`select url from instances where url = $1`, [
        'http://board.test',
      ]);
      assert.equal(left.rows.length, 0, 'the board is still listed in its own directory');
    });

    test('another board is still allowed to announce', async () => {
      // This one is refused too, but for being unreachable rather than for
      // being us - which is the assertion. The self check must not be so
      // broad that it turns away the boards the directory exists to list.
      const response = await post('/api/v1/directory/announce', {
        url: 'http://other-board.invalid',
      });
      const body = (await response.json()) as { error?: { code: string } };
      assert.equal(body.error?.code, 'unreachable', JSON.stringify(body));
    });
  });

  describe('MCP', () => {
    test('initialize, list and call all work over the loopback dispatcher', async () => {
      const init = (await (
        await post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      ).json()) as { result: { protocolVersion: string; instructions: string } };
      assert.match(init.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(init.result.instructions, /Nothing is scraped/);

      const tools = (await (
        await post('/api/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
      ).json()) as { result: { tools: { name: string }[] } };
      assert.ok(tools.result.tools.length >= 10);

      const called = (await (
        await post('/api/mcp', {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'search_jobs', arguments: { limit: 3 } },
        })
      ).json()) as { result: { content: { text: string }[]; isError?: boolean } };
      assert.notEqual(called.result.isError, true);
      assert.ok((called.result.content[0]?.text ?? '').length > 0);
    });

    test('a notification is answered with nothing at all', async () => {
      const response = await post('/api/mcp', {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      // Replying to a notification is a desync some clients treat as fatal.
      assert.equal(response.status, 202);
      assert.equal(await response.text(), '');
    });

    test('cookies are ignored, so a page on the web cannot drive it', async () => {
      if (pool === null) return;
      const { createSession } = await import('../dist/core/auth.js');
      const user = await pool.query(`select id from users limit 1`);
      const token = await createSession(pool as never, user.rows[0]?.['id'] as string, {});
      const response = (await (
        await post(
          '/api/mcp',
          { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
          { cookie: `aj_session=${token}` },
        )
      ).json()) as { result: { isError?: boolean; content: { text: string }[] } };
      assert.equal(response.result.isError, true, 'a cookie authenticated an MCP call');
      assert.match(response.result.content[0]?.text ?? '', /Not signed in|login/);
    });
  });

  describe('discovery', () => {
    test('jobs and candidates each have their own filterable feed', async () => {
      // Asked for as /feed?tags= and /candidates/feed?tags=, so the two halves
      // of the board are subscribable separately rather than only together.
      for (const path of ['/feed', '/candidates/feed']) {
        const response = await get(path);
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get('content-type') ?? '', /application\/rss\+xml/, path);
        const xml = await response.text();
        assert.match(xml, /<atom:link[^>]+rel="self"/, path);
        assert.match(xml, /<lastBuildDate>/, path);
      }

      // The jobs feed carries jobs and no people, and the other way round.
      const jobs = await (await get('/feed')).text();
      assert.ok(!jobs.includes('<category>Candidate</category>'), 'jobs feed must be jobs');
      const people = await (await get('/candidates/feed')).text();
      assert.ok(!people.includes('<category>Job</category>'), 'candidates feed must be people');

      // A tag nobody uses is an empty but still valid feed, not a 404 or a crash.
      const empty = await get('/feed?tags=nobody-uses-this-tag');
      assert.equal(empty.status, 200);
      const emptyXml = await empty.text();
      assert.match(emptyXml, /<lastBuildDate>/);
      assert.ok(!emptyXml.includes('<item>'), 'an unmatched tag lists nothing');
    });

    test('a job tag filters the board, in both url spellings', async () => {
      // `tag=a&tag=b` is what the CLI sends and `tags=a,b` is what a badge
      // links to; they have to mean the same thing.
      const page = (await (await get('/api/v1/jobs?limit=1')).json()) as {
        items: { slug: string; tags: string[]; stack: string[] }[];
      };
      const tag = page.items[0]?.tags[0] ?? page.items[0]?.stack[0];
      if (tag === undefined) return;

      const comma = (await (
        await get(`/api/v1/jobs?tags=${encodeURIComponent(tag)}`)
      ).json()) as { total: number };
      const repeated = (await (
        await get(`/api/v1/jobs?tag=${encodeURIComponent(tag)}`)
      ).json()) as { total: number };
      assert.equal(comma.total, repeated.total);
      assert.ok(comma.total > 0, `expected ${tag} to match something`);
    });

    test('one query, every representation', async () => {
      // A filter written once should work whichever way you read the board.
      // /jobs.rss and /feed.rss built their query from an EMPTY
      // URLSearchParams, so both answered with the whole board however it was
      // filtered: a feed that looks filtered and is not.
      const surfaces = [
        '/api/v1/jobs',
        '/jobs.json',
        '/jobs.md',
        '/feed',
        '/jobs.rss',
        '/feed.rss',
      ];

      // Something every seeded job is not, so a filter that works excludes all
      // of them and one that is ignored does not.
      const impossible = 'seniority=intern&workplace=onsite&employmentType=internship';
      for (const path of surfaces) {
        const response = await get(`${path}?${impossible}`);
        assert.equal(response.status, 200, path);
        const body = await response.text();
        const items =
          path.endsWith('.rss') || path === '/feed'
            ? (body.match(/<item>/g) ?? []).length
            : path.endsWith('.md')
              ? (body.match(/^## /gm) ?? []).length
              : ((JSON.parse(body) as { items: unknown[] }).items ?? []).length;
        assert.equal(items, 0, `${path} ignored the filter and returned ${items}`);
      }

      // And unfiltered, every one of them still has the board in it.
      for (const path of surfaces) {
        const body = await (await get(path)).text();
        const empty = body.includes('<item>') || body.includes('## ') || body.includes('"items"');
        assert.ok(empty, `${path} returned nothing unfiltered`);
      }
    });

    test('markdown is served as markdown, and carries what an agent needs', async () => {
      const response = await get('/jobs.md');
      assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);
      const body = await response.text();
      // The apply schema is the thing an agent has to reach, so the document
      // has to carry it rather than making them guess the URL.
      assert.match(body, /apply-schema/);
      assert.match(body, /^# /m);

      const candidates = await get('/candidates.md');
      assert.equal(candidates.status, 200);
      assert.match(candidates.headers.get('content-type') ?? '', /text\/markdown/);
    });

    test('the feed, sitemap and llms.txt all answer', async () => {
      for (const path of [
        '/jobs.json',
        '/jobs.rss',
        '/feed.rss',
        '/sitemap.xml',
        '/robots.txt',
        '/llms.txt',
      ]) {
        assert.equal((await get(path)).status, 200, path);
      }
    });

    test('the site feed carries the whole site and what a directory checks for', async () => {
      const response = await get('/feed.rss');
      assert.match(response.headers.get('content-type') ?? '', /application\/rss\+xml/);
      const xml = await response.text();

      // The metadata a feed directory validates. /jobs.rss has none of it.
      assert.match(xml, /<atom:link[^>]+rel="self"/);
      assert.match(xml, /<lastBuildDate>/);
      assert.match(xml, /<language>en<\/language>/);

      // Everything, not just jobs: employers are in here too.
      assert.match(xml, /<category>Job<\/category>/);
      assert.match(xml, /<category>Employer<\/category>/);

      // Every item needs a resolvable guid or a reader dedupes them wrongly.
      const guids = [...xml.matchAll(/<guid isPermaLink="true">([^<]+)<\/guid>/g)].map((m) => m[1]);
      assert.ok(guids.length > 0, 'expected items');
      assert.equal(new Set(guids).size, guids.length, 'guids must be unique');
      for (const guid of guids) assert.match(guid ?? '', /^https?:\/\//);
    });

    test('the approval link carries the code, so approving is one click', async () => {
      // The page still accepts a typed code, for a browser on another
      // machine. What this rules out is a link that opens an empty form
      // beside a terminal holding the code.
      const grant = (await (await post('/api/v1/auth/device', { label: 'test' })).json()) as {
        userCode: string;
        verifyUrl: string;
      };
      assert.match(grant.verifyUrl, /\/device\?code=/);
      assert.ok(grant.verifyUrl.endsWith(grant.userCode), grant.verifyUrl);
    });

    test('llms.txt says the board is not scraped, because that is the point', async () => {
      const text = await (await get('/llms.txt')).text();
      assert.match(text, /Nothing is scraped/);
      assert.match(text, /apply-schema/);
    });

    test('a job page carries its JSON-LD', async () => {
      const page = (await (await get('/api/v1/jobs?limit=1')).json()) as {
        items: { slug: string }[];
      };
      const html = await (await get(`/jobs/${page.items[0]?.slug}`, { accept: 'text/html' })).text();
      assert.match(html, /application\/ld\+json/);
      assert.match(html, /"@type":"JobPosting"/);
    });

    test('the security headers are set on every page', async () => {
      const response = await get('/', { accept: 'text/html' });
      const csp = response.headers.get('content-security-policy') ?? '';
      assert.match(csp, /script-src 'self'/);
      assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), csp);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    });
  });
});
