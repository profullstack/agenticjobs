/**
 * Routes, asked of the router this repo actually builds.
 *
 * Every other test in this suite calls a handler or renders a component, and
 * that is where the resume download bug hid: the handler was correct, the
 * pattern read correctly, and the router never matched the URL, so all four
 * downloads 404'd in 0.6.0 while the suite stayed green and the release notes
 * announced the feature.
 *
 * The pattern was `/candidates/:slug/resume.:format{md|html|pdf|docx}`. A
 * literal prefix in the same segment as a regex-constrained parameter is a
 * RegExpRouter feature. Hono's default SmartRouter falls back to TrieRouter
 * for the whole router the moment any single route is beyond RegExpRouter, and
 * TrieRouter does not support that combination, so the route matched nothing.
 *
 * These assert on `pageRoutes().router` directly rather than through a request.
 * That is the level the bug lives at, it needs no database and no app, and it
 * cannot be fooled: building a small app to reproduce this gets you
 * RegExpRouter and a passing 200, which is exactly how the pattern survived
 * review in the first place.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegExpRouter } from 'hono/router/reg-exp-router';
import { TrieRouter } from 'hono/router/trie-router';
import { pageRoutes } from '../dist/server/routes/pages.js';

/** How many handlers this repo's page router offers for a path. */
function handlersFor(path: string): number {
  const [matched] = pageRoutes().router.match('GET', path);
  return matched.length;
}

test('every resume download URL matches a route', () => {
  for (const format of ['md', 'html', 'pdf', 'docx']) {
    const path = `/candidates/anybody/resume.${format}`;
    assert.ok(
      handlersFor(path) > 0,
      `${path} matches no route. Do not put a regex-constrained parameter ` +
        `after a literal prefix in one segment: this router is TrieRouter and ` +
        `does not support it. Use one plain route per extension.`,
    );
  }

  // A dot is legal in a public slug, and must not be mistaken for the format.
  assert.ok(handlersFor('/candidates/ada.b/resume.pdf') > 0, 'a dotted slug still downloads');
});

test('the fix did not simply make everything match', () => {
  assert.ok(handlersFor('/candidates/anybody') > 0, 'the candidate page still routes');
  assert.equal(handlersFor('/candidates/anybody/resume.exe'), 0, 'an unoffered format misses');
  assert.equal(handlersFor('/candidates/anybody/nonsense'), 0, 'an unrelated path misses');
});

test('the pattern that broke it is a RegExpRouter feature, not a universal one', () => {
  // Pinned because it is the whole reason the code is shaped the way it is. If
  // a future hono teaches TrieRouter this pattern, this test says so and the
  // comment in pages.tsx can be retired.
  const pattern = '/candidates/:slug/resume.:format{md|html|pdf|docx}';
  const ask = (Router: typeof RegExpRouter | typeof TrieRouter): number => {
    const router = new Router<string>();
    router.add('GET', pattern, 'handler');
    return router.match('GET', '/candidates/ada/resume.md')[0].length;
  };

  assert.equal(ask(RegExpRouter), 1, 'RegExpRouter supports it, which is why it looked fine');
  assert.equal(ask(TrieRouter), 0, 'TrieRouter does not, and TrieRouter is what runs here');
});
