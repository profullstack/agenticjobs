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

test('code spans preserve boundary whitespace according to CommonMark', () => {
  const tick = '`';
  assert.equal(renderInline(tick + '  padded  ' + tick), '<code> padded </code>');
  assert.equal(renderInline(tick + '   ' + tick), '<code>   </code>');
  assert.equal(renderInline(tick + 'left ' + tick), '<code>left </code>');
  assert.equal(renderInline(tick + ' left' + tick), '<code> left</code>');
  assert.equal(renderInline(tick + '\tcode\t' + tick), '<code>\tcode\t</code>');
  assert.equal(renderInline(tick + '\u00a0code\u00a0' + tick), '<code>\u00a0code\u00a0</code>');
  assert.equal(renderInline(tick + 'literal' + tick), '<code>literal</code>');
  assert.equal(renderInline(tick + 'line\r\nbreak' + tick), '<code>line break</code>');
  assert.equal(renderInline(tick + 'line\rbreak' + tick), '<code>line break</code>');
  assert.equal(renderInline(tick + 'line\nbreak' + tick), '<code>line break</code>');
  assert.equal(renderInline(tick + '\n' + tick), '<code> </code>');
  assert.equal(renderInline(tick + '  line\n  break  ' + tick), '<code> line   break </code>');
});

test('a fence is not parsed as markup', () => {
  const html = renderMarkdown('```\n# not a heading\n**not bold**\n```');
  assert.ok(html.startsWith('<pre><code>'), html);
  assert.ok(!html.includes('<h1'), html);
  assert.ok(!html.includes('<strong>'), html);
});

test('a shorter fence inside a longer one stays literal code', () => {
  const html = renderMarkdown('````markdown\n```\n**literal**\n```\n````');
  assert.ok(html.includes('**literal**'), html);
  assert.ok(!html.includes('<strong>'), html);
  // The run of three backticks is content here, not a closer.
  assert.equal(html.match(/<pre>/g)?.length, 1, html);
});

test('a longer fence closes a shorter one, as CommonMark allows', () => {
  const html = renderMarkdown('```\ncode\n`````\nafter');
  assert.ok(html.includes('code'), html);
  assert.ok(html.includes('<p>after</p>'), html);
});

