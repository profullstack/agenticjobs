/**
 * The stylesheet, checked for the one mistake that silently breaks phones.
 *
 * There is no browser in CI, so this cannot assert layout. What it can assert
 * is the invariant that caused the bug: an `fr` track whose floor is `auto`
 * cannot shrink below its widest child, so a single long unbreakable string
 * scrolls the entire page sideways on a narrow screen. Every `fr` track in
 * this stylesheet must therefore be written `minmax(0, …)`.
 *
 * This is a rule about the file, which is a weak kind of test, but it is the
 * kind that would have caught it: the two-column rule was already correct and
 * the mobile-first base rule was not, so a reviewer comparing them had every
 * reason to think the file was consistent.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../web/public/app.css', import.meta.url), 'utf8');

test('every fr track can shrink, so one long string cannot widen the page', () => {
  const declarations = css.match(/grid-template-columns:[^;]+;/g) ?? [];
  assert.ok(declarations.length > 0, 'expected some grid definitions to check');

  const offenders = declarations.filter((declaration) => {
    // Strip the minmax() calls, then see whether any bare `fr` is left over.
    const withoutMinmax = declaration.replace(/minmax\([^)]*\)/g, '');
    return /\d*\.?\d*fr/.test(withoutMinmax);
  });

  assert.deepEqual(
    offenders,
    [],
    `write these as minmax(0, 1fr) so the track can shrink:\n${offenders.join('\n')}`,
  );
});

test('wide content has somewhere to scroll that is not the page', () => {
  // Both of these carry content the author does not control the width of: a
  // pasted URL in a code block, a table in a Markdown description.
  for (const selector of ['.code-block', '.table-wrap']) {
    const block = new RegExp(`\\${selector}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? '';
    assert.match(block, /overflow-x:\s*auto/, `${selector} must scroll inside itself`);
  }
});
