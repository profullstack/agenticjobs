import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResume } from '../dist/markup/resume.js';
import { CandidateDetail } from '../dist/views/candidates.js';

const email = 'ada_lovelace@example.com';
const website = 'https://example.com/ada_lovelace?version=__draft__&filter=job_*';

test('contact values and links preserve literal punctuation in addresses', () => {
  const values = [
    email,
    'ada__research__team@example.com',
    'ada*jobs@example.com',
    'ada`jobs@example.com',
    '_ada@example.com',
  ];
  for (const value of values) {
    for (const bullet of [`- **Email**: ${value}`, `- ${value}`]) {
      const contact = parseResume(`# Ada\n\n${bullet}`).contact[0];
      assert.equal(contact?.value, value, bullet);
      assert.equal(contact?.href, `mailto:${value}`, bullet);
    }
  }
  const contact = parseResume(`# Ada\n\n- Web: ${website}\n- Web: example.com/ada_lovelace`).contact;
  assert.deepEqual(contact.map(({ value, href }) => ({ value, href })), [
    { value: website, href: website },
    { value: 'example.com/ada_lovelace', href: 'https://example.com/ada_lovelace' },
  ]);
});

test('wrapping emphasis and code are removed without rewriting the enclosed address', () => {
  for (const marker of ['*', '**', '***', '_', '__', '___', '`', '``']) {
    const contact = parseResume(`# Ada\n\n- Email: ${marker}${email}${marker}`).contact[0];
    assert.equal(contact?.value, email, marker);
    assert.equal(contact?.href, `mailto:${email}`, marker);
  }
  const contact = parseResume(`# Ada\n\n- Email: **_${email}_**\n- Email: \`ada*jobs*@example.com\``).contact;
  assert.equal(contact[0]?.value, email);
  assert.equal(contact[1]?.value, 'ada*jobs*@example.com');
  assert.equal(contact[1]?.href, 'mailto:ada*jobs*@example.com');
});

test('explicit links and non-link facts retain their written values', () => {
  const contact = parseResume([
    '# Ada', '',
    `- Email: [Email Ada](mailto:${email})`,
    `- [Portfolio](${website})`,
    '- Location: **London, UK**',
    '- Availability: _Part time_',
    '- Handle: ada_lovelace',
  ].join('\n')).contact;
  assert.deepEqual(contact, [
    { key: 'Email', value: 'Email Ada', href: `mailto:${email}` },
    { key: 'Portfolio', value: 'Portfolio', href: website },
    { key: 'Location', value: 'London, UK', href: null },
    { key: 'Availability', value: 'Part time', href: null },
    { key: 'Handle', value: 'ada_lovelace', href: null },
  ]);
});

test('the candidate contact card links to the address supplied in the resume', () => {
  const parsed = parseResume(`# Ada\n\n- Email: ${email}\n- Web: https://example.com/ada_lovelace`);
  const html = String(CandidateDetail({
    candidate: {
      slug: 'ada', name: 'Ada', headline: null, location: null,
      skills: [], capacity: null, updatedAt: '',
    },
    parsed, html: '', markdownUrl: '/candidates/ada/resume.md', listed: true,
  }));
  assert.ok(html.includes(`href="mailto:${email}"`));
  assert.ok(html.includes(`>${email}</a>`));
  assert.ok(html.includes('href="https://example.com/ada_lovelace"'));
});
