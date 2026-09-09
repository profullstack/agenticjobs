/**
 * Sending the sign-in link, and staying out of your own directory.
 *
 * The case that matters most here is the negative one: an instance that
 * cannot send must never put the link in front of whoever typed the address.
 * `deliverMagicLink` returning false is what the pages rely on to say so
 * without showing it, so that return value is asserted in every branch.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, sameOrigin } from '../dist/config.js';
import { createMailer, deliverMagicLink, magicLinkMessage } from '../dist/core/mail.js';

const BASE = {
  DATABASE_URL: 'postgres://x@localhost:5432/x',
  SECRET: 'a'.repeat(64),
};

test('no key means no mailer, which is a supported state and not an error', () => {
  const config = loadConfig({ ...BASE, PUBLIC_URL: 'https://board.test' });
  assert.equal(config.resendApiKey, null);
  assert.equal(createMailer(config), null);
});

test('the default From: is on the domain the board is served from', () => {
  // Resend refuses a sender whose domain is not verified, so the only default
  // with a chance of working is the board's own host.
  const config = loadConfig({
    ...BASE,
    PUBLIC_URL: 'https://jobs.example.com',
    BOARD_NAME: 'Example Jobs',
  });
  assert.equal(config.mailFrom, '"Example Jobs" <jobs@jobs.example.com>');

  // A laptop is not a sending domain, so it keeps the address that says so.
  const local = loadConfig({ ...BASE, PUBLIC_URL: 'http://localhost:8787' });
  assert.equal(local.mailFrom, 'jobs@localhost');

  // An explicit setting always wins.
  const explicit = loadConfig({
    ...BASE,
    PUBLIC_URL: 'https://jobs.example.com',
    MAIL_FROM: 'Careers <careers@example.com>',
  });
  assert.equal(explicit.mailFrom, 'Careers <careers@example.com>');
});

test('a sign-in email carries the link and says how long it lasts', () => {
  const message = magicLinkMessage({
    to: 'ada@example.com',
    url: 'https://board.test/auth/callback?token=abc',
    boardName: 'Example Jobs',
    redirect: null,
    minutes: 15,
  });
  assert.equal(message.subject, 'Sign in to Example Jobs');
  assert.ok(message.text.includes('https://board.test/auth/callback?token=abc'));
  assert.ok(message.html.includes('href="https://board.test/auth/callback?token=abc"'));
  assert.ok(message.text.includes('15 minutes'));
});

test('a link asked for by a terminal shows that terminal’s code', () => {
  // Without the code in the email there is nothing to compare against the
  // screen, and a link phished out of an inbox approves someone else's
  // terminal just as well as your own.
  const message = magicLinkMessage({
    to: 'ada@example.com',
    url: 'https://board.test/auth/callback?token=abc',
    boardName: 'Example Jobs',
    redirect: '/device?code=8CEY-2TTA',
    minutes: 15,
  });
  assert.equal(message.subject, 'Approve your terminal on Example Jobs');
  assert.ok(message.text.includes('8CEY-2TTA'));
  assert.ok(message.html.includes('8CEY-2TTA'));
});

test('a board name cannot break out of the html it is rendered into', () => {
  const message = magicLinkMessage({
    to: 'ada@example.com',
    url: 'https://board.test/auth/callback?token=abc&next=%2Fme',
    boardName: '<script>alert(1)</script>',
    redirect: null,
    minutes: 15,
  });
  assert.ok(!message.html.includes('<script>'), message.html);
  // The ampersand in the URL is escaped in the attribute and still parses back
  // to the same address.
  assert.ok(message.html.includes('token=abc&amp;next=%2Fme'), message.html);
});

test('delivery reports what happened, not what is configured', async () => {
  const sent: { to: string; subject: string }[] = [];
  const working = { send: async (m: { to: string; subject: string }) => (sent.push(m), true) };
  const refusing = { send: async () => false };

  const options = {
    boardName: 'Example Jobs',
    email: 'ada@example.com',
    url: 'https://board.test/auth/callback?token=abc',
    redirect: null,
  };

  assert.equal(await deliverMagicLink({ ...options, mailer: working }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, 'ada@example.com');

  // A provider that refuses is not a delivery, and neither is having no
  // provider at all. Both are false, which is what stops the page claiming an
  // email is on its way.
  assert.equal(await deliverMagicLink({ ...options, mailer: refusing }), false);
  assert.equal(await deliverMagicLink({ ...options, mailer: null }), false);
});

test('a provider that throws does not become a failed sign-in', async () => {
  const config = loadConfig({ ...BASE, PUBLIC_URL: 'https://board.test', RESEND_API_KEY: 're_x' });
  const mailer = createMailer(config, () => undefined);
  assert.notEqual(mailer, null);

  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('getaddrinfo ENOTFOUND api.resend.com');
  }) as typeof globalThis.fetch;
  try {
    const ok = await mailer?.send({ to: 'a@b.co', subject: 's', html: '<p>h</p>', text: 't' });
    assert.equal(ok, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('an unverified sending domain is a refusal, not a crash', async () => {
  const config = loadConfig({ ...BASE, PUBLIC_URL: 'https://board.test', RESEND_API_KEY: 're_x' });
  const logged: string[] = [];
  const mailer = createMailer(config, (message) => logged.push(message));

  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: 'The board.test domain is not verified.' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
  try {
    const ok = await mailer?.send({ to: 'a@b.co', subject: 's', html: '<p>h</p>', text: 't' });
    assert.equal(ok, false);
    // The provider's own sentence is the useful part, so it must reach the log.
    assert.ok(logged.some((line) => line.includes('not verified')), logged.join('\n'));
  } finally {
    globalThis.fetch = original;
  }
});

test('a board is not listed in its own directory', () => {
  // The flagship runs both roles and names itself in DIRECTORY_URL, so these
  // are the comparisons that keep it out of its own listing.
  assert.equal(sameOrigin('https://agenticjobs.work', 'https://agenticjobs.work'), true);
  assert.equal(sameOrigin('https://agenticjobs.work/', 'https://agenticjobs.work'), true);
  assert.equal(sameOrigin('https://AgenticJobs.work', 'https://agenticjobs.work'), true);
  assert.equal(sameOrigin('https://agenticjobs.work:443', 'https://agenticjobs.work'), true);

  // A different board, a different scheme and a different host are all other
  // boards, and must still be able to announce.
  assert.equal(sameOrigin('https://www.agenticjobs.work', 'https://agenticjobs.work'), false);
  assert.equal(sameOrigin('http://agenticjobs.work', 'https://agenticjobs.work'), false);
  assert.equal(sameOrigin('https://jobs.example.com', 'https://agenticjobs.work'), false);
  assert.equal(sameOrigin(null, 'https://agenticjobs.work'), false);
  assert.equal(sameOrigin('not a url', 'https://agenticjobs.work'), false);
});
