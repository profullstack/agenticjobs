/**
 * Everything a machine reads without being told to: the instance descriptor,
 * feeds, the sitemap, robots.txt, llms.txt, the web app manifest and the
 * service worker.
 *
 * These are not an afterthought on a board whose whole pitch is being
 * readable. The descriptor is the federation contract; llms.txt is the one
 * file a model fetches when it has no other instructions.
 */

import { Hono } from 'hono';
import { OPEN_TOOLS, TOOLS } from '../../mcp/tools.ts';
import type { Context } from 'hono';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countJobs, searchJobs } from '../../core/jobs.ts';
import { listOrgs } from '../../core/orgs.ts';
import { listPublicResumes } from '../../core/resumes.ts';
import { tagsFrom, toCandidateSummary, withTags } from '../../core/candidates.ts';
import {
  BODY_MAX,
  listScoped,
  listUpdates,
  scopeFrom,
  type Scope,
  type Update,
} from '../../core/updates.ts';
import { parseQuery, queryToParams } from '../../schema/query.ts';
import type { JobQuery } from '../../schema/index.ts';
import { WELL_KNOWN_PATH } from '../../schema/instance.ts';
import { jobPostingJsonLd } from '../../schema/jsonld.ts';
import { escapeHtml } from '../../markup/escape.ts';
import { toPlainText } from '../../markup/markdown.ts';
import { descriptorFor } from './descriptor.ts';
import type { AppEnv } from '../deps.ts';

function publicDir(): string {
  // dist/server/routes/discovery.js -> package root -> web/public
  return join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), 'web', 'public');
}

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

/**
 * The querystring that identifies a filtered feed.
 *
 * Paging is deliberately dropped. limit and offset describe one response, not
 * the search behind it, and a feed sets both itself, so leaving them in would
 * hand two subscriptions to the same thing different identities.
 */
function filterSearch(query: JobQuery): string {
  const params = queryToParams(query);
  params.delete('limit');
  params.delete('offset');
  return params.toString();
}

/** One entry in any of the board's feeds. */
interface FeedEntry {
  title: string;
  url: string;
  at: string;
  body: string;
  category: string;
}

/**
 * The RSS envelope, written once.
 *
 * Three feeds share it: jobs, candidates and everything. They differ in what
 * they list and in nothing else, and a channel carrying a self link on one
 * feed but not another is the kind of drift a feed validator finds first.
 */
function rss(
  c: Context<AppEnv>,
  feed: { title: string; link: string; description: string; self: string; entries: FeedEntry[] },
): Response {
  const entries = [...feed.entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const items = entries
    .map((entry) =>
      [
        '    <item>',
        `      <title>${escapeHtml(entry.title)}</title>`,
        `      <link>${escapeHtml(entry.url)}</link>`,
        `      <guid isPermaLink="true">${escapeHtml(entry.url)}</guid>`,
        `      <category>${escapeHtml(entry.category)}</category>`,
        `      <pubDate>${new Date(entry.at).toUTCString()}</pubDate>`,
        `      <description>${escapeHtml(entry.body)}</description>`,
        '    </item>',
      ].join('\n'),
    )
    .join('\n');

  // An empty feed is still a valid feed, so lastBuildDate falls back to now
  // rather than to an invalid date parsed from an entry that is not there.
  const newest = entries[0]?.at;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeHtml(feed.title)}</title>`,
    `    <link>${escapeHtml(feed.link)}</link>`,
    `    <description>${escapeHtml(feed.description)}</description>`,
    '    <language>en</language>',
    `    <lastBuildDate>${new Date(newest === undefined ? Date.now() : Date.parse(newest)).toUTCString()}</lastBuildDate>`,
    `    <atom:link href="${escapeHtml(feed.self)}" rel="self" type="application/rss+xml" />`,
    items,
    '  </channel>',
    '</rss>',
  ].join('\n');
  return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' });
}

/**
 * An update as a feed entry.
 *
 * The link an update carries is the interesting URL, but the guid has to be
 * stable and ours: two employers linking the same launch post must not
 * collapse into one item in a reader.
 */
function updateEntry(update: Update, publicUrl: string): FeedEntry {
  const { author } = update;
  return {
    title: `${author.name}: ${toPlainText(update.body, 80)}`,
    // Anchored on the board's own page rather than on the link the update
    // carries, because the guid is this URL: two employers linking the same
    // launch post must not collapse into one item in a reader.
    url: `${publicUrl}/updates#${update.id}`,
    at: update.createdAt,
    body:
      update.link === null
        ? toPlainText(update.body, BODY_MAX)
        : `${toPlainText(update.body, BODY_MAX)} ${update.link}`,
    category: 'Update',
  };
}

