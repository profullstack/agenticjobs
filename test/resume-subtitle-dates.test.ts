import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResume } from '../src/markup/resume.ts';

for (const subtitle of [
  'Engineer - Platform',
  'Engineer – Platform',
  'Engineer — Platform',
  'Assistant to Director',
  'Engineer - Current Systems',
]) {
  test(`undated subtitle stays prose: ${subtitle}`, () => {
    const resume = parseResume(`# Ada\n\n## Experience\n\n### Example\n${subtitle}\n`);
    const entry = resume.sections[0]?.entries[0];
    assert.equal(entry?.subtitle, subtitle);
    assert.equal(entry?.start, null);
    assert.equal(entry?.end, null);
    assert.equal(entry?.current, false);
    assert.equal(entry?.markdown, subtitle);
  });
}

test('a role containing separators still uses its trailing date range', () => {
  const resume = parseResume(
    '# Ada\n\n## Experience\n\n### Example\nAssistant to Director - Platform (Mar 2020 - Present)\n',
  );
  const entry = resume.sections[0]?.entries[0];
  assert.equal(entry?.start, 'Mar 2020');
  assert.equal(entry?.end, 'Present');
  assert.equal(entry?.current, true);
});
