import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJob } from '../dist/core/import-job.js';

const sourceUrl = 'https://example.com/jobs/engineer';

function structured(description: string): string {
  return `<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title: 'Engineer',
    description,
  })}</script>`;
}

test('out-of-range numeric references do not abort a structured job import', () => {
  for (const entity of ['&#1114112;', '&#x110000;', '&#XFFFFFFFF;', `&#${'9'.repeat(400)};`]) {
    const job = extractJob(structured(`<p>Build ${entity} tools.</p>`), sourceUrl);
    assert.equal(job.via, 'jsonld');
    assert.equal(job.description, 'Build \uFFFD tools.', entity);
  }
});

test('invalid numeric references remain importable in page metadata and body text', () => {
  const html = `<html><head>
    <meta property="og:title" content="Engineer &#x110000;">
    </head><body><main><p>Build &#1114112; tools.</p></main></body></html>`;
  const job = extractJob(html, sourceUrl);
  assert.equal(job.via, 'page');
  assert.equal(job.title, 'Engineer \uFFFD');
  assert.equal(job.description, 'Build \uFFFD tools.');
});

test('null and surrogate references become replacement characters', () => {
  const job = extractJob(structured('<p>Text &#0; &#x0; &#55296; &#xDFFF;.</p>'), sourceUrl);
  assert.equal(job.description, 'Text \uFFFD \uFFFD \uFFFD \uFFFD.');
});

test('valid Unicode boundaries, astral characters and escaped examples are preserved', () => {
  const job = extractJob(
    structured('<p>&#xD7FF; &#xE000; &#x10FFFF; &#128640; &amp;#x110000;</p>'),
    sourceUrl,
  );
  assert.equal(job.description, '\uD7FF \uE000 \u{10FFFF} 🚀 &#x110000;');
});
