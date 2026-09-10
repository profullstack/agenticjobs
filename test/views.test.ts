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
import { PostJobPage } from '../dist/views/post.js';
import { DocsPage } from '../dist/views/docs.js';

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
    Filters({
      query: { ...EMPTY_QUERY, tags: ['javascript', 'react'], salaryMin: 100, org: 'acme' },
    }),
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

test('the policy lets a payer be sent on to CoinPay after they press Pay', async () => {
  // Pay is a form. The board mints the quote and answers 303 to CoinPay's
  // hosted page, and Chrome checks that redirect against form-action too. With
  // 'self' alone the payment existed and the person saw nothing happen.
  const { securityHeaders } = await import('../dist/server/middleware.js');

  const withCoinPay = new Headers();
  await securityHeaders({ formActions: ['https://coinpayportal.com/pay/x'] })(
    { res: { headers: withCoinPay } } as never,
    async () => undefined,
  );
  const policy = withCoinPay.get('content-security-policy') ?? '';
  assert.match(policy, /form-action 'self' https:\/\/coinpayportal\.com(;|$)/, policy);
  assert.ok(!policy.includes('coinpayportal.com/pay'), 'an origin is listed, not a path');

  // A board with no billing names nobody else.
  const without = new Headers();
  await securityHeaders()({ res: { headers: without } } as never, async () => undefined);
  assert.match(without.get('content-security-policy') ?? '', /form-action 'self'(;|$)/);
});

test('an employer can act on an application from the page they read it on', async () => {
  // The status badge existed from the first release and nothing could change
  // it, so every applicant read "new" forever. The buttons are the fix; the
  // status the application is already in is not offered as one of them.
  const { ManageJobPage } = await import('../dist/views/post.js');

  const job = {
    id: 'j',
    slug: 'a-job',
    title: 'A job',
    description: '',
    org: { id: 'o', slug: 'o', name: 'Org' },
    employmentType: 'full-time',
    workplace: 'remote',
    seniority: null,
    location: 'Remote',
    remoteRegions: [],
    salary: { min: null, max: null, currency: 'USD', period: 'year', equity: null },
    tags: [],
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
  const application = {
    id: 'a1b2c3d4-0000-4000-8000-000000000000',
    jobId: 'j',
    answers: { name: 'A Candidate', email: 'c@example.com' },
    agent: null,
    status: 'reviewing',
    submittedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    resume: null,
    resumeTitle: null,
  };

  const html = String(
    ManageJobPage({ job, html: '', applications: [application], publicUrl: 'http://b.test' }),
  );

  // A POST, not a link: a GET that hires someone can be prefetched.
  assert.match(
    html,
    /action="\/me\/jobs\/a-job\/applications\/a1b2c3d4-0000-4000-8000-000000000000\/decision"/,
  );
  assert.match(html, /value="rejected"/, 'reject must be offered');
  assert.match(html, /value="hired"/, 'hire must be offered');
  assert.ok(!html.includes('value="reviewing"'), 'the status it is already in is not a button');
  assert.ok(!html.includes('value="new"'), 'the candidate-side statuses are never offered');
});

test('the post form can say a role is unpaid', () => {
  // "No way to post an unpaid internship" was the report: leaving the range
  // empty is indistinguishable from not answering, and 0 in the range sorts
  // and filters as a paid job worth nothing.
  const org = {
    id: 'o',
    slug: 'acme',
    name: 'Acme',
    website: null,
    logoUrl: null,
    description: null,
    createdAt: '',
  };
  const html = String(PostJobPage({ orgs: [org] }));
  assert.match(html, /name="salaryUnpaid"/, 'the control has to exist to be usable');
  assert.match(html, /type="checkbox"/);
  // Scoped to this input: the form has other checked controls, so a bare
  // search for "checked" passes no matter what this box does.
  const box = (source) => /<input[^>]*name="salaryUnpaid"[^>]*>/.exec(source)?.[0] ?? '';
  assert.ok(
    !box(html).includes('checked'),
    `off unless the employer says otherwise, got ${box(html)}`,
  );

  const ticked = String(PostJobPage({ orgs: [org], values: { salaryUnpaid: 'on' } }));
  assert.ok(
    box(ticked).includes('checked'),
    `a rejected form comes back with the box still ticked, got ${box(ticked)}`,
  );
});

/**
 * The two things a reader arrives at /docs wanting to do.
 *
 * Reading and applying were documented from the first day because they are
 * what the board was built to show off. Getting listed and hiring were not,
 * and the page read as though the board were only half usable. These assert
 * the step that is actually easy to leave out of each: publishing a resume is
 * a decision separate from saving one, and posting a job needs an employer
 * before it needs a listing.
 */
const docs = () =>
  String(
    DocsPage({
      publicUrl: 'https://example.test',
      boardName: 'Example Board',
      isDirectory: true,
    }),
  );

test('the docs say how to get listed as a candidate, not only how to apply', () => {
  const html = docs();
  assert.match(html, /\/api\/v1\/resumes/, 'the endpoint that saves a resume');
  assert.match(html, /visibility/, 'listing it is a separate decision, so it has to be named');
  assert.match(html, /&quot;public&quot;|"public"/, 'and the value that lists it');
  assert.match(html, /\/candidates/, 'where a listed resume ends up');
  // Skills are the tags people browse by, and a resume with no such section
  // is invisible to every one of those links. Documented or nobody knows.
  assert.match(html, /## Skills/);
});

test('the docs say how to post a job, employer first', () => {
  const html = docs();
  const employer = html.indexOf('agenticjobs employer create');
  const post = html.indexOf('agenticjobs post job.md');
  assert.ok(employer !== -1, 'creating the employer has to be on the page');
  assert.ok(post !== -1, 'and so does posting the listing');
  assert.ok(employer < post, 'in that order: a listing has nowhere to go without an employer');
  assert.match(html, /agent_policy|agentPolicy/, 'the field this board exists for');
  assert.match(html, /draft/i, 'a posted job is a draft until a person publishes it');
  assert.match(html, /agenticjobs publish/);
});

/**
 * Both flows have to be doable with the client the page tells you to install.
 *
 * They were documented as curl with a hand-copied bearer token, because the
 * CLI genuinely could not create an employer or publish a resume. Asserting
 * the commands rather than the endpoints is what keeps the page from drifting
 * back to that: a curl example passes an endpoint assertion happily.
 */
test('neither flow sends you to curl for a step the CLI cannot do', () => {
  const html = docs();
  assert.match(html, /agenticjobs employer create/, 'employers are made from the terminal');
  assert.match(html, /agenticjobs resume publish/, 'and resumes are listed from it');
  // The REST equivalents stay documented; what must not come back is a curl
  // as the only way through either flow.
  assert.ok(
    !/curl -X (POST|PATCH) [^\n]*\/api\/v1\/(orgs|resumes)/.test(html),
    'a curl with a bearer token is no longer the documented path for either step',
  );
});
