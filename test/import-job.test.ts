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

for (const scenario of [
  {
    label: 'named quote entities',
    description: '<p>Maintain &quot;Search&quot; &amp; Ranking.</p>',
    expected: 'Maintain "Search" & Ranking.',
  },
  {
    label: 'numeric quote entities',
    description: '<p>Maintain &#34;Search&#34;.</p>',
    expected: 'Maintain "Search".',
  },
  {
    label: 'escaped angle brackets',
    description: '<p>Write examples using &lt;Job&gt; and &lt;/Job&gt;.</p>',
    expected: 'Write examples using <Job> and </Job>.',
  },
  {
    label: 'literal entity examples',
    description: '<p>Document the &amp;quot; entity.</p>',
    expected: 'Document the &quot; entity.',
  },
]) {
  test(`a JSON-LD description preserves ${scenario.label}`, () => {
    const data = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Structured role',
      description: scenario.description,
      employmentType: 'FULL_TIME',
      jobLocationType: 'TELECOMMUTE',
    });
    const html = `<script type="application/ld+json">${data}</script>
      <main><h1>Fallback role</h1><p>Fallback description.</p></main>`;
    const job = extractJob(html, 'https://example.com/jobs/structured');
    assert.equal(job.via, 'jsonld');
    assert.equal(job.title, 'Structured role');
    assert.equal(job.description, scenario.expected);
    assert.equal(job.employmentType, 'full-time');
    assert.equal(job.workplace, 'remote');
    assert.deepEqual(job.warnings, []);
  });
}

test('a whole JSON-LD block escaped as HTML remains importable', () => {
  const escaped = JSON.stringify({
    '@type': 'JobPosting',
    title: 'Legacy role',
    description: '<p>Research &amp; development.</p>',
  })
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const job = extractJob(
    `<script type="application/ld+json">${escaped}</script>`,
    'https://example.com/jobs/legacy',
  );
  assert.equal(job.via, 'jsonld');
  assert.equal(job.title, 'Legacy role');
  assert.equal(job.description, 'Research & development.');
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

for (const scenario of [
  {
    label: 'the document title when no Open Graph title or heading exists',
    meta: '',
    heading: '',
    expected: 'Research & Development Engineer',
  },
  {
    label: 'the document title when the heading contains only whitespace',
    meta: '',
    heading: '<h1> <span>&nbsp;</span> </h1>',
    expected: 'Research & Development Engineer',
  },
  {
    label: 'the heading when the Open Graph title decodes to whitespace',
    meta: '<meta property="og:title" content="&nbsp;">',
    heading: '<h1>Heading role</h1>',
    expected: 'Heading role',
  },
  {
    label: 'the Open Graph title ahead of both the heading and document title',
    meta: '<meta property="og:title" content="Metadata role | Example Careers">',
    heading: '<h1>Heading role</h1>',
    expected: 'Metadata role',
  },
  {
    label: 'the heading ahead of the document title',
    meta: '',
    heading: '<h1><span>Design &amp; Engineering</span></h1>',
    expected: 'Design & Engineering',
  },
]) {
  test(`a page import uses ${scenario.label}`, () => {
    const html = `<!doctype html><html><head>
      <title>Research &amp; Development Engineer | Example Careers</title>
      ${scenario.meta}</head><body><main>${scenario.heading}
      <p>Build useful tools.</p></main></body></html>`;
    const job = extractJob(html, 'https://example.com/jobs/engineer');
    assert.equal(job.via, 'page');
    assert.equal(job.title, scenario.expected);
    assert.match(job.description, /Build useful tools\./);
    assert.ok(job.warnings.some((warning) => /no JobPosting data/i.test(warning)));
  });
}

test('a document title alone does not allow an empty description to be imported', () => {
  assert.throws(
    () =>
      extractJob(
        '<html><head><title>Role</title></head><body><main></main></body></html>',
        'https://example.com/jobs/empty',
      ),
    (error: unknown) => {
      assert.ok(error instanceof JobImportProblem);
      assert.match(error.message, /no readable text/);
      return true;
    },
  );
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

test('update tells its two jobs apart by whether it was given a URL', async () => {
  // `agenticjobs update` updated this install long before there was an
  // importer, and `case 'update'` for the importer sat after that one in the
  // switch, so it was unreachable: `update <url>` ran the self-updater. This
  // asserts the discriminator rather than the switch, which is the part that
  // has to stay true.
  const { looksLikeUrl } = await import('../dist/cli/index.js');
  assert.equal(looksLikeUrl('https://example.com/jobs/1'), true);
  assert.equal(looksLikeUrl('http://example.com/jobs/1'), true);
  assert.equal(looksLikeUrl(undefined), false, 'bare `update` must still update the install');
  assert.equal(looksLikeUrl('some-job-slug'), false);
  assert.equal(looksLikeUrl('file:///etc/passwd'), false);
});
