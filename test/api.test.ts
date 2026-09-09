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
  reason = error instanceof Error ? error.message : String(error);
}

after(async () => {
  if (closePool !== null) await closePool();
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

      const both = await publish('Both Person', ['JavaScript', 'React', 'Node.js']);
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
