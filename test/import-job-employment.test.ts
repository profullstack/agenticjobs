import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJob } from '../dist/core/import-job.js';
import { jobPostingJsonLd } from '../dist/schema/jsonld.js';
import { EMPLOYMENT_TYPES } from '../dist/schema/job.js';

function importType(employmentType: unknown) {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Research engineer',
    description: 'Build data tools.',
    jobLocationType: 'TELECOMMUTE',
    employmentType,
  };
  return extractJob(
    `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
    'https://example.com/jobs/research-engineer',
  );
}

for (const [value, expected] of [
  [' CONTRACTOR ', 'contract'],
  [['INTERN', 'FULL_TIME'], 'internship'],
] as const) {
  test(`import preserves the standard employment value ${JSON.stringify(value)}`, () => {
    const job = importType(value);
    assert.equal(job.employmentType, expected);
    assert.deepEqual(job.warnings, []);
  });
}

test('existing local employment names remain accepted', () => {
  for (const type of EMPLOYMENT_TYPES) {
    assert.equal(importType(type).employmentType, type);
  }
});

test('unsupported or missing employment values still produce a warning', () => {
  for (const value of [undefined, null, 42, {}, [], 'VOLUNTEER', 'OTHER', 'PER_DIEM']) {
    const job = importType(value);
    assert.equal(job.employmentType, undefined);
    assert.ok(job.warnings.includes('No employment type in the posting.'));
  }
});

// Exercise the actual emitter as well as the importer: an instance must be
// able to import every employment type it publishes on its own job pages.
for (const employmentType of EMPLOYMENT_TYPES) {
  test(`a published ${employmentType} job retains its type when imported`, () => {
    const posting = jobPostingJsonLd({
      slug: 'research-engineer',
      title: 'Research engineer',
      description: 'Build data tools.',
      employmentType,
      workplace: 'remote',
      remoteRegions: [],
      org: { name: 'Example Research' },
      apply: { via: 'board' },
      createdAt: '2026-09-01T00:00:00Z',
      tags: [],
      stack: [],
      requirements: [],
      responsibilities: [],
      salary: { min: null, max: null },
      agentPolicy: 'welcome',
    } as never, 'https://example.com');
    const imported = extractJob(
      `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
      String(posting.url),
    );
    assert.equal(imported.employmentType, employmentType);
    assert.deepEqual(imported.warnings, []);
  });
}
