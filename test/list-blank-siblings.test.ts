import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../src/markup/markdown.ts';

// CommonMark's list rule: blank lines between sibling items make a loose list,
// rather than restarting each ordered item in a separate list.
// https://spec.commonmark.org/0.31.2/#lists
test('blank-separated automatic numbering stays in one ordered list', () => {
  const source = '1. Read the brief\n\n1. Prepare the patch\n\n1. Run the checks';
  assert.equal(
    renderMarkdown(source),
    '<ol><li><p>Read the brief</p></li><li><p>Prepare the patch</p></li><li><p>Run the checks</p></li></ol>',
  );
});

test('a loose ordered list retains only its first starting number', () => {
  assert.equal(
    renderMarkdown('3. Review\n\n1. Deliver'),
    '<ol start="3"><li><p>Review</p></li><li><p>Deliver</p></li></ol>',
  );
});

test('blank-separated bullets keep one loose list for each supported marker', () => {
  for (const marker of ['-', '*', '+']) {
    assert.equal(
      renderMarkdown(`${marker} Rust\n\n${marker} TypeScript`),
      '<ul><li><p>Rust</p></li><li><p>TypeScript</p></li></ul>',
    );
  }
});

test('whitespace-only blank runs and CRLF do not reset sibling numbering', () => {
  assert.equal(
    renderMarkdown('1) First\r\n \t\r\n\r\n1) Second'),
    '<ol><li><p>First</p></li><li><p>Second</p></li></ol>',
  );
});

test('one blank sibling separator makes all items in that list loose', () => {
  assert.equal(
    renderMarkdown('1. First\n\n1. Second\n1. Third'),
    '<ol><li><p>First</p></li><li><p>Second</p></li><li><p>Third</p></li></ol>',
  );
});

test('nested loose siblings stay nested and do not consume the parent sibling', () => {
  assert.equal(
    renderMarkdown('- Parent\n  1. Child\n\n  1. Next child\n- Sibling'),
    '<ul><li><p>Parent</p>\n<ol><li><p>Child</p></li><li><p>Next child</p></li></ol></li><li>Sibling</li></ul>',
  );
});

test('a blank line before another marker style still starts a separate list', () => {
  for (const [source, expected] of [
    ['1. First\n\n1) Second', '<ol><li>First</li></ol>\n<ol><li>Second</li></ol>'],
    ['- First\n\n* Second', '<ul><li>First</li></ul>\n<ul><li>Second</li></ul>'],
    ['1. First\n\n- Second', '<ol><li>First</li></ol>\n<ul><li>Second</li></ul>'],
  ]) {
    assert.equal(renderMarkdown(source), expected);
  }
});

test('a blank-separated thematic break is not mistaken for another bullet', () => {
  for (const marker of ['-', '*']) {
    assert.equal(
      renderMarkdown(`${marker} Before\n\n${marker} ${marker} ${marker}\n\n${marker} After`),
      '<ul><li>Before</li></ul>\n<hr />\n<ul><li>After</li></ul>',
    );
  }
});

test('outside paragraphs, quotes, headings and tight lists retain their boundaries', () => {
  for (const [source, expected] of [
    ['- Item\n\nOutside', '<ul><li>Item</li></ul>\n<p>Outside</p>'],
    ['- Item\n\n> Outside', '<ul><li>Item</li></ul>\n<blockquote><p>Outside</p></blockquote>'],
    ['- Item\n\n# Outside', '<ul><li>Item</li></ul>\n<h1>Outside</h1>'],
    ['1. First\n1. Second', '<ol><li>First</li><li>Second</li></ol>'],
  ]) {
    assert.equal(renderMarkdown(source), expected);
  }
});
