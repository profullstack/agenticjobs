import assert from 'node:assert/strict';
import test from 'node:test';
import { renderInline, renderMarkdown } from '../dist/markup/markdown.js';

const rel = 'nofollow ugc noopener noreferrer';

// Inline passes run after links and images have been emitted as HTML. None of
// them may look inside that emitted markup: a bare URL or an emphasis marker
// inside a label or an attribute must stay text, and a code span next to a
// bare URL must not be swallowed into its href.
test('bare url inside a link label stays label text', () => {
  assert.equal(
    renderInline('[see https://b.example](https://a.example)'),
    `<a href="https://a.example" rel="${rel}">see https://b.example</a>`,
  );
});

test('bare url inside an image alt stays attribute text', () => {
  const html = renderInline('![see https://b.example](https://x.example/i.png)');
  assert.equal(
    html,
    '<img src="https://x.example/i.png" alt="see https://b.example" loading="lazy" />',
  );
});

test('emphasis inside an image alt renders as plain text, not tags', () => {
  const html = renderInline('![*star* and **bold**](https://x.example/i.png)');
  assert.equal(
    html,
    '<img src="https://x.example/i.png" alt="star and bold" loading="lazy" />',
  );
});

test('emphasis still works inside a link label', () => {
  assert.equal(
    renderInline('[a *b* and **c**](https://x.example)'),
    `<a href="https://x.example" rel="${rel}">a <em>b</em> and <strong>c</strong></a>`,
  );
});

test('a code span at the end of a bare url is not swallowed into the href', () => {
  const html = renderInline('https://a.example/`code`');
  assert.equal(
    html,
    `<a href="https://a.example/" rel="${rel}">https://a.example/</a><code>code</code>`,
  );
});

test('a code span right after a link label is not swallowed either', () => {
  const html = renderInline('[x](https://a.example)`code`');
  assert.equal(
    html,
    `<a href="https://a.example" rel="${rel}">x</a><code>code</code>`,
  );
});

test('nested-link attempt inside a paragraph renders one anchor', () => {
  const html = renderMarkdown('Read [see https://b.example](https://a.example) today.');
  const anchors = html.match(/<a href=/g) ?? [];
  assert.equal(anchors.length, 1);
});
