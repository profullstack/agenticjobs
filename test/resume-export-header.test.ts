import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resumeHtml } from '../dist/core/markdown-media.js';
import { parseResume } from '../dist/markup/resume.js';

function htmlFor(markdown: string): string {
  return resumeHtml({ markdown, parsed: parseResume(markdown), title: 'Resume' });
}

test('the documented headline appears only in the export header', () => {
  const markdown = '# Ada Lovelace\n\n- Email: ada@example.com\n\nMathematician\n\n## Skills\n\n- Analytical Engine';
  const html = htmlFor(markdown);
  assert.equal((html.match(/Mathematician/g) ?? []).length, 1);
  assert.match(html, /class="subtitle">Mathematician<\/p>/);
  assert.match(html, /Analytical Engine/);
});

for (const bullet of ['-', '*', '+']) {
  test(`contacts after a headline using ${bullet} are not repeated in the body`, () => {
    const markdown = `#\tAda Lovelace #\n\n**Mathematician**\n\n${bullet}\tEmail: ada@example.com\n${bullet} Location: London\n\n## Skills\n\n- Analytical Engine`;
    const html = htmlFor(markdown);
    const body = html.split('</header>')[1] ?? '';
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.equal((html.match(/Mathematician/g) ?? []).length, 1);
    assert.ok(!body.includes('ada@example.com'));
    assert.ok(!body.includes('London'));
    assert.match(body, /Analytical Engine/);
  });
}

test('unpromoted preamble text and additional headings survive the export', () => {
  const markdown = '# Ada Lovelace\n\nOperated by ada@example.com\n\n**Mathematician**\n\nA second paragraph with useful context.\n\n# Additional heading\n\n## Skills\n\n- Analytical Engine';
  const body = htmlFor(markdown).split('</header>')[1] ?? '';
  assert.match(body, /Operated by ada@example\.com/);
  assert.match(body, /A second paragraph with useful context\./);
  assert.match(body, /Additional heading/);
  assert.ok(!body.includes('Mathematician'));
});

test('a parsed document without a name keeps its body', () => {
  const markdown = 'Some introductory text.\n\n## Skills\n\n- Analytical Engine';
  const body = htmlFor(markdown).split('</header>')[1] ?? '';
  assert.match(body, /Some introductory text\./);
  assert.match(body, /Analytical Engine/);
});
