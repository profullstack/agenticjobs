/**
 * OpenResume.md.
 *
 * The governing rule under test: every one of the six conventions degrades
 * rather than fails. A document that ignores all of them is still a resume.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseResume,
  redactContactChannels,
  resumeTemplate,
  resumeSearchText,
} from '../dist/markup/resume.js';

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

test('a section called "Core Skills" is still the skills section', () => {
  // A resume using this heading showed an empty skills list on its candidate
  // card while the section sat right there in the document.
  for (const heading of ['Skills', 'Core Skills', 'Key Skills', 'Technical Skills']) {
    const parsed = parseResume(`# A Person\n\n## ${heading}\n\n- TypeScript\n- Postgres\n`);
    const section = parsed.sections.find((item) => item.kind === 'skills');
    assert.ok(section, `"${heading}" should be the skills section`);
    // The written name is kept even though the kind is normalised.
    assert.equal(section?.title, heading);
  }
});

test('a skills badge is a skill, not the category it sits under', async () => {
  // Resumes commonly write "- **Languages:** JavaScript, Go", and the first
  // badge on the candidate card read "**Languages:** JavaScript".
  const { toCandidateSummary } = await import('../dist/core/candidates.js');
  const markdown = [
    '# A Person',
    '',
    '## Core Skills',
    '',
    '- **Languages:** JavaScript, TypeScript, Go',
    '- **Data:** PostgreSQL',
    '- Docker',
  ].join('\n');

  const summary = toCandidateSummary({
    id: 'x', userId: 'u', slug: 's', title: 'T', markdown,
    parsed: parseResume(markdown), visibility: 'public', publicSlug: 's',
    sourceName: null, createdAt: '', updatedAt: '',
  });

  assert.deepEqual(summary.skills, [
    'JavaScript', 'TypeScript', 'Go', 'PostgreSQL', 'Docker',
  ]);
});

/**
 * Contact channels are for signed-in callers.
 *
 * A public resume is still public. What is gated is the block that is worth
 * harvesting on its own, and the test of what counts is whether the parse
 * produced a link: a channel is a way to reach someone, a location is a fact
 * about them and the directory already shows it.
 */

const WITH_FACTS = [
  '# Ada Lovelace',
  '',
  '- **Email**: ada@example.com',
  '- **Phone**: +1 (408) 555-0100',
  '- **Location**: London, England',
  '- **Work Authorization**: UK Citizen',
  '- [GitHub](https://github.com/ada)',
  '',
  'Mathematician.',
  '',
  '## Links',
  '',
  '- [Notes](https://example.com/notes)',
  '',
  '## Work Experience',
  '',
  '### Analytical Engine | London',
  'Chief Programmer (1842 - 1843)',
  '',
  '- Wrote the first published algorithm.',
].join('\n');

test('a contact channel is withheld and a plain fact is not', () => {
  const { markdown, redacted } = redactContactChannels(WITH_FACTS);
  assert.equal(redacted, true);

  assert.ok(!markdown.includes('ada@example.com'), 'the address is gone');
  assert.ok(!markdown.includes('555-0100'), 'the phone number is gone');
  assert.ok(!markdown.includes('github.com/ada'), 'the profile link is gone');

  // These read as facts about the person, not as ways to reach them, and the
  // candidate card prints the location whether or not anybody is signed in.
  assert.ok(markdown.includes('London, England'), 'the location stays');
  assert.ok(markdown.includes('UK Citizen'), 'work authorization stays');
});

test('what was withheld says so, in the place it was withheld from', () => {
  const { markdown } = redactContactChannels(WITH_FACTS);
  const parsed = parseResume(markdown);

  // Re-parsing the redacted Markdown is how the routes build the object they
  // serve, so the document and its parse can never disagree.
  const keys = parsed.contact.map((item) => item.key.toLowerCase());
  assert.deepEqual(keys, ['contact', 'location', 'work authorization']);
  assert.equal(parsed.contact[0]?.value, 'shared with signed-in members');
  assert.equal(parsed.contact[0]?.href, null, 'the notice is not itself a link');

  // A caller that cannot tell this from a resume with no contact details will
  // report the second as the first.
  assert.ok(parsed.contact.length > 0, 'the block is not simply emptied');
  assert.equal(parsed.name, 'Ada Lovelace', 'the rest of the document is untouched');
});

test('only the contact block is redacted, not every link in the resume', () => {
  const { markdown } = redactContactChannels(WITH_FACTS);
  assert.ok(
    markdown.includes('https://example.com/notes'),
    'a link under a heading is content, not a contact channel',
  );
  assert.ok(markdown.includes('Wrote the first published algorithm.'));
  assert.ok(markdown.includes('## Work Experience'));
});

test('a resume with nothing to withhold is not reported as redacted', () => {
  const plain = ['# A Person', '', '- **Location**: Berlin', '', '## Skills', '', '- Go'].join('\n');
  const { markdown, redacted } = redactContactChannels(plain);
  assert.equal(redacted, false);
  assert.equal(markdown, plain, 'and it comes back untouched');
});

test('resumeForViewer gates on being signed in, and nothing else', async () => {
  const { resumeForViewer } = await import('../dist/core/candidates.js');
  const resume = { markdown: WITH_FACTS, parsed: parseResume(WITH_FACTS) };

  const member = resumeForViewer(resume, true);
  assert.equal(member.redacted, false);
  assert.equal(member.markdown, WITH_FACTS, 'a signed-in caller reads the whole document');
  assert.ok(member.markdown.includes('ada@example.com'));

  // An agent with a device token arrives here as a viewer too, which is the
  // point: the board is for agents reading on somebody's behalf.
  const anonymous = resumeForViewer(resume, false);
  assert.equal(anonymous.redacted, true);
  assert.ok(!anonymous.markdown.includes('ada@example.com'));
  assert.ok(
    !JSON.stringify(anonymous.parsed).includes('ada@example.com'),
    'the parse is rebuilt from the redacted Markdown, not passed through',
  );
});

test('a redacted resume still has a location for the directory card', async () => {
  const { resumeForViewer, toCandidateSummary } = await import('../dist/core/candidates.js');
  const anonymous = resumeForViewer(
    { markdown: WITH_FACTS, parsed: parseResume(WITH_FACTS) },
    false,
  );

  const summary = toCandidateSummary({
    id: 'x', userId: 'u', slug: 's', title: 'T',
    markdown: anonymous.markdown, parsed: anonymous.parsed,
    visibility: 'public', publicSlug: 's',
    sourceName: null, createdAt: '', updatedAt: '',
  });

  assert.equal(summary.name, 'Ada Lovelace');
  assert.equal(summary.location, 'London, England');
});
