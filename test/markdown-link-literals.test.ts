import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderInline } from '../src/markup/markdown.ts';

const rel = 'nofollow ugc noopener noreferrer';

function href(source: string): string | undefined {
  return /<a href="([^"]*)"/.exec(renderInline(source))?.[1];
}

test('an explicit module link retains its __init__.py destination', () => {
  const url = 'https://example.com/__init__.py';
  assert.equal(href(`[Python module](${url})`), url);
});

test('a bare module URL retains its destination and literal display text', () => {
  const url = 'https://example.com/__init__.py';
  assert.equal(renderInline(url), `<a href="${url}" rel="${rel}">${url}</a>`);
});

test('an explicit link retains a literal bold-marker query value', () => {
  const url = 'https://example.com/search?q=**python**';
  assert.equal(href(`[Pattern search](${url})`), url);
});

test('a bare URL retains a literal strikethrough-marker query value', () => {
  const url = 'https://example.com/search?q=~~draft~~';
  assert.equal(renderInline(url), `<a href="${url}" rel="${rel}">${url}</a>`);
});

test('link labels retain emphasis and literal inline code', () => {
  assert.equal(
    renderInline('[**Project** `__init__.py`](https://example.com/project)'),
    `<a href="https://example.com/project" rel="${rel}">` +
      '<strong>Project</strong> <code>__init__.py</code></a>',
  );
});

test('paragraph emphasis can wrap a link', () => {
  assert.equal(
    renderInline('**[Project](https://example.com/project)**'),
    `<strong><a href="https://example.com/project" rel="${rel}">Project</a></strong>`,
  );
});

test('allowed URL schemes and local destinations retain their links', () => {
  for (const url of [
    'https://example.com/project',
    'http://example.com/project',
    'mailto:ada@example.com',
    'tel:+123456789',
    '/jobs/project',
    '#requirements',
  ]) {
    assert.equal(href(`[Contact](${url})`), url);
  }
});

test('unsafe and protocol-relative link destinations still produce no anchor', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,payload',
    '//example.com/project',
    '/\\example.com/project',
  ]) {
    assert.ok(!renderInline(`[Contact](${url})`).includes('<a '), url);
  }
});

test('link destination quotes and query separators remain escaped once', () => {
  assert.equal(
    renderInline('[Search](https://example.com/search?q="python"&sort=recent)'),
    '<a href="https://example.com/search?q=&quot;python&quot;&amp;sort=recent" ' +
      `rel="${rel}">Search</a>`,
  );
});

test('raw HTML in a formatted link label remains text', () => {
  const html = renderInline('[**<img src=x onerror=alert(1)>**](https://example.com)');
  assert.ok(!html.includes('<img '), html);
  assert.ok(html.includes('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>'), html);
});

test('image destinations and alt attributes remain literal and escaped', () => {
  assert.equal(
    renderInline('![**logo**"<tag>](https://example.com/__logo__.png)'),
    '<img src="https://example.com/__logo__.png" ' +
      'alt="**logo**&quot;&lt;tag&gt;" loading="lazy" />',
  );
});
