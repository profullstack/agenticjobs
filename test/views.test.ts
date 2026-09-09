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

test('searching from a tagged page keeps the tag', async () => {
  // A GET form submits its own fields and nothing else. Tags are set by
  // clicking a badge rather than by a control, so without hidden inputs the
  // search box silently threw away the filter the person had just applied.
  const { Filters } = await import('../dist/views/jobs.js');
  const { EMPTY_QUERY } = await import('../dist/schema/query.js');

  const html = String(
    Filters({ query: { ...EMPTY_QUERY, tags: ['javascript', 'react'], salaryMin: 100, org: 'acme' } }),
  );

  assert.match(html, /name="tags" value="javascript,react"/, 'tags must survive a search');
  assert.match(html, /name="salaryMin" value="100"/, 'a salary floor must survive too');
  assert.match(html, /name="org" value="acme"/, 'so must an employer filter');

  // An unfiltered form carries no empty hidden fields.
  const bare = String(Filters({ query: EMPTY_QUERY }));
  assert.ok(!bare.includes('name="tags"'), 'no tags set means no hidden tags field');
});

test('a filter that is not a tag is still shown, and still comes off', async () => {
  // The strip listed query.tags and nothing else, so narrowing to remote work
  // changed the results and appeared nowhere: no chip naming it, and, because
  // the whole strip was gated on there being a tag, no Clear and no Subscribe
  // either. The only way back was the browser's back button.
  const { JobList, activeFilters } = await import('../dist/views/jobs.js');
  const { EMPTY_QUERY } = await import('../dist/schema/query.js');

  const query = { ...EMPTY_QUERY, workplace: 'remote' };
  const html = String(
    JobList({
      page: { items: [], total: 0, limit: 25, offset: 0 },
      query,
      boardName: 'A board',
      tagline: 'jobs',
      publicUrl: 'https://example.test',
    }),
  );

  assert.match(html, /Filtering by:/, 'a filtered page must say what it is filtered by');
  assert.match(html, /remote x/, 'remote must be named as the filter it is');
  assert.match(html, /Clear/, 'and must be clearable');

  // Taking it off leaves the search, not the filter.
  const [chip] = activeFilters(query);
  assert.equal(chip.label, 'remote');
  assert.equal(chip.href, '/');

  // Every facet gets a chip, in reading order, and each drops only itself.
  const many = activeFilters({
    ...EMPTY_QUERY,
    q: 'go',
    tags: ['javascript'],
    workplace: 'remote',
    seniority: 'senior',
  });
  assert.deepEqual(
    many.map((filter) => filter.label),
    ['"go"', 'javascript', 'remote', 'senior'],
  );
  const dropped = many.find((filter) => filter.label === 'remote');
  assert.ok(dropped);
  assert.ok(!dropped.href.includes('workplace'), dropped.href);
  assert.match(dropped.href, /tags=javascript/, 'the other filters stay');
  assert.match(dropped.href, /seniority=senior/);
  assert.match(dropped.href, /q=go/);
});

test('Subscribe follows every filter, not only the tags', async () => {
  // The link was hand-built as `?tags=`, so a reader who had narrowed to
  // remote javascript subscribed to all the javascript on the board, and
  // nothing in the feed said it had been widened.
  const { feedHref } = await import('../dist/views/jobs.js');
  const { EMPTY_QUERY } = await import('../dist/schema/query.js');

  const href = feedHref({
    ...EMPTY_QUERY,
    tags: ['javascript'],
    workplace: 'remote',
    // Paging is a fact about one screenful, never about a subscription.
    offset: 50,
    limit: 100,
  });

  assert.match(href, /^\/feed\?/);
  assert.match(href, /tags=javascript/);
  assert.match(href, /workplace=remote/, 'the filter the reader sees must be in the feed');
  assert.ok(!href.includes('offset'), href);
  assert.ok(!href.includes('limit'), href);

  // An unfiltered board still has a plain feed.
  assert.equal(feedHref(EMPTY_QUERY), '/feed');
});

test('the candidates page subscribes to candidates', async () => {
  // /feed.rss is the everything feed (jobs, employers and people), so
  // subscribing from a page of candidates filtered to a skill delivered
  // mostly job posts.
  const { CandidateList } = await import('../dist/views/candidates.js');

  const html = String(
    CandidateList({ candidates: [], publicUrl: 'https://example.test', tags: ['javascript'] }),
  );

  assert.match(html, /href="\/candidates\/feed\?tags=javascript"/);
  // The everything feed is still named in the prose at the foot of the page,
  // which is right. What must not happen is the filter being handed to it.
  assert.ok(!html.includes('/feed.rss?tags='), 'the filter must not go to the everything feed');
});

test('the third-party script is a real tag, and the policy lets it run', async () => {
  // A bot PR added the stats tag as Next.js's <Script> component. This is a
  // Hono app: `next` is not a dependency, so it broke tsc and the image build.
  // The quieter half was the policy - script-src was 'self' only, so once the
  // import was fixed the browser would still have dropped the script and the
  // numbers would have read as no audience rather than as a bug.
  const { Layout } = await import('../dist/views/layout.js');
  const { securityHeaders } = await import('../dist/server/middleware.js');

  const html = String(
    Layout({
      title: 'A board',
      viewer: null,
      boardName: 'A board',
      publicUrl: 'https://example.test',
      path: '/',
      children: 'x',
    }),
  );

  assert.match(html, /<script[^>]+src="https:\/\/crawlproof\.com\/stats\.js"/);
  assert.match(html, /data-site="98e94c73-a6c0-491d-aa41-4c58c93f5ee1"/);
  // `defer` is what the component's strategy="afterInteractive" meant.
  assert.match(html, /src="https:\/\/crawlproof\.com\/stats\.js"[^>]*defer/);
  assert.ok(!html.includes('strategy='), 'no framework component attributes survive into the HTML');

  // And the policy actually permits the host it now loads from.
  const headers = new Headers();
  await securityHeaders()({ res: { headers } } as never, async () => undefined);
  const policy = headers.get('content-security-policy') ?? '';

  assert.match(policy, /script-src [^;]*'self'/, "the board's own script still runs");
  assert.match(policy, /script-src [^;]*https:\/\/crawlproof\.com/, 'and so does the stats tag');
});
