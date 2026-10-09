import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../dist/markup/markdown.js';
import { nameOf, resumeForViewer, toCandidateSummary } from '../dist/core/candidates.js';
import {
  CONTACT_WITHHELD,
  hasContactChannel,
  parseResume,
  redactContactChannels,
} from '../dist/markup/resume.js';

test('a percent-encoded mailto destination in a resume section is withheld', () => {
  const source = '# Ada\n\n## Availability\nPlease [email me](mailto:ada%40example.com).\n';
  assert.match(renderMarkdown(source), /href="mailto:ada%40example\.com"/);

  const view = redactContactChannels(source);
  assert.equal(view.redacted, true);
  assert.ok(!view.markdown.includes('ada%40example.com'));
  assert.ok(view.markdown.includes(CONTACT_WITHHELD));
  assert.ok(view.markdown.includes('Please'));
  assert.doesNotMatch(renderMarkdown(view.markdown), /href="mailto:/i);
});

test('balanced mail headers cannot hide a query recipient after the subject', () => {
  for (const uri of [
    'mailto:?subject=Work(contract(nested))&to=ada%40example.test',
    "mailto:?subject=Operator's&to=ada%40example.test",
  ]) {
    const source = `# Ada\n\n## Availability\n[operator](${uri}) 2026\n`;
    assert.match(renderMarkdown(source), /href="mailto:/);
    const view = redactContactChannels(source);
    assert.equal(view.markdown, `# Ada\n\n## Availability\n[operator](${CONTACT_WITHHELD}) 2026\n`);
    assert.equal(hasContactChannel(uri), true);
  }
});

test('explicit tel destinations do not require a formatted number to be withheld', () => {
  for (const uri of [
    'tel:15550101010',
    'TEL:%2B15550101010',
    'tel:+49(30)1234567',
    'tel:(212)5550123',
    'tel:+49 170 5551234',
    'tel:(555) 010-1010',
    'tel:15550101010;ext=42',
    'tel:+49\\(30\\)1234567',
    'tel:+1-212.555(0123);ext=77',
    'tel:5550123;phone-context=+1(212);ext=77',
    'tel:5550123;ext=77;phone-context=+1(212)',
  ]) {
    const source = `# Ada\n\n## Availability\nPlease [call me](${uri}).\n`;
    if (!/\s/.test(uri)) assert.match(renderMarkdown(source), /href="tel:/i);
    const view = redactContactChannels(source);
    assert.equal(view.redacted, true, uri);
    assert.ok(!view.markdown.includes(uri), uri);
    assert.equal(view.markdown.split(CONTACT_WITHHELD).length - 1, 1, uri);
    assert.doesNotMatch(view.markdown, /\d/, uri);
    assert.doesNotMatch(renderMarkdown(view.markdown), /href="tel:/i);
  }
});

test('contact-channel guards recognize encoded mailto and compact tel URIs repeatedly', () => {
  for (let repeat = 0; repeat < 3; repeat += 1) {
    for (const text of [
      'Contact [Ada](mailto:ada%40example.com)',
      'Call tel:15550101010',
      'Write MAILTO:ada%40example.com?subject=Hello',
      'Phone TEL:%2B15550101010',
    ]) {
      assert.equal(hasContactChannel(text), true, text);
    }
  }
});

test('multiple explicit channels in prose and angle destinations are all withheld', () => {
  const source = [
    '# Ada',
    '',
    '## Contact',
    '[Email](<MAILTO:ada%40example.com?subject=Hello>) or [Phone](tel:15550101010).',
    'Backup: mailto:backup%40example.com',
    '',
  ].join('\n');
  const view = redactContactChannels(source);
  assert.equal(view.redacted, true);
  assert.doesNotMatch(view.markdown, /(?:mailto:|tel:|%40|15550101010)/i);
  assert.equal(view.markdown.split(CONTACT_WITHHELD).length - 1, 3);
  assert.match(view.markdown, /Backup:/);
});

test('project links, dates and ordinary numeric identifiers remain unchanged', () => {
  const source = '# Ada\n\n## Work\n[Project](https://example.com/docs) 2019-2024, ticket 15550101010.\n'
    + '[URI docs](https://example.test/docs/mailto:syntax) and '
    + '[Phone docs](https://example.test/docs/tel:syntax).\n'
    + '[Protocol guide](https://example.test/docs/v1.mailto:syntax)\n'
    + '[Phone guide](https://example.test/docs/v1.tel:syntax)\n'
    + 'https://example.test/docs?guide=urn:mailto:syntax\n'
    + 'https://example.test/docs?guide=urn:tel:syntax\n';
  const view = redactContactChannels(source);
  assert.equal(view.redacted, false);
  assert.equal(view.markdown, source);
  assert.equal(hasContactChannel('Project 2019-2024, ticket 15550101010'), false);
  assert.equal(hasContactChannel('https://example.test/docs/mailto:syntax'), false);
  assert.equal(hasContactChannel('https://example.test/docs/tel:syntax'), false);
  assert.equal(hasContactChannel('https://example.test/docs/v1.mailto:syntax'), false);
  assert.equal(hasContactChannel('https://example.test/docs?guide=urn:tel:syntax'), false);
  assert.match(renderMarkdown(view.markdown), /href="https:\/\/example\.com\/docs"/);
});

test('a project URL immediately before a contact link does not conceal the channel', () => {
  for (const prefix of [
    '[Docs](https://example.test/path(one(two)))',
    'Portfolio https://example.test',
    'Portfolio https://[2001:db8::1]/docs/mailto:syntax ',
  ]) {
    const source = `# Ada\n\n## Work\n${prefix}[email](mailto:ada%40example.test)\n`;
    assert.match(renderMarkdown(source), /href="mailto:/);
    const view = redactContactChannels(source);
    assert.ok(view.markdown.includes(prefix));
    assert.ok(!view.markdown.includes('ada%40example.test'));
    assert.equal(hasContactChannel(source), true);
  }
});

test('the end of a telephone link preserves following years and numeric prose', () => {
  for (const [uri, prose] of [
    ['tel:(212)5550123', '2026'],
    ['tel:15550101010', '2019-2024'],
    ['tel:5550123', '42 releases shipped'],
  ]) {
    const source = `# Ada\n\n## Work\n[call](${uri}) ${prose}\n`;
    const view = redactContactChannels(source);
    assert.equal(view.markdown, `# Ada\n\n## Work\n[call](${CONTACT_WITHHELD}) ${prose}\n`);
    assert.ok(renderMarkdown(view.markdown).includes(prose));
  }
});

test('the anonymous resume view withholds the URI while the signed-in copy stays whole', () => {
  const source = '# Ada\n\n## Availability\n[email](mailto:ada%40example.com)\n';
  const resume = { markdown: source, parsed: null };
  const publicView = resumeForViewer(resume, false);
  assert.equal(publicView.redacted, true);
  assert.ok(!publicView.markdown.includes('ada%40example.com'));
  assert.doesNotMatch(renderMarkdown(publicView.markdown), /href="mailto:/i);
  assert.deepEqual(resumeForViewer(resume, true), {
    markdown: source, parsed: null, redacted: false,
  });
});

test('cached directory names and headlines cannot expose the same explicit URIs', () => {
  const resume = {
    title: 'Contact mailto:ada%40example.com',
    parsed: {
      name: 'Call tel:15550101010',
      headline: '[email](mailto:ada%40example.com)',
      contact: [],
      sections: [],
    },
    publicSlug: 'ada',
    updatedAt: '2026-10-09T00:00:00Z',
  } as never;
  assert.equal(nameOf(resume), 'Candidate');
  const summary = toCandidateSummary(resume);
  assert.equal(summary.name, 'Candidate');
  assert.equal(summary.headline, null);
});

test('cached locations withhold contact URIs while ordinary places remain visible', () => {
  for (const location of ['mailto:ada%40example.test', 'tel:15550101010', 'Berlin, Germany']) {
    const markdown = `# Ada\n\n- **Location**: ${location}\n\n## Work\nEngineer\n`;
    const resume = {
      title: 'Ada', markdown, parsed: parseResume(markdown),
      publicSlug: 'ada', updatedAt: '2026-10-09T00:00:00Z',
    } as never;
    assert.equal(toCandidateSummary(resume).location,
      location === 'Berlin, Germany' ? location : null);
    assert.equal(resumeForViewer(resume, true).markdown, markdown);
  }
});

test('skills reject a channel before label removal and preserve complementary skills', () => {
  const markdown = '# Ada\n\n## Skills\n- mailto:ada%40example.test\n'
    + '- tel:15550101010\n- **Languages:** TypeScript, mailto:backup%40example.test, Go\n'
    + '- mailto:ada%40example.test,bob%40example.test\n'
    + '- AWS, mailto:first%40example.test,second%40example.test, Remote\n';
  const resume = {
    title: 'Ada', markdown, parsed: parseResume(markdown),
    publicSlug: 'ada', updatedAt: '2026-10-09T00:00:00Z',
  } as never;
  assert.deepEqual(toCandidateSummary(resume).skills, ['TypeScript', 'Go', 'AWS', 'Remote']);
  assert.equal(resumeForViewer(resume, true).markdown, markdown);
});
