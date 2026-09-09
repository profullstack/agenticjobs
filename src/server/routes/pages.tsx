/**
 * The HTML pages.
 *
 * They render server-side from the same core functions the API uses, so there
 * is one set of queries and one set of permission checks rather than two that
 * drift. Every form works without JavaScript; the one script on the site adds
 * passkeys and nothing else.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  approveDeviceCode,
  consumeMagicLink,
  createSession,
  findDeviceCode,
  normaliseEmail,
  revokeSession,
  safeRedirect,
  SESSION_COOKIE,
  startMagicLink,
  sweepExpired,
  type Viewer,
} from '../../core/auth.ts';
import {
  createApplication,
  listApplications,
  recentApplicationCount,
  validateApplication,
} from '../../core/applications.ts';
import {
  createJob,
  getJobBySlug,
  normaliseInput,
  searchJobs,
  setStatus,
} from '../../core/jobs.ts';
import { createOrg, getOrgBySlug, isMember, listOrgs, listOrgsForUser } from '../../core/orgs.ts';
import {
  createResume,
  deleteResume,
  ensurePublicSlug,
  getPublicResume,
  getResume,
  publicResumeSource,
  listPublicResumes,
  isVisibility,
  listResumes,
  updateResume,
} from '../../core/resumes.ts';
import { importDocument, ImportProblem } from '../../core/import.ts';
import { deliverMagicLink } from '../../core/mail.ts';
import { listInstances, listTopics } from '../../directory/registry.ts';
import { federatedSearch, targetsFromDescriptors } from '../../directory/federate.ts';
import { parseQuery } from '../../schema/query.ts';
import { jobPostingJsonLd } from '../../schema/jsonld.ts';
import { toPlainText } from '../../markup/markdown.ts';
import { renderMarkdown } from '../../markup/markdown.ts';
import { parseResume, resumeTemplate } from '../../markup/resume.ts';
import { Layout, type PageProps } from '../../views/layout.tsx';
import { EmployerDetail, EmployerList, JobDetail, JobList } from '../../views/jobs.tsx';
import { DevicePage, LoginPage } from '../../views/auth.tsx';
import { MePage, ResumeEditor } from '../../views/me.tsx';
import { ManageJobPage, NewEmployerPage, PostJobPage } from '../../views/post.tsx';
import { NetworkPage, NetworkSearchPage } from '../../views/network.tsx';
import { DocsPage, SpecPage } from '../../views/docs.tsx';
import { CandidateDetail, CandidateList } from '../../views/candidates.tsx';
import {
  allTags,
  resumeForViewer,
  tagsFrom,
  toCandidateSummary,
  withTags,
} from '../../core/candidates.ts';
import {
  BODY_MAX,
  candidateSlugFor,
  follow,
  followerCount,
  isFollowing,
  listFollowedUpdates,
  listFollowing,
  listUpdates,
  listUpdatesFor,
  postUpdate,
  unfollow,
  userForCandidate,
  type Target,
} from '../../core/updates.ts';
import { UpdatesPage, type SocialProps } from '../../views/updates.tsx';
import {
  CONTENT_TYPE,
  ConversionProblem,
  filename,
  resumeDocx,
  resumeHtml,
  resumePdf,
  type MediaFormat,
} from '../../core/markdown-media.ts';
import { readSpec } from './specs.ts';
import type { AppEnv } from '../deps.ts';

type Ctx = Context<AppEnv>;

/**
 * Everything the shell needs, gathered once.
 *
 * Typed as the subset of PageProps it actually supplies, so a page that
 * forgets `title` is a compile error rather than a blank browser tab.
 */
type Shell = Pick<PageProps, 'viewer' | 'boardName' | 'publicUrl' | 'path' | 'isDirectory'>;

function shell(c: Ctx): Shell {
  const { config } = c.get('deps');
  return {
    viewer: c.get('viewer'),
    boardName: config.boardName,
    publicUrl: config.publicUrl,
    path: new URL(c.req.url).pathname,
    isDirectory: config.isDirectory,
  };
}

/** Hono's c.html may hand back a promise when the tree contains one. */
type Html = Response | Promise<Response>;

function requireViewer(c: Ctx): Viewer | Response {
  const viewer = c.get('viewer');
  if (viewer !== null) return viewer;
  const next = new URL(c.req.url).pathname;
  return c.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
}

