import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJob } from '../dist/core/import-job.js';

const sourceUrl = 'https://example.com/jobs/data-engineer';
const posting = JSON.stringify({
  '@type': 'JobPosting',
  title: 'Data Engineer',
  description: '<p>Build data pipelines.</p>',
  employmentType: 'FULL_TIME',
  jobLocationType: 'TELECOMMUTE',
});

for (const attribute of [
  'type = "application/ld+json"',
  "type\t=\n'application/ld+json'",
  'TYPE = "application/ld+json"',
]) {
  test(`structured job data accepts attribute whitespace: ${JSON.stringify(attribute)}`, () => {
    const job = extractJob(
      `<script ${attribute}>${posting}</script>
       <main><h1>Careers</h1><p>Browse our roles.</p></main>`,
      sourceUrl,
    );
    assert.equal(job.via, 'jsonld');
    assert.equal(job.title, 'Data Engineer');
    assert.equal(job.description, 'Build data pipelines.');
    assert.equal(job.employmentType, 'full-time');
    assert.equal(job.workplace, 'remote');
  });
}

for (const contentFirst of [false, true]) {
  test(`metadata accepts attribute whitespace with content ${contentFirst ? 'first' : 'last'}`, () => {
    const meta = (name: string, value: string) => {
      const key = `property\t=\n'${name}'`;
      const content = `content = "${value}"`;
      return `<meta ${contentFirst ? `${content} ${key}` : `${key} ${content}`}>`;
    };
    const job = extractJob(
      `<html><head>${meta('og:title', 'Data Engineer | Careers')}
       ${meta('og:description', 'Build data &amp; research tools.')}</head>
       <body><main></main></body></html>`,
      sourceUrl,
    );
    assert.equal(job.via, 'page');
    assert.equal(job.title, 'Data Engineer');
    assert.equal(job.description, 'Build data & research tools.');
  });
}
