/**
 * Credit codes and invites (@profullstack/redeem-credits, @profullstack/affiliates).
 *
 * A code grants credit in US cents. Every account has three single-use
 * invites; an accepted invite pays both people a small credit, but only for a
 * new account whose address was confirmed by its magic link, never for one
 * mailbox inviting itself, and never from an inviter account younger than a
 * day. The invite rides on the magic link, so a link opened in another
 * browser still counts.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Hono } from 'hono';
import { canonicalInvite, cleanRef, formatCents, sameMailbox } from '../dist/core/credits.js';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://agenticjobs:agenticjobs@localhost:5432/agenticjobs';

test('one mailbox under two spellings is one mailbox', () => {
  assert.ok(sameMailbox('Ada@Acme.com', 'ada+jobs@acme.com'));
  assert.ok(sameMailbox('a.d.a@gmail.com', 'ada+x@googlemail.com'));
  assert.ok(!sameMailbox('ada@acme.com', 'ada@acme.org'));
  assert.ok(!sameMailbox('a.da@acme.com', 'ada@acme.com'), 'dots only fold on Gmail');
});

test('codes from a URL or a cookie are cleaned before anything reads them', () => {
  assert.equal(canonicalInvite('inv 7k3m qx9d 2f8h'), 'INV-7K3M-QX9D-2F8H');
  assert.equal(canonicalInvite('<script>'), null);
  assert.equal(canonicalInvite('AJ-1234-5678-9ABC-DEFG'), null, 'a credit code is not an invite');
  assert.equal(cleanRef('e6ketybk'), 'E6KETYBK');
  assert.equal(cleanRef('x'), null);
  assert.equal(cleanRef('abc;drop'), null);
  assert.equal(formatCents(500), '$5.00');
  assert.equal(formatCents(25), '$0.25');
});

let app: Hono<never> | null = null;
let pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
} | null = null;
let closePool: (() => Promise<void>) | null = null;
let mint: ((pool: never, request: Record<string, unknown>) => Promise<{ code: string }>) | null =
  null;
let reason = '';
let ready = false;
const sent: { to: string; text: string }[] = [];

try {
  const db = await import('../dist/db/pool.js');
  const { migrate } = await import('../dist/db/migrate.js');
  const { createApp } = await import('../dist/server/app.js');
  const { loadConfig } = await import('../dist/config.js');
  const credits = await import('../dist/core/credits.js');
  const created = db.getPool(DATABASE_URL);
  await created.query('select 1');
  await migrate(created);
  pool = created as never;
  closePool = db.closePool;
  mint = credits.mintCreditCode as never;
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

function form(path: string, fields: Record<string, string>, cookie = ''): Promise<Response> {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

function json(path: string, cookie: string, payload: unknown): Promise<Response> {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(payload),
  });
}

function cookieFrom(res: Response, name: string): string {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const found = all.find((line) => line.startsWith(`${name}=`));
  return found === undefined ? '' : (found.split(';')[0] ?? '');
}

function unique(tag: string): string {
  return `${tag}+${Date.now()}${Math.random().toString(36).slice(2, 7)}@example.org`;
}

/** Ask for a link with `cookie` set, then spend it with no cookie at all: another browser. */
async function signIn(email: string, cookie = '', path = '/login'): Promise<string> {
  const res = await form(path, { email }, cookie);
  assert.equal(res.status, 200, await res.text());
  const mail = sent.findLast((message) => message.to === email);
  assert.ok(mail, 'no link was sent');
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  assert.ok(token);
  const callback = await call(`/auth/callback?token=${token}`);
  assert.equal(callback.status, 303);
  return cookieFrom(callback, 'aj_session');
}

