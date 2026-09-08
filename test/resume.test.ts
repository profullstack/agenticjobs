/**
 * OpenResume.md.
 *
 * The governing rule under test: every one of the six conventions degrades
 * rather than fails. A document that ignores all of them is still a resume.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResume, resumeTemplate, resumeSearchText } from '../dist/markup/resume.js';

const FULL = `# Ada Lovelace

- **Email**: ada@example.com
- **Phone**: +1 (408) 555-0100
- **Web**: example.com
- [GitHub](https://github.com/ada)

Mathematician, looking for work on machines that do not exist yet.

## Work Experience

### Analytical Engine | London
Chief Programmer (1842 - 1843)

- Wrote the first published algorithm intended for a machine.
- Described what the engine could do beyond arithmetic.

### Difference Engine | London
Correspondent (Mar 2020 - Present)

- Still going.

## Skills

- Languages: analytical notation, French
`;

test('the name, headline and contact block are read', () => {
  const resume = parseResume(FULL);
  assert.equal(resume.name, 'Ada Lovelace');
  assert.match(resume.headline ?? '', /Mathematician/);
  const keys = resume.contact.map((field) => field.key);
  assert.deepEqual(keys, ['Email', 'Phone', 'Web', 'GitHub']);
});

test('contact values are linked by what they are, not by their key', () => {
  const contact = parseResume(FULL).contact;
  assert.equal(contact[0]?.href, 'mailto:ada@example.com');
  assert.equal(contact[1]?.href, 'tel:+14085550100');
  // A bare domain is a URL even though nothing said so.
  assert.equal(contact[2]?.href, 'https://example.com');
  assert.equal(contact[3]?.href, 'https://github.com/ada');
});

test('section names are normalised but the written name is kept', () => {
  const sections = parseResume(FULL).sections;
  const experience = sections.find((section) => section.kind === 'experience');
  assert.ok(experience);
  assert.equal(experience.title, 'Work Experience');
  assert.equal(experience.entries.length, 2);
});

test('an entry splits into title and place, and its range is read', () => {
  const experience = parseResume(FULL).sections.find((s) => s.kind === 'experience');
  const first = experience?.entries[0];
  assert.equal(first?.title, 'Analytical Engine');
  assert.equal(first?.place, 'London');
  assert.equal(first?.start, '1842');
  assert.equal(first?.end, '1843');
  assert.equal(first?.current, false);
  assert.equal(first?.highlights.length, 2);
});

test('"Present" marks a current role', () => {
  const experience = parseResume(FULL).sections.find((s) => s.kind === 'experience');
  assert.equal(experience?.entries[1]?.current, true);
  assert.equal(experience?.entries[1]?.start, 'Mar 2020');
});

test('an en dash and an em dash are ranges too', () => {
  for (const dash of ['–', '—']) {
    const resume = parseResume(`# A\n\n## Experience\n\n### B\nRole (2019 ${dash} 2021)\n`);
    const entry = resume.sections[0]?.entries[0];
    assert.equal(entry?.start, '2019', dash);
    assert.equal(entry?.end, '2021', dash);
  }
});

test('a section written as prose keeps its prose instead of losing it', () => {
  const resume = parseResume('# A\n\n## Education\n\nSan Diego State University (1993-1998)\n');
  const education = resume.sections.find((section) => section.kind === 'education');
  assert.equal(education?.entries.length, 0);
  assert.match(education?.markdown ?? '', /San Diego State/);
});

test('a document with nothing but a name still parses', () => {
  const resume = parseResume('# Someone');
  assert.equal(resume.name, 'Someone');
  assert.equal(resume.sections.length, 0);
  // The warnings are advice, never errors.
  assert.ok(resume.warnings.length > 0);
});

test('a document with no name parses and says so', () => {
  const resume = parseResume('Just some text about me.');
  assert.equal(resume.name, null);
  assert.ok(resume.warnings.some((warning) => warning.includes('No name')));
});

test('the markdown is carried through untouched', () => {
  assert.equal(parseResume(FULL).markdown, FULL.trim());
});

test('the search text covers every section and highlight', () => {
  const text = resumeSearchText(parseResume(FULL));
  assert.match(text, /Analytical Engine/);
  assert.match(text, /first published algorithm/);
  assert.match(text, /analytical notation/);
});

test('the template is itself valid, with no warnings that matter', () => {
  const resume = parseResume(resumeTemplate('Ada Lovelace'));
  assert.equal(resume.name, 'Ada Lovelace');
  assert.ok(resume.sections.some((section) => section.kind === 'experience'));
  assert.deepEqual(resume.warnings, []);
});
