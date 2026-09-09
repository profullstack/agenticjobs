/**
 * The markup pipeline.
 *
 * The security cases are first and are not negotiable: this renderer is the
 * only path from something a stranger typed to something a browser parses.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown, renderInline, toPlainText } from '../dist/markup/markdown.js';
import { escapeHtml, safeUrl, jsonForScript } from '../dist/markup/escape.js';

test('raw HTML in the source is content, never markup', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script'), html);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('an img onerror cannot be smuggled through a link label', () => {
  const html = renderInline('[<img src=x onerror=alert(1)>](https://example.com)');
  // The payload survives as TEXT, which is correct and harmless. What must not
  // survive is a tag: the assertion is about markup, not about the substring.
  assert.ok(!/<img/i.test(html), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), html);
});

test('javascript: urls are dropped, including obfuscated ones', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('JaVaScRiPt:alert(1)'), null);
  // A control character mid-scheme is the classic bypass.
  assert.equal(safeUrl(`java${String.fromCharCode(10)}script:alert(1)`), null);
  assert.equal(safeUrl('data:text/html,<script>'), null);
  assert.equal(safeUrl('https://example.com'), 'https://example.com');
  assert.equal(safeUrl('mailto:a@b.co'), 'mailto:a@b.co');
  assert.equal(safeUrl('/jobs/x'), '/jobs/x');
});

test('a link with a javascript target renders as text, not a dead anchor', () => {
  const html = renderInline('[click](javascript:alert(1))');
  assert.ok(!html.includes('<a '), html);
});

test('json for a script element escapes the closing tag', () => {
  const encoded = jsonForScript({ title: '</script><script>alert(1)</script>' });
  assert.ok(!encoded.includes('</script>'), encoded);
  assert.ok(encoded.includes('\\u003c'));
});

test('escapeHtml covers the five characters that matter', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('code spans keep their contents literal', () => {
  const html = renderInline('use `**not bold**` here');
  assert.ok(html.includes('<code>**not bold**</code>'), html);
  assert.ok(!html.includes('<strong>'), html);
});

test('a fence is not parsed as markup', () => {
  const html = renderMarkdown('```\n# not a heading\n**not bold**\n```');
  assert.ok(html.startsWith('<pre><code>'), html);
  assert.ok(!html.includes('<h1'), html);
  assert.ok(!html.includes('<strong>'), html);
});

test('headings can be shifted so an embedded document has no second h1', () => {
  assert.ok(renderMarkdown('# Title').includes('<h1>Title</h1>'));
  assert.ok(renderMarkdown('# Title', { headingOffset: 1 }).includes('<h2>Title</h2>'));
});

test('tables render and scroll inside themselves', () => {
  const html = renderMarkdown('| a | b |\n| --- | ---: |\n| 1 | 2 |');
  assert.ok(html.includes('<div class="table-wrap">'), html);
  assert.ok(html.includes('<th>a</th>'), html);
  assert.ok(html.includes('text-align:right'), html);
});

test('lists keep single-line items inline', () => {
  const html = renderMarkdown('- one\n- two');
  assert.equal(html, '<ul><li>one</li><li>two</li></ul>');
});

test('ordered and unordered lists do not merge', () => {
  const html = renderMarkdown('- one\n1. two');
  assert.ok(html.includes('<ul>') && html.includes('<ol>'), html);
});

test('a bare url becomes a link, and a trailing full stop stays outside it', () => {
  const html = renderInline('see https://example.com/x.');
  assert.ok(html.includes('href="https://example.com/x"'), html);
  assert.ok(html.endsWith('.'), html);
});

test('images can be forced to links, for documents strangers read', () => {
  const plain = renderInline('![alt](https://example.com/a.png)');
  assert.ok(plain.includes('<img'), plain);
  const safe = renderInline('![alt](https://example.com/a.png)', { noImages: true });
  assert.ok(!safe.includes('<img'), safe);
  assert.ok(safe.includes('<a href='), safe);
});

test('plain text strips markup and truncates on a word boundary', () => {
  const text = toPlainText('# Title\n\nSome **bold** words and a [link](https://x.co).', 20);
  assert.ok(!text.includes('#'), text);
  assert.ok(!text.includes('**'), text);
  assert.ok(text.endsWith('...'), text);
  assert.ok(text.length <= 21, text);
});

test('a description keeps the line breaks that are its structure', async () => {
  // clean() flattened every control character, newlines included, so a job
  // description posted from a Markdown file arrived as one paragraph and every
  // heading and list in it was destroyed before it was ever rendered.
  const { clean } = await import('../dist/schema/text.js');
  const markdown = '# Role\n\n- one\n- two\n\nEnd.';

  assert.equal(clean(markdown, 500, { multiline: true }), markdown);
  // Single-line fields are unchanged: a title with a newline in it is not a
  // title, and this is what keeps a slug on one line.
  assert.equal(clean(markdown, 500), '# Role  - one - two  End.');

  // Windows line endings normalise rather than doubling up.
  assert.equal(clean('a\r\nb', 500, { multiline: true }), 'a\nb');

  // Everything else below 0x20 still goes, including the ESC that starts an
  // ANSI sequence, because the TUI prints this text.
  assert.equal(clean('a\u001b[31mred\u0007b', 500, { multiline: true }), 'a [31mred b');
  assert.ok(!clean('x\u0000y', 500, { multiline: true }).includes('\u0000'));
});

test('a multi-line description renders as the markdown it is', () => {
  const html = renderMarkdown('# Role\n\n- one\n- two');
  assert.match(html, /<h1[^>]*>Role<\/h1>/);
  assert.match(html, /<li>one<\/li>/);
});
