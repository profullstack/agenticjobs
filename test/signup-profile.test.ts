/**
 * The shared @profullstack/profile fields on signup.
 *
 * Asked for on /signup only (never on /login), validated before any link is
 * made, carried on the magic link because the account does not exist until
 * the link is spent, and saved into user_profiles when it is. The member can
 * read and change them through /api/v1/me/profile.
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
const sent: { to: string; text: string }[] = [];

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
  app = createApp(created, config, {
    send: async (message: { to: string; text: string }) => {
      sent.push(message);
      return true;
    },
  }) as never;
  ready = true;
} catch (error) {
  reason = error instanceof Error ? error.message : String(error);
}

after(async () => {
  if (closePool !== null) await closePool();
});

function call(path: string, init: RequestInit = {}): Promise<Response> {
  if (app === null) throw new Error('no app');
  return app.fetch(new Request(`http://board.test${path}`, init)) as Promise<Response>;
}

function form(path: string, fields: Record<string, string>): Promise<Response> {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

describe(
  'the signup page',
  { skip: ready ? false : `no database: ${reason || 'setup failed'}` },
  () => {
    test('signup asks for the profile fields, sign-in does not', async () => {
      const signup = await (await call('/signup')).text();
      for (const name of [
        'first_name',
        'last_name',
        'company_domain',
        'job_title',
        'linkedin_url',
      ]) {
        assert.match(signup, new RegExp(`name="${name}"`));
      }
      // Count inside the signup form only: the shared footer (0.3+) carries its
      // own newsletter form with an email box of its own.
      const signupForm = signup.match(/<form[^>]*action="\/signup"[\s\S]*?<\/form>/)?.[0] ?? '';
      assert.equal(
        signupForm.match(/<input[^>]*\bname="email"/g)?.length,
        1,
        "one email box, the form's own",
      );
      const login = await (await call('/login')).text();
      assert.doesNotMatch(login, /name="first_name"/);
    });

    test('a refused signup keeps what was typed and sends nothing', async () => {
      const before = sent.length;
      const res = await form('/signup', { email: 'ada@acme.com', first_name: 'Ada' });
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.match(html, /value="Ada"/);
      assert.match(html, /aria-invalid="true"/);
      assert.equal(sent.length, before);
    });

    test('a signup stores the fields when the link is followed', async () => {
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const email = `ada+${stamp}@acme.com`;
      const res = await form('/signup', {
        email,
        first_name: 'Ada',
        last_name: 'Lovelace',
        company_domain: 'https://www.acme.com/about',
        job_title: 'VP Engineering',
        linkedin_url: 'in/ada-lovelace',
      });
      assert.equal(res.status, 200);

      const mail = sent.findLast((message) => message.to === email);
      assert.ok(mail, 'no link was sent');
      const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
      assert.ok(token, 'the mail has no token');

      const callback = await call(`/auth/callback?token=${token}`);
      assert.equal(callback.status, 303);
      const cookie = (callback.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

      const { rows } = await pool!.query(
        `select p.* from user_profiles p join users u on u.id = p.user_id where lower(u.email) = $1`,
        [email],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!['first_name'], 'Ada');
      assert.equal(rows[0]!['last_name'], 'Lovelace');
      assert.equal(rows[0]!['company_domain'], 'acme.com');
      assert.equal(rows[0]!['job_title'], 'VP Engineering');
      assert.equal(rows[0]!['linkedin_url'], 'https://www.linkedin.com/in/ada-lovelace');

      // The same row through the API, and a PATCH that changes one field.
      const got = (await (await call('/api/v1/me/profile', { headers: { cookie } })).json()) as {
        profile: Record<string, string>;
      };
      assert.equal(got.profile['job_title'], 'VP Engineering');
      const patched = await call('/api/v1/me/profile', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ job_title: 'CTO' }),
      });
      assert.equal(patched.status, 200);
      assert.equal(
        ((await patched.json()) as { profile: Record<string, string> }).profile['job_title'],
        'CTO',
      );
    });

    test('the profile API refuses a caller who is not signed in', async () => {
      const res = await call('/api/v1/me/profile');
      assert.equal(res.status, 401);
    });
  },
);
