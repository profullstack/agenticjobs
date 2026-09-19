import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResume } from '../dist/markup/resume.js';

for (const marker of ['```', '~~~']) {
  test(`resume sections retain ${marker} examples without interpreting their headings`, () => {
    const example = [marker + 'markdown', '# Example name', '## Example section', '### Example entry', '- Example bullet', marker].join('\n');
    const source = ['# Ada', '## Projects', example, '### Real project', 'Maintainer (2024 - Present)', '- Shipped a parser', '## Education', 'University'].join('\n');
    const resume = parseResume(source);
    assert.equal(resume.name, 'Ada');
    assert.deepEqual(resume.sections.map((section) => section.title), ['Projects', 'Education']);
    assert.equal(resume.sections[0]?.markdown, example);
    assert.deepEqual(resume.sections[0]?.entries.map((entry) => entry.title), ['Real project']);
    assert.deepEqual(resume.sections[0]?.entries[0]?.highlights, ['Shipped a parser']);
    assert.equal(resume.warnings.some((warning) => warning.includes('More than one')), false);
    assert.equal(resume.markdown, source);
  });
}

test('entry code stays in the body and does not become a role or an achievement', () => {
  const example = ['```text', '- sample item', '### sample heading', '```'].join('\n');
  const resume = parseResume(['# Ada', '## Experience', '### Compiler', example, 'Engineer (2020 - Present)', '- Real achievement'].join('\n'));
  const entry = resume.sections[0]?.entries[0];
  assert.equal(resume.sections[0]?.entries.length, 1);
  assert.equal(entry?.subtitle, 'Engineer (2020 - Present)');
  assert.equal(entry?.start, '2020');
  assert.equal(entry?.current, true);
  assert.deepEqual(entry?.highlights, ['Real achievement']);
  assert.equal(entry?.markdown, example + '\nEngineer (2020 - Present)\n- Real achievement');
});

test('code before and after the name cannot supply identity or contact fields', () => {
  const source = ['```markdown', '# Example person', '```', '# Ada', '~~~text', '- Email: sample@example.com', 'Example headline', '~~~', '- Email: ada@example.com', 'Compiler engineer', '## Experience'].join('\n');
  const resume = parseResume(source);
  assert.equal(resume.name, 'Ada');
  assert.equal(resume.headline, 'Compiler engineer');
  assert.deepEqual(resume.contact.map((field) => field.value), ['ada@example.com']);
  assert.equal(resume.markdown, source);
});

test('only a matching, sufficiently long fence without trailing text ends the example', () => {
  const example = ['   ````markdown', '```', '## Short marker is content', '~~~~', '## Different marker is content', '```` trailing text', '## Trailing text is content', '  `````\t'].join('\n');
  const resume = parseResume(['# Ada', '## Projects', example, '## Experience'].join('\n'));
  assert.deepEqual(resume.sections.map((section) => section.title), ['Projects', 'Experience']);
  assert.equal(resume.sections[0]?.markdown, example.trim());
});

test('an unfinished code block retains its remaining content without extra sections', () => {
  const example = ['~~~text', '## Example section', '### Example entry', '- Example bullet'].join('\n');
  const resume = parseResume(['# Ada', '## Projects', example].join('\n'));
  assert.deepEqual(resume.sections.map((section) => section.title), ['Projects']);
  assert.equal(resume.sections[0]?.markdown, example);
  assert.deepEqual(resume.sections[0]?.entries, []);
});

test('inline backticks and short markers do not hide later resume sections', () => {
  for (const line of ['``inline``', '``` inline ` code', '~~not a fence']) {
    const resume = parseResume(['# Ada', '## Projects', line, '## Experience'].join('\n'));
    assert.deepEqual(resume.sections.map((section) => section.title), ['Projects', 'Experience'], line);
    assert.equal(resume.sections[0]?.markdown, line);
  }
});