async function balance(session: string): Promise<number> {
  const res = await call('/api/v1/credits', { headers: { cookie: session } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { balanceCents: number }).balanceCents;
}

async function makeOld(email: string): Promise<void> {
  await pool!.query(
    `update users set created_at = now() - interval '3 days' where lower(email) = lower($1)`,
    [email],
  );
}

async function invite(session: string): Promise<{ code: string; url: string }> {
  const res = await json('/api/v1/invites', session, { note: 'test' });
  assert.equal(res.status, 201);
  return (await res.json()) as { code: string; url: string };
}

describe('credit codes and invites', { skip: ready ? false : `no database: ${reason}` }, () => {
  test('a minted code is redeemed once from /me and shows on the page', async () => {
    const session = await signIn(unique('redeemer'));
    const { code } = await mint!(pool as never, { cents: 500, label: 'test' });
    const res = await form(
      '/me/redeem',
      { code: code.toLowerCase().replaceAll('-', ' ') },
      session,
    );
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location') ?? '', /credit=added&cents=500/);
    assert.equal(await balance(session), 500);
    const page = await (
      await call('/me?credit=added&cents=500', { headers: { cookie: session } })
    ).text();
    assert.match(page, /\$5\.00/);
    assert.match(page, /action="\/me\/redeem"/);

    const again = await json('/api/v1/credits/redeem', session, { code });
    assert.equal(again.status, 400);
    assert.equal(
      ((await again.json()) as { error: { code: string } }).error.code,
      'already_redeemed',
    );

    const other = await signIn(unique('second'));
    const used = await json('/api/v1/credits/redeem', other, { code });
    assert.equal(((await used.json()) as { error: { code: string } }).error.code, 'used_up');
    const junk = await json('/api/v1/credits/redeem', other, { code: 'AJ-0000-0000-0000-0000' });
    assert.equal(((await junk.json()) as { error: { code: string } }).error.code, 'invalid');
  });

  test('an accepted invite pays both sides, even when the link is opened in another browser', async () => {
    const inviterEmail = unique('inviter');
    const inviter = await signIn(inviterEmail);
    await makeOld(inviterEmail);
    const made = await invite(inviter);
    assert.match(made.url, /^http:\/\/board\.test\/i\/INV-/);

    const landing = await call(new URL(made.url).pathname);
    assert.equal(landing.status, 200);
    const inviteCookie = cookieFrom(landing, 'aj_invite');
    assert.ok(inviteCookie, 'the landing page remembers the invite');
    const signup = await (await call(`/signup?invite=${made.code}`)).text();
    assert.match(signup, /name="invite"/);

    const inviteeEmail = unique('invitee');
    const invitee = await signIn(inviteeEmail, inviteCookie);
    assert.equal(await balance(invitee), 100);
    assert.equal(await balance(inviter), 100);

    const summary = (await (
      await call('/api/v1/invites', { headers: { cookie: inviter } })
    ).json()) as { quota: { left: number }; invites: { used: boolean }[]; invitedCount: number };
    assert.equal(summary.quota.left, 2);
    assert.equal(summary.invites[0]?.used, true);
    assert.equal(summary.invitedCount, 1);

    // The same invite a second time does nothing for anyone.
    const late = await signIn(unique('late'), inviteCookie);
    assert.equal(await balance(late), 0);
    assert.equal(await balance(inviter), 100);
  });

  test('no bonus from a brand-new inviter, an existing member, or one mailbox twice', async () => {
    const freshEmail = unique('fresh');
    const fresh = await signIn(freshEmail);
    const made = await invite(fresh);
    const cookie = `aj_invite=${made.code}`;
    const invitee = await signIn(unique('of-fresh'), cookie);
    assert.equal(await balance(invitee), 0);
    assert.equal(await balance(fresh), 0);
    const { rows } = await pool!.query(
      `select status from invite_bonuses where user_id = (select id from users where lower(email) = lower($1))`,
      [freshEmail],
    );
    assert.equal(
      rows[0]?.['status'],
      'inviter_too_new',
      'the invite is recorded, the bonus withheld',
    );

    // An existing account following an invite spends nothing.
    const oldEmail = unique('old');
    await signIn(oldEmail);
    await makeOld(oldEmail);
    const ownerEmail = unique('owner');
    const owner = await signIn(ownerEmail);
    await makeOld(ownerEmail);
    const second = await invite(owner);
    await signIn(oldEmail, `aj_invite=${second.code}`);
    const after = (await (
      await call('/api/v1/invites', { headers: { cookie: owner } })
    ).json()) as { invites: { used: boolean }[] };
    assert.equal(after.invites[0]?.used, false);

    // The owner's own other address.
    const self = await signIn(
      ownerEmail.replace('owner+', 'owner+alt'),
      `aj_invite=${second.code}`,
    );
    assert.equal(await balance(self), 0);
    assert.equal(await balance(owner), 0);
  });

  test('three invites per account, then 409', async () => {
    const session = await signIn(unique('quota'));
    for (let index = 0; index < 3; index += 1) await invite(session);
    const fourth = await json('/api/v1/invites', session, {});
    assert.equal(fourth.status, 409);
    const page = await (await call('/invites', { headers: { cookie: session } })).text();
    assert.match(page, /No invites left/);
  });

  test('?ref= is first touch and is credited to the affiliate at sign-up', async () => {
    const affiliate = await signIn(unique('affiliate'));
    const summary = (await (
      await call('/api/v1/invites', { headers: { cookie: affiliate } })
    ).json()) as { affiliateCode: string; affiliateUrl: string };
    assert.equal(summary.affiliateUrl, `http://board.test/?ref=${summary.affiliateCode}`);
    const visit = await call(`/jobs?ref=${summary.affiliateCode}`);
    const ref = cookieFrom(visit, 'referral_code');
    assert.equal(ref, `referral_code=${summary.affiliateCode}`);
    const second = await call('/jobs?ref=OTHERCODE', { headers: { cookie: ref } });
    assert.equal(cookieFrom(second, 'referral_code'), '', 'first touch is never overwritten');

    const email = unique('referred');
    await signIn(email, ref, '/login');
    const { rows } = await pool!.query(
      `select a.affiliate_id from aff_attributions a
         join users u on u.id::text = a.user_id where lower(u.email) = lower($1)`,
      [email],
    );
    assert.equal(rows.length, 1);
  });

  test('minting over the API is for a browser-session administrator only', async () => {
    const session = await signIn(unique('not-admin'));
    const res = await json('/api/v1/admin/credit-codes', session, { cents: 100, label: 'x' });
    assert.equal(res.status, 403);
    const anonymous = await call('/api/v1/credits');
    assert.equal(anonymous.status, 401);
  });
});
