/**
 * Markdown to media.
 *
 * The Markdown is canonical and these are renderings of it, so what matters is
 * that a rendering carries the same document: the name once, the contact block
 * as a header rather than as a stray bullet list, and the sections in order.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resumeDocx, resumeHtml, filename, CONTENT_TYPE } from '../dist/core/markdown-media.js';
import { parseResume } from '../dist/markup/resume.js';

const MARKDOWN = [
  '# Ada Lovelace',
  '',
  '- Email: ada@example.com',
  '- Location: London',
  '',
  '## Professional Summary',
  '',
  'Wrote the first program.',
  '',
  '## Core Skills',
  '',
  '- Analytical Engine',
  '- Mathematics',
  '',
].join('\n');

test('the header is rendered as a header, not repeated as body text', () => {
  const html = resumeHtml({
    markdown: MARKDOWN,
    parsed: parseResume(MARKDOWN),
    title: 'Resume',
  });

  // Name once in the header, once in the title element, and nowhere else: the
  // h1 and the contact bullets are lifted out so the body does not repeat them.
  assert.equal((html.match(/Ada Lovelace/g) ?? []).length, 2, html.slice(0, 400));
  assert.match(html, /<h1>Ada Lovelace<\/h1>/);
  assert.match(html, /class="contact"/);
  assert.match(html, /ada@example\.com/);
  // The contact block must not also appear as a bullet list in the body.
  assert.ok(!/<li>Email: ada@example\.com<\/li>/.test(html), 'contact was repeated as a list');

  // And the sections survive, in order.
  assert.ok(html.indexOf('Professional Summary') < html.indexOf('Core Skills'));
  assert.match(html, /Wrote the first program\./);
});

test('the stylesheet is inlined, because a linked one silently fails in a PDF', () => {
  const html = resumeHtml({ markdown: MARKDOWN, parsed: parseResume(MARKDOWN), title: 'R' });
  assert.match(html, /<style>/);
  assert.ok(!html.includes('<link rel="stylesheet"'), 'a PDF engine fetches nothing');
  // Written for a print engine: grid does not render in one.
  assert.ok(!/display:\s*grid/.test(html), 'no grid in the export stylesheet');
  assert.match(html, /@page/);
});

test('a resume that parsed as nothing still renders', () => {
  // A document with no h1 has no header to lift, and must not lose its body.
  const plain = 'Just some text about me.\n';
  const html = resumeHtml({ markdown: plain, parsed: null, title: 'Fallback Title' });
  assert.match(html, /Fallback Title/);
  assert.match(html, /Just some text about me\./);
});

test('a downloaded file is named after the person', () => {
  assert.equal(filename('Ada Lovelace', 'pdf'), 'ada-lovelace.pdf');
  assert.equal(filename('  ', 'docx'), 'resume.docx');
  // A name that is punctuation all the way down still produces a filename.
  assert.equal(filename('!!!', 'pdf'), 'resume.pdf');
  assert.match(filename('A'.repeat(200), 'docx'), /^a{60}\.docx$/);
});

test('the content types are the ones a browser and Word expect', () => {
  assert.equal(CONTENT_TYPE.pdf, 'application/pdf');
  assert.match(CONTENT_TYPE.docx, /wordprocessingml\.document$/);
});

test('docx is produced by the converter already in the image', async () => {
  // pandoc is installed for reading .doc and .odt uploads; writing .docx is
  // the same binary, so this needs nothing new.
  let docx: Buffer;
  try {
    docx = await resumeDocx(MARKDOWN);
  } catch (error) {
    // A dev box without pandoc should not fail the suite, but the message has
    // to say which binary is missing rather than "exit 127".
    assert.match((error as Error).message, /pandoc/);
    return;
  }
  assert.ok(docx.length > 1000, `docx was ${docx.length} bytes`);
  // A .docx is a zip.
  assert.equal(docx.subarray(0, 2).toString(), 'PK');
});
