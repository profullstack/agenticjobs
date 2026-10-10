import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCandidateSummary, withTags } from '../dist/core/candidates.js';
import { renderMarkdown } from '../dist/markup/markdown.js';
import { parseResume, resumeBodyMarkdown, resumeSearchText } from '../dist/markup/resume.js';

for (const spaces of [0, 1, 2, 3]) {
  test(`resume headings with ${spaces} leading spaces retain candidate skills`, () => {
    const indent = ' '.repeat(spaces);
    const markdown = [
      '# Ada Example', '', '- Email: ada@example.com', '', 'Engineer.', '',
      `${indent}## Experience`, '', `${indent}### Example Works | Remote`,
      'Engineer (2020 - Present)', '', '- Built orchestration systems.', '',
      `${indent}## Skills`, '', '- TypeScript', '- PostgreSQL',
    ].join('\n');
    const parsed = parseResume(markdown);
    const summary = toCandidateSummary({
      id: 'example', userId: 'example-user', slug: 'ada', title: 'Ada Example',
      markdown, parsed, visibility: 'public', publicSlug: 'ada', sourceName: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });

    assert.deepEqual(parsed.sections.map((section) => section.kind), ['experience', 'skills']);
    const entry = parsed.sections[0]?.entries[0];
    assert.equal(entry?.title, 'Example Works');
    assert.equal(entry?.place, 'Remote');
    assert.equal(entry?.start, '2020');
    assert.equal(entry?.current, true);
    assert.deepEqual(entry?.highlights, ['Built orchestration systems.']);
    assert.deepEqual(summary.skills, ['TypeScript', 'PostgreSQL']);
    assert.deepEqual(withTags([summary], ['TypeScript']), [summary]);
    assert.deepEqual(withTags([summary], ['Rust']), []);
    assert.match(resumeSearchText(parsed), /Example Works/);
    assert.match(resumeSearchText(parsed), /TypeScript/);
    assert.equal(parsed.markdown, markdown);
    assert.deepEqual(parsed.warnings, []);
    const html = renderMarkdown(resumeBodyMarkdown(markdown));
    assert.match(html, /<h2>Skills<\/h2>/);
    assert.match(html, /<h3>Example Works \| Remote<\/h3>/);
  });
}

for (const spaces of [1, 2, 3]) {
  test(`an indented name with ${spaces} spaces is promoted to the resume header`, () => {
    const indent = ' '.repeat(spaces);
    // A preceding example keeps source.trim() from masking the indentation.
    const markdown = [
      '```text', '# Example only', '```', '', `${indent}# Team C# ###`, '',
      '- Email: ada@example.com', '', 'Compiler engineer', '', '## Experience',
    ].join('\n');
    const parsed = parseResume(markdown);
    assert.equal(parsed.name, 'Team C#');
    assert.equal(parsed.headline, 'Compiler engineer');
    assert.deepEqual(parsed.contact.map((field) => field.value), ['ada@example.com']);
    assert.equal(parsed.warnings.some((warning) => warning.includes('More than one')), false);
    const body = resumeBodyMarkdown(markdown);
    assert.ok(!body.includes('Team C#'));
    assert.ok(!body.includes('ada@example.com'));
    assert.match(body, /# Example only/);
    assert.equal(parsed.markdown, markdown);
  });
}

test('indented entries work independently of section indentation', () => {
  const parsed = parseResume('# Ada\n## Experience\n   ### Compiler C# ###\nEngineer');
  assert.equal(parsed.sections[0]?.entries[0]?.title, 'Compiler C#');
  assert.equal(parsed.sections[0]?.entries[0]?.subtitle, 'Engineer');
});

test('four spaces, tabs and fenced examples do not create resume headings', () => {
  const example = ['   ```markdown', ' # Example', '  ## Skills', '   ### Sample', '   ```'];
  const markdown = [
    '# Ada', '## Projects', ...example, '    # Not a name', '    ## Not a section',
    '    ### Not an entry', '\t## Not a section', '## Experience',
  ].join('\n');
  const parsed = parseResume(markdown);
  assert.equal(parsed.name, 'Ada');
  assert.deepEqual(parsed.sections.map((section) => section.kind), ['projects', 'experience']);
  assert.deepEqual(parsed.sections[0]?.entries, []);
  assert.equal(parsed.warnings.some((warning) => warning.includes('More than one')), false);
  assert.equal(parsed.markdown, markdown);
});
