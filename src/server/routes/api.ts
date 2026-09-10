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
  decideApplication,
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
  publishProblem,
  searchJobs,
  setStatus,
  editJob,
  updateJobFromImport,
} from '../../core/jobs.ts';
import { extractJob, JobImportProblem, type ImportedJob } from '../../core/import-job.ts';
import {
  createOrg,
  deleteOrg,
  getOrgBySlug,
  isMember,
  listOrgs,
  listOrgsForUser,
  updateOrg,
} from '../../core/orgs.ts';
import {
  createResume,
  deleteResume,
  getPublicResume,
  getResume,
  listPublicResumes,
  getResumeById,
  getSharedResume,
  isVisibility,
  listResumes,
  updateResume,
} from '../../core/resumes.ts';
import { importDocument, ImportProblem, MAX_UPLOAD_BYTES } from '../../core/import.ts';
import { deliverMagicLink } from '../../core/mail.ts';
import {
  resumeForViewer,
  tagsFrom,
  toCandidateSummary,
  withTags,
} from '../../core/candidates.ts';
import {
  candidateSlugFor,
  deleteUpdate,
  follow,
  followerCount,
  isFollowing,
  listFollowedUpdates,
  listFollowing,
  listScoped,
  postUpdate,
  scopeFrom,
  unfollow,
  userForCandidate,
  type Target,
  type Update,
} from '../../core/updates.ts';
import { sameOrigin } from '../../config.ts';
import { announce, Blocked, listInstances, listTopics } from '../../directory/registry.ts';
import { federatedSearch, targetsFromDescriptors } from '../../directory/federate.ts';
import { FetchProblem, fetchText } from '../../directory/fetch.ts';
import { parseQuery } from '../../schema/query.ts';
import type { Job } from '../../schema/job.ts';
import { APPLICATION_DECISIONS, isApplicationDecision } from '../../schema/job.ts';
import { jobPostingJsonLd } from '../../schema/jsonld.ts';
import { parseResume } from '../../markup/resume.ts';
import { renderMarkdown } from '../../markup/markdown.ts';
import {
  counterpartyFrom,
  getThread,
  listThreads,
  markRead,
  notifyParticipants,
  sendMessage,
  startThread,
} from '../../core/inbox.ts';
import {
  applyWebhook,
  cancelInvoice,
  getInvoice,
  listInvoicesFor,
  listInvoicesIn,
  requestPayment,
  sendInvoice,
  syncInvoice,
} from '../../core/invoices.ts';
import { disconnect, finishConnect, getAccount } from '../../core/coinpay.ts';
import { coinpayRedirectUri } from './pages.tsx';
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

/**
 * The pay fields of a PATCH, merged onto what the listing already says.
 *
 * Any pay field in the body replaces the whole of the pay: `pay` (lines, in
 * either form), the flat salary fields, `payMethod`, `unpaid`. A body with
 * none of them keeps the listing's pay as it is, so editing a description
 * does not quietly clear a rate.
 */
