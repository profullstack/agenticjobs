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
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countJobs, searchJobs } from '../../core/jobs.ts';
import { listOrgs } from '../../core/orgs.ts';
import { listPublicResumes } from '../../core/resumes.ts';
import { tagsFrom, toCandidateSummary, withTags } from '../../core/candidates.ts';
import { parseQuery } from '../../schema/query.ts';
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
          tags: [...job.tags, ...job.stack, job.workplace, job.employmentType],
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
    const page = await searchJobs(pool, { ...parseQuery(new URLSearchParams()), limit: 100 });
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
  routes.get('/feed.rss', async (c) => {
    const { pool, config } = c.get('deps');
    // `?skill=` narrows the feed to the candidates who list it, so every tag
    // on the site is subscribable rather than only browsable.
    const tags = tagsFrom(new URL(c.req.url).searchParams);
    const [page, orgs, candidates] = await Promise.all([
      searchJobs(pool, { ...parseQuery(new URLSearchParams()), limit: 100 }),
      listOrgs(pool, 100),
      listPublicResumes(pool, 100),
    ]);

    type Entry = { title: string; url: string; at: string; body: string; category: string };
    const wanted = withTags(candidates.map(toCandidateSummary), tags);
    const entries: Entry[] = (tags.length > 0 ? [] : [
      ...page.items.map((job) => ({
        title: `${job.title} at ${job.org.name}`,
        url: `${config.publicUrl}/jobs/${job.slug}`,
        at: job.publishedAt ?? job.createdAt,
        body: toPlainText(job.description, 500),
        category: 'Job',
      })),
      ...orgs.map((org) => ({
        title: `${org.name} is hiring on ${config.boardName}`,
        url: `${config.publicUrl}/employers/${org.slug}`,
        at: org.createdAt,
        body: org.description ?? `${org.name} posts its openings on ${config.boardName}.`,
        category: 'Employer',
      })),
    ]).concat(
      wanted.map((summary): Entry => ({
        title: `${summary.name} is looking`,
        url: `${config.publicUrl}/candidates/${summary.slug}`,
        at: summary.updatedAt,
        body: summary.headline ?? `${summary.name} published a resume.`,
        category: 'Candidate',
      })),
    ).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

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

    // An empty board still serves a valid feed; lastBuildDate falls back to now
    // rather than to an invalid date built from an undefined entry.
    const newest = entries[0]?.at;
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
      '  <channel>',
      `    <title>${escapeHtml(tags.length === 0 ? config.boardName : `${config.boardName}: ${tags.join(', ')}`)}</title>`,
      `    <link>${escapeHtml(tags.length === 0 ? config.publicUrl : `${config.publicUrl}/candidates?tags=${encodeURIComponent(tags.join(','))}`)}</link>`,
      `    <description>${escapeHtml(tags.length === 0 ? config.boardTagline : `Candidates on ${config.boardName} who list all of ${tags.join(', ')}.`)}</description>`,
      '    <language>en</language>',
      `    <lastBuildDate>${new Date(newest === undefined ? Date.now() : Date.parse(newest)).toUTCString()}</lastBuildDate>`,
      `    <atom:link href="${escapeHtml(`${config.publicUrl}/feed.rss${tags.length === 0 ? '' : `?tags=${encodeURIComponent(tags.join(','))}`}`)}" rel="self" type="application/rss+xml" />`,
      items,
      '  </channel>',
      '</rss>',
    ].join('\n');
    return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' });
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
        '/docs',
        '/docs/openresume',
        '/docs/openjob',
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
        '# Everything this board publishes, as one feed.',
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
        `- [Search](${config.publicUrl}/api/v1/jobs?q=): q, workplace, employmentType, seniority, agentPolicy, tag, salaryMin`,
        `- [Feed](${config.publicUrl}/jobs.json): the 100 most recent, as JSON Feed`,
        '',
        '## Applying',
        '',
        `GET ${config.publicUrl}/api/v1/jobs/{slug}/apply-schema for the exact fields, then POST`,
        `them to ${config.publicUrl}/api/v1/jobs/{slug}/apply.`,
        '',
        'Every listing declares an agent policy: welcome, disclose or human-only. If it is',
        '"disclose", send an `agent` object saying which agent wrote the application. Disclosing',
        'is not held against a candidate on a board that asked for it.',
        '',
        'Resumes are Markdown in the OpenResume.md convention:',
        `${config.publicUrl}/docs/openresume`,
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
