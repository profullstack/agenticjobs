/**
 * The REST API.
 *
 * Every other surface is a client of this: the CLI, the TUI, the desktop app,
 * the MCP tools and one instance searching another. The HTML pages are the one
 * exception, and only because they render server-side from the same core
 * functions rather than from a second set of queries.
 *
 * Two rules hold throughout:
 *
 *  1. An error is an object with a message a person could act on, not a status
 *     code and an empty body. Half the callers here are models.
 *  2. Reads are public unless the data belongs to someone. A job board whose
 *     listings need a key is a job board nobody's agent will ever read.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  approveDeviceCode,
  createSession,
  ensureUser,
  normaliseEmail,
  pollDeviceAuth,
  requireAdmin,
  safeRedirect,
  startDeviceAuth,
  startMagicLink,
  type Viewer,
} from '../../core/auth.ts';
import {
  createApplication,
  listApplications,
  listDraftApplications,
  recentApplicationCount,
  submitApplication,
  validateApplication,
} from '../../core/applications.ts';
import {
  countJobs,
  createJob,
  getJobBySlug,
  getJobBySourceUrl,
  normaliseInput,
  searchJobs,
  setStatus,
  updateJobFromImport,
} from '../../core/jobs.ts';
import { extractJob, JobImportProblem, type ImportedJob } from '../../core/import-job.ts';
import { createOrg, getOrgBySlug, isMember, listOrgs, listOrgsForUser } from '../../core/orgs.ts';
import {
  createResume,
  deleteResume,
  getResume,
  getResumeById,
  getSharedResume,
  isVisibility,
  listResumes,
  updateResume,
} from '../../core/resumes.ts';
import { importDocument, ImportProblem, MAX_UPLOAD_BYTES } from '../../core/import.ts';
import { deliverMagicLink } from '../../core/mail.ts';
import { sameOrigin } from '../../config.ts';
import { announce, Blocked, listInstances, listTopics } from '../../directory/registry.ts';
import { federatedSearch, targetsFromDescriptors } from '../../directory/federate.ts';
import { FetchProblem, fetchText } from '../../directory/fetch.ts';
import { parseQuery } from '../../schema/query.ts';
import { jobPostingJsonLd } from '../../schema/jsonld.ts';
import { parseResume } from '../../markup/resume.ts';
import { renderMarkdown } from '../../markup/markdown.ts';
import { descriptorFor } from './descriptor.ts';
import { openApiDocument } from './openapi.ts';
import type { AppEnv } from '../deps.ts';

type Ctx = Context<AppEnv>;

interface ApiError {
  error: { message: string; code: string; fields?: { field: string; message: string }[] };
}

function fail(
  c: Ctx,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502,
  code: string,
  message: string,
  fields?: { field: string; message: string }[],
): Response {
  const body: ApiError = { error: { message, code, ...(fields === undefined ? {} : { fields }) } };
  return c.json(body, status);
}

function viewerOf(c: Ctx): Viewer | null {
  return c.get('viewer');
}

/** Body from JSON or a form, so curl, a browser and a model all work. */
async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const parsed = (await c.req.json()) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    }
    const form = await c.req.parseBody({ all: true });
    return form as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function apiRoutes(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  // --- jobs -------------------------------------------------------------

  api.get('/jobs', async (c) => {
    const { pool } = c.get('deps');
    const query = parseQuery(new URL(c.req.url).searchParams);
    const page = await searchJobs(pool, query);
    return c.json({ ...page, query });
  });

  api.get('/jobs/:slug', async (c) => {
    const { pool, config } = c.get('deps');
    const job = await getJobBySlug(pool, c.req.param('slug'));
    if (job === null) return fail(c, 404, 'not_found', 'No such job, or it is not published.');
    return c.json({
      job,
      html: renderMarkdown(job.description, { headingOffset: 2 }),
      jsonld: jobPostingJsonLd(job, config.publicUrl),
    });
  });

  /**
   * The application form, as data.
   *
   * This is the endpoint that makes the board agentic: an agent reads the
   * fields it has to fill in and the address to post them to, and never has to
   * render a page or guess a form encoding.
   */
  api.get('/jobs/:slug/apply-schema', async (c) => {
    const { pool, config } = c.get('deps');
    const job = await getJobBySlug(pool, c.req.param('slug'));
    if (job === null) return fail(c, 404, 'not_found', 'No such job, or it is not published.');
    // No offsite branch any more: every listing is applied to here, so an
    // agent reading this endpoint always gets a schema it can complete.
    return c.json({
      via: 'board',
      endpoint: `${config.publicUrl}/api/v1/jobs/${job.slug}/apply`,
      method: 'POST',
      agentPolicy: job.agentPolicy,
      schema: job.apply.schema,
      resume: {
        format: 'openresume.md',
        accepts: 'markdown',
        field: 'resume',
        spec: `${config.publicUrl}/docs/openresume`,
      },
      disclosure: {
        field: 'agent',
        shape: { name: 'string', supervised: 'boolean' },
        required: job.agentPolicy === 'disclose',
        note:
          job.agentPolicy === 'human-only'
            ? 'This employer asks for applications written by a person.'
            : 'Say which agent wrote this, if one did.',
      },
    });
  });

  api.post('/jobs/:slug/apply', async (c) => {
    const { pool } = c.get('deps');
    const job = await getJobBySlug(pool, c.req.param('slug'));
    if (job === null) return fail(c, 404, 'not_found', 'No such job, or it is not published.');
    const body = await readBody(c);
    const validated = validateApplication(job.apply.schema, body, job.agentPolicy);
    if (!validated.ok) {
      return fail(c, 400, 'invalid', 'Some answers need fixing.', validated.problems);
    }

    const email = validated.value.answers['email'] ?? '';
    if (email !== '') {
      const recent = await recentApplicationCount(pool, email);
      if (recent >= 20) {
        return fail(
          c,
          429,
          'rate_limited',
          'That address has sent a lot of applications in the last hour. Try again later.',
        );
      }
    }

    const viewer = viewerOf(c);
    const resolved = await resolveResume(c, body, viewer);
    // `typeof null` is 'object', so the error case is checked by shape and not
    // by typeof alone.
    if (resolved !== null && typeof resolved === 'object') {
      return fail(c, 400, 'invalid_resume', resolved.error);
    }
    const resumeMarkdown: string | null = resolved;

    // `submit: false` holds it as a draft for a person to release. This is the
    // candidate's half of the same seam an employer has with job drafts: an
    // agent can do the work, a person decides it goes out.
    const submit = body['submit'] !== false && body['submit'] !== 'false';
    if (!submit && viewer === null) {
      return fail(
        c,
        401,
        'unauthenticated',
        'Holding an application as a draft needs an account, otherwise nobody could come back to release it.',
      );
    }

    const application = await createApplication(pool, job.id, validated.value, { submit });
    if (resumeMarkdown !== null || viewer !== null) {
      await pool.query(
        `update applications set resume_markdown = $2, resume_title = $3, user_id = $4
          where id = $1`,
        [
          application.id,
          resumeMarkdown,
          resumeMarkdown === null ? null : (parseResume(resumeMarkdown).name ?? 'Resume'),
          viewer?.id ?? null,
        ],
      );
    }

    return c.json(
      {
        ok: true,
        applicationId: application.id,
        job: job.slug,
        status: application.status,
        submitted: submit,
        ...(submit
          ? {}
          : {
              message:
                'Held as a draft. Nobody at the employer can see it until it is submitted.',
              submitWith: `POST /api/v1/applications/${application.id}/submit`,
            }),
      },
      201,
    );
  });

  api.post('/jobs', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to post a job.');

    const body = await readBody(c);
    const orgSlug = typeof body['org'] === 'string' ? body['org'] : '';
    const org = orgSlug === '' ? null : await getOrgBySlug(pool, orgSlug);
    if (org === null) {
      return fail(c, 400, 'no_org', 'Name the employer to post under, as "org": "<slug>".');
    }
    if (!(await isMember(pool, viewer.id, org.id))) {
      return fail(c, 403, 'not_a_member', `You are not a member of ${org.name}.`);
    }

    const input = normaliseInput(body, org.id);
    if (typeof input === 'string') return fail(c, 400, 'invalid', input);

    const job = await createJob(pool, input);
    // A job posted through the API arrives as a draft like any other, unless
    // the caller asked for it to go live. An agent that posts a job the author
    // has not read is the failure mode worth designing against.
    if (body['publish'] === true || body['publish'] === 'true') {
      const published = await setStatus(pool, job.id, 'published');
      return c.json({ job: published ?? job }, 201);
    }
    return c.json({ job }, 201);
  });

  /**
   * Import a job from a URL, or refresh one already imported.
   *
   * The only thing a URL is for on this board. It reads the page, takes the
   * JobPosting data if the page publishes any and the readable text if it does
   * not, and leaves the result as a DRAFT for a person to check. Extraction
   * from a page nobody designed for it is approximate, and a board whose pitch
   * is that nothing is scraped cannot publish a scrape unread.
   *
   * Posting the same URL twice refreshes the listing that came from it rather
   * than making a second one, so this is both `new` and `update`.
   */
  api.post('/jobs/import', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to import a job.');

    const body = await readBody(c);
    const url = typeof body['url'] === 'string' ? body['url'].trim() : '';
    if (url === '') return fail(c, 400, 'invalid', 'Which URL? Send "url": "https://...".');

    let imported: ImportedJob;
    try {
      imported = extractJob(await fetchText(url, { maxBytes: 2 * 1024 * 1024 }), url);
    } catch (error) {
      if (error instanceof JobImportProblem) return fail(c, 400, 'import_failed', error.message);
      if (error instanceof FetchProblem) return fail(c, 400, 'unreachable', error.message);
      throw error;
    }

    // A URL that was imported before updates that listing. Doing otherwise
    // would leave two copies of one job on a board that claims each listing is
    // a real distinct opening.
    const existing = await getJobBySourceUrl(pool, url);
    if (existing !== null) {
      if (!(await isMember(pool, viewer.id, existing.org.id))) {
        return fail(c, 403, 'not_a_member', `That listing belongs to ${existing.org.name}.`);
      }
      const updated = await updateJobFromImport(pool, existing.id, {
        title: imported.title,
        description: imported.description,
        sourceUrl: url,
        ...(imported.employmentType === undefined ? {} : { employmentType: imported.employmentType }),
        ...(imported.workplace === undefined ? {} : { workplace: imported.workplace }),
        ...(imported.location === undefined ? {} : { location: imported.location }),
      });
      return c.json({ job: updated ?? existing, via: imported.via, warnings: imported.warnings, created: false });
    }

    const orgSlug = typeof body['org'] === 'string' ? body['org'] : '';
    const org = orgSlug === '' ? null : await getOrgBySlug(pool, orgSlug);
    if (org === null) {
      return fail(c, 400, 'no_org', 'Name the employer to import under, as "org": "<slug>".');
    }
    if (!(await isMember(pool, viewer.id, org.id))) {
      return fail(c, 403, 'not_a_member', `You are not a member of ${org.name}.`);
    }

    const input = normaliseInput(
      {
        title: imported.title,
        description: imported.description,
        agentPolicy: typeof body['agentPolicy'] === 'string' ? body['agentPolicy'] : 'welcome',
        ...(imported.employmentType === undefined ? {} : { employmentType: imported.employmentType }),
        ...(imported.workplace === undefined ? {} : { workplace: imported.workplace }),
        ...(imported.location === undefined ? {} : { location: imported.location }),
      },
      org.id,
    );
    if (typeof input === 'string') return fail(c, 400, 'invalid', input);

    const job = await createJob(pool, { ...input, sourceUrl: url });
    return c.json({ job, via: imported.via, warnings: imported.warnings, created: true }, 201);
  });

  api.post('/jobs/:slug/:action{publish|close|reopen}', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');

    const job = await getJobBySlug(pool, c.req.param('slug'), { includeUnpublished: true });
    if (job === null) return fail(c, 404, 'not_found', 'No such job.');
    if (!(await isMember(pool, viewer.id, job.org.id))) {
      return fail(c, 403, 'not_a_member', `You are not a member of ${job.org.name}.`);
    }

    const action = c.req.param('action');
    const status = action === 'close' ? 'closed' : 'published';
    const updated = await setStatus(pool, job.id, status);
    return c.json({ job: updated });
  });

  api.get('/jobs/:slug/applications', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');

    const job = await getJobBySlug(pool, c.req.param('slug'), { includeUnpublished: true });
    if (job === null) return fail(c, 404, 'not_found', 'No such job.');
    if (!(await isMember(pool, viewer.id, job.org.id))) {
      return fail(c, 403, 'not_a_member', `You are not a member of ${job.org.name}.`);
    }

    const applications = await listApplications(pool, job.id);
    const withResumes = await Promise.all(
      applications.map(async (application) => {
        const row = await pool.query<{ resume_markdown: string | null; resume_title: string | null }>(
          `select resume_markdown, resume_title from applications where id = $1`,
          [application.id],
        );
        return {
          ...application,
          resume: row.rows[0]?.resume_markdown ?? null,
          resumeTitle: row.rows[0]?.resume_title ?? null,
        };
      }),
    );
    return c.json({ job: job.slug, items: withResumes, total: withResumes.length });
  });

  /**
   * Applications you have prepared but not sent.
   *
   * The review step for a candidate, reachable from a browser, the CLI, the
   * TUI or a tool call - it is the same endpoint for all of them.
   */
  api.get('/applications/drafts', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const items = await listDraftApplications(pool, viewer.id);
    return c.json({ items, total: items.length });
  });

  api.post('/applications/:id/submit', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const sent = await submitApplication(pool, c.req.param('id'), viewer.id);
    if (!sent) {
      return fail(
        c,
        404,
        'not_found',
        'No draft of yours with that id. It may already have been sent.',
      );
    }
    return c.json({ ok: true, submitted: true });
  });

  // --- employers --------------------------------------------------------

  api.get('/orgs', async (c) => {
    const { pool } = c.get('deps');
    return c.json({ items: await listOrgs(pool) });
  });

  api.get('/orgs/:slug', async (c) => {
    const { pool } = c.get('deps');
    const org = await getOrgBySlug(pool, c.req.param('slug'));
    if (org === null) return fail(c, 404, 'not_found', 'No such employer.');
    const query = parseQuery(new URLSearchParams({ org: org.slug }));
    const jobs = await searchJobs(pool, query);
    return c.json({ org, jobs });
  });

  api.post('/orgs', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to add an employer.');
    const body = await readBody(c);
    const created = await createOrg(pool, viewer.id, {
      name: typeof body['name'] === 'string' ? body['name'] : '',
      website: typeof body['website'] === 'string' ? body['website'] : null,
      description: typeof body['description'] === 'string' ? body['description'] : null,
      logoUrl: typeof body['logoUrl'] === 'string' ? body['logoUrl'] : null,
    });
    if (typeof created === 'string') return fail(c, 400, 'invalid', created);
    return c.json({ org: created }, 201);
  });

  // --- me and resumes ---------------------------------------------------

  api.get('/me', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'No token, or it has expired.');
    return c.json({
      user: {
        id: viewer.id,
        email: viewer.email,
        name: viewer.name,
        isAdmin: viewer.isAdmin,
        viaToken: viewer.viaToken,
      },
      orgs: await listOrgsForUser(pool, viewer.id),
      resumes: (await listResumes(pool, viewer.id)).map((resume) => ({
        slug: resume.slug,
        title: resume.title,
        visibility: resume.visibility,
        updatedAt: resume.updatedAt,
      })),
    });
  });

  api.get('/resumes', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    return c.json({ items: await listResumes(pool, viewer.id) });
  });

  api.get('/resumes/:slug', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const resume = await getResume(pool, viewer.id, c.req.param('slug'));
    if (resume === null) return fail(c, 404, 'not_found', 'No such resume.');
    return c.json({ resume, html: renderMarkdown(resume.markdown, { headingOffset: 1, noImages: true }) });
  });

  api.post('/resumes', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const body = await readBody(c);
    const markdown = typeof body['markdown'] === 'string' ? body['markdown'] : '';
    if (markdown.trim() === '') {
      return fail(c, 400, 'invalid', 'Send the resume as Markdown in a "markdown" field.');
    }
    const visibility = body['visibility'];
    const resume = await createResume(pool, viewer.id, {
      markdown,
      ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
      ...(isVisibility(visibility) ? { visibility } : {}),
    });
    return c.json({ resume }, 201);
  });

  api.patch('/resumes/:slug', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const body = await readBody(c);
    const existing = await getResume(pool, viewer.id, c.req.param('slug'));
    if (existing === null) return fail(c, 404, 'not_found', 'No such resume.');
    const visibility = body['visibility'];
    const resume = await updateResume(pool, viewer.id, c.req.param('slug'), {
      markdown: typeof body['markdown'] === 'string' ? body['markdown'] : existing.markdown,
      ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
      ...(isVisibility(visibility) ? { visibility } : {}),
    });
    return c.json({ resume });
  });

  api.delete('/resumes/:slug', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const removed = await deleteResume(pool, viewer.id, c.req.param('slug'));
    if (!removed) return fail(c, 404, 'not_found', 'No such resume.');
    return c.json({ ok: true });
  });

  /**
   * Upload a document and get Markdown back.
   *
   * The result is stored as a resume the candidate can then edit, because a
   * conversion nobody checks is a conversion nobody trusts.
   */
  api.post('/resumes/import', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');

    let file: File | null = null;
    try {
      const form = await c.req.parseBody();
      const candidate = form['file'];
      if (candidate instanceof File) file = candidate;
    } catch {
      file = null;
    }
    if (file === null) return fail(c, 400, 'no_file', 'Attach the document as a "file" field.');
    if (file.size > MAX_UPLOAD_BYTES) {
      return fail(c, 413, 'too_large', `The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const imported = await importDocument(file.name, bytes, file.type);
      const resume = await createResume(pool, viewer.id, {
        markdown: imported.markdown,
        source: { name: file.name, mime: file.type || 'application/octet-stream', bytes },
      });
      return c.json({ resume, via: imported.via, warnings: imported.warnings }, 201);
    } catch (error) {
      if (error instanceof ImportProblem) return fail(c, 400, 'import_failed', error.message);
      throw error;
    }
  });

  // --- sign in ----------------------------------------------------------

  api.post('/auth/magic-link', async (c) => {
    const { pool, config, mailer } = c.get('deps');
    const body = await readBody(c);
    const email = normaliseEmail(body['email']);
    if (email === null) return fail(c, 400, 'invalid', 'That is not an email address.');
    // A terminal signing up asks for the link to land on /device with its code
    // already filled in, so one click both creates the account and approves the
    // terminal. safeRedirect keeps this to same-origin paths: an open redirect
    // on a sign-in link is a phish.
    const redirect = safeRedirect(body['redirect']);
    const link = await startMagicLink(pool, email, redirect);
    const url = `${config.publicUrl}/auth/callback?token=${link.token}`;
    const delivered = await deliverMagicLink({
      mailer,
      boardName: config.boardName,
      email,
      url,
      redirect,
    });
    return c.json({ ok: true, expiresAt: link.expiresAt, delivered });
  });

  api.post('/auth/device', async (c) => {
    const { pool, config } = c.get('deps');
    const body = await readBody(c);
    const label = typeof body['label'] === 'string' ? body['label'] : 'terminal';
    const grant = await startDeviceAuth(pool, label, config.publicUrl);
    return c.json(grant);
  });

  api.post('/auth/device/poll', async (c) => {
    const { pool } = c.get('deps');
    const body = await readBody(c);
    const deviceCode = typeof body['deviceCode'] === 'string' ? body['deviceCode'] : '';
    if (deviceCode === '') return fail(c, 400, 'invalid', 'Send the deviceCode you were given.');
    return c.json(await pollDeviceAuth(pool, deviceCode));
  });

  api.post('/auth/device/approve', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const body = await readBody(c);
    const code = typeof body['userCode'] === 'string' ? body['userCode'] : '';
    const approved = await approveDeviceCode(pool, code, viewer.id);
    if (!approved) return fail(c, 404, 'no_such_code', 'That code is unknown or has expired.');
    return c.json({ ok: true });
  });

  // --- federation -------------------------------------------------------

  api.get('/directory/instances', async (c) => {
    const { pool, config } = c.get('deps');
    if (!config.isDirectory) return fail(c, 404, 'not_a_directory', 'This instance is not a directory.');
    const params = new URL(c.req.url).searchParams;
    const items = await listInstances(pool, {
      topic: params.get('topic'),
      q: params.get('q'),
      onlineOnly: params.get('online') === 'true',
      limit: Number(params.get('limit') ?? '100'),
    });
    return c.json({ items, total: items.length });
  });

  api.get('/directory/topics', async (c) => {
    const { pool, config } = c.get('deps');
    if (!config.isDirectory) return fail(c, 404, 'not_a_directory', 'This instance is not a directory.');
    return c.json({ items: await listTopics(pool) });
  });

  api.post('/directory/announce', async (c) => {
    const { pool, config } = c.get('deps');
    if (!config.isDirectory) {
      return fail(c, 404, 'not_a_directory', 'This instance is not a directory.');
    }
    const body = await readBody(c);
    const url = typeof body['url'] === 'string' ? body['url'] : '';
    // A directory does not list itself. Refused here rather than only at the
    // announcing end, because anyone may POST any URL: without this, a third
    // party could put this board into its own listing by announcing on its
    // behalf.
    if (sameOrigin(url, config.publicUrl)) {
      return fail(c, 400, 'self', 'A board is not listed in its own directory.');
    }
    try {
      const listing = await announce(pool, url);
      return c.json({ ok: true, instance: listing });
    } catch (error) {
      if (error instanceof Blocked) return fail(c, 403, 'blocked', error.message);
      if (error instanceof FetchProblem) {
        // The instance is the one that has to fix this, so say what we saw.
        return fail(c, 400, 'unreachable', error.message);
      }
      throw error;
    }
  });

  /** One question, every instance the directory knows about. */
  api.get('/directory/search', async (c) => {
    const { pool, config } = c.get('deps');
    if (!config.isDirectory) return fail(c, 404, 'not_a_directory', 'This instance is not a directory.');
    const params = new URL(c.req.url).searchParams;
    const query = parseQuery(params);
    const instances = await listInstances(pool, { onlineOnly: true, limit: 40 });
    const result = await federatedSearch(
      targetsFromDescriptors(instances.map((instance) => instance.descriptor)),
      query,
    );
    return c.json(result);
  });

  // --- this instance ----------------------------------------------------

  api.get('/openapi.json', (c) => {
    const { config } = c.get('deps');
    return c.json(openApiDocument(config));
  });

  api.get('/stats', async (c) => {
    const { pool, config } = c.get('deps');
    return c.json({
      board: config.boardName,
      url: config.publicUrl,
      jobs: await countJobs(pool),
      directory: config.isDirectory,
    });
  });

  api.get('/descriptor', async (c) => {
    const { pool, config } = c.get('deps');
    return c.json(await descriptorFor(pool, config));
  });

  api.all('*', (c) => fail(c, 404, 'not_found', `No API route for ${c.req.path}.`));

  return api;
}

/**
 * Which resume an application carries.
 *
 * Three ways in, because three kinds of caller apply: a person picks one they
 * have saved, an agent posts Markdown inline, and a stranger with no account
 * pastes it into the form. All three end up as Markdown copied onto the
 * application.
 */
async function resolveResume(
  c: Ctx,
  body: Record<string, unknown>,
  viewer: Viewer | null,
): Promise<string | null | { error: string }> {
  const { pool } = c.get('deps');

  const inline = body['resume'];
  if (typeof inline === 'string' && inline.trim() !== '') {
    if (inline.length > 200_000) return { error: 'That resume is too long.' };
    return inline;
  }

  const slug = body['resumeSlug'];
  if (typeof slug === 'string' && slug !== '') {
    if (viewer === null) return { error: 'Sign in to send a resume you have saved.' };
    const resume = await getResume(pool, viewer.id, slug);
    if (resume === null) return { error: `You have no resume called "${slug}".` };
    return resume.markdown;
  }

  const id = body['resumeId'];
  if (typeof id === 'string' && id !== '') {
    // A shared id is accepted from anyone, which is what a share link is for;
    // a private one only from its owner.
    const shared = await getSharedResume(pool, id);
    if (shared !== null) return shared.markdown;
    if (viewer !== null) {
      const owned = await getResumeById(pool, id);
      if (owned !== null && owned.userId === viewer.id) return owned.markdown;
    }
    return { error: 'That resume is not shared, or does not exist.' };
  }

  return null;
}

export { requireAdmin };
