/**
 * The service worker's cache key must move whenever the shell moves.
 *
 * This is a ratchet for a bug that already happened. sw.js used a hand-written
 * `VERSION = 'v1'` and said in its own comment to bump it on any asset change.
 * A CSS fix shipped without the bump, so every returning reader kept serving
 * the old stylesheet out of the cache and the fix reached nobody who had
 * visited before. A comment asking a person to remember is not a mechanism.
 *
 * So VERSION is a hash of the shell assets and this recomputes it. Change
 * app.css and this fails until VERSION is updated, which is exactly when the
 * cache needs a new name.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const swSource = readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8');

/** The asset list the worker actually caches, read from the worker itself. */
function shellAssets(): string[] {
  const list = /const ASSETS = \[([^\]]*)\]/.exec(swSource)?.[1] ?? '';
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

test('the cache name is a hash of what it caches, so it cannot go stale', () => {
  const assets = shellAssets();
  assert.ok(assets.length > 0, 'expected the worker to list shell assets');

  const hash = createHash('sha256');
  for (const asset of assets) {
    // `/assets/app.css` is served from `web/public/app.css`.
    const file = new URL(`../web/public/${asset.replace(/^\/assets\//, '')}`, import.meta.url);
    hash.update(readFileSync(file));
  }
  const expected = hash.digest('hex').slice(0, 8);
  const actual = /const VERSION = '([^']+)'/.exec(swSource)?.[1];

  assert.equal(
    actual,
    expected,
    `A shell asset changed. Set VERSION in web/public/sw.js to '${expected}' so returning readers get it.`,
  );
});

test('a cached shell asset is refreshed rather than served forever', () => {
  // Cache-first with no revalidation is what made the stale stylesheet
  // permanent. The handler must write back into the cache.
  const handler = /if \(ASSETS\.includes\(url\.pathname\)\) \{[\s\S]*?\n  \}/.exec(swSource)?.[0] ?? '';
  assert.match(handler, /cache\.put\(/, 'shell assets must be revalidated into the cache');
});

test('the shell is cached from the network, not from the HTTP cache', () => {
  // The assets are served with max-age=3600, and both addAll and a plain
  // revalidating fetch go through the HTTP cache by default. Without
  // cache: 'reload' the worker caches whatever stale copy the HTTP cache is
  // holding, under a correct-looking cache name, and serves it for an hour.
  // The mobile fix was invisible in a real browser for exactly this reason
  // even after the cache name had moved.
  assert.match(swSource, /addAll\([\s\S]*cache: 'reload'/, 'install must bypass the HTTP cache');

  const handler = /if \(ASSETS\.includes\(url\.pathname\)\) \{[\s\S]*?\n  \}/.exec(swSource)?.[0] ?? '';
  assert.match(handler, /cache: 'reload'/, 'revalidation must bypass the HTTP cache too');
});
