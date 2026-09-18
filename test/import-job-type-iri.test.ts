import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJob } from '../dist/core/import-job.js';

const SOURCE = 'https://example.test/careers/ocean-data-engineer';

function page(type: unknown): string {
  const posting = {
    '@context': 'https://schema.org',
    '@type': type,
    title: 'Ocean Data Engineer',
    description: '<p>Build reproducible ocean-observation pipelines.</p>',
    employmentType: 'FULL_TIME',
    jobLocationType: 'TELECOMMUTE',
    jobLocation: { address: { addressLocality: 'Shanghai', addressCountry: 'CN' } },
  };
  return `<script type="application/ld+json">${JSON.stringify({ '@graph': [posting] })}</script>
    <main><h1>Example Careers</h1><p>Browse all our current opportunities.</p></main>`;
}

// JSON-LD permits a full IRI as a node's @type, including within an array.
// https://www.w3.org/TR/json-ld11/#specifying-the-type
for (const type of [
  'JobPosting',
  'http://schema.org/JobPosting',
  'https://schema.org/JobPosting',
  ['https://schema.org/Thing', 'https://schema.org/JobPosting'],
]) {
  test(`imports structured job fields for @type ${JSON.stringify(type)}`, () => {
    const result = extractJob(page(type), SOURCE);
    assert.equal(result.via, 'jsonld');
    assert.equal(result.title, 'Ocean Data Engineer');
    assert.equal(result.description, 'Build reproducible ocean-observation pipelines.');
    assert.equal(result.employmentType, 'full-time');
    assert.equal(result.workplace, 'remote');
    assert.equal(result.location, 'Shanghai, CN');
    assert.equal(result.sourceUrl, SOURCE);
    assert.deepEqual(result.warnings, []);
  });
}

test('unrelated vocabularies and similarly named types still use the page fallback', () => {
  for (const type of [
    'https://example.test/JobPosting',
    'https://schema.org/JobPostingAction',
    'https://schema.org/jobposting',
    ['https://schema.org/Thing', null, 42],
  ]) {
    const result = extractJob(page(type), SOURCE);
    assert.equal(result.via, 'page', JSON.stringify(type));
    assert.equal(result.title, 'Example Careers');
    assert.equal(result.employmentType, undefined);
    assert.equal(result.workplace, undefined);
    assert.ok(result.warnings.length > 0);
  }
});
