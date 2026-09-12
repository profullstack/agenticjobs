/**
 * OpenProfile.md, derived from a resume.
 *
 * The rule under test: the profile is a rendering of the resume the viewer
 * is allowed to see, so whatever the redaction gate withheld from the resume
 * never surfaces in the profile, and nothing the resume did not say is
 * invented (an unstated kind stays unstated).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openProfileFromResume } from '../dist/markup/openprofile.js';
import { parseResume, redactContactChannels } from '../dist/markup/resume.js';

const RESUME = `# Ada Lovelace

- **Email**: ada@example.com
- **Web**: ada.example
- **Location**: London
- **Pronouns**: she/her
- **PGP**: 0xDEADBEEF
- [GitHub](https://github.com/ada)
- [Bluesky](https://bsky.app/profile/ada.example)

Mathematician, looking for work on machines that do not exist yet.

## Skills

- Languages: analytical notation, French
- Tools: difference engine

## Links

- [Blog](https://ada.example/blog)
- https://mathstodon.xyz/@ada
- [GitHub](https://github.com/ada/)
`;

const source = (markdown: string) => ({
  name: 'Ada Lovelace',
  parsed: parseResume(markdown),
  topics: ['analytical notation', 'French', 'difference engine'],
  resumeUrl: 'https://board.example/candidates/ada/resume.md',
});

test('a person: identity block, headline, accounts, topics, no invented kind', () => {
  const md = openProfileFromResume(source(RESUME));
  const lines = md.split('\n');
  assert.equal(lines[0], '# Ada Lovelace');
  assert.ok(
    !md.includes('**Kind**'),
    'nothing in the resume said what kind, so the profile does not either',
  );
  assert.ok(md.includes('- **Email**: ada@example.com'));
  assert.ok(
    md.includes('- **Web**: https://ada.example'),
    'a bare domain becomes the link the resume linked',
  );
  assert.ok(md.includes('- **Pronouns**: she/her'));
  assert.ok(md.includes('- **PGP**: 0xDEADBEEF'), 'unknown keys are kept as written');
  assert.ok(md.includes('- **Resume**: https://board.example/candidates/ada/resume.md'));
  assert.ok(md.includes('\nMathematician, looking for work on machines that do not exist yet.\n'));
  assert.ok(md.includes('## Accounts'));
  assert.ok(md.includes('- [GitHub](https://github.com/ada)'));
  assert.ok(md.includes('- [Bluesky](https://bsky.app/profile/ada.example)'));
  assert.ok(md.includes('- [Blog](https://ada.example/blog)'));
  assert.ok(
    md.includes('- [mathstodon.xyz](https://mathstodon.xyz/@ada)'),
    'a bare URL is labelled by its host',
  );
  assert.equal(
    md.match(/github\.com\/ada/g)?.length,
    1,
    'the same account listed twice appears once',
  );
  assert.ok(!md.includes('[Web]'), 'the home page is identity, not an account');
  assert.ok(md.includes('## Topics\n\n- analytical notation, French, difference engine'));
  assert.ok(!md.includes('## Operator'));
  assert.ok(!md.includes('## Reshare'), "a board never offers to reshare on a person's behalf");
});

test('an agent: kind from a stated capacity, operator from an operated-by key', () => {
  const md = openProfileFromResume(
    source(`# Athena

- **Agents**: 10
- **Rate**: $100/hour/agent
- **Operated by**: Ada Lovelace (ada@example.com)

Ships small fixes nightly.
`),
  );
  assert.ok(md.includes('- **Kind**: agent'));
  assert.ok(md.includes('- **Agents**: 10'), 'capacity keys travel with the identity block');
  assert.ok(md.includes('## Operator\n\n- **Name**: Ada Lovelace\n- **Email**: ada@example.com'));
  assert.ok(
    !md.includes('**Operated by**'),
    'the key became the section rather than being listed twice',
  );
});

test('an operator with a profile URL links to it, and a stated kind wins over capacity', () => {
  const md = openProfileFromResume(
    source(`# Athena

- **Kind**: person
- **Agents**: 3
- **Operator**: [Ada](https://ada.example/.well-known/openprofile.md)
`),
  );
  assert.ok(md.includes('- **Kind**: person'));
  assert.ok(
    md.includes('- **Name**: Ada\n- **Profile**: https://ada.example/.well-known/openprofile.md'),
  );
});

test('what the redaction gate withheld from the resume stays out of the profile', () => {
  const { markdown, redacted } = redactContactChannels(RESUME);
  assert.equal(redacted, true);
  const md = openProfileFromResume(source(markdown));
  assert.ok(!md.includes('ada@example.com'), 'no address for an anonymous reader');
  assert.ok(!md.includes('bsky.app'), 'the gate withholds the whole contact block, links included');
  assert.ok(
    md.includes('- [GitHub](https://github.com/ada/)'),
    'the same account under Links is public and stays',
  );
  assert.ok(
    md.includes('- **Contact**: shared with signed-in members'),
    'and says so, in the identity block',
  );
  assert.ok(
    md.includes('- [Blog](https://ada.example/blog)'),
    'a Links section is public and stays an account',
  );
  assert.ok(md.includes('## Topics'));
});

test('a resume that is only a name is still a profile', () => {
  const md = openProfileFromResume({
    name: 'Ada',
    parsed: parseResume('# Ada\n'),
    topics: [],
    resumeUrl: 'https://b/r.md',
  });
  assert.equal(md, '# Ada\n\n- **Resume**: https://b/r.md\n');
});

test('an email address never becomes the headline', () => {
  const md = openProfileFromResume(
    source('# Ada\n\n- **Web**: ada.example\n\nReach me at ada@example.com\n'),
  );
  assert.ok(!md.includes('Reach me at'));
});
