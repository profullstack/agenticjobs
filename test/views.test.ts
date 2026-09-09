/**
 * Layout facts that are invisible to every other kind of test.
 *
 * A component in the wrong column still typechecks, still renders, and still
 * passes an API test. The only thing that catches it is asserting where the
 * markup puts it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResumeEditor } from '../dist/views/me.js';

const resume = {
  id: 'r',
  userId: 'u',
  slug: 'agentic-web-architect',
  title: 'Agentic Web Architect',
  markdown: '# A Person\n\n## Skills\n\n- Go\n',
  parsed: null,
  visibility: 'public' as const,
  publicSlug: 'a-person',
  sourceName: null,
  createdAt: '',
  updatedAt: '',
};

test('the resume preview is below the editor, not squeezed into the sidebar', () => {
  // The sidebar is 20rem. A resume rendered into 20rem is a column of two-word
  // lines, which is what it was, and is unreadable. A document needs the width
  // of the page; the short things belong beside the form.
  const html = String(
    ResumeEditor({ resume, html: '<h1>A Person</h1>', warnings: ['check this'] }),
  );

  const aside = /<aside[\s\S]*?<\/aside>/.exec(html)?.[0];
  assert.ok(aside, 'expected a sidebar');
  assert.ok(!aside.includes('Preview'), 'the preview must not be in the sidebar');

  // What genuinely is short stays there.
  assert.ok(aside.includes('check this'), 'warnings belong in the sidebar');
  assert.ok(aside.includes('/candidates/a-person'), 'the share link belongs in the sidebar');

  // And the preview follows the whole two-column block rather than sitting in it.
  assert.ok(
    html.indexOf('Preview') > html.indexOf('</aside>'),
    'the preview must come after the sidebar closes',
  );
});

test('remote and contract filter, and they filter as themselves', async () => {
  // They are not tags: a job's tag list does not contain "remote", so linking
  // them as tags=remote would search for a word that is not there and return
  // nothing. Each links to the filter that actually holds it.
  const { JobCard, facetHref } = await import('../dist/views/jobs.js');
  const { EMPTY_QUERY } = await import('../dist/schema/query.js');

  const job = {
    id: 'j',
    slug: 'a-job',
    title: 'A job',
    description: '',
    org: { slug: 'o', name: 'Org' },
    employmentType: 'contract',
    workplace: 'remote',
    seniority: null,
    location: 'Remote',
    remoteRegions: [],
    salary: { min: null, max: null, currency: 'USD', period: 'year', equity: null },
    tags: ['javascript'],
    stack: [],
    requirements: [],
    responsibilities: [],
    agentPolicy: 'welcome',
    apply: { via: 'board', schema: { fields: [] } },
    status: 'published',
    publishedAt: new Date().toISOString(),
    createdAt: '',
    expiresAt: null,
  };

  const html = String(JobCard({ job, query: EMPTY_QUERY }));
  assert.match(html, /href="\/\?workplace=remote"/, 'remote must filter by workplace');
  assert.match(html, /href="\/\?employmentType=contract"/, 'contract must filter by type');
  assert.ok(!html.includes('tags=remote'), 'remote is not a tag');

  // A facet clicked from a filtered page narrows it rather than replacing it.
  const narrowed = facetHref(
    { ...EMPTY_QUERY, tags: ['javascript'], offset: 50 },
    { workplace: 'remote' },
  );
  assert.match(narrowed, /tags=javascript/);
  assert.match(narrowed, /workplace=remote/);
  // Paging resets: page 3 of the old search is not page 3 of the new one.
  assert.ok(!narrowed.includes('offset'), narrowed);
});
