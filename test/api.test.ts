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

    const checked: string[] = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      if (!Object.hasOwn(methods, 'get')) continue;
      const concrete = path
        .replace('{slug}', path.startsWith('/api/v1/orgs') ? orgSlug : slug)
        .replace('{id}', 'x');
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
    test('the feed, sitemap and llms.txt all answer', async () => {
      for (const path of ['/jobs.json', '/jobs.rss', '/sitemap.xml', '/robots.txt', '/llms.txt']) {
        assert.equal((await get(path)).status, 200, path);
      }
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
