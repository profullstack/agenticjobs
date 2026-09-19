import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJob } from '../dist/core/import-job.js';

const description = 'Build data pipelines<br class="editor-break">Maintain ingestion jobs<br data-note="before > after" />Document operations.';
const expected = 'Build data pipelines\nMaintain ingestion jobs\nDocument operations.';

test('JSON-LD job descriptions preserve attributed line breaks', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', title: 'Data engineer', description,
  })}</script>`;
  const result = extractJob(html, 'https://example.com/jobs/engineer');
  assert.equal(result.via, 'jsonld');
  assert.equal(result.description, expected);
});

test('page imports preserve attributed line breaks, including uppercase tags', () => {
  const html = `<title>Data engineer</title><main>${description.replace('<br class=', '<BR class=')}</main>`;
  const result = extractJob(html, 'https://example.com/jobs/engineer');
  assert.equal(result.via, 'page');
  assert.equal(result.description, expected);
});

test('plain break forms still work and custom tags beginning with br are not breaks', () => {
  const html = '<title>Engineer</title><main>First<br>Second<br/>Third<br />Fourth<br-widget>Label</br-widget>End.</main>';
  assert.equal(extractJob(html, 'https://example.com/jobs/engineer').description,
    'First\nSecond\nThird\nFourth Label End.');
});
