/**
 * Withholding contact channels from signed-out readers.
 *
 * Both cases here were live on agenticjobs.work at the same time, in one real
 * candidate's profile, and each defeated the redaction a different way: an
 * address in a section body was never looked at, and the candidate directory
 * served a cached headline that predated the parser fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTACT_WITHHELD, redactContactChannels } from '../dist/markup/resume.js';
import { nameOf, toCandidateSummary } from '../dist/core/candidates.js';

const ADDRESS = 'bb8654838@example.com';

test('an address in a section body is withheld, not only one in the preamble', () => {
  const source = [
    '# Athena',
    '',
    '**Operated by:** DevilX (' + ADDRESS + ')',
    '',
    '## Availability',
    'Full-time autonomous. Contact: ' + ADDRESS,
    '',
  ].join('\n');

  const { markdown, redacted } = redactContactChannels(source);

  assert.equal(redacted, true);
  assert.ok(!markdown.includes(ADDRESS), 'no copy of the address may survive');
  // Both occurrences, not just the first one anybody happened to look at.
  assert.equal(markdown.split(CONTACT_WITHHELD).length - 1, 2);
  assert.match(markdown, /Full-time autonomous/);
});

test('every address on a line is withheld, not just the first', () => {
  const source = `# X\n\n## Contact\nReach a@example.com or b@example.com today\n`;
  const { markdown } = redactContactChannels(source);
  assert.ok(!markdown.includes('a@example.com'));
  assert.ok(!markdown.includes('b@example.com'));
});

/**
 * The global-regex trap.
 *
 * `EMAIL_IN_TEXT` is global, and a global regex's `test` advances `lastIndex`
 * between calls — so `test` then `replace` skips matches it has already walked
 * past. With many addresses on consecutive lines that drops roughly every
 * other one, while a single-line unit test passes happily.
 */
test('consecutive lines each get redacted, with no lastIndex carry-over', () => {
  const lines = ['# X', '', '## Contact'];
  for (let i = 0; i < 10; i++) lines.push(`person${i}@example.com`);
  const { markdown } = redactContactChannels(lines.join('\n'));

  for (let i = 0; i < 10; i++) {
    assert.ok(!markdown.includes(`person${i}@example.com`), `person${i} survived`);
  }
});

test('a resume with no address is returned untouched', () => {
  const source = '# X\n\n- **Location**: Remote\n\n## Summary\nNothing to hide.\n';
  const { markdown, redacted } = redactContactChannels(source);
  assert.equal(redacted, false);
  assert.equal(markdown, source);
});

/**
 * The stale cache.
 *
 * `parsed` is written on save, so a parser fix does not repair rows already in
 * the table. The directory kept serving the old headline — with the markup and
 * the address in it — from correct code reading a stale value.
 */
test('a cached headline holding an address is dropped at render time', () => {
  const summary = toCandidateSummary({
    id: 'r1',
    userId: 'u1',
    slug: 'athena',
    title: 'Athena',
    markdown: '# Athena\n',
    parsed: {
      name: 'Athena',
      headline: `Operated by:** DevilX (${ADDRESS})`,
      contact: [],
      sections: [],
      markdown: '',
      warnings: [],
    },
    visibility: 'public',
    publicSlug: 'athena',
    sourceName: null,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  } as never);

  assert.equal(summary.headline, null);
});

test('an address in the name line is withheld, not passed through as the h1', () => {
  const source = `# Jane Doe ${ADDRESS}\n\n- **Location**: Berlin\n\n## Summary\nText.\n`;
  const { markdown, redacted } = redactContactChannels(source);

  assert.equal(redacted, true);
  assert.ok(!markdown.includes(ADDRESS), 'the h1 must not carry the address');
  assert.match(markdown, new RegExp(`^# Jane Doe ${CONTACT_WITHHELD}$`, 'm'));
});

test('an address in a section heading is withheld', () => {
  const source = `# Jane\n\n- **Location**: Berlin\n\n## Contact me at ${ADDRESS}\nText.\n`;
  const { markdown, redacted } = redactContactChannels(source);

  assert.equal(redacted, true);
  assert.ok(!markdown.includes(ADDRESS), 'the h2 must not carry the address');
});

test('an address in a plain-fact contact bullet is withheld', () => {
  const source = `# Jane\n\n- **Location**: Berlin\n- **Note**: mail me at ${ADDRESS} anytime\n\n## Summary\nOk.\n`;
  const { markdown, redacted } = redactContactChannels(source);

  assert.equal(redacted, true);
  assert.ok(!markdown.includes(ADDRESS), 'a bullet without an href must not carry the address');
  assert.match(markdown, /- \*\*Note\*\*: mail me at /, 'the fact itself stays');
});

test('a name holding an address is dropped on the directory card', () => {
  const summary = toCandidateSummary({
    id: 'r1',
    userId: 'u1',
    slug: 'jane',
    title: 'Jane Doe',
    markdown: '# x\n',
    parsed: {
      name: `Jane Doe ${ADDRESS}`,
      headline: null,
      contact: [],
      sections: [],
      markdown: '',
      warnings: [],
    },
    visibility: 'public',
    publicSlug: 'jane',
    sourceName: null,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  } as never);

  assert.equal(summary.name, 'Jane Doe');
});

test('a title holding an address is not the fallback either', () => {
  const name = nameOf({
    id: 'r1',
    userId: 'u1',
    slug: 'jane',
    title: `Reach me at ${ADDRESS}`,
    markdown: '# x\n',
    parsed: { name: null, headline: null, contact: [], sections: [], markdown: '', warnings: [] },
    visibility: 'public',
    publicSlug: 'jane',
    sourceName: null,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  } as never);

  assert.equal(name, 'Candidate');
});

test('a cached headline with stray markup is cleaned, not dropped', () => {
  const summary = toCandidateSummary({
    id: 'r1',
    userId: 'u1',
    slug: 'x',
    title: 'X',
    markdown: '# X\n',
    parsed: {
      name: 'X',
      headline: 'Security agent** for hire',
      contact: [],
      sections: [],
      markdown: '',
      warnings: [],
    },
    visibility: 'public',
    publicSlug: 'x',
    sourceName: null,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  } as never);

  assert.equal(summary.headline, 'Security agent for hire');
});
