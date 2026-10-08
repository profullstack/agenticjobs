import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJobDocument } from '../src/cli/jobfile.ts';

test('closing hashes are not part of a plain Markdown job title', () => {
  for (const heading of ['# Staff Engineer #', '# Staff Engineer ##', '# Staff Engineer ###   ']) {
    const source = `${heading}\n\nRole details`;
    assert.deepEqual(parseJobDocument(source), {
      title: 'Staff Engineer',
      description: source.trim(),
    });
  }
});

test('closing hashes are not part of a title derived below front matter', () => {
  const parsed = parseJobDocument(
    '---\norg: acme\n---\nIntro paragraph\n\n# Staff Engineer ##\n\nRole details',
  );
  assert.deepEqual(parsed, {
    org: 'acme',
    title: 'Staff Engineer',
    description: 'Intro paragraph\n\nRole details',
  });
});

test('a heading made only of closing hashes yields an empty title, as an empty heading does', () => {
  for (const heading of ['# #', '# ###', '# ###   ']) {
    const source = `${heading}\n\nRole details`;
    assert.deepEqual(parseJobDocument(source), { title: '', description: source.trim() });
    assert.equal(parseJobDocument(`---\norg: acme\n---\n${source}`).title, '');
  }
});

test('hashes that are part of the title text are kept', () => {
  assert.equal(parseJobDocument('# Senior C#\n\nRole details').title, 'Senior C#');
  assert.equal(
    parseJobDocument('# F# and C# Engineer\n\nRole details').title,
    'F# and C# Engineer',
  );
  assert.equal(parseJobDocument('# Issue #42 Owner\n\nRole details').title, 'Issue #42 Owner');
  assert.equal(parseJobDocument('# Senior C# ##\n\nRole details').title, 'Senior C#');
});

test('an explicit front matter title and its body are unchanged', () => {
  const parsed = parseJobDocument(
    '---\ntitle: Platform Lead #\norg: acme\n---\n# Staff Engineer ##\n\nRole details',
  );
  assert.deepEqual(parsed, {
    title: 'Platform Lead #',
    org: 'acme',
    description: '# Staff Engineer ##\n\nRole details',
  });
});

test('a closing-hash heading inside a code fence is still not a title', () => {
  const source = '```md\n# Example only ##\n```\n\n# Staff Engineer ##\n\nRole details';
  assert.equal(parseJobDocument(source).title, 'Staff Engineer');
});