test('a tilde fence does not close a backtick fence', () => {
  const html = renderMarkdown('```\n~~~\nstill code\n```');
  assert.ok(html.includes('still code'), html);
  assert.equal(html.match(/<pre>/g)?.length, 1, html);
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

test('mismatched header and delimiter rows stay ordinary text', () => {
  const html = renderMarkdown('| a | b | c |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(!html.includes('<table>'), html);
  assert.ok(html.includes('| a | b | c |'), html);
});

test('a supported block after a table starts its own block', () => {
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n# | Heading |\n- | item |\n> | quote |');
  assert.equal(html.match(/<table>/g)?.length, 1, html);
  assert.ok(html.includes('<h1>| Heading |</h1>'), html);
  assert.ok(html.includes('<ul><li>| item |</li></ul>'), html);
  assert.ok(html.includes('<blockquote><p>| quote |</p></blockquote>'), html);
});

test('escaped pipes stay inside table cells and preserve later columns', () => {
  const html = renderMarkdown(
    '| Skill \\| Detail | Experience |\n| --- | --- |\n| Shell A\\|B | 3 years |',
  );
  assert.ok(html.includes('<th>Skill | Detail</th>'), html);
  assert.ok(html.includes('<td>Shell A|B</td><td>3 years</td>'), html);
});

test('escaped pipes retain code-span backslashes and the following columns', () => {
  const html = renderMarkdown(
    '| One | Two | Three | Four |\n| --- | --- | --- | --- |\n| `A\\|B` | `A\\\\|B` | `A\\\\\\|B` | `A\\\\\\\\|B` |',
  );
  assert.ok(
    html.includes(
      '<td><code>A|B</code></td><td><code>A\\|B</code></td><td><code>A\\\\|B</code></td><td><code>A\\\\\\|B</code></td>',
    ),
    html,
  );
});

test('table escaped pipes, empty cells, and alignment remain intact', () => {
  const html = renderMarkdown(
    '| A | B |\n| :--- | ---: |\n| | Note \\|',
  );
  assert.ok(html.includes('<td></td>'), html);
  assert.ok(html.includes('<td style="text-align:right">Note |</td>'), html);
});

test('lists keep single-line items inline', () => {
  const html = renderMarkdown('- one\n- two');
  assert.equal(html, '<ul><li>one</li><li>two</li></ul>');
});

test('ordered and unordered lists do not merge', () => {
  const html = renderMarkdown('- one\n1. two');
  assert.ok(html.includes('<ul>') && html.includes('<ol>'), html);
});

test('different list marker styles start new lists', () => {
  assert.equal(
    renderMarkdown('1. one\n2) two'),
    '<ol><li>one</li></ol>\n<ol start="2"><li>two</li></ol>',
  );
  assert.equal(
    renderMarkdown('- one\n* two'),
    '<ul><li>one</li></ul>\n<ul><li>two</li></ul>',
  );
});

test('ordered lists preserve a non-default starting number', () => {
  assert.equal(
    renderMarkdown('3. Review\n4. Deliver'),
    '<ol start="3"><li>Review</li><li>Deliver</li></ol>',
  );
  assert.equal(
    renderMarkdown('0. Prerequisite\n1. Run'),
    '<ol start="0"><li>Prerequisite</li><li>Run</li></ol>',
  );
  assert.equal(
    renderMarkdown('3) Review\n4) Deliver'),
    '<ol start="3"><li>Review</li><li>Deliver</li></ol>',
  );
});

test('ordered list starts normalize leading zeroes and nested starts', () => {
  assert.equal(renderMarkdown('01. First\n02. Second'), '<ol><li>First</li><li>Second</li></ol>');
  assert.equal(
    renderMarkdown('3. Parent\n   0. Child\n   1. Next\n4. Sibling'),
    '<ol start="3"><li><p>Parent</p>\n<ol start="0"><li>Child</li><li>Next</li></ol></li><li>Sibling</li></ol>',
  );
});

test('a bare url becomes a link, and a trailing full stop stays outside it', () => {
  const html = renderInline('see https://example.com/x.');
  assert.ok(html.includes('href="https://example.com/x"'), html);
  assert.ok(html.endsWith('.'), html);
});

test('ordinary links preserve escaped and balanced parentheses', () => {
  const escaped = renderInline('[Example](https://example.com/reports\\(2026\\))');
  assert.ok(escaped.includes('href="https://example.com/reports(2026)"'), escaped);
  assert.ok(!escaped.endsWith(')'), escaped);

  const balanced = renderInline('[Example](https://example.com/reports(2026))');
  assert.ok(balanced.includes('href="https://example.com/reports(2026)"'), balanced);
  assert.ok(!balanced.endsWith(')'), balanced);
  const punctuation = renderInline('See [Example](https://example.com/reports(2026)).');
  assert.ok(punctuation.includes('href="https://example.com/reports(2026)"'), punctuation);
  assert.ok(punctuation.endsWith('</a>.'), punctuation);
});

test('ordinary images and optional link titles preserve parenthesized destinations', () => {
  const image = renderInline('![Report](https://example.com/reports\\(2026\\).png)');
  assert.ok(image.includes('src="https://example.com/reports(2026).png"'), image);
  const titled = renderInline('[Example](https://example.com/reports(2026) "Annual (2026) report")', {
    linkRel: 'nofollow',
  });
  assert.ok(titled.includes('href="https://example.com/reports(2026)"'), titled);
  assert.ok(titled.includes('rel="nofollow"'), titled);
  assert.ok(!titled.includes('Annual (2026) report'), titled);
  for (const title of ['Annual ) report', 'Annual ( report']) {
    const withTitle = renderInline(`[Example](https://example.com/report "${title}")`);
    assert.equal(withTitle, '<a href="https://example.com/report" rel="nofollow ugc noopener noreferrer">Example</a>');
  }
  const noImages = renderInline('![Report](https://example.com/reports(2026).png)', { noImages: true });
  assert.ok(noImages.includes('<a href="https://example.com/reports(2026).png"'), noImages);
});

test('empty inline links keep their existing literal behavior', () => {
  const html = renderInline('[](https://example.com/reports(2026))');
  assert.ok(html.startsWith('[]('), html);
});

test('a query string in a link target is not double-escaped', () => {
  const html = renderInline('[jobs](https://example.com/?a=1&b=2)');
  assert.ok(html.includes('href="https://example.com/?a=1&amp;b=2"'), html);
  assert.ok(!html.includes('&amp;amp;'), html);
});

test('a query string in a bare url is not double-escaped', () => {
  const html = renderInline('see https://example.com/?a=1&b=2 now');
  assert.ok(html.includes('href="https://example.com/?a=1&amp;b=2"'), html);
  assert.ok(!html.includes('&amp;amp;'), html);
});

test('a query string in an image source is not double-escaped', () => {
  const html = renderInline('![chart](https://example.com/i.png?w=100&h=50)');
  assert.ok(html.includes('src="https://example.com/i.png?w=100&amp;h=50"'), html);
  assert.ok(!html.includes('&amp;amp;'), html);
});

test('a literal entity in a link target decodes exactly once', () => {
  const html = renderInline('[x](https://example.com/?a=1&amp;b=2)');
  // The source held the text "&amp;", which round-trips as &amp;amp; — the
  // browser decodes it back to the address the author wrote.
  assert.ok(html.includes('href="https://example.com/?a=1&amp;amp;b=2"'), html);
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

test('plain text truncation honors small limits and Unicode characters', () => {
  assert.equal(toPlainText('x'.repeat(161), 160).length, 160);
  assert.equal(toPlainText('exact fit', 9), 'exact fit');
  assert.equal(toPlainText('long text', 0), '');
  assert.equal(toPlainText('long text', 1), '.');
  assert.equal(toPlainText('long text', 2), '..');
  assert.equal(toPlainText('long text', 3), '...');
  assert.equal(toPlainText('long text', -1), '');
  assert.equal(toPlainText('long text', 2.9), '..');
  assert.equal(toPlainText('long text', Number.POSITIVE_INFINITY), 'long text');
  assert.equal(toPlainText('😀😀😀', 2), '..');
  assert.equal(toPlainText('😀😀😀😀😀', 4), '...');
  const repeatedEmoji = toPlainText('😀'.repeat(100), 160);
  assert.ok(repeatedEmoji.length <= 160, repeatedEmoji);
  assert.ok(repeatedEmoji.isWellFormed(), repeatedEmoji);
  assert.equal(toPlainText('界界界界界', 4), '界...');
  assert.equal(toPlainText('one two three', 9), 'one...');
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

test('every field that holds a document keeps its line breaks', async () => {
  // This bug has now been found three times in three places: job descriptions,
  // resume Markdown and the cover letter. All three go through clean(), all
  // three are documents, and the default flattens newlines. The rule is that
  // anything rendered as Markdown or written in a textarea is multiline.
  const { clean } = await import('../dist/schema/text.js');
  const doc = 'line one\nline two';

  // The three call sites, by the shape they pass.
  assert.equal(clean(doc, 100, { multiline: true }), doc);

  // And the default is still single-line, which is what titles and slugs need.
  assert.equal(clean(doc, 100), 'line one line two');
});
