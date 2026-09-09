/**
 * Updates and follows, in the parts that hold without a database.
 *
 * The rate limit, the duplicate check and the permission checks are SQL and
 * are exercised by the API suite. What is here is the rest: what an update is
 * allowed to link to, and how one renders.
 *
 * The link rules matter more than they look. An update is the one place on
 * this board where anybody signed in can publish a URL, which is exactly the
 * shape of a link farm, so what the field accepts is the feature's whole
 * security surface.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseLink, BODY_MAX, BODY_MIN } from '../dist/core/updates.js';
import { UpdateItem, UpdateList, FollowButton } from '../dist/views/updates.js';

/** Hono's JSX nodes stringify, which is how the other view tests read them. */
function render(node: unknown): string {
  return String(node);
}

test('a link has to be somewhere another person can actually go', () => {
  assert.equal(normaliseLink('https://example.com/post'), 'https://example.com/post');
  // A path survives. The directory's own helper keeps only an origin, and
  // using it unchanged here would silently turn a link to an article into a
  // link to a home page.
  assert.equal(normaliseLink('https://example.com/blog/we-shipped?x=1'), 'https://example.com/blog/we-shipped?x=1');
  // Typed without a scheme, which is how people type a URL.
  assert.equal(normaliseLink('example.com/x'), 'https://example.com/x');

  // Nothing is not an error, it is no link.
  assert.equal(normaliseLink(''), null);
  assert.equal(normaliseLink(undefined), null);

  // The private ranges and loopback: a link nobody else can open, and a URL
  // this board would be publishing on someone's behalf.
  assert.equal(normaliseLink('http://localhost:3000/x'), null);
  assert.equal(normaliseLink('http://127.0.0.1/x'), null);
  assert.equal(normaliseLink('http://10.1.2.3/x'), null);
  assert.equal(normaliseLink('http://192.168.0.1/'), null);
  assert.equal(normaliseLink('http://172.16.4.4/'), null);

  // Not a web link at all.
  assert.equal(normaliseLink('javascript:alert(1)'), null);
  assert.equal(normaliseLink('file:///etc/passwd'), null);
  assert.equal(normaliseLink('data:text/html,<script>'), null);
});

test('credentials in a link are stripped, because a link is for clicking', () => {
  const link = normaliseLink('https://user:secret@example.com/x');
  assert.ok(link !== null);
  assert.ok(!link.includes('secret'), link);
  assert.ok(link.startsWith('https://example.com/'), link);
});

test('an update is short enough to be news and long enough to say something', () => {
  assert.equal(BODY_MAX, 600);
  assert.ok(BODY_MIN > 0 && BODY_MIN < 40);
});

const UPDATE = {
  id: 'a1b2',
  body: 'We closed the backend role. Two more open next month.',
  link: 'https://example.com/hiring',
  createdAt: new Date().toISOString(),
  author: { kind: 'employer' as const, slug: 'acme', name: 'Acme' },
};

test('an update renders as text, never as markup', () => {
  const html = render(
    UpdateItem({ update: { ...UPDATE, body: 'we shipped <script>alert(1)</script>' } }),
  );
  assert.ok(!html.includes('<script>'), html);
  assert.match(html, /&lt;script&gt;/);
});

test("an update's link is nofollow, so the board is not a link farm", () => {
  const html = render(UpdateItem({ update: UPDATE }));
  assert.match(html, /rel="nofollow noopener"/);
  // Shown as its host, so the destination is legible before the click.
  assert.match(html, />example\.com</);
  assert.match(html, /href="https:\/\/example\.com\/hiring"/);
});

test('an update is anchorable, because the feed points at it', () => {
  const html = render(UpdateList({ updates: [UPDATE] }));
  assert.match(html, /id="a1b2"/);
  assert.match(html, /href="\/employers\/acme"/);
});

test('a candidate update links to the candidate, not to an employer', () => {
  const html = render(
    UpdateList({
      updates: [{ ...UPDATE, author: { kind: 'candidate', slug: 'ada', name: 'Ada' } }],
    }),
  );
  assert.match(html, /href="\/candidates\/ada"/);
});

test('following is a form, because a GET that follows can be prefetched', () => {
  const html = render(
    FollowButton({
      action: '/employers/acme/follow',
      following: false,
      followers: 3,
      signedIn: true,
      next: '/employers/acme',
    }),
  );
  assert.match(html, /<form method="post" action="\/employers\/acme\/follow"/);
  assert.ok(!/<a[^>]+href="\/employers\/acme\/follow"/.test(html), 'follow must not be a link');
  assert.match(html, /3 followers/);
});

test('a signed-out reader is sent to sign in, and comes back here', () => {
  const html = render(
    FollowButton({
      action: '/candidates/ada/follow',
      following: false,
      followers: 0,
      signedIn: false,
      next: '/candidates/ada',
    }),
  );
  assert.match(html, /href="\/login\?next=%2Fcandidates%2Fada"/);
  assert.ok(!html.includes('<form'), 'nothing to submit when signed out');
});
