import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJobDocument } from '../src/cli/jobfile.ts';

test('plain Markdown titles allow one to three leading spaces', () => {
  for (const indent of [1, 2, 3]) {
    const source = `Intro paragraph\n\n${' '.repeat(indent)}# Staff Engineer ##\n\nRole details`;
    assert.deepEqual(parseJobDocument(source), {
      title: 'Staff Engineer',
      description: source,
    });
  }
});

test('indented titles below front matter are removed without losing surrounding prose', () => {
  for (const indent of [1, 2, 3]) {
    const source = `---\norg: acme\n---\nIntro paragraph\n\n${' '.repeat(indent)}# Staff Engineer\n\nRole details`;
    assert.deepEqual(parseJobDocument(source), {
      org: 'acme',
      title: 'Staff Engineer',
      description: 'Intro paragraph\n\nRole details',
    });
  }
});

test('four-space indented code does not become a title', () => {
  const source = 'Intro paragraph\n\n    # Example only\n\nRole details';
  assert.deepEqual(parseJobDocument(source), { description: source });
  assert.equal(parseJobDocument(`${source}\n\n  # Actual role`).title, 'Actual role');
});

test('indented headings inside fenced code are still ignored', () => {
  const source = '```md\n  # Example only\n```\n\n   # Actual role';
  assert.equal(parseJobDocument(source).title, 'Actual role');
});

test('an explicit front matter title preserves an indented body heading', () => {
  const body = 'Intro paragraph\n\n  # Body heading\n\nRole details';
  assert.deepEqual(parseJobDocument(`---\ntitle: Explicit role\n---\n${body}`), {
    title: 'Explicit role',
    description: body,
  });
});

test('leading indented code after front matter stays code, even after blank lines', () => {
  for (const indent of ['    ', '\t']) {
    const body = `${indent}# Example only\n\nRole details`;
    for (const padding of ['', '\n \t\n']) {
      assert.deepEqual(parseJobDocument(`---\norg: acme\n---\n${padding}${body}\n\n`), {
        org: 'acme',
        description: body,
      });
    }
  }
});

test('the real title after leading indented code is extracted without deleting the example', () => {
  const body = '    # Example only\n\n  # Actual role\n\nRole details';
  assert.deepEqual(parseJobDocument(`---\norg: acme\n---\n${body}`), {
    org: 'acme',
    title: 'Actual role',
    description: '    # Example only\n\nRole details',
  });
});

test('an indented code-fence example does not hide the real title', () => {
  const body = '    ```md\n\n  # Actual role\n\nRole details';
  assert.deepEqual(parseJobDocument(`---\norg: acme\n---\n${body}`), {
    org: 'acme',
    title: 'Actual role',
    description: '    ```md\n\nRole details',
  });
});

test('explicit front matter titles retain initial body indentation', () => {
  const body = '    # Example only\n\nRole details';
  assert.deepEqual(parseJobDocument(`---\ntitle: Explicit role\n---\n${body}`), {
    title: 'Explicit role',
    description: body,
  });
});