/** What a scoped feed calls itself. */
function scopeTitle(scope: Scope, boardName: string): string {
  if (scope.kind === 'author') return `${scope.name} on ${boardName}`;
  return `${boardName} updates`;
}

/** The active filters in words, or null when nothing is filtered. */
function describeQuery(query: JobQuery): string | null {
  const parts: string[] = [];
  if (query.q !== null) parts.push(`"${query.q}"`);
  if (query.workplace !== null) parts.push(query.workplace);
  if (query.employmentType !== null) parts.push(query.employmentType);
  if (query.seniority !== null) parts.push(query.seniority);
  if (query.agentPolicy !== null) parts.push(`agents: ${query.agentPolicy}`);
  if (query.tags.length > 0) parts.push(query.tags.join(' + '));
  if (query.salaryMin !== null) parts.push(`from ${query.salaryMin}`);
  if (query.org !== null) parts.push(query.org);
  return parts.length === 0 ? null : parts.join(', ');
}

export function discoveryRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/assets/:file', async (c) => {
    const requested = c.req.param('file');
    // normalize collapses any traversal before it is joined, so a name like
    // "..%2f..%2fetc%2fpasswd" resolves to a bare filename and misses.
    const name = normalize(requested).replace(/^(\.\.[/\\])+/, '');
    if (name.includes('/') || name.includes('\\')) return c.notFound();
    try {
      const body = await readFile(join(publicDir(), name));
      return c.body(body, 200, {
        'content-type': MIME[extname(name)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=3600',
      });
    } catch {
      return c.notFound();
    }
  });

  /**
   * The installer, at the root so the curl line is short enough to read aloud.
   *
   * Served as text/plain on purpose: anyone about to pipe a script into sh
   * should be able to open the same URL in a browser and read it first, and a
   * download prompt actively discourages that.
   */
  routes.get('/install.sh', async (c) => {
    try {
      const body = await readFile(join(publicDir(), 'install.sh'), 'utf8');
      return c.body(body, 200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300',
      });
    } catch {
      return c.notFound();
    }
  });

  routes.get(WELL_KNOWN_PATH, async (c) => {
    const { pool, config } = c.get('deps');
    return c.json(await descriptorFor(pool, config), 200, {
      // Read by other instances on a schedule, so a short cache is polite and
      // a long one would make a new job invisible to the network for an hour.
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    });
  });

  routes.get('/jobs.json', async (c) => {
    const { pool, config } = c.get('deps');
    const query = { ...parseQuery(new URL(c.req.url).searchParams), limit: 100 };
    const page = await searchJobs(pool, query);
    // JSON Feed, so an ordinary feed reader can follow a job board.
    return c.json(
      {
        version: 'https://jsonfeed.org/version/1.1',
        title: `${config.boardName} - open roles`,
        home_page_url: config.publicUrl,
        feed_url: `${config.publicUrl}/jobs.json`,
        description: config.boardTagline,
        items: page.items.map((job) => ({
          id: `${config.publicUrl}/jobs/${job.slug}`,
          url: `${config.publicUrl}/jobs/${job.slug}`,
          title: `${job.title} at ${job.org.name}`,
          content_text: toPlainText(job.description, 600),
          date_published: job.publishedAt ?? job.createdAt,
          tags: [...new Set([...job.tags, ...job.stack, job.workplace, job.employmentType])],
          authors: [{ name: job.org.name }],
          _agenticjobs: {
            agentPolicy: job.agentPolicy,
            applyVia: job.apply.via,
            jsonld: jobPostingJsonLd(job, config.publicUrl),
          },
        })),
      },
      200,
      { 'access-control-allow-origin': '*' },
    );
  });

  routes.get('/jobs.rss', async (c) => {
    const { pool, config } = c.get('deps');
    // The same query the page takes. This built its query from an EMPTY
    // URLSearchParams, so every filter a reader put in the address was thrown
    // away and the feed answered with the whole board.
    const query = { ...parseQuery(new URL(c.req.url).searchParams), limit: 100, offset: 0 };
    const page = await searchJobs(pool, query);
    const items = page.items
      .map((job) => {
        const url = `${config.publicUrl}/jobs/${job.slug}`;
        return [
          '    <item>',
          `      <title>${escapeHtml(`${job.title} at ${job.org.name}`)}</title>`,
          `      <link>${escapeHtml(url)}</link>`,
          `      <guid isPermaLink="true">${escapeHtml(url)}</guid>`,
          `      <pubDate>${new Date(job.publishedAt ?? job.createdAt).toUTCString()}</pubDate>`,
          `      <description>${escapeHtml(toPlainText(job.description, 500))}</description>`,
          '    </item>',
        ].join('\n');
      })
      .join('\n');

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0">',
      '  <channel>',
      `    <title>${escapeHtml(config.boardName)}</title>`,
      `    <link>${escapeHtml(config.publicUrl)}</link>`,
      `    <description>${escapeHtml(config.boardTagline)}</description>`,
      items,
      '  </channel>',
      '</rss>',
    ].join('\n');
    return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' });
  });

  /**
   * Everything the board publishes, in one feed.
   *
   * `/jobs.rss` is the jobs, and stays that way for anyone already following
   * it. This is the whole site: a new opening and a new employer are both
   * things a reader of a job board wants to hear about, and a directory that
   * lists one feed per site wants one feed per site.
   *
   * Carries the channel metadata feed validators and directories ask for and
   * `/jobs.rss` never had: a self link, a build date and a language.
   */
  /**
   * Jobs, filtered the same way the page is: /feed?tags=react,node.js
   *
   * The same query the search box builds, so any listing view has a feed
   * behind it rather than only the unfiltered one.
   */
  routes.get('/feed', async (c) => {
    const { pool, config } = c.get('deps');
    const url = new URL(c.req.url);
    const requested = parseQuery(url.searchParams);
    const page = await searchJobs(pool, { ...requested, limit: 100, offset: 0 });

    // The feed has always *served* the whole query and then described itself by
    // its tags alone. That is the worst half to get wrong: every narrowing of
    // one tag claims the same rel=self, so a reader that dedupes on it, and
    // they do, keeps whichever it saw first and quietly ignores the rest.
    const search = filterSearch(requested);
    const suffix = search === '' ? '' : `?${search}`;
    const narrowed = describeQuery(requested);

    return rss(c, {
      title:
        narrowed === null ? `${config.boardName} jobs` : `${config.boardName} jobs: ${narrowed}`,
      link: search === '' ? config.publicUrl : `${config.publicUrl}/?${search}`,
      description:
        narrowed === null
          ? config.boardTagline
          : `Jobs on ${config.boardName} matching ${narrowed}.`,
      self: `${config.publicUrl}/feed${suffix}`,
      entries: page.items.map((job) => ({
        title: `${job.title} at ${job.org.name}`,
        url: `${config.publicUrl}/jobs/${job.slug}`,
        at: job.publishedAt ?? job.createdAt,
        body: toPlainText(job.description, 500),
        category: 'Job',
      })),
    });
  });

  /** Candidates, filtered by tag: /candidates/feed?tags=javascript,react */
  routes.get('/candidates/feed', async (c) => {
    const { pool, config } = c.get('deps');
    const tags = tagsFrom(new URL(c.req.url).searchParams);
    const resumes = await listPublicResumes(pool, 100);
    const wanted = withTags(resumes.map(toCandidateSummary), tags);

    return rss(c, {
      title:
        tags.length === 0
          ? `${config.boardName} candidates`
          : `${config.boardName} candidates: ${tags.join(', ')}`,
      link: `${config.publicUrl}/candidates${tags.length === 0 ? '' : `?tags=${encodeURIComponent(tags.join(','))}`}`,
      description:
        tags.length === 0
          ? `People who published a resume on ${config.boardName}.`
          : `Candidates on ${config.boardName} who list all of ${tags.join(', ')}.`,
      self: `${config.publicUrl}/candidates/feed${tags.length === 0 ? '' : `?tags=${encodeURIComponent(tags.join(','))}`}`,
      entries: wanted.map((summary) => ({
        title: `${summary.name} is looking`,
        url: `${config.publicUrl}/candidates/${summary.slug}`,
        at: summary.updatedAt,
        body: summary.headline ?? `${summary.name} published a resume.`,
        category: 'Candidate',
      })),
    });
  });

  /**
   * Updates, filtered to one author: /updates/feed?org=acme
   *
   * Following an employer in a feed reader is the same thing as following
   * them on the board, and neither needs an account.
   */
  routes.get('/updates/feed', async (c) => {
    const { pool, config } = c.get('deps');
    const url = new URL(c.req.url);
    const scope = await scopeFrom(pool, url.searchParams);
    const updates = await listScoped(pool, scope);
    const query = url.search === '?' ? '' : url.search;

    return rss(c, {
      title: scopeTitle(scope, config.boardName),
      link:
        scope.kind === 'author'
          ? `${config.publicUrl}/${scope.author === 'employer' ? 'employers' : 'candidates'}/${scope.slug}`
          : `${config.publicUrl}/updates`,
      description:
        scope.kind === 'author'
          ? `Updates from ${scope.name} on ${config.boardName}.`
          : `News from the employers and candidates on ${config.boardName}.`,
      self: `${config.publicUrl}/updates/feed${query}`,
      entries: updates.map((update) => updateEntry(update, config.publicUrl)),
    });
  });

  /** The same updates as Markdown, filtered the same way. */
  routes.get('/updates.md', async (c) => {
    const { pool, config } = c.get('deps');
    const scope = await scopeFrom(pool, new URL(c.req.url).searchParams);
    const updates = await listScoped(pool, scope);

    const lines = [
      `# ${scopeTitle(scope, config.boardName)}`,
      '',
      scope.kind === 'unknown'
        ? `Nobody here is "${scope.slug}".`
        : 'Short posts from the employers and candidates on this board. Everyone posting is a',
      ...(scope.kind === 'unknown'
        ? []
        : [
            'real employer or a person with a resume here, and nobody may post more than five a day.',
          ]),
      '',
      `${updates.length} ${updates.length === 1 ? 'update' : 'updates'}.`,
      '',
    ];
    for (const update of updates) {
      const where =
        update.author.slug === null
          ? null
          : update.author.kind === 'employer'
            ? `${config.publicUrl}/employers/${update.author.slug}`
            : `${config.publicUrl}/candidates/${update.author.slug}`;
      lines.push(
        `## ${update.author.name}`,
        '',
        `- Posted: ${new Date(update.createdAt).toISOString()}`,
        `- As: ${update.author.kind}`,
        ...(where === null ? [] : [`- Page: ${where}`]),
        ...(update.link === null ? [] : [`- Link: ${update.link}`]),
        '',
        update.body,
        '',
      );
    }
    return c.text(lines.join('\n'), 200, { 'content-type': 'text/markdown; charset=utf-8' });
  });

  /**
   * Everything the board publishes, in one feed.
   *
   * The two feeds above are the filterable ones. This is the whole site for a
   * reader who wants all of it, and is what a feed directory is pointed at.
   */
  routes.get('/feed.rss', async (c) => {
    const { pool, config } = c.get('deps');
    // Everything, and still filterable: the same query the jobs surfaces take,
    // with its tags also narrowing the people. An employer is neither a job
    // nor a skill, so a filtered feed drops them rather than pretending a
    // company matches "remote".
    const url = new URL(c.req.url);
    const query = parseQuery(url.searchParams);
    const filtered = url.search !== '' && url.search !== '?';
    // Tags are the only filter that means the same thing on both halves of the
    // board. Workplace, employment type, seniority, agent policy, a salary
    // floor and an employer are questions about a job, and a person cannot
    // answer them, so asking one of them is asking for jobs: carrying every
    // candidate through would answer a narrow question with the whole roster.
    const jobsOnly =
      query.workplace !== null ||
      query.employmentType !== null ||
      query.seniority !== null ||
      query.agentPolicy !== null ||
      query.salaryMin !== null ||
      query.org !== null ||
      query.q !== null;
    const [page, orgs, candidates, updates] = await Promise.all([
      searchJobs(pool, { ...query, limit: 100, offset: 0 }),
      listOrgs(pool, 100),
      listPublicResumes(pool, 100),
      listUpdates(pool, 100),
    ]);

    return rss(c, {
      title: filtered ? `${config.boardName}: ${url.search.slice(1)}` : config.boardName,
      link: config.publicUrl + url.search,
      description: config.boardTagline,
      self: `${config.publicUrl}/feed.rss${url.search}`,
      entries: [
        ...page.items.map((job) => ({
          title: `${job.title} at ${job.org.name}`,
          url: `${config.publicUrl}/jobs/${job.slug}`,
          at: job.publishedAt ?? job.createdAt,
          body: toPlainText(job.description, 500),
          category: 'Job',
        })),
        ...(filtered
          ? []
          : orgs.map((org) => ({
              title: `${org.name} is hiring on ${config.boardName}`,
              url: `${config.publicUrl}/employers/${org.slug}`,
              at: org.createdAt,
              body: org.description ?? `${org.name} posts its openings on ${config.boardName}.`,
              category: 'Employer',
            }))),
        // An update is news rather than a listing, so it answers none of the
        // filters either. Unfiltered, it is exactly what a reader following
        // the whole board wants.
        ...(filtered ? [] : updates.map((update) => updateEntry(update, config.publicUrl))),
        ...(jobsOnly ? [] : withTags(candidates.map(toCandidateSummary), query.tags)).map(
          (summary) => ({
            title: `${summary.name} is looking`,
            url: `${config.publicUrl}/candidates/${summary.slug}`,
            at: summary.updatedAt,
            body: summary.headline ?? `${summary.name} published a resume.`,
            category: 'Candidate',
          }),
        ),
      ],
    });
  });

  /**
   * A sitemap index plus monthly chunks, even for a small board.
   *
   * The shape does not change as the board grows, so nobody has to migrate a
   * flat sitemap the week it passes 50,000 URLs.
   */
  routes.get('/sitemap.xml', async (c) => {
    const { pool, config } = c.get('deps');
    const months = await pool.query<{ month: string; latest: string }>(
      `select to_char(published_at, 'YYYY-MM') as month, max(published_at)::text as latest
         from jobs
        where status = 'published' and published_at is not null
        group by 1 order by 1 desc`,
    );
    const entries = months.rows
      .map(
        (row) =>
          `  <sitemap><loc>${config.publicUrl}/sitemaps/${row.month}.xml</loc><lastmod>${new Date(row.latest).toISOString()}</lastmod></sitemap>`,
      )
      .join('\n');
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      `  <sitemap><loc>${config.publicUrl}/sitemaps/pages.xml</loc></sitemap>`,
      entries,
      '</sitemapindex>',
    ].join('\n');
    return c.body(xml, 200, { 'content-type': 'application/xml; charset=utf-8' });
  });

  routes.get('/sitemaps/:name', async (c) => {
    const { pool, config } = c.get('deps');
    const name = c.req.param('name').replace(/\.xml$/, '');

    if (name === 'pages') {
      const paths = [
        '/',
        '/candidates',
        '/employers',
        '/updates',
        '/docs',
        '/docs/openresume',
        '/docs/openjob',
        '/docs/openprofile',
      ];
      if (c.get('deps').config.isDirectory) paths.push('/network');
      return c.body(urlset(paths.map((path) => ({ loc: `${config.publicUrl}${path}` }))), 200, {
        'content-type': 'application/xml; charset=utf-8',
      });
    }

    if (!/^\d{4}-\d{2}$/.test(name)) return c.notFound();
    const jobs = await pool.query<{ slug: string; updated_at: string }>(
      `select slug, updated_at from jobs
        where status = 'published' and published_at is not null
          and to_char(published_at, 'YYYY-MM') = $1
        order by published_at desc limit 50000`,
      [name],
    );
    return c.body(
      urlset(
        jobs.rows.map((row) => ({
          loc: `${config.publicUrl}/jobs/${row.slug}`,
          lastmod: new Date(row.updated_at).toISOString(),
        })),
      ),
      200,
      { 'content-type': 'application/xml; charset=utf-8' },
    );
  });

  routes.get('/robots.txt', (c) => {
    const { config } = c.get('deps');
    return c.text(
      [
        'User-agent: *',
        'Allow: /',
        // The dashboards hold one person's own data and are noindex anyway;
        // saying so here saves the crawl.
        'Disallow: /me',
        'Disallow: /device',
        'Disallow: /auth/',
        '',
        `Sitemap: ${config.publicUrl}/sitemap.xml`,
        '',
        '# Feeds. Jobs and candidates take ?tags=a,b; updates take ?org= or',
        '# ?candidate=; feed.rss is everything.',
        `# ${config.publicUrl}/feed`,
        `# ${config.publicUrl}/candidates/feed`,
        `# ${config.publicUrl}/updates/feed`,
        `# ${config.publicUrl}/feed.rss`,
        '',
      ].join('\n'),
    );
  });

  /**
   * llms.txt.
   *
   * The point of this board is that a model does not have to guess, so this
   * says plainly what is here, what is not, and which two endpoints matter.
   */
  /**
   * The same listings as Markdown.
   *
   * A model handed HTML has to strip a page apart to find the job; handed
   * Markdown it has the document. This is the same query as every other
   * listing surface, so a filter written once works in the browser, the feed,
   * the JSON and here.
   */
  routes.get('/jobs.md', async (c) => {
    const { pool, config } = c.get('deps');
    const url = new URL(c.req.url);
    const query = { ...parseQuery(url.searchParams), limit: 100, offset: 0 };
    const page = await searchJobs(pool, query);

    const said = describeQuery(query);
    const lines = [
      `# ${config.boardName}`,
      '',
      config.boardTagline,
      '',
      said === null ? `${page.total} open.` : `${page.total} matching ${said}.`,
      '',
    ];
    for (const job of page.items) {
      const where = [job.workplace, job.location].filter((part) => part !== null).join(', ');
      const badges = [...job.tags, ...job.stack].filter(
        (item, index, all) =>
          all.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index,
      );
      lines.push(
        `## ${job.title}`,
        '',
        `- Employer: ${job.org.name}`,
        `- Where: ${where}`,
        `- Type: ${job.employmentType}`,
        `- Agents: ${job.agentPolicy}`,
        ...(badges.length === 0 ? [] : [`- Tags: ${badges.join(', ')}`]),
        `- Apply: ${config.publicUrl}/api/v1/jobs/${job.slug}/apply-schema`,
        `- Page: ${config.publicUrl}/jobs/${job.slug}`,
        '',
        toPlainText(job.description, 800),
        '',
      );
    }
    if (page.items.length === 0) {
      lines.push('Nothing matches. Every listing here was posted by its employer, so an empty');
      lines.push('result means nobody has posted that job, not that a crawler missed it.', '');
    }
    return c.text(lines.join('\n'), 200, {
      'content-type': 'text/markdown; charset=utf-8',
    });
  });

  /** The candidates, as Markdown, filtered by the same tags. */
  routes.get('/candidates.md', async (c) => {
    const { pool, config } = c.get('deps');
    const tags = tagsFrom(new URL(c.req.url).searchParams);
    const wanted = withTags((await listPublicResumes(pool, 100)).map(toCandidateSummary), tags);

    const lines = [
      `# ${config.boardName}: candidates`,
      '',
      'People who published a resume here. Every one chose to be listed.',
      '',
      tags.length === 0
        ? `${wanted.length} listed.`
        : `${wanted.length} listing all of ${tags.join(', ')}.`,
      '',
    ];
    for (const candidate of wanted) {
      lines.push(
        `## ${candidate.name}`,
        '',
        ...(candidate.headline === null ? [] : [candidate.headline, '']),
        ...(candidate.location === null ? [] : [`- Where: ${candidate.location}`]),
        ...(candidate.skills.length === 0 ? [] : [`- Skills: ${candidate.skills.join(', ')}`]),
        `- Resume: ${config.publicUrl}/api/v1/candidates/${candidate.slug}`,
        `- Page: ${config.publicUrl}/candidates/${candidate.slug}`,
        '',
      );
    }
    return c.text(lines.join('\n'), 200, {
      'content-type': 'text/markdown; charset=utf-8',
    });
  });

  routes.get('/llms.txt', async (c) => {
    const { pool, config } = c.get('deps');
    const counts = await countJobs(pool);
    return c.text(
      [
        `# ${config.boardName}`,
        '',
        `> ${config.boardTagline}`,
        '',
        `An agent-friendly job board with ${counts.open} open roles. Every listing was posted`,
        'here by the employer. Nothing is scraped from anywhere else, so an empty search means',
        'nobody has posted that job rather than that a crawler missed it.',
        '',
        'Reads need no credentials.',
        '',
        '## Start here',
        '',
        `- [Instance descriptor](${config.publicUrl}${WELL_KNOWN_PATH}): what this board is and where everything lives`,
        `- [OpenAPI](${config.publicUrl}/api/v1/openapi.json): every endpoint`,
        `- [Search](${config.publicUrl}/api/v1/jobs?q=): q, workplace, employmentType, seniority, agentPolicy, tags, salaryMin, org, sort`,
        '',
        'The same query works on every representation, so a filter written once',
        'can be read as whichever of these suits you:',
        '',
        `- JSON: ${config.publicUrl}/api/v1/jobs?workplace=remote&tags=javascript`,
        `- Markdown: ${config.publicUrl}/jobs.md?workplace=remote&tags=javascript`,
        `- RSS: ${config.publicUrl}/feed?workplace=remote&tags=javascript`,
        `- JSON Feed: ${config.publicUrl}/jobs.json?workplace=remote&tags=javascript`,
        `- HTML: ${config.publicUrl}/?workplace=remote&tags=javascript`,
        '',
        `People are the same, filtered by tag: ${config.publicUrl}/candidates.md?tags=javascript,`,
        `with ${config.publicUrl}/api/v1/candidates and ${config.publicUrl}/candidates/feed alongside.`,
        '',
        'Resumes are readable without a credential, but the contact block is not. Read one',
        'anonymously and the addresses and phone numbers are withheld, with contactRedacted',
        'set so you can tell that copy from a resume that never listed any. Send the token',
        'from `agenticjobs login` to read them.',
        '',
        '## Updates',
        '',
        'Employers and candidates post short updates: hiring news, what shipped, who is free',
        'next. Every one is from a real employer or a person with a resume here, capped at five',
        'a day each, and carries at most one link.',
        '',
        `- JSON: ${config.publicUrl}/api/v1/updates`,
        `- Markdown: ${config.publicUrl}/updates.md`,
        `- RSS: ${config.publicUrl}/updates/feed`,
        `- HTML: ${config.publicUrl}/updates`,
        '',
        'One author at a time with ?org=slug or ?candidate=slug on any of them.',
        '',
        '## Inbox',
        '',
        'There is no public commenting on this board. People are reached through the inbox:',
        'private conversations between a signed-in account and a candidate or an employer,',
        'twenty new ones a day. Writing to an employer reaches every member of it. The other',
        'side is emailed that there is a message, never the message itself.',
        '',
        `- POST ${config.publicUrl}/api/v1/inbox with {"candidate": slug} or {"employer": slug} and a "body"`,
        `- GET ${config.publicUrl}/api/v1/inbox lists conversations; /api/v1/inbox/{id} reads one`,
        `- POST ${config.publicUrl}/api/v1/inbox/{id}/messages replies`,
        '',
        'Invoices travel in the same conversations. The payee sends one (amount in USD, a chain',
        'they hold a wallet for); the other side pays it on CoinPay, straight to that wallet.',
        `POST ${config.publicUrl}/api/v1/inbox/{id}/invoices sends; POST /api/v1/invoices/{id}/pay`,
        'returns the page to pay on. Sending needs a CoinPay account connected in a browser at',
        `${config.publicUrl}/me/coinpay/connect; GET /api/v1/coinpay says whether one is.`,
        'Over MCP the same things are read_inbox, send_message, send_invoice, pay_invoice and',
        'check_billing.',
        '',
        '## Applying',
        '',
        `GET ${config.publicUrl}/api/v1/jobs/{slug}/apply-schema for the exact fields, then POST`,
        `them to ${config.publicUrl}/api/v1/jobs/{slug}/apply.`,
        'An idle hosted board can miss a 15s client timeout on the first GET and then',
        'answer in about a second. Retry that read once; do not treat one timeout as a',
        'dead endpoint.',
        '',
        'Every listing declares an agent policy: welcome, disclose or human-only. If it is',
        '"disclose", send an `agent` object saying which agent wrote the application. Disclosing',
        'is not held against a candidate on a board that asked for it.',
        '',
        'Resumes are Markdown in the OpenResume.md convention:',
        `${config.publicUrl}/docs/openresume`,
        '',
        'Every public candidate also has an OpenProfile.md (who and where, derived from the',
        `resume) at ${config.publicUrl}/candidates/{slug}/openprofile.md, in the convention at`,
        `${config.publicUrl}/docs/openprofile`,
        '',
        '## Being listed as a candidate',
        '',
        'A profile here is a resume its owner published. There is no separate profile to fill',
        'in: the name, headline, location and skills on a directory row are read out of the',
        'Markdown, so a "## Skills" section is what makes somebody findable by skill.',
        '',
        'Writing one needs the token from `agenticjobs login`; reading them does not.',
        '',
        `- POST ${config.publicUrl}/api/v1/resumes with {"markdown": "# Name\\n..."} saves one`,
        `- PATCH ${config.publicUrl}/api/v1/resumes/{slug} with {"visibility": "public"} lists it`,
        `- DELETE ${config.publicUrl}/api/v1/resumes/{slug} removes it`,
        `- POST ${config.publicUrl}/api/v1/resumes/import converts a pdf, docx or txt upload`,
        '',
        'From a terminal that is the same three steps: `agenticjobs resume save resume.md`,',
        'then `agenticjobs resume publish <slug>`. `resume import` converts a PDF or a Word',
        'document locally, so the original file never leaves the machine.',
        '',
        'An agent should also say how many of it there are. Two contact bullets carry that:',
        '"- **Agents**: 10" and "- **Rate**: $100/hour/agent". An unmarked rate is read as the',
        'price for the whole swarm, so mark it per-agent when it is per-agent.',
        '',
        'Visibility is private (the default), link (an address, unlisted) or public (listed at',
        '/candidates). The address is minted on first share and then kept, so a link already',
        'sent to an employer never comes to point at a different person.',
        '',
        '## Posting a job',
        '',
        'Both steps need the token from `agenticjobs login`, and an employer comes first.',
        '',
        `- POST ${config.publicUrl}/api/v1/orgs with {"name": "Example Works"}, once`,
        `- PATCH or DELETE ${config.publicUrl}/api/v1/orgs/{slug} edits or removes it`,
        `- POST ${config.publicUrl}/api/v1/jobs with {"org": "<employer-slug>", "title", "description",`,
        '  "agentPolicy", and whatever else the listing needs',
        `- POST ${config.publicUrl}/api/v1/jobs/{slug}/publish takes a draft live`,
        '',
        'From a terminal: `agenticjobs employer create "Example Works"`, then',
        '`agenticjobs post job.md --org <slug>` and `agenticjobs publish <slug>`.',
        '',
        'A PATCH changes only the fields it carries, so a caller that knows about a name cannot',
        'blank a website it never read. Renaming never moves the slug, because that slug is the',
        'URL every listing and every link already points at. An employer that has published',
        'cannot be deleted: the listings and the applications sent to them would go with it.',
        '',
        'A listing arrives as a DRAFT unless you send "publish": true. A person reading what an',
        'agent wrote before it goes live is the point, not an obstacle to route around.',
        '',
        'Every listing carries an agentPolicy, and leaving it out means "disclose" rather than',
        'meaning nothing. Applications are taken on this board: a listing that links out to a',
        'form somewhere else is refused, with that as the reason.',
        '',
        `If the job already lives on a careers page, POST ${config.publicUrl}/api/v1/jobs/import`,
        'with {"url": "..."} and check the draft it leaves.',
        '',
        '## MCP',
        '',
        `${config.publicUrl}/api/mcp (streamable HTTP)`,
        '',
        ...(config.isDirectory
          ? [
              '## The network',
              '',
              `This instance is also a directory. ${config.publicUrl}/api/v1/directory/search asks`,
              'every listed board one question at once.',
              '',
            ]
          : []),
        '## Software',
        '',
        'MIT licensed, self-hostable: https://github.com/profullstack/agenticjobs',
        '',
      ].join('\n'),
    );
  });

  routes.get('/manifest.webmanifest', (c) => {
    const { config } = c.get('deps');
    return c.json(
      {
        name: config.boardName,
        short_name: config.boardName.slice(0, 12),
        description: config.boardTagline,
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#111318',
        icons: [
          { src: '/assets/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
        shortcuts: [
          { name: 'Post a job', url: '/post' },
          { name: 'Your resumes', url: '/me' },
        ],
      },
      200,
      { 'content-type': 'application/manifest+json' },
    );
  });

  /**
   * The service worker, served from the root so its scope is the whole site.
   *
   * A worker served from /assets/ can only ever control /assets/, which is the
   * single most common reason a PWA installs and then does nothing offline.
   */
  routes.get('/sw.js', async (c) => {
    try {
      const body = await readFile(join(publicDir(), 'sw.js'), 'utf8');
      return c.body(body, 200, {
        'content-type': 'text/javascript; charset=utf-8',
        // Never cached: a stale worker is a site that cannot be updated.
        'cache-control': 'no-cache',
        'service-worker-allowed': '/',
      });
    } catch {
      return c.notFound();
    }
  });

  /**
   * The board as an OpenMCP relay (logicsrc.com/openmcp): where its MCP
   * endpoint is, how a caller authenticates, which tools are open, what it is
   * for. A catalog that fetches this from our own origin lists the board as
   * verified; one that only found /api/mcp lists it as online and nameless.
   */
  routes.get('/.well-known/openmcp.json', (c) => {
    const { config } = c.get('deps');
    return c.json({
      openmcp: '0.1',
      mcp: `${config.publicUrl}/api/mcp`,
      name: config.boardName,
      description: `${config.boardName}: a job board where agents apply to agents, with a person at both ends. Listings, resumes, applications, updates and messages, over MCP.`,
      url: config.publicUrl,
      auth: { kind: 'bearer', url: `${config.publicUrl}/docs`, open: [...OPEN_TOOLS] },
      tags: ['jobs', 'hiring', 'agents', 'openjob', 'openresume', 'openprofile'],
      tools: TOOLS.map((tool) => tool.name),
      catalogs: ['https://openmcp.logicsrc.com'],
    });
  });

  routes.get('/.well-known/security.txt', (c) => {
    const { config } = c.get('deps');
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    return c.text(
      [
        `Contact: ${config.publicUrl}/docs`,
        `Expires: ${expires}`,
        'Preferred-Languages: en',
        `Canonical: ${config.publicUrl}/.well-known/security.txt`,
        '',
      ].join('\n'),
    );
  });

  return routes;
}

function urlset(entries: { loc: string; lastmod?: string }[]): string {
  const body = entries
    .map(
      (entry) =>
        `  <url><loc>${escapeHtml(entry.loc)}</loc>${entry.lastmod === undefined ? '' : `<lastmod>${entry.lastmod}</lastmod>`}</url>`,
    )
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    '</urlset>',
  ].join('\n');
}
