/**
 * Importing a job from a URL.
 *
 * The extractor is pure, so most of this is exact-input tests. The one case
 * that is not about parsing is the last: importing means fetching a URL a
 * stranger chose, and the guard against that pointing at localhost lives in
 * the shared fetch rather than here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJob, JobImportProblem } from '../dist/core/import-job.js';
import { fetchText } from '../dist/directory/fetch.js';

const JSONLD = `<!doctype html><html><head>
<title>Staff Engineer | Example Careers</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting",
 "title":"Staff Engineer",
 "description":"<p>Build the thing.</p><ul><li>TypeScript</li><li>Postgres</li></ul>",
 "employmentType":"FULL_TIME",
 "jobLocationType":"TELECOMMUTE",
 "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Lisbon","addressCountry":"PT"}}}
</script></head><body><p>ignored furniture</p></body></html>`;

test('a page that publishes JobPosting data is read from the data', () => {
  const job = extractJob(JSONLD, 'https://example.com/jobs/1');
  assert.equal(job.via, 'jsonld');
  assert.equal(job.title, 'Staff Engineer');
  assert.equal(job.employmentType, 'full-time');
  assert.equal(job.workplace, 'remote');
  assert.equal(job.location, 'Lisbon, PT');
  assert.equal(job.sourceUrl, 'https://example.com/jobs/1');
  // The description is HTML in the JSON-LD and must arrive as readable text.
  assert.match(job.description, /Build the thing\./);
  assert.match(job.description, /- TypeScript/);
  assert.ok(!job.description.includes('<'), job.description);
  // Furniture outside the posting must not leak in.
  assert.ok(!job.description.includes('ignored furniture'));
});

test('a JobPosting inside an @graph is still found', () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","name":"Example"},
      {"@type":"JobPosting","title":"Cook","description":"Cook things."}]}
  </script>`;
  const job = extractJob(html, 'https://example.com/x');
  assert.equal(job.via, 'jsonld');
  assert.equal(job.title, 'Cook');
});

test('a page with no JobPosting is read off the page, and says so', () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Register your agent | ugig.net">
    </head><body><main><h1>Register your agent</h1>
    <p>Pick which jobs your agent applies to.</p></main></body></html>`;
  const job = extractJob(html, 'https://ugig.net/gigs/1');
  assert.equal(job.via, 'page');
  // The site name after the pipe is not part of the job title.
  assert.equal(job.title, 'Register your agent');
  assert.match(job.description, /Pick which jobs/);
  assert.ok(
    job.warnings.some((w) => /no JobPosting data/i.test(w)),
    'an approximate import must say it was approximate',
  );
});

test('scripts and styles never become the description', () => {
  const html = `<body><main><h1>Role</h1>
    <script>window.x = "do not read me";</script>
    <style>.a{color:red}</style>
    <p>Real text.</p></main></body>`;
  const job = extractJob(html, 'https://example.com/x');
  assert.ok(!job.description.includes('do not read me'), job.description);
  assert.ok(!job.description.includes('color:red'), job.description);
  assert.match(job.description, /Real text\./);
});

test('a malformed JSON-LD block does not abandon the import', () => {
  const html = `<script type="application/ld+json">{ this is not json </script>
    <body><main><h1>Still a job</h1><p>Body text.</p></main></body>`;
  const job = extractJob(html, 'https://example.com/x');
  assert.equal(job.via, 'page');
  assert.equal(job.title, 'Still a job');
});

test('a page with nothing readable is refused rather than imported empty', () => {
  assert.throws(
    () => extractJob('<html><head></head><body></body></html>', 'https://example.com/x'),
    JobImportProblem,
  );
});

test('an import cannot be aimed at the machine the board runs on', async () => {
  // Fetching a URL a stranger chose is the whole feature, so this guard is the
  // feature's security boundary rather than a detail.
  for (const url of [
    'http://localhost:8787/admin',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(() => fetchText(url), /not an address we will fetch/, url);
  }
});