function payPatch(body: Record<string, unknown>, job: Job): Record<string, unknown> {
  const sent = (key: string): boolean => body[key] !== undefined && body[key] !== null;
  const hasLines =
    sent('pay') || sent('payLines') || sent('salaryMin') || sent('salaryMax') ||
    sent('salaryPeriod') || sent('salaryCurrency');
  const hasUnpaid = sent('salaryUnpaid') || sent('unpaid') || sent('payUnpaid');
  return {
    ...(hasLines
      ? {
          pay: body['pay'] ?? body['payLines'],
          salaryMin: body['salaryMin'],
          salaryMax: body['salaryMax'],
          salaryPeriod: body['salaryPeriod'],
          salaryCurrency: body['salaryCurrency'],
        }
      : { pay: { lines: job.pay.lines } }),
    salaryUnpaid: hasUnpaid
      ? (body['salaryUnpaid'] ?? body['unpaid'] ?? body['payUnpaid'])
      : hasLines
        ? false
        : job.pay.unpaid,
    payMethod: body['payMethod'] ?? body['paymentMethod'] ?? body['paymentCoin'] ?? job.pay.method,
    payEquity: body['payEquity'] ?? body['salaryEquity'] ?? body['equity'] ?? job.pay.equity,
  };
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

    // A job posted through the API arrives as a draft like any other, unless
    // the caller asked for it to go live. An agent that posts a job the author
    // has not read is the failure mode worth designing against.
    const publish = body['publish'] === true || body['publish'] === 'true';
    if (publish) {
      // Checked before the insert: a caller who asked for a live listing and
      // gets a 400 should not find a draft they did not ask for either.
      const problem = publishProblem(input);
      if (problem !== null) return fail(c, 400, 'pay_required', problem);
    }

    const job = await createJob(pool, input);
    if (publish) {
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

    // Which listing this is about is settled before anything is fetched, so a
    // bad slug costs no network request and answers with the actual problem
    // rather than whatever the page happened to do.
    //
    // A URL imported before refreshes the listing that came from it; importing
    // it again would leave two copies of one job on a board that claims each
    // listing is a distinct real opening. `slug` adopts a listing written by
    // hand into the importer, and is the only way an existing listing gets a
    // source URL: without it, a job posted before the importer existed can
    // never be refreshed from its page, only duplicated by it.
    const slug = typeof body['slug'] === 'string' ? body['slug'].trim() : '';
    const existing =
      slug === ''
        ? await getJobBySourceUrl(pool, url)
        : await getJobBySlug(pool, slug, { includeUnpublished: true });
    if (slug !== '' && existing === null) {
      return fail(c, 404, 'not_found', `No listing here has the slug ${slug}.`);
    }
    if (existing !== null && !(await isMember(pool, viewer.id, existing.org.id))) {
      return fail(c, 403, 'not_a_member', `That listing belongs to ${existing.org.name}.`);
    }

    let imported: ImportedJob;
    try {
      imported = extractJob(await fetchText(url, { maxBytes: 2 * 1024 * 1024 }), url);
    } catch (error) {
      if (error instanceof JobImportProblem) return fail(c, 400, 'import_failed', error.message);
      if (error instanceof FetchProblem) return fail(c, 400, 'unreachable', error.message);
      throw error;
    }

    if (existing !== null) {
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

  /**
   * Edit a listing.
   *
   * The board could create a job and publish it and close it, and could not
   * change a word of it. A typo in a published listing could only be fixed by
   * closing it and posting another one under a new URL, which breaks every
   * link to it.
   *
   * Only the fields that are sent are touched, so this is also what makes an
   * imported listing salvageable: an import off a page with no JobPosting data
   * is approximate, and someone has to be able to tidy the result.
   */
  api.patch('/jobs/:slug', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');

    const job = await getJobBySlug(pool, c.req.param('slug'), { includeUnpublished: true });
    if (job === null) return fail(c, 404, 'not_found', 'No such job.');
    if (!(await isMember(pool, viewer.id, job.org.id))) {
      return fail(c, 403, 'not_a_member', `That listing belongs to ${job.org.name}.`);
    }

    const body = await readBody(c);
    // Merged onto what the listing already says, then run through the same
    // normaliser a new job goes through, so an edit cannot put a listing into
    // a state a post could not have created.
    const merged = normaliseInput(
      {
        title: body['title'] ?? job.title,
        description: body['description'] ?? job.description,
        employmentType: body['employmentType'] ?? job.employmentType,
        workplace: body['workplace'] ?? job.workplace,
        seniority: body['seniority'] ?? job.seniority ?? undefined,
        location: body['location'] ?? job.location ?? undefined,
        tags: body['tags'] ?? job.tags,
        stack: body['stack'] ?? job.stack,
        requirements: body['requirements'] ?? job.requirements,
        responsibilities: body['responsibilities'] ?? job.responsibilities,
        agentPolicy: body['agentPolicy'] ?? job.agentPolicy,
        ...payPatch(body, job),
      },
      job.org.id,
    );
    if (typeof merged === 'string') return fail(c, 400, 'invalid', merged);

    // A live listing stays held to the publish rule: an edit that removes
    // the pay would leave it public without one.
    if (job.status === 'published') {
      const problem = publishProblem(merged);
      if (problem !== null) return fail(c, 400, 'pay_required', problem);
    }

    const updated = await editJob(pool, job.id, merged);
    return c.json({ job: updated ?? job });
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
    if (status === 'published') {
      // Pay is required to go live. The message says what to send, because
      // the caller is as likely to be an agent as a person.
      const problem = publishProblem(job);
      if (problem !== null) return fail(c, 400, 'pay_required', problem);
    }
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
   * Decide on one application.
   *
   * Addressed by application id rather than nested under the job, because a
   * decision is about the application and the caller already holds its id
   * from `GET /jobs/{slug}/applications`. Membership is enforced inside
   * `decideApplication`, so there is no ownership check to forget here.
   */
  api.post('/applications/:id/decision', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const status = (body as { status?: unknown }).status;
    if (!isApplicationDecision(status)) {
      return fail(c, 400, 'bad_status', `status must be one of ${APPLICATION_DECISIONS.join(', ')}.`);
    }

    const application = await decideApplication(pool, {
      id: c.req.param('id'),
      userId: viewer.id,
      status,
    });
    if (application === null) {
      return fail(c, 404, 'not_found', 'No such application on a listing you can act for.');
    }
    return c.json({ application });
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

  /**
   * Change an employer.
   *
   * Absent fields are left alone rather than cleared, so a caller that knows
   * about a name and nothing else cannot blank a website it never read. That
   * is also what makes this safe to call from a script that only ever sets
   * one thing.
   */
  api.patch('/orgs/:slug', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to edit an employer.');

    const org = await getOrgBySlug(pool, c.req.param('slug'));
    if (org === null) return fail(c, 404, 'not_found', 'No such employer.');
    if (!(await isMember(pool, viewer.id, org.id))) {
      return fail(c, 403, 'not_a_member', `You are not a member of ${org.name}.`);
    }

    const body = await readBody(c);
    const field = (key: string): string | null | undefined => {
      const value = body[key];
      if (value === undefined) return undefined;
      // An explicit null clears the field; a string sets it. Anything else is
      // not an answer, so it is treated as not having been sent.
      if (value === null) return null;
      return typeof value === 'string' ? value : undefined;
    };

    const updated = await updateOrg(pool, org.slug, {
      ...(field('name') === undefined ? {} : { name: field('name') ?? '' }),
      ...(field('website') === undefined ? {} : { website: field('website') }),
      ...(field('description') === undefined ? {} : { description: field('description') }),
      ...(field('logoUrl') === undefined ? {} : { logoUrl: field('logoUrl') }),
    });
    if (typeof updated === 'string') return fail(c, 400, 'invalid', updated);
    return c.json({ org: updated });
  });

  /**
   * Delete an employer that never published anything.
   *
   * The rule lives in the model rather than here, because it is a fact about
   * what deleting an organisation drags with it and not a fact about HTTP.
   */
  api.delete('/orgs/:slug', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to delete an employer.');

    const org = await getOrgBySlug(pool, c.req.param('slug'));
    if (org === null) return fail(c, 404, 'not_found', 'No such employer.');
    if (!(await isMember(pool, viewer.id, org.id))) {
      return fail(c, 403, 'not_a_member', `You are not a member of ${org.name}.`);
    }

    const removed = await deleteOrg(pool, org.id);
    if (typeof removed === 'string') return fail(c, 409, 'has_listings', removed);
    return c.json({ ok: true, deleted: org.slug });
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

  // --- candidates -------------------------------------------------------

  /**
   * The other half of the board, as data.
   *
   * Reads are public here for the same reason job reads are: a candidate
   * directory an agent needs a key for is one no agent will ever read. Only
   * resumes whose owner chose to be listed appear.
   */
  api.get('/candidates', async (c) => {
    const { pool, config } = c.get('deps');
    const tags = tagsFrom(new URL(c.req.url).searchParams);
    const resumes = await listPublicResumes(pool);
    const matched = withTags(resumes.map(toCandidateSummary), tags);
    return c.json({
      items: matched.map((summary) => ({
        ...summary,
        url: `${config.publicUrl}/candidates/${summary.slug}`,
        resume: `${config.publicUrl}/api/v1/candidates/${summary.slug}`,
      })),
      total: matched.length,
      // Said back so a caller can see the filter was understood, and told
      // plainly that several tags narrow rather than widen.
      ...(tags.length === 0 ? {} : { tags, match: 'all' }),
      spec: `${config.publicUrl}/docs/openresume`,
    });
  });

  api.get('/candidates/:slug', async (c) => {
    const { pool, config } = c.get('deps');
    const resume = await getPublicResume(pool, c.req.param('slug'));
    if (resume === null) {
      return fail(c, 404, 'not_found', 'No such candidate, or that resume is not shared.');
    }
    // Reading a resume is public; the contact block inside it is not. An
    // anonymous caller gets the document with every channel withheld and is
    // told so in the payload, because an agent that cannot see the difference
    // will report "no contact details on file" and be wrong.
    const shown = resumeForViewer(resume, c.get('viewer') !== null);
    return c.json({
      candidate: toCandidateSummary(resume),
      // The Markdown is the canonical document, so it travels whole rather
      // than only as the parse of it.
      markdown: shown.markdown,
      parsed: shown.parsed,
      ...(shown.redacted
        ? {
            contactRedacted: true,
            contactHint: 'Sign in, or send a token, to read the contact block.',
          }
        : {}),
      listed: resume.visibility === 'public',
      url: `${config.publicUrl}/candidates/${resume.publicSlug}`,
      spec: `${config.publicUrl}/docs/openresume`,
    });
  });

  // --- updates and following ---------------------------------------------

  /**
   * The updates, as data.
   *
   * The same two parameters every other representation takes, so a filter
   * written once reads as JSON, Markdown, RSS or a page. `following=true` is
   * the only one that needs a credential, because it is the only one that is
   * about the caller rather than about the board.
   */
  api.get('/updates', async (c) => {
    const { pool, config } = c.get('deps');
    const params = new URL(c.req.url).searchParams;
    const viewer = viewerOf(c);

    if (params.get('following') === 'true') {
      if (viewer === null) {
        return fail(c, 401, 'unauthorised', 'Sign in to read the updates from who you follow.');
      }
      const mine = await listFollowedUpdates(pool, viewer.id);
      return c.json({ items: mine.map((update) => withUrl(update, config.publicUrl)), total: mine.length });
    }

    const scope = await scopeFrom(pool, params);
    if (scope.kind === 'unknown') {
      return fail(c, 404, 'not_found', `Nobody here is "${scope.slug}".`);
    }
    const items = await listScoped(pool, scope);
    return c.json({
      items: items.map((update) => withUrl(update, config.publicUrl)),
      total: items.length,
      ...(scope.kind === 'author' ? { author: { kind: scope.author, slug: scope.slug, name: scope.name } } : {}),
    });
  });

  /**
   * Post one.
   *
   * `org` decides who it is from: with it, the employer of that slug and only
   * if you post for them; without it, you. There is no third case and no way
   * to name somebody else.
   */
  api.post('/updates', async (c) => {
    const { pool, config } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthorised', 'Sign in to post an update.');

    const body = await readBody(c);
    const orgSlug = typeof body['org'] === 'string' ? body['org'].trim() : '';

    let target: Target;
    let back: string;
    if (orgSlug !== '') {
      const org = await getOrgBySlug(pool, orgSlug);
      if (org === null) return fail(c, 404, 'not_found', `No employer with the slug "${orgSlug}".`);
      target = { kind: 'employer', orgId: org.id };
      back = `${config.publicUrl}/employers/${org.slug}`;
    } else {
      const slug = await candidateSlugFor(pool, viewer.id);
      if (slug === null) {
        return fail(
          c,
          403,
          'no_profile',
          'Publish a resume before posting an update, so the update has a page behind it.',
        );
      }
      target = { kind: 'candidate', userId: viewer.id };
      back = `${config.publicUrl}/candidates/${slug}`;
    }

    const posted = await postUpdate(pool, viewer.id, target, {
      body: body['body'],
      link: body['link'],
    });
    if (typeof posted === 'string') {
      // 429 when it is the rate limit and 400 when it is the update itself:
      // one is worth retrying tomorrow and the other never is.
      const rate = posted.includes('limit');
      return fail(c, rate ? 429 : 400, rate ? 'rate_limited' : 'invalid', posted);
    }
    return c.json({ update: withUrl(posted, config.publicUrl), author: back }, 201);
  });

  /**
   * Take one down.
   *
   * Whoever wrote it, or anybody who posts for that employer: a person who
   * leaves a company should not leave a post nobody there can remove. A 404
   * covers both "no such update" and "not yours", because the two are the
   * same fact to a caller who should not be able to tell them apart.
   */
  api.delete('/updates/:id', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthorised', 'Sign in to delete an update.');
    const gone = await deleteUpdate(pool, viewer.id, c.req.param('id'));
    if (!gone) return fail(c, 404, 'not_found', 'No such update, or it is not yours to delete.');
    return c.json({ deleted: true });
  });

  /**
   * Follow and unfollow.
   *
   * POST follows, DELETE unfollows, and both are idempotent: following twice
   * is following once, so a retried call is never an error to interpret.
   *
   * Written out four times rather than generated in a loop, because the test
   * that checks every served route is documented reads these paths out of
   * this file as literals. A route built from a template string is a route
   * that can quietly leave the OpenAPI document.
   */
  const setFollow = async (
    c: Ctx,
    target: Target | null,
    slug: string,
    wanted: boolean,
  ): Promise<Response> => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthorised', 'Sign in to follow.');
    if (target === null) return fail(c, 404, 'not_found', `Nobody here is "${slug}".`);
    if (wanted) await follow(pool, viewer.id, target);
    else await unfollow(pool, viewer.id, target);
    return c.json({
      following: await isFollowing(pool, viewer.id, target),
      followers: await followerCount(pool, target),
    });
  };

  const orgTarget = async (c: Ctx, slug: string): Promise<Target | null> => {
    const org = await getOrgBySlug(c.get('deps').pool, slug);
    return org === null ? null : { kind: 'employer', orgId: org.id };
  };

  const candidateTarget = async (c: Ctx, slug: string): Promise<Target | null> => {
    const userId = await userForCandidate(c.get('deps').pool, slug);
    return userId === null ? null : { kind: 'candidate', userId };
  };

  api.post('/orgs/:slug/follow', async (c) => {
    const slug = c.req.param('slug');
    return setFollow(c, await orgTarget(c, slug), slug, true);
  });

  api.delete('/orgs/:slug/follow', async (c) => {
    const slug = c.req.param('slug');
    return setFollow(c, await orgTarget(c, slug), slug, false);
  });

  api.post('/candidates/:slug/follow', async (c) => {
    const slug = c.req.param('slug');
    return setFollow(c, await candidateTarget(c, slug), slug, true);
  });

  api.delete('/candidates/:slug/follow', async (c) => {
    const slug = c.req.param('slug');
    return setFollow(c, await candidateTarget(c, slug), slug, false);
  });

  api.get('/me/following', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthorised', 'Sign in to see who you follow.');
    const items = await listFollowing(pool, viewer.id);
    return c.json({ items, total: items.length });
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

  // --- inbox ------------------------------------------------------------

  /**
   * Private conversations. Everything here needs the caller's identity, and
   * nothing here is visible to anyone outside the conversation: a thread id
   * that is not yours is a 404, not a 403, so ids cannot be probed.
   */
  api.get('/inbox', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to read your inbox.');
    const items = await listThreads(pool, viewer.id);
    return c.json({ items, total: items.length, unread: items.filter((t) => t.unread > 0).length });
  });

  /**
   * Start a conversation, or continue the one these two parties already have.
   *
   * `candidate` or `employer` names who it is to, by slug. `as` is an employer
   * slug to write as, for a member writing on the company's behalf. `job` ties
   * it to a listing.
   */
  api.post('/inbox', async (c) => {
    const { pool, config, mailer } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to send a message.');
    const body = await readBody(c);
    const to = await counterpartyFrom(pool, {
      candidate: typeof body['candidate'] === 'string' ? body['candidate'] : null,
      employer: typeof body['employer'] === 'string' ? body['employer'] : null,
    });
    if (to === null) {
      return fail(c, 404, 'not_found', 'Name a candidate or an employer by slug. Nobody here matches.');
    }
    const jobSlug = typeof body['job'] === 'string' ? body['job'].trim() : '';
    const job = jobSlug === '' ? null : await getJobBySlug(pool, jobSlug);
    if (jobSlug !== '' && job === null) return fail(c, 404, 'not_found', `No job with the slug "${jobSlug}".`);
    const asSlug = typeof body['as'] === 'string' ? body['as'].trim() : '';
    const asOrg = asSlug === '' ? null : await getOrgBySlug(pool, asSlug);
    if (asSlug !== '' && asOrg === null) return fail(c, 404, 'not_found', `No employer with the slug "${asSlug}".`);

    const started = await startThread(pool, viewer.id, to, {
      subject: body['subject'],
      body: body['body'],
      jobId: job?.id ?? null,
      as: asOrg?.id ?? null,
    });
    if (typeof started === 'string') {
      return fail(c, started.includes('conversations today') ? 429 : 400, 'rejected', started);
    }
    await notifyParticipants(pool, {
      mailer,
      boardName: config.boardName,
      publicUrl: config.publicUrl,
      threadId: started.threadId,
      senderId: viewer.id,
      kind: 'text',
    });
    return c.json(
      { ...started, url: `${config.publicUrl}/inbox/${started.threadId}` },
      started.created ? 201 : 200,
    );
  });

  api.get('/inbox/:id', async (c) => {
    const { pool, coinpay } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to read your inbox.');
    const id = c.req.param('id');
    if (!isUuid(id)) return fail(c, 404, 'not_found', 'No such conversation.');
    const thread = await getThread(pool, id, viewer.id);
    if (thread === null) return fail(c, 404, 'not_found', 'No such conversation.');
    const invoices = await Promise.all(
      (await listInvoicesIn(pool, coinpay, id)).map((invoice) => syncInvoice(pool, coinpay, invoice)),
    );
    await markRead(pool, id, viewer.id);
    return c.json({ thread, invoices });
  });

  api.post('/inbox/:id/messages', async (c) => {
    const { pool, config, mailer } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to send a message.');
    const id = c.req.param('id');
    if (!isUuid(id)) return fail(c, 404, 'not_found', 'No such conversation.');
    const body = await readBody(c);
    const sent = await sendMessage(pool, id, viewer.id, body['body']);
    if (typeof sent === 'string') {
      return fail(c, sent.includes('not in that') ? 404 : 400, 'rejected', sent);
    }
    await notifyParticipants(pool, {
      mailer,
      boardName: config.boardName,
      publicUrl: config.publicUrl,
      threadId: id,
      senderId: viewer.id,
      kind: 'text',
    });
    return c.json({ message: sent }, 201);
  });

  // --- invoices and billing ------------------------------------------------

  /**
   * Send an invoice into a conversation. The caller is the payee; the money
   * settles to the wallet on their connected CoinPay account, in `currency`
   * (a chain they have a wallet on). Omit `currency` when there is one wallet.
   */
  api.post('/inbox/:id/invoices', async (c) => {
    const { pool, config, mailer, coinpay } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to send an invoice.');
    const id = c.req.param('id');
    if (!isUuid(id)) return fail(c, 404, 'not_found', 'No such conversation.');
    const body = await readBody(c);
    const invoice = await sendInvoice(pool, coinpay, {
      threadId: id,
      payeeId: viewer.id,
      amount: body['amount'],
      currency: body['currency'],
      description: body['description'],
    });
    if (typeof invoice === 'string') {
      return fail(c, invoice.includes('not in that') ? 404 : 400, 'rejected', invoice);
    }
    await notifyParticipants(pool, {
      mailer,
      boardName: config.boardName,
      publicUrl: config.publicUrl,
      threadId: id,
      senderId: viewer.id,
      kind: 'invoice',
    });
    return c.json({ invoice }, 201);
  });

  /** Every invoice the caller sent or can pay, newest first. */
  api.get('/invoices', async (c) => {
    const { pool, coinpay } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to read your invoices.');
    const items = await listInvoicesFor(pool, coinpay, viewer.id);
    return c.json({ items, total: items.length });
  });

  api.get('/invoices/:id', async (c) => {
    const { pool, coinpay } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to read an invoice.');
    const id = c.req.param('id');
    if (!isUuid(id)) return fail(c, 404, 'not_found', 'No such invoice.');
    const invoice = await getInvoice(pool, coinpay, id, viewer.id);
    if (invoice === null) return fail(c, 404, 'not_found', 'No such invoice.');
    return c.json({ invoice: await syncInvoice(pool, coinpay, invoice) });
  });

  /**
   * Get a live quote to pay an invoice. The response carries `payment.url`,
   * the CoinPay page to pay on, and `payment.address` plus `amountCrypto` for
   * a wallet that would rather pay directly.
   */
  api.post('/invoices/:id/pay', async (c) => {
    const { pool, config, coinpay } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in to pay an invoice.');
    const id = c.req.param('id');
    if (!isUuid(id)) return fail(c, 404, 'not_found', 'No such invoice.');
    const result = await requestPayment(pool, coinpay, {
      invoiceId: id,
      payerId: viewer.id,
      publicUrl: config.publicUrl,
    });
    if (typeof result === 'string') {
      return fail(c, result === 'No such invoice.' ? 404 : 400, 'rejected', result);
    }
    return c.json({ invoice: result });
  });

  api.post('/invoices/:id/cancel', async (c) => {
    const { pool, coinpay } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    const id = c.req.param('id');
    if (!isUuid(id)) return fail(c, 404, 'not_found', 'No such invoice.');
    const invoice = await getInvoice(pool, coinpay, id, viewer.id);
    if (invoice === null) return fail(c, 404, 'not_found', 'No such invoice.');
    const cancelled = await cancelInvoice(pool, id, viewer.id);
    if (!cancelled) {
      return fail(c, 409, 'not_cancellable', 'Only the sender can cancel an invoice, and only while it is unpaid.');
    }
    return c.json({ ok: true });
  });

  /**
   * The caller's CoinPay connection: whether this board has billing at all,
   * and whether this account is connected well enough to be paid.
   */
  api.get('/coinpay', async (c) => {
    const { pool, config, coinpay } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    if (coinpay === null) return c.json({ configured: false, account: null });
    const account = await getAccount(pool, viewer.id);
    return c.json({
      configured: true,
      account,
      // Connecting needs a browser: it is CoinPay's consent screen.
      connectUrl: `${config.publicUrl}/me/coinpay/connect`,
    });
  });

  api.delete('/coinpay', async (c) => {
    const { pool } = c.get('deps');
    const viewer = viewerOf(c);
    if (viewer === null) return fail(c, 401, 'unauthenticated', 'Sign in first.');
    return c.json({ ok: await disconnect(pool, viewer.id) });
  });

  /**
   * Where CoinPay sends the person after consent. Under /api/v1 because that
   * is the path registered on the OAuth client; it answers a browser, with a
   * redirect, not JSON.
   */
  api.get('/coinpay/callback', async (c) => {
    const { pool, config, coinpay } = c.get('deps');
    const params = new URL(c.req.url).searchParams;
    const code = params.get('code') ?? '';
    const state = params.get('state') ?? '';
    if (params.get('error') !== null) {
      const said = params.get('error_description') ?? params.get('error') ?? 'refused';
      return c.redirect(`/me?coinpay=${encodeURIComponent(`CoinPay said: ${said}`)}#billing`, 303);
    }
    if (code === '' || state === '') return fail(c, 400, 'bad_request', 'Missing code or state.');
    if (coinpay === null) return fail(c, 404, 'not_found', 'This board has no payment rail configured.');
    const done = await finishConnect(pool, coinpay, {
      state,
      code,
      redirectUri: coinpayRedirectUri(config.publicUrl),
    });
    if (typeof done === 'string') {
      return c.redirect(`/me?coinpay=${encodeURIComponent(done)}#billing`, 303);
    }
    const back = done.redirect ?? '/me#billing';
    if (back.startsWith('/me')) return c.redirect('/me?coinpay=connected#billing', 303);
    return c.redirect(`${back}${back.includes('?') ? '&' : '?'}coinpay=connected`, 303);
  });

  /**
   * CoinPay telling us a payment settled. Verified against the business's
   * webhook secret; an unsigned or mis-signed body is dropped with a 401 and
   * the invoice waits for the next page load to ask CoinPay directly.
   */
  api.post('/coinpay/webhook', async (c) => {
    const { pool, coinpay } = c.get('deps');
    if (coinpay === null) return fail(c, 404, 'not_found', 'This board has no payment rail configured.');
    const raw = await c.req.text();
    if (!coinpay.verifyWebhook(raw, c.req.header('x-coinpay-signature'))) {
      return fail(c, 401, 'bad_signature', "The signature does not match this board's webhook secret.");
    }
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      payload = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return fail(c, 400, 'bad_request', 'The body is not JSON.');
    }
    const outcome = await applyWebhook(pool, payload);
    return c.json({ received: true, outcome });
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
/**
 * An update, with the page its author is on.
 *
 * The URL is built here rather than by each caller: a reader should never
 * have to know that an employer lives under /employers and a person under
 * /candidates in order to follow a link out of the feed.
 */
function withUrl(update: Update, publicUrl: string): Update & { authorUrl: string | null } {
  const path =
    update.author.slug === null
      ? null
      : update.author.kind === 'employer'
        ? `/employers/${update.author.slug}`
        : `/candidates/${update.author.slug}`;
  return { ...update, authorUrl: path === null ? null : `${publicUrl}${path}` };
}

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
