/**
 * The tools.
 *
 * Every one of them calls the board's REST API. None of them touch the
 * database, even when running inside the server, because a second read path
 * gets its own permission bugs - the tool would be checking a rule the API
 * checks differently, and the two would drift apart on the first change.
 *
 * `Caller` is the only thing that differs between the two hosts: inside the
 * server it dispatches through the app's own fetch, and in the stdio binary it
 * is an ordinary HTTP client pointed at a remote board.
 */

import { text, toolError, type ToolDefinition, type ToolResult } from './protocol.ts';
import { APPLICATION_DECISIONS, isApplicationDecision } from '../schema/job.ts';

export interface Caller {
  /** Path is relative to the board root, e.g. `/api/v1/jobs?q=rust`. */
  call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
  /** The board this caller talks to, for messages. */
  server: string;
  /** Whether a token is configured, so tools can say what is missing. */
  authenticated: boolean;
}

function object(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const string = (description: string): Record<string, unknown> => ({ type: 'string', description });
const integer = (description: string): Record<string, unknown> => ({
  type: 'integer',
  description,
});

export const TOOLS: ToolDefinition[] = [
  {
    name: 'search_jobs',
    title: 'Search jobs',
    description:
      'Search this board. Every listing was posted here by its employer, so an empty result means nobody has posted that job - not that a crawler missed it. Filter on agentPolicy to find employers who welcome agent-written applications.',
    inputSchema: object({
      q: string('Free text over title, description, tags and stack.'),
      workplace: { type: 'string', enum: ['remote', 'hybrid', 'onsite'] },
      employmentType: {
        type: 'string',
        enum: ['full-time', 'part-time', 'contract', 'internship', 'temporary'],
      },
      seniority: {
        type: 'string',
        enum: ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead'],
      },
      agentPolicy: {
        type: 'string',
        enum: ['welcome', 'disclose', 'human-only'],
        description: 'Where the employer stands on applications written with an agent.',
      },
      tag: string('One tag or several, comma separated. Matches tags and stack.'),
      tags: string('The same thing, spelled the way the site and its feeds spell it.'),
      salaryMin: integer('Minimum, compared against the top of each range.'),
      limit: integer('1-100, default 25.'),
      offset: integer('For paging.'),
    }),
  },
  {
    name: 'get_job',
    title: 'Read one job',
    description: 'The full listing, its description as Markdown, and its schema.org JSON-LD.',
    inputSchema: object({ slug: string('The job slug.') }, ['slug']),
  },
  {
    name: 'get_apply_schema',
    title: 'How to apply',
    description:
      'The exact fields this job wants, where to send them, and whether the employer asks agent-written applications to disclose. Always call this before apply_to_job. If it times out, call it once more: an idle hosted board can miss the first request.',
    inputSchema: object({ slug: string('The job slug.') }, ['slug']),
  },
  {
    name: 'apply_to_job',
    title: 'Apply to a job',
    description:
      'Send an application. Fill in the fields get_apply_schema listed. Pass the resume as Markdown in the OpenResume.md convention. If the employer asks for disclosure, say which agent wrote it - disclosing is not held against a candidate on a board that asked for it.',
    inputSchema: object(
      {
        slug: string('The job slug.'),
        answers: {
          type: 'object',
          description: 'The fields from get_apply_schema, keyed by field name.',
          additionalProperties: { type: 'string' },
        },
        resume: string('The resume, as Markdown.'),
        resumeSlug: string('Or the slug of a resume already saved on this board.'),
        agentName: string('Which agent wrote this, if one did.'),
        agentSupervised: {
          type: 'boolean',
          description: 'Whether a person read it before it was sent.',
        },
      },
      ['slug', 'answers'],
    ),
  },
  {
    name: 'list_employers',
    title: 'List employers',
    description: 'Everyone with an open listing on this board.',
    inputSchema: object({}),
  },
  {
    name: 'whoami',
    title: 'Who am I',
    description:
      'The account this connection is signed in as, with the employers it can post under and the resumes it has saved.',
    inputSchema: object({}),
  },
  {
    name: 'list_resumes',
    title: 'List saved resumes',
    description: 'The resumes on this account, as Markdown.',
    inputSchema: object({}),
  },
  {
    name: 'save_resume',
    title: 'Save a resume',
    description:
      'Create or replace a resume. Markdown, in the OpenResume.md convention: an h1 with the name, a bullet list of contact details, then ## sections and ### entries.',
    inputSchema: object(
      {
        markdown: string('The resume, as Markdown.'),
        title: string('What to call it. Defaults to the name in the document.'),
        slug: string('Replace an existing resume with this slug, instead of creating one.'),
      },
      ['markdown'],
    ),
  },
  {
    name: 'post_job',
    title: 'Post a job',
    description:
      'Create a listing. It stays a draft until publish_job is called, so nothing goes live without someone asking for it. Requires membership of the employer.',
    inputSchema: object(
      {
        org: string('The employer slug to post under.'),
        title: string('The role.'),
        description: string('The listing body, as Markdown.'),
        employmentType: { type: 'string', enum: ['full-time', 'part-time', 'contract', 'internship', 'temporary'] },
        workplace: { type: 'string', enum: ['remote', 'hybrid', 'onsite'] },
        seniority: { type: 'string', enum: ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead'] },
        location: string('Free text.'),
        salaryMin: integer('Bottom of the range.'),
        salaryMax: integer('Top of the range.'),
        salaryCurrency: string('ISO code, e.g. USD.'),
        salaryPeriod: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year'] },
        tags: string('Comma separated.'),
        stack: string('Comma separated.'),
        agentPolicy: {
          type: 'string',
          enum: ['welcome', 'disclose', 'human-only'],
          description: 'Required on every listing. Defaults to disclose.',
        },
      },
      ['org', 'title', 'description'],
    ),
  },
  {
    name: 'publish_job',
    title: 'Publish a job',
    description: 'Take a draft live. Requires membership of the employer.',
    inputSchema: object({ slug: string('The job slug.') }, ['slug']),
  },
  {
    name: 'list_applications',
    title: 'Read applications',
    description:
      'Applications to one of your listings, including each candidate resume and any agent disclosure.',
    inputSchema: object({ slug: string('The job slug.') }, ['slug']),
  },
  {
    name: 'decide_application',
    title: 'Decide on an application',
    description:
      'Move one application to reviewing, rejected or hired. Take the id from list_applications. Requires membership of the employer. This records the decision on the board; it does not email the candidate, so tell them yourself.',
    inputSchema: object(
      {
        id: string('The application id, as list_applications returns it.'),
        status: {
          type: 'string',
          enum: [...APPLICATION_DECISIONS],
          description:
            'reviewing means you are reading it, rejected means no, hired means yes. The candidate-side statuses cannot be set here.',
        },
      },
      ['id', 'status'],
    ),
  },
  {
    name: 'read_updates',
    title: 'Read updates',
    description:
      'Short posts from the employers and candidates on this board: hiring news, what shipped, who is free next. Everything here is from a real employer or a person with a resume, capped at five a day each. Name an employer or a candidate to read one of them, or set following to true for the ones this account follows.',
    inputSchema: object({
      org: string("An employer's slug."),
      candidate: string("A candidate's slug."),
      following: {
        type: 'boolean',
        description: 'Only from who this account follows. Needs a signed-in account.',
      },
    }),
  },
  {
    name: 'post_update',
    title: 'Post an update',
    description:
      'Post a short update. With org, it is from that employer and you must post for them; without it, from this account, which needs a published resume so the update has a page behind it. At most 600 characters and one link. Five a day, and the same text twice is refused - this is news, not a channel to broadcast on.',
    inputSchema: object(
      {
        body: string('What happened. Plain text, at most 600 characters.'),
        link: string('One public URL. Optional.'),
        org: string('Post as this employer instead of as this account.'),
      },
      ['body'],
    ),
  },
  {
    name: 'follow',
    title: 'Follow or unfollow',
    description:
      'Follow an employer or a candidate so their updates appear in this account\'s feed. Set following to false to stop. Following twice is following once.',
    inputSchema: object(
      {
        org: string("An employer's slug."),
        candidate: string("A candidate's slug."),
        following: { type: 'boolean', description: 'Defaults to true.' },
      },
      [],
    ),
  },
  {
    name: 'search_network',
    title: 'Search every board',
    description:
      'One search across every board listed in this instance directory, in parallel. Results say which board each came from; a board that failed to answer is named rather than silently dropped. Only works on an instance that is a directory.',
    inputSchema: object({
      q: string('Free text.'),
      workplace: { type: 'string', enum: ['remote', 'hybrid', 'onsite'] },
      agentPolicy: { type: 'string', enum: ['welcome', 'disclose', 'human-only'] },
      limit: integer('1-100, default 25.'),
    }),
  },
  {
    name: 'list_instances',
    title: 'List boards',
    description: 'Every board this instance directory knows about. Directories only.',
    inputSchema: object({ topic: string('Filter by topic.') }),
  },
];

function query(args: Record<string, unknown>, keys: string[]): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'tag') {
      for (const tag of String(value).split(',')) {
        const trimmed = tag.trim();
        if (trimmed !== '') params.append('tag', trimmed);
      }
      continue;
    }
    params.set(key, String(value));
  }
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

