/**
 * Protocol-relative URL regression tests for safeUrl.
 *
 * The scheme allowlist lets `/` through so root-anchored paths keep working.
 * But a second separator after the leading `/` is not a path: `//host` is a
 * protocol-relative URL that inherits the page scheme and lands on an
 * attacker-chosen host, and a URL parser folds `/\host` into the same thing.
 * Either renders an off-site link from markup that reads as an internal path.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeUrl } from '../dist/markup/escape.js';
import { renderInline } from '../dist/markup/markdown.js';

test('protocol-relative urls are dropped', () => {
  assert.equal(safeUrl('//attacker.example'), null);
  assert.equal(safeUrl('//attacker.example/path?q=1'), null);
  // Whitespace around the value is trimmed before the scheme check, so the
  // same bypass padded with spaces must not slip through either.
  assert.equal(safeUrl('  //attacker.example  '), null);
});

test('a backslash after the leading slash parses as a second separator', () => {
  assert.equal(safeUrl('/\\attacker.example'), null);
  assert.equal(safeUrl('/\\attacker.example/path'), null);
});

test('root-anchored paths still pass', () => {
  assert.equal(safeUrl('/'), '/');
  assert.equal(safeUrl('/jobs/x'), '/jobs/x');
  // A second slash later in the path is a path, not an authority.
  assert.equal(safeUrl('/a//b'), '/a//b');
  // A backslash anywhere but position two is ordinary path content.
  assert.equal(safeUrl('/a\\b'), '/a\\b');
});

test('a protocol-relative link renders as text, not an off-site anchor', () => {
  const html = renderInline('[click](//evil.example)');
  assert.ok(!html.includes('href="//evil.example"'), html);
});