async function formOf(c: Ctx): Promise<Record<string, string>> {
  try {
    const body = await c.req.parseBody();
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function pageRoutes(): Hono<AppEnv> {
  const pages = new Hono<AppEnv>();

  // --- jobs -------------------------------------------------------------

  pages.get('/', async (c) => {
    const { pool, config } = c.get('deps');
    const query = parseQuery(new URL(c.req.url).searchParams);
    const page = await searchJobs(pool, query);
    return c.html(
      <Layout
        {...shell(c)}
        title={config.boardName}
        description={config.boardTagline}
      >
        <JobList
          page={page}
          query={query}
          boardName={config.boardName}
          tagline={config.boardTagline}
          publicUrl={config.publicUrl}
        />
      </Layout>,
    );
  });

  pages.get('/jobs/:slug', async (c) => {
    const { pool, config } = c.get('deps');
    const viewer = c.get('viewer');
    const job = await getJobBySlug(pool, c.req.param('slug'));
    if (job === null) return c.notFound();

    const resumes = viewer === null ? [] : await listResumes(pool, viewer.id);
    return c.html(
      <Layout
        {...shell(c)}
        title={`${job.title} at ${job.org.name}`}
        description={toPlainText(job.description, 160)}
        jsonld={jobPostingJsonLd(job, config.publicUrl)}
      >
        <JobDetail
          job={job}
          html={renderMarkdown(job.description, { headingOffset: 1 })}
          publicUrl={config.publicUrl}
          signedIn={viewer !== null}
          resumes={resumes.map((resume) => ({ slug: resume.slug, title: resume.title }))}
        />
      </Layout>,
    );
  });

  pages.post('/jobs/:slug/apply', async (c) => {
    const { pool, config } = c.get('deps');
    const viewer = c.get('viewer');
    const job = await getJobBySlug(pool, c.req.param('slug'));
    if (job === null) return c.notFound();
    if (job.apply.via !== 'board') return c.redirect(`/jobs/${job.slug}`, 303);

    const form = await formOf(c);
    // The form flattens the disclosure into dotted names, because a nested
    // object is not a thing an HTML form can post.
    const input: Record<string, unknown> = { ...form };
    if ((form['agent.name'] ?? '').trim() !== '') {
      input['agent'] = {
        name: form['agent.name'],
        supervised: form['agent.supervised'] === 'true',
      };
    }

    const validated = validateApplication(job.apply.schema, input, job.agentPolicy);
    const render = (problems: { field: string; message: string }[]): Html =>
      c.html(
        <Layout {...shell(c)} title={`Apply: ${job.title}`} noindex>
          <JobDetail
            job={job}
            html={renderMarkdown(job.description, { headingOffset: 1 })}
            publicUrl={config.publicUrl}
            problems={problems}
            values={form}
            signedIn={viewer !== null}
          />
        </Layout>,
        400,
      );

    if (!validated.ok) return render(validated.problems);

    const email = validated.value.answers['email'] ?? '';
    if (email !== '' && (await recentApplicationCount(pool, email)) >= 20) {
      return render([
        { field: 'email', message: 'That address has sent a lot of applications this hour.' },
      ]);
    }

    const resumeMarkdown = (form['resume'] ?? '').trim();
    let resolved: string | null = resumeMarkdown === '' ? null : resumeMarkdown;
    const slug = form['resumeSlug'] ?? '';
    if (resolved === null && slug !== '' && viewer !== null) {
      const saved = await getResume(pool, viewer.id, slug);
      resolved = saved?.markdown ?? null;
    }

    const application = await createApplication(pool, job.id, validated.value);
    if (resolved !== null || viewer !== null) {
      await pool.query(
        `update applications set resume_markdown = $2, resume_title = $3, user_id = $4 where id = $1`,
        [
          application.id,
          resolved,
          resolved === null ? null : (parseResume(resolved).name ?? 'Resume'),
          viewer?.id ?? null,
        ],
      );
    }

    return c.html(
      <Layout {...shell(c)} title={`Applied: ${job.title}`} noindex>
        <JobDetail
          job={job}
          html={renderMarkdown(job.description, { headingOffset: 1 })}
          publicUrl={config.publicUrl}
          applied
          signedIn={viewer !== null}
        />
      </Layout>,
    );
  });

  // --- candidates ---------------------------------------------------------

  pages.get('/candidates', async (c) => {
    const { pool, config } = c.get('deps');
    const tags = tagsFrom(new URL(c.req.url).searchParams);
    const resumes = await listPublicResumes(pool);
    const all = resumes.map(toCandidateSummary);
    const candidates = withTags(all, tags);
    return c.html(
      <Layout
        {...shell(c)}
        title={tags.length === 0 ? 'Candidates' : `Candidates: ${tags.join(', ')}`}
        description={`People who published a resume on ${config.boardName}.`}
        // A filtered view is a slice of a page that is already indexed, so it
        // is not a second page for a crawler to collect.
        noindex={tags.length > 0}
      >
        <CandidateList
          candidates={candidates}
          publicUrl={config.publicUrl}
          tags={tags}
          index={allTags(all)}
        />
      </Layout>,
    );
  });

  /**
   * One candidate.
   *
   * `error` is the update composer's, and is passed rather than redirected
   * with, so a rejected post comes back on the page that made it.
   */
  const candidatePage = async (c: Ctx, slug: string, error?: string): Promise<Response> => {
    const { pool, config } = c.get('deps');
    const resume = await getPublicResume(pool, slug);
    if (resume === null) return c.notFound();

    const summary = toCandidateSummary(resume);
    const viewer = c.get('viewer');
    const shown = resumeForViewer(resume, viewer !== null);
    const target: Target = { kind: 'candidate', userId: resume.userId };
    const [updates, followers, following] = await Promise.all([
      listUpdatesFor(pool, target),
      followerCount(pool, target),
      viewer === null ? Promise.resolve(false) : isFollowing(pool, viewer.id, target),
    ]);

    const social: SocialProps = {
      as: summary.name,
      updates,
      follow: {
        action: `/candidates/${slug}/follow`,
        following,
        followers,
        // Nobody follows themselves, so their own page shows the composer
        // where the button would be.
        signedIn: viewer !== null && viewer.id !== resume.userId,
        next: `/candidates/${slug}`,
      },
      composer:
        viewer !== null && viewer.id === resume.userId
          ? { action: '/me/updates', max: BODY_MAX }
          : null,
      ...(error === undefined ? {} : { error }),
    };

    return c.html(
      <Layout
        {...shell(c)}
        title={summary.name}
        description={summary.headline ?? `${summary.name} on ${config.boardName}.`}
        // A resume reachable only by its link stays out of search results, or
        // "anyone with the link" quietly becomes "anyone".
        noindex={resume.visibility !== 'public'}
      >
        <CandidateDetail
          candidate={summary}
          parsed={shown.parsed}
          html={renderMarkdown(shown.markdown, { headingOffset: 1 })}
          markdownUrl={`${config.publicUrl}/api/v1/candidates/${summary.slug}`}
          listed={resume.visibility === 'public'}
          contactRedacted={shown.redacted}
          social={social}
        />
      </Layout>,
      error === undefined ? 200 : 400,
    );
  };

  pages.get('/candidates/:slug', (c) => candidatePage(c, c.req.param('slug')));

  /**
   * The resume as a file.
   *
   * The Markdown is canonical and everything here is a rendering of it, made
   * on request and never stored. An uploaded original is the exception: if
   * somebody handed us a PDF, giving that back beats giving back a PDF we
   * regenerated from our parse of their PDF.
   *
   * ONE ROUTE PER EXTENSION, which is worth the four lines. This was written
   * as a single `resume.:format{md|html|pdf|docx}` and every download 404'd in
   * 0.6.0, because a literal prefix in the same path segment as a
   * regex-constrained parameter is a RegExpRouter feature and this router is
   * not RegExpRouter. On hono 4.13.7, given that pattern and asked for
   * `/candidates/ada/resume.md`:
   *
   *     RegExpRouter  -> 1 handler
   *     TrieRouter    -> 0 handlers
   *
   * Hono's default is SmartRouter, which tries RegExpRouter and falls back to
   * TrieRouter for the WHOLE router as soon as any one route is beyond it.
   * Some other route here is, so every route in this file is matched by
   * TrieRouter, and this one quietly matched nothing:
   *
   *     pageRoutes().router.match('GET', '/candidates/ada/resume.md') -> 0
   *
   * Nothing to do with mounting - it misses on the bare router. A small
   * throwaway app reproducing this will resolve to RegExpRouter and answer
   * 200, which is a trap worth knowing about before writing one.
   *
   * So: no regex parameter. Four plain paths that any router matches.
   */
  const resumeFile = async (c: Ctx, format: 'md' | MediaFormat) => {
    const { pool, config } = c.get('deps');
    // Ctx is not tied to one path, so the parameter is optional to the type
    // system even though every route below supplies it. An empty slug matches
    // no resume and falls through to the 404 on the next line.
    const slug = c.req.param('slug') ?? '';

    const resume = await getPublicResume(pool, slug);
    if (resume === null) return c.notFound();
    const name = toCandidateSummary(resume).name;
    const shown = resumeForViewer(resume, c.get('viewer') !== null);

    if (format === 'md') {
      return c.body(shown.markdown, 200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${filename(name, 'html').replace(/\.html$/, '.md')}"`,
      });
    }

    // The original upload, when it is the thing being asked for.
    //
    // Not to an anonymous caller once anything has been withheld: those bytes
    // are whatever the candidate uploaded, the contact block included, and
    // there is no redacting a PDF somebody else typeset. Skipping the
    // shortcut falls through to a copy generated from the redacted Markdown,
    // which is the same thing the page is showing them.
    if ((format === 'pdf' || format === 'docx') && !shown.redacted) {
      const source = await publicResumeSource(pool, slug);
      const wanted = format === 'pdf' ? 'pdf' : 'wordprocessingml';
      if (source !== null && source.mime.includes(wanted)) {
        return c.body(new Uint8Array(source.bytes), 200, {
          'content-type': source.mime,
          'content-disposition': `attachment; filename="${filename(name, format)}"`,
        });
      }
    }

    const html = resumeHtml({
      markdown: shown.markdown,
      parsed: shown.parsed,
      title: resume.title,
    });
    if (format === 'html') {
      return c.body(html, 200, { 'content-type': CONTENT_TYPE.html });
    }

    try {
      const bytes = format === 'pdf' ? await resumePdf(html) : await resumeDocx(shown.markdown);
      return c.body(new Uint8Array(bytes), 200, {
        'content-type': CONTENT_TYPE[format],
        'content-disposition': `attachment; filename="${filename(name, format)}"`,
      });
    } catch (error) {
      if (error instanceof ConversionProblem) {
        // 503 rather than 500: the document is fine and the converter is not,
        // so this is worth retrying and worth telling an operator about.
        return c.text(`That file could not be made. ${error.message}\n`, 503);
      }
      throw error;
    }
  };

  // Spelled out rather than generated in a loop, so each URL this board serves
  // appears literally in the source and grep finds it.
  pages.get('/candidates/:slug/resume.md', (c) => resumeFile(c, 'md'));
  pages.get('/candidates/:slug/resume.html', (c) => resumeFile(c, 'html'));
  pages.get('/candidates/:slug/resume.pdf', (c) => resumeFile(c, 'pdf'));
  pages.get('/candidates/:slug/resume.docx', (c) => resumeFile(c, 'docx'));

  pages.get('/employers', async (c) => {
    const { pool } = c.get('deps');
    return c.html(
      <Layout {...shell(c)} title="Employers">
        <EmployerList orgs={await listOrgs(pool)} />
      </Layout>,
    );
  });

  const employerPage = async (c: Ctx, slug: string, error?: string): Promise<Response> => {
    const { pool } = c.get('deps');
    const org = await getOrgBySlug(pool, slug);
    if (org === null) return c.notFound();
    const params = new URL(c.req.url).searchParams;
    params.set('org', org.slug);
    const query = parseQuery(params);
    const viewer = c.get('viewer');
    const target: Target = { kind: 'employer', orgId: org.id };
    const [page, updates, followers, following, member] = await Promise.all([
      searchJobs(pool, query),
      listUpdatesFor(pool, target),
      followerCount(pool, target),
      viewer === null ? Promise.resolve(false) : isFollowing(pool, viewer.id, target),
      viewer === null ? Promise.resolve(false) : isMember(pool, viewer.id, org.id),
    ]);

    const social: SocialProps = {
      as: org.name,
      updates,
      follow: {
        action: `/employers/${org.slug}/follow`,
        following,
        followers,
        signedIn: viewer !== null,
        next: `/employers/${org.slug}`,
      },
      composer: member ? { action: `/employers/${org.slug}/updates`, max: BODY_MAX } : null,
      ...(error === undefined ? {} : { error }),
    };

    return c.html(
      <Layout
        {...shell(c)}
        title={org.name}
        description={org.description ?? `Open roles at ${org.name}.`}
      >
        <EmployerDetail org={org} page={page} query={query} social={social} />
      </Layout>,
      error === undefined ? 200 : 400,
    );
  };

  pages.get('/employers/:slug', (c) => employerPage(c, c.req.param('slug')));

  // --- updates and following --------------------------------------------

  /**
   * Follow and unfollow are the same route.
   *
   * The button carries the state it saw, so the POST says which way it meant
   * to go. A double-submitted form cannot leave somebody following what they
   * just unfollowed, and there is no second URL to guess.
   */
  const toggleFollow = async (c: Ctx, target: Target, back: string): Promise<Response> => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const form = await formOf(c);
    if (form['following'] === 'yes') await unfollow(pool, viewer.id, target);
    else await follow(pool, viewer.id, target);
    return c.redirect(back, 303);
  };

  pages.post('/employers/:slug/follow', async (c) => {
    const { pool } = c.get('deps');
    const org = await getOrgBySlug(pool, c.req.param('slug'));
    if (org === null) return c.notFound();
    return toggleFollow(c, { kind: 'employer', orgId: org.id }, `/employers/${org.slug}`);
  });

  pages.post('/candidates/:slug/follow', async (c) => {
    const { pool } = c.get('deps');
    const slug = c.req.param('slug');
    const userId = await userForCandidate(pool, slug);
    if (userId === null) return c.notFound();
    return toggleFollow(c, { kind: 'candidate', userId }, `/candidates/${slug}`);
  });

  pages.post('/employers/:slug/updates', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const org = await getOrgBySlug(pool, c.req.param('slug'));
    if (org === null) return c.notFound();

    const form = await formOf(c);
    const posted = await postUpdate(
      pool,
      viewer.id,
      { kind: 'employer', orgId: org.id },
      { body: form['body'], link: form['link'] },
    );
    if (typeof posted === 'string') return employerPage(c, org.slug, posted);
    return c.redirect(`/employers/${org.slug}`, 303);
  });

  /**
   * Posting as yourself.
   *
   * One route rather than one per resume: an update is from the person, and
   * their page is whichever resume they listed.
   */
  pages.post('/me/updates', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;

    const slug = await candidateSlugFor(pool, viewer.id);
    if (slug === null) {
      return c.text(
        'Publish a resume before posting an update, so the update has a page behind it.\n',
        403,
      );
    }
    const form = await formOf(c);
    const posted = await postUpdate(
      pool,
      viewer.id,
      { kind: 'candidate', userId: viewer.id },
      { body: form['body'], link: form['link'] },
    );
    if (typeof posted === 'string') return candidatePage(c, slug, posted);
    return c.redirect(`/candidates/${slug}`, 303);
  });

  /** The board's news page, plus your own if you are signed in. */
  pages.get('/updates', async (c) => {
    const { pool, config } = c.get('deps');
    const viewer = c.get('viewer');
    const [updates, followed, following] = await Promise.all([
      listUpdates(pool),
      viewer === null ? Promise.resolve(null) : listFollowedUpdates(pool, viewer.id),
      viewer === null ? Promise.resolve([]) : listFollowing(pool, viewer.id),
    ]);
    return c.html(
      <Layout
        {...shell(c)}
        title="Updates"
        description={`News from the employers and candidates on ${config.boardName}.`}
      >
        <UpdatesPage
          updates={updates}
          boardName={config.boardName}
          followed={followed}
          following={following}
        />
      </Layout>,
    );
  });

  // --- sign in ----------------------------------------------------------

  pages.get('/login', (c) => {
    if (c.get('viewer') !== null) return c.redirect('/me', 302);
    const next = safeRedirect(new URL(c.req.url).searchParams.get('next'));
    return c.html(
      <Layout {...shell(c)} title="Sign in" noindex>
        <LoginPage {...(next === null ? {} : { next })} />
      </Layout>,
    );
  });

  pages.post('/login', async (c) => {
    const { pool, config, mailer } = c.get('deps');
    const form = await formOf(c);
    const email = normaliseEmail(form['email']);
    if (email === null) {
      return c.html(
        <Layout {...shell(c)} title="Sign in" noindex>
          <LoginPage error="That does not look like an email address." />
        </Layout>,
        400,
      );
    }

    const next = safeRedirect(form['next']);
    const link = await startMagicLink(pool, email, next);
    const url = `${config.publicUrl}/auth/callback?token=${link.token}`;
    const delivered = await deliverMagicLink({
      mailer,
      boardName: config.boardName,
      email,
      url,
      redirect: next,
    });
    // Sweeping here rather than on a timer keeps the process free of one.
    void sweepExpired(pool).catch(() => undefined);

    // Never the link itself: whoever typed the address is not necessarily
    // whoever owns it, so putting the link on this page hands them the
    // account. `unsent` is about this board's mail setup and not about the
    // address, so saying it tells a stranger nothing about who has an account.
    return c.html(
      <Layout {...shell(c)} title="Check your email" noindex>
        <LoginPage sent={email} unsent={!delivered} />
      </Layout>,
    );
  });

  pages.get('/auth/callback', async (c) => {
    const { pool } = c.get('deps');
    const token = new URL(c.req.url).searchParams.get('token') ?? '';
    const consumed = await consumeMagicLink(pool, token);
    if (consumed === null) {
      return c.html(
        <Layout {...shell(c)} title="Sign in" noindex>
          <LoginPage error="That link has expired or has already been used. Ask for another." />
        </Layout>,
        400,
      );
    }

    const session = await createSession(pool, consumed.user.id, { label: 'browser' });
    setSessionCookie(c, session);
    return c.redirect(consumed.redirect ?? '/me', 303);
  });

  pages.post('/logout', async (c) => {
    const { pool } = c.get('deps');
    const cookie = c.req.header('cookie') ?? '';
    const token = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie)?.[1];
    if (token !== undefined) await revokeSession(pool, decodeURIComponent(token));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/', 303);
  });

  // --- device flow ------------------------------------------------------

  pages.get('/device', async (c) => {
    const { pool } = c.get('deps');
    const viewer = c.get('viewer');
    const code = (new URL(c.req.url).searchParams.get('code') ?? '').toUpperCase();
    const pending = code === '' ? null : await findDeviceCode(pool, code);
    return c.html(
      <Layout {...shell(c)} title="Approve a terminal" noindex>
        <DevicePage
          signedIn={viewer !== null}
          {...(code === '' ? {} : { code })}
          {...(pending === null ? {} : { label: pending.label })}
        />
      </Layout>,
    );
  });

  pages.post('/device', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const form = await formOf(c);
    const approved = await approveDeviceCode(pool, form['userCode'] ?? '', viewer.id);
    return c.html(
      <Layout {...shell(c)} title="Approve a terminal" noindex>
        <DevicePage
          signedIn
          done={approved}
          {...(approved ? {} : { error: 'That code is unknown or has expired. Ask the terminal for a new one.' })}
        />
      </Layout>,
      approved ? 200 : 400,
    );
  });

  // --- you --------------------------------------------------------------

  pages.get('/me', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;

    const orgs = await listOrgsForUser(pool, viewer.id);
    // Queried per employer rather than fetched board-wide and filtered here.
    // The board-wide version read every other employer's unpublished drafts
    // into this process and relied on a JS filter to keep them off the page,
    // which is one refactor away from being a leak.
    const pages = await Promise.all(
      orgs.map((org) =>
        searchJobs(
          pool,
          { ...parseQuery(new URLSearchParams()), org: org.slug, limit: 50 },
          { includeUnpublished: true },
        ),
      ),
    );
    const mine = pages.flatMap((page) => page.items);
    const applications = await pool.query<{
      job_title: string;
      job_slug: string;
      status: string;
      created_at: string;
    }>(
      `select j.title as job_title, j.slug as job_slug, a.status, a.created_at
         from applications a join jobs j on j.id = a.job_id
        where a.user_id = $1 order by a.created_at desc limit 50`,
      [viewer.id],
    );

    const [candidateSlug, updates, following] = await Promise.all([
      candidateSlugFor(pool, viewer.id),
      listUpdatesFor(pool, { kind: 'candidate', userId: viewer.id }),
      listFollowing(pool, viewer.id),
    ]);

    return c.html(
      <Layout {...shell(c)} title="You" noindex>
        <MePage
          viewer={viewer}
          orgs={orgs}
          jobs={mine}
          resumes={await listResumes(pool, viewer.id)}
          applications={applications.rows.map((row) => ({
            jobTitle: row.job_title,
            jobSlug: row.job_slug,
            status: row.status,
            createdAt: row.created_at,
          }))}
          updates={updates}
          following={following}
          candidateSlug={candidateSlug}
          updateMax={BODY_MAX}
        />
      </Layout>,
    );
  });

  pages.get('/me/resumes/new', (c) => {
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    return c.html(
      <Layout {...shell(c)} title="New resume" noindex>
        <ResumeEditor resume={null} html="" warnings={[]} />
      </Layout>,
    );
  });

  pages.post('/me/resumes/new', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const form = await formOf(c);
    const markdown = (form['markdown'] ?? '').trim();
    const visibility = form['visibility'];
    const resume = await createResume(pool, viewer.id, {
      markdown: markdown === '' ? resumeTemplate(viewer.name ?? 'Your Name') : markdown,
      ...(form['title'] === undefined ? {} : { title: form['title'] }),
      ...(isVisibility(visibility) ? { visibility } : {}),
    });
    return c.redirect(`/me/resumes/${resume.slug}?saved=1`, 303);
  });

  pages.post('/me/resumes/import', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;

    let file: File | null = null;
    try {
      const body = await c.req.parseBody();
      if (body['file'] instanceof File) file = body['file'];
    } catch {
      file = null;
    }
    const fail = (message: string): Html =>
      c.html(
        <Layout {...shell(c)} title="New resume" noindex>
          <ResumeEditor resume={null} html="" warnings={[]} error={message} />
        </Layout>,
        400,
      );
    if (file === null) return fail('Choose a file first.');

    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const imported = await importDocument(file.name, bytes, file.type);
      const resume = await createResume(pool, viewer.id, {
        markdown: imported.markdown,
        source: { name: file.name, mime: file.type || 'application/octet-stream', bytes },
      });
      return c.redirect(`/me/resumes/${resume.slug}?imported=${imported.via}`, 303);
    } catch (error) {
      if (error instanceof ImportProblem) return fail(error.message);
      throw error;
    }
  });

  pages.get('/me/resumes/:slug', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const resume = await getResume(pool, viewer.id, c.req.param('slug'));
    if (resume === null) return c.notFound();

    const params = new URL(c.req.url).searchParams;
    const parsed = parseResume(resume.markdown);
    const warnings = [...parsed.warnings];
    const imported = params.get('imported');
    if (imported !== null) {
      warnings.unshift(
        `Converted from your ${imported === 'pdf' ? 'PDF' : imported} upload. Check it before you use it.`,
      );
    }

    return c.html(
      <Layout {...shell(c)} title={resume.title} noindex>
        <ResumeEditor
          resume={resume}
          html={renderMarkdown(resume.markdown, { headingOffset: 1, noImages: true })}
          warnings={warnings}
          saved={params.get('saved') === '1'}
        />
      </Layout>,
    );
  });

  pages.post('/me/resumes/:slug', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const form = await formOf(c);
    const visibility = form['visibility'];
    const updated = await updateResume(pool, viewer.id, c.req.param('slug'), {
      markdown: form['markdown'] ?? '',
      ...(form['title'] === undefined ? {} : { title: form['title'] }),
      ...(isVisibility(visibility) ? { visibility } : {}),
    });
    if (updated === null) return c.notFound();
    // Choosing "public" or "anyone with the link" is what mints the board-wide
    // address. Doing it here rather than in the update keeps a private resume
    // from claiming a name in a namespace everyone shares.
    await ensurePublicSlug(pool, updated);
    return c.redirect(`/me/resumes/${updated.slug}?saved=1`, 303);
  });

  pages.post('/me/resumes/:slug/delete', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    await deleteResume(pool, viewer.id, c.req.param('slug'));
    return c.redirect('/me', 303);
  });

  pages.get('/me/employers/new', (c) => {
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    return c.html(
      <Layout {...shell(c)} title="Add an employer" noindex>
        <NewEmployerPage />
      </Layout>,
    );
  });

  pages.post('/me/employers/new', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const form = await formOf(c);
    const created = await createOrg(pool, viewer.id, {
      name: form['name'] ?? '',
      website: form['website'] ?? null,
      description: form['description'] ?? null,
    });
    if (typeof created === 'string') {
      return c.html(
        <Layout {...shell(c)} title="Add an employer" noindex>
          <NewEmployerPage error={created} />
        </Layout>,
        400,
      );
    }
    return c.redirect('/post', 303);
  });

  // --- posting ----------------------------------------------------------

  pages.get('/post', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    return c.html(
      <Layout {...shell(c)} title="Post a job" noindex>
        <PostJobPage orgs={await listOrgsForUser(pool, viewer.id)} />
      </Layout>,
    );
  });

  pages.post('/post', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;

    const form = await formOf(c);
    const orgs = await listOrgsForUser(pool, viewer.id);
    const org = orgs.find((candidate) => candidate.slug === form['org']);
    const fail = (message: string): Html =>
      c.html(
        <Layout {...shell(c)} title="Post a job" noindex>
          <PostJobPage orgs={orgs} error={message} values={form} />
        </Layout>,
        400,
      );

    if (org === undefined) return fail('Choose which employer this is for.');
    const input = normaliseInput(form, org.id);
    if (typeof input === 'string') return fail(input);

    const job = await createJob(pool, input);
    return c.redirect(`/me/jobs/${job.slug}`, 303);
  });

  pages.get('/me/jobs/:slug', async (c) => {
    const { pool, config } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;

    const job = await getJobBySlug(pool, c.req.param('slug'), { includeUnpublished: true });
    if (job === null) return c.notFound();
    if (!(await isMember(pool, viewer.id, job.org.id))) return c.notFound();

    const applications = await listApplications(pool, job.id);
    const detailed = await Promise.all(
      applications.map(async (application) => {
        const row = await pool.query<{ resume_markdown: string | null; resume_title: string | null }>(
          `select resume_markdown, resume_title from applications where id = $1`,
          [application.id],
        );
        const markdown = row.rows[0]?.resume_markdown ?? null;
        return {
          ...application,
          resume: markdown === null ? null : renderMarkdown(markdown, { headingOffset: 3, noImages: true }),
          resumeTitle: row.rows[0]?.resume_title ?? null,
        };
      }),
    );

    return c.html(
      <Layout {...shell(c)} title={job.title} noindex>
        <ManageJobPage
          job={job}
          html={renderMarkdown(job.description, { headingOffset: 2 })}
          applications={detailed}
          publicUrl={config.publicUrl}
        />
      </Layout>,
    );
  });

  pages.post('/me/jobs/:slug/:action{publish|close}', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const job = await getJobBySlug(pool, c.req.param('slug'), { includeUnpublished: true });
    if (job === null) return c.notFound();
    if (!(await isMember(pool, viewer.id, job.org.id))) return c.notFound();
    await setStatus(pool, job.id, c.req.param('action') === 'close' ? 'closed' : 'published');
    return c.redirect(`/me/jobs/${job.slug}`, 303);
  });

  // --- the network ------------------------------------------------------

  pages.get('/network', async (c) => {
    const { pool, config } = c.get('deps');
    if (!config.isDirectory) return c.notFound();
    const topic = new URL(c.req.url).searchParams.get('topic');
    return c.html(
      <Layout
        {...shell(c)}
        title="The network"
        description="Every agenticjobs board that has announced itself here."
      >
        <NetworkPage
          instances={await listInstances(pool, { topic, limit: 200 })}
          topics={await listTopics(pool)}
          publicUrl={config.publicUrl}
          boardName={config.boardName}
        />
      </Layout>,
    );
  });

  pages.get('/network/search', async (c) => {
    const { pool, config } = c.get('deps');
    if (!config.isDirectory) return c.notFound();
    const query = parseQuery(new URL(c.req.url).searchParams);
    const instances = await listInstances(pool, { onlineOnly: true, limit: 40 });
    const result = await federatedSearch(
      targetsFromDescriptors(instances.map((instance) => instance.descriptor)),
      query,
    );
    return c.html(
      <Layout {...shell(c)} title="Search the network">
        <NetworkSearchPage result={result} query={query} />
      </Layout>,
    );
  });

  // --- docs -------------------------------------------------------------

  pages.get('/docs', (c) => {
    const { config } = c.get('deps');
    return c.html(
      <Layout
        {...shell(c)}
        title="For agents"
        description="How to search, read and apply on this board over HTTP, MCP or a terminal."
      >
        <DocsPage
          publicUrl={config.publicUrl}
          boardName={config.boardName}
          isDirectory={config.isDirectory}
        />
      </Layout>,
    );
  });

  pages.get('/docs/:name{openresume|openjob}', async (c) => {
    const name = c.req.param('name');
    const spec = await readSpec(name);
    if (spec === null) return c.notFound();
    return c.html(
      <Layout {...shell(c)} title={spec.title} description={spec.summary}>
        <SpecPage title={spec.title} html={spec.html} />
      </Layout>,
    );
  });

  return pages;
}

function setSessionCookie(c: Ctx, token: string): void {
  const { config } = c.get('deps');
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    // Lax rather than Strict: Strict means arriving from the magic link in a
    // mail client does not carry the cookie, so the person lands signed out.
    sameSite: 'Lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: 30 * 24 * 60 * 60,
  });
}