function message(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (typeof error?.message === 'string') return error.message;
  }
  return fallback;
}

export async function callTool(
  caller: Caller,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'search_jobs': {
      const path = `/api/v1/jobs${query(args, [
        'q',
        'workplace',
        'employmentType',
        'seniority',
        'agentPolicy',
        'tag',
        'salaryMin',
        'limit',
        'offset',
      ])}`;
      const response = await caller.call('GET', path);
      if (response.status !== 200) return toolError(message(response.body, 'Search failed.'));
      const page = response.body as { items?: unknown[]; total?: number };
      const items = page.items ?? [];
      if (items.length === 0) {
        return text(
          `No jobs on ${caller.server} match that. This board only holds listings posted to it, so nothing matched rather than nothing was found.`,
          response.body,
        );
      }
      return text(summarise(items, page.total ?? items.length, caller.server), response.body);
    }

    case 'get_job': {
      const response = await caller.call('GET', `/api/v1/jobs/${encodeURIComponent(String(args['slug'] ?? ''))}`);
      if (response.status !== 200) return toolError(message(response.body, 'No such job.'));
      return text(describeJob(response.body), response.body);
    }

    case 'get_apply_schema': {
      const response = await caller.call(
        'GET',
        `/api/v1/jobs/${encodeURIComponent(String(args['slug'] ?? ''))}/apply-schema`,
      );
      if (response.status !== 200) return toolError(message(response.body, 'No such job.'));
      return text(JSON.stringify(response.body, null, 2), response.body);
    }

    case 'apply_to_job': {
      const answers =
        typeof args['answers'] === 'object' && args['answers'] !== null
          ? (args['answers'] as Record<string, unknown>)
          : {};
      const body: Record<string, unknown> = { ...answers };
      if (typeof args['resume'] === 'string') body['resume'] = args['resume'];
      if (typeof args['resumeSlug'] === 'string') body['resumeSlug'] = args['resumeSlug'];
      if (typeof args['agentName'] === 'string' && args['agentName'] !== '') {
        body['agent'] = { name: args['agentName'], supervised: args['agentSupervised'] === true };
      }
      const response = await caller.call(
        'POST',
        `/api/v1/jobs/${encodeURIComponent(String(args['slug'] ?? ''))}/apply`,
        body,
      );
      if (response.status !== 201) {
        const fields = (response.body as { error?: { fields?: { field: string; message: string }[] } })
          .error?.fields;
        const detail =
          fields === undefined
            ? ''
            : `\n\n${fields.map((problem) => `- ${problem.field}: ${problem.message}`).join('\n')}`;
        return toolError(`${message(response.body, 'The application was not accepted.')}${detail}`);
      }
      return text('Application sent.', response.body);
    }

    case 'list_employers': {
      const response = await caller.call('GET', '/api/v1/orgs');
      return text(JSON.stringify(response.body, null, 2), response.body);
    }

    case 'whoami': {
      const response = await caller.call('GET', '/api/v1/me');
      if (response.status === 401) {
        return toolError(
          caller.authenticated
            ? `The token for ${caller.server} has expired. Run: agenticjobs login ${caller.server}`
            : `Not signed in to ${caller.server}. Run: agenticjobs login ${caller.server}`,
        );
      }
      return text(JSON.stringify(response.body, null, 2), response.body);
    }

    case 'list_resumes': {
      const response = await caller.call('GET', '/api/v1/resumes');
      if (response.status === 401) return toolError(signInFirst(caller));
      return text(JSON.stringify(response.body, null, 2), response.body);
    }

    case 'save_resume': {
      const slug = args['slug'];
      const body = {
        markdown: String(args['markdown'] ?? ''),
        ...(typeof args['title'] === 'string' ? { title: args['title'] } : {}),
      };
      const response =
        typeof slug === 'string' && slug !== ''
          ? await caller.call('PATCH', `/api/v1/resumes/${encodeURIComponent(slug)}`, body)
          : await caller.call('POST', '/api/v1/resumes', body);
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status >= 400) return toolError(message(response.body, 'The resume was not saved.'));
      return text('Saved.', response.body);
    }

    case 'post_job': {
      const response = await caller.call('POST', '/api/v1/jobs', args);
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 201) return toolError(message(response.body, 'The job was not created.'));
      const created = (response.body as { job?: { slug?: string } }).job;
      return text(
        `Created as a draft: ${created?.slug ?? 'unknown'}. It is not visible to anyone until publish_job is called.`,
        response.body,
      );
    }

    case 'publish_job': {
      const response = await caller.call(
        'POST',
        `/api/v1/jobs/${encodeURIComponent(String(args['slug'] ?? ''))}/publish`,
      );
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status >= 400) return toolError(message(response.body, 'The job was not published.'));
      return text('Published.', response.body);
    }

    case 'list_applications': {
      const response = await caller.call(
        'GET',
        `/api/v1/jobs/${encodeURIComponent(String(args['slug'] ?? ''))}/applications`,
      );
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status >= 400) return toolError(message(response.body, 'Could not read applications.'));
      return text(JSON.stringify(response.body, null, 2), response.body);
    }

    case 'decide_application': {
      const id = String(args['id'] ?? '');
      const status = args['status'];
      if (!isApplicationDecision(status)) {
        return toolError(`status must be one of ${APPLICATION_DECISIONS.join(', ')}.`);
      }
      const response = await caller.call(
        'POST',
        `/api/v1/applications/${encodeURIComponent(id)}/decision`,
        { status },
      );
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status >= 400) {
        return toolError(message(response.body, 'The decision was not recorded.'));
      }
      const decided = response.body as { application?: { answers?: Record<string, string> } };
      const who = decided.application?.answers?.['name'] ?? 'The application';
      return text(`${who} is now ${status}. The candidate was not emailed.`, response.body);
    }

    case 'read_updates': {
      const path = `/api/v1/updates${query(args, ['org', 'candidate', 'following'])}`;
      const response = await caller.call('GET', path);
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 200) return toolError(message(response.body, 'No such author.'));
      const page = response.body as { items?: unknown[] };
      const items = page.items ?? [];
      if (items.length === 0) {
        return text(`Nothing posted on ${caller.server} that matches.`, response.body);
      }
      return text(JSON.stringify(response.body, null, 2), response.body);
    }

    case 'post_update': {
      const response = await caller.call('POST', '/api/v1/updates', {
        body: String(args['body'] ?? ''),
        ...(typeof args['link'] === 'string' && args['link'] !== '' ? { link: args['link'] } : {}),
        ...(typeof args['org'] === 'string' && args['org'] !== '' ? { org: args['org'] } : {}),
      });
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 201) {
        return toolError(message(response.body, 'The update was not posted.'));
      }
      const posted = response.body as { author?: string };
      return text(`Posted. It is on ${posted.author ?? caller.server}.`, response.body);
    }

    case 'follow': {
      const org = typeof args['org'] === 'string' ? args['org'] : '';
      const candidate = typeof args['candidate'] === 'string' ? args['candidate'] : '';
      if (org === '' && candidate === '') {
        return toolError('Name an employer with org, or a candidate with candidate.');
      }
      const path =
        org !== ''
          ? `/api/v1/orgs/${encodeURIComponent(org)}/follow`
          : `/api/v1/candidates/${encodeURIComponent(candidate)}/follow`;
      const wanted = args['following'] !== false;
      const response = await caller.call(wanted ? 'POST' : 'DELETE', path);
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 200) return toolError(message(response.body, 'Nobody by that name.'));
      return text(wanted ? 'Following.' : 'Not following.', response.body);
    }

    case 'search_network': {
      const response = await caller.call(
        'GET',
        `/api/v1/directory/search${query(args, ['q', 'workplace', 'agentPolicy', 'limit'])}`,
      );
      if (response.status === 404) {
        return toolError(`${caller.server} is a board, not a directory, so it has no network to search.`);
      }
      const result = response.body as {
        jobs?: { job: { title: string }; instanceName: string; url: string }[];
        sources?: { name: string; ok: boolean }[];
      };
      const failed = (result.sources ?? []).filter((source) => !source.ok);
      const lines = (result.jobs ?? []).map(
        (entry) => `- ${entry.job.title} (${entry.instanceName}) ${entry.url}`,
      );
      const note =
        failed.length === 0
          ? ''
          : `\n\n${failed.length} board(s) did not answer, so their listings are missing: ${failed.map((source) => source.name).join(', ')}.`;
      return text(
        lines.length === 0 ? `Nothing matched on any listed board.${note}` : `${lines.join('\n')}${note}`,
        response.body,
      );
    }

    case 'list_instances': {
      const response = await caller.call(
        'GET',
        `/api/v1/directory/instances${query(args, ['topic'])}`,
      );
      if (response.status === 404) return toolError(`${caller.server} is not a directory.`);
      return text(JSON.stringify(response.body, null, 2), response.body);
    }

    default:
      return toolError(`No tool called ${name}.`);
  }
}

