import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../dist/markup/markdown.js';
import { parseResume, resumeSearchText } from '../dist/markup/resume.js';

test('heading text keeps attached hashes at every supported level', () => {
  for (let level = 1; level <= 6; level += 1) {
    for (const content of ['C#', 'F#', 'Issue###', 'C# and F#']) {
      const marker = '#'.repeat(level);
      assert.equal(renderMarkdown(`${marker} ${content}`), `<h${level}>${content}</h${level}>`);
      assert.equal(renderMarkdown(`${marker} ${content}  `), `<h${level}>${content}</h${level}>`);
    }
  }
  assert.equal(renderMarkdown('## C#', { headingOffset: 1 }), '<h3>C#</h3>');
});

test('only whitespace-separated trailing hashes close a heading', () => {
  for (const closing of [' #', ' ###', '\t##', ' ## \t']) {
    assert.equal(renderMarkdown(`## C#${closing}`), '<h2>C#</h2>');
    assert.equal(renderMarkdown(`## Compiler${closing}`), '<h2>Compiler</h2>');
  }
  assert.equal(renderMarkdown('## C# ### notes'), '<h2>C# ### notes</h2>');
  assert.equal(renderMarkdown('## ###'), '<h2></h2>');
});

test('resume names, sections, entries and search text preserve attached hashes', () => {
  for (const closing of ['', ' ###', '\t##  ']) {
    const source = [
      `# Team C#${closing}`, '',
      `## C#${closing}`, '',
      `### Tools for F#${closing}`,
      'Compiler work.',
    ].join('\r\n');
    const parsed = parseResume(source);
    assert.equal(parsed.name, 'Team C#');
    assert.equal(parsed.sections[0]?.title, 'C#');
    assert.equal(parsed.sections[0]?.entries[0]?.title, 'Tools for F#');
    assert.match(resumeSearchText(parsed), /Team C#\nC#\nTools for F#/);
  }
});