function signInFirst(caller: Caller): string {
  return `That needs an account on ${caller.server}. Run: agenticjobs login ${caller.server}`;
}

interface JobLike {
  title?: string;
  slug?: string;
  org?: { name?: string };
  workplace?: string;
  location?: string | null;
  agentPolicy?: string;
  salary?: { min?: number | null; max?: number | null; currency?: string };
}

function summarise(items: unknown[], total: number, server: string): string {
  const lines = items.map((item) => {
    const job = item as JobLike;
    const pay =
      job.salary?.max !== null && job.salary?.max !== undefined
        ? ` - ${job.salary.currency ?? 'USD'} ${job.salary.min ?? ''}-${job.salary.max}`
        : '';
    return `- ${job.title ?? 'Untitled'} at ${job.org?.name ?? 'unknown'} (${job.workplace ?? '?'}${job.location ? `, ${job.location}` : ''})${pay} [${job.agentPolicy ?? '?'}] ${server}/jobs/${job.slug ?? ''}`;
  });
  return `${total} match on ${server}, showing ${items.length}:\n\n${lines.join('\n')}`;
}

function describeJob(body: unknown): string {
  const job = (body as { job?: JobLike }).job;
  if (job === undefined) return JSON.stringify(body, null, 2);
  return JSON.stringify(job, null, 2);
}
