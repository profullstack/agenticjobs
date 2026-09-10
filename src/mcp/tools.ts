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
import { formatPayShort, payOfJob, type Pay } from '../schema/pay.ts';
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
      'Create a listing. It stays a draft until publish_job is called, so nothing goes live without someone asking for it. Requires membership of the employer. Publishing requires pay: send it as `pay`, one line per price, or `unpaid: true`.',
    inputSchema: object(
      {
        org: string('The employer slug to post under.'),
        title: string('The role.'),
        description: string('The listing body, as Markdown.'),
        employmentType: { type: 'string', enum: ['full-time', 'part-time', 'contract', 'internship', 'temporary'] },
        workplace: { type: 'string', enum: ['remote', 'hybrid', 'onsite'] },
        seniority: { type: 'string', enum: ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead'] },
        location: string('Free text.'),
        pay: {
          type: 'array',
          items: { type: 'string' },
          description:
            'What it pays, one line per price, the way a person says it: "$120k - $150k a year", "$100 an hour", "$0.25 per task", "$0.25 per PR that fixes a bug you find", "$5000 fixed", "10% revenue share", "0.01 SOL per task". Required before the listing can be published.',
        },
        payMethod: string('How it is settled: a coin such as SOL, USDC, ETH, USDT or POL, or a rail such as "bank transfer", "PayPal" or "payroll".'),
        payEquity: string('Equity, as text. Optional.'),
        unpaid: { type: 'boolean', description: 'True only when the role pays nothing and the employer says so.' },
        salaryMin: integer('Bottom of an annual range. Older form of pay; prefer `pay`.'),
        salaryMax: integer('Top of an annual range. Older form of pay; prefer `pay`.'),
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
    name: 'recommend',
    title: 'Write a recommendation',
    description:
      'Recommend a candidate (candidate: their slug) or an employer (org: its slug). Not a rating: a paragraph with a name on it, shown on their page once they approve it. As this account, which needs a published resume, or as an employer this account posts for ("as"). Writing again replaces the earlier one. Ten a day.',
    inputSchema: object(
      {
        candidate: string("A candidate's slug."),
        org: string("An employer's slug."),
        as: string('Write as this employer. Optional.'),
        relationship: string('"Hired them for a three-month contract". Optional.'),
        body: string('What you would say. Plain text, 20 to 2000 characters.'),
      },
      ['body'],
    ),
  },
  {
    name: 'list_recommendations',
    title: 'Recommendations about this account',
    description:
      'What has been written about this account and its employers, every status, and what this account wrote. Pending ones are waiting for a decision.',
    inputSchema: object({}),
  },
  {
    name: 'decide_recommendation',
    title: 'Approve, reject or withdraw a recommendation',
    description:
      'approve puts one written about you on your page; reject keeps it off, and can be used later to take an approved one down; withdraw deletes one you wrote.',
    inputSchema: object(
      {
        id: string('The recommendation id, from list_recommendations.'),
        action: { type: 'string', enum: ['approve', 'reject', 'withdraw'] },
      },
      ['id', 'action'],
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
    name: 'read_inbox',
    title: 'Read the inbox',
    description:
      "This account's private conversations with candidates and employers, newest first, with unread counts. Pass a thread id to read one conversation in full, with the invoices in it; reading one marks it read. There is no public commenting on this board: the inbox is how people are reached.",
    inputSchema: object({
      thread: string('A conversation id. Omit for the list.'),
    }),
  },
  {
    name: 'send_message',
    title: 'Send a message',
    description:
      'Write privately to a candidate (by candidate slug) or an employer (by employer slug), or reply in a conversation (by thread id). A first message to somebody about the same job continues the conversation you already have with them. Twenty new conversations a day. They are emailed that there is a message, never the message itself. Use this to ask about a role, follow up on an application, or agree terms; use send_invoice to bill.',
    inputSchema: object(
      {
        thread: string('Reply in this conversation.'),
        candidate: string("Or start one with this candidate's slug."),
        employer: string("Or start one with this employer's slug."),
        job: string('The job slug this is about, when starting one. Optional.'),
        as: string('Write as this employer (slug) instead of as yourself. You must belong to it.'),
        subject: string('One line, when starting one. Optional.'),
        body: string('The message. Plain text, at most 4000 characters.'),
      },
      ['body'],
    ),
  },
  {
    name: 'send_invoice',
    title: 'Send an invoice',
    description:
      'Bill the other side of a conversation. You are the payee: the payment settles on CoinPay straight to a wallet on your connected CoinPay account, and the board never holds it. Needs that account connected with wallet:read, which is a browser step at /me/coinpay/connect; check_billing says whether it is. Amount is in US dollars; currency is a chain you hold a wallet for (BTC, ETH, SOL, USDC_POL ...), and can be omitted when you have one wallet.',
    inputSchema: object(
      {
        thread: string('The conversation to bill in.'),
        amount: string('US dollars, like "1200" or "1200.50".'),
        currency: string('The chain to be paid on. Omit with one wallet.'),
        description: string('What this is for. It is the message the other side reads.'),
      },
      ['thread', 'amount'],
    ),
  },
  {
    name: 'pay_invoice',
    title: 'Pay an invoice',
    description:
      'Get a live quote to pay an invoice you were sent: the CoinPay page to pay on, and the address and crypto amount for a wallet paying directly. A quote lasts a few minutes; call again for a fresh one. Paying needs a wallet, so hand the URL to the person. Without an id, lists every invoice this account sent or can pay.',
    inputSchema: object({
      invoice: string('The invoice id. Omit to list.'),
    }),
  },
  {
    name: 'check_billing',
    title: 'Check billing',
    description:
      "Whether this board has billing at all and whether this account's CoinPay connection can be paid to: connected, which wallets, or what to do. Connecting is a browser step; this tool tells you the URL.",
    inputSchema: object({}),
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
      const created = (response.body as {
        job?: { slug?: string; pay?: { unpaid?: boolean; lines?: { min?: number | null; max?: number | null }[] } };
      }).job;
      const stated =
        created?.pay?.unpaid === true ||
        (created?.pay?.lines ?? []).some((line) => line.min != null || line.max != null);
      return text(
        `Created as a draft: ${created?.slug ?? 'unknown'}. It is not visible to anyone until publish_job is called.${
          stated ? '' : ' It does not say what it pays yet, and cannot be published until it does: send pay, one line per price, or unpaid: true.'
        }`,
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

    case 'recommend': {
      const candidate = typeof args['candidate'] === 'string' ? args['candidate'] : '';
      const org = typeof args['org'] === 'string' ? args['org'] : '';
      if (candidate === '' && org === '') return toolError('Name a candidate with candidate, or an employer with org.');
      const path =
        candidate !== ''
          ? `/api/v1/candidates/${encodeURIComponent(candidate)}/recommendations`
          : `/api/v1/orgs/${encodeURIComponent(org)}/recommendations`;
      const response = await caller.call('POST', path, {
        body: args['body'],
        ...(typeof args['relationship'] === 'string' ? { relationship: args['relationship'] } : {}),
        ...(typeof args['as'] === 'string' && args['as'] !== '' ? { as: args['as'] } : {}),
      });
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 201) return toolError(message(response.body, 'The recommendation was not written.'));
      const written = (response.body as { recommendation?: { subject?: { name?: string }; author?: { name?: string } } }).recommendation;
      return text(
        `Written, from ${written?.author?.name ?? 'you'}. It is pending until ${written?.subject?.name ?? 'they'} approves it, and is not on their page until then.`,
        response.body,
      );
    }

    case 'list_recommendations': {
      const response = await caller.call('GET', '/api/v1/me/recommendations');
      if (response.status === 401) return toolError(signInFirst(caller));
      const mine = response.body as {
        received: { id: string; status: string; author: { name: string }; subject: { name: string }; body: string }[];
        given: { id: string; status: string; subject: { name: string }; body: string }[];
        pending: number;
      };
      const lines = [
        `${mine.pending} waiting for a decision.`,
        '',
        ...mine.received.map((item) => `- [${item.status}] ${item.author.name} about ${item.subject.name}: ${item.body.slice(0, 100)} [${item.id}]`),
        ...(mine.given.length > 0 ? ['', 'You wrote:'] : []),
        ...mine.given.map((item) => `- [${item.status}] about ${item.subject.name}: ${item.body.slice(0, 100)} [${item.id}]`),
      ];
      return text(lines.join('\n'), response.body);
    }

    case 'decide_recommendation': {
      const action = String(args['action'] ?? '');
      if (!['approve', 'reject', 'withdraw'].includes(action)) return toolError('action is approve, reject or withdraw.');
      const response = await caller.call(
        'POST',
        `/api/v1/recommendations/${encodeURIComponent(String(args['id'] ?? ''))}/${action}`,
      );
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 200) return toolError(message(response.body, 'Nothing changed.'));
      return text(
        action === 'approve' ? 'Approved. It is on the page now.' : action === 'reject' ? 'Rejected. It is not shown.' : 'Withdrawn.',
        response.body,
      );
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

    case 'read_inbox': {
      const thread = typeof args['thread'] === 'string' ? args['thread'].trim() : '';
      const path = thread === '' ? '/api/v1/inbox' : `/api/v1/inbox/${encodeURIComponent(thread)}`;
      const response = await caller.call('GET', path);
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 200) return toolError(message(response.body, 'No such conversation.'));
      if (thread === '') {
        const page = response.body as { items?: unknown[] };
        if ((page.items ?? []).length === 0) return text('The inbox is empty.', response.body);
      }
      return text(JSON.stringify(response.body, null, 2), response.body);
    }

    case 'send_message': {
      const body = String(args['body'] ?? '');
      const thread = typeof args['thread'] === 'string' ? args['thread'].trim() : '';
      if (thread !== '') {
        const response = await caller.call('POST', `/api/v1/inbox/${encodeURIComponent(thread)}/messages`, {
          body,
        });
        if (response.status === 401) return toolError(signInFirst(caller));
        if (response.status !== 201) return toolError(message(response.body, 'Not sent.'));
        return text('Sent.', response.body);
      }
      const payload: Record<string, string> = { body };
      for (const key of ['candidate', 'employer', 'job', 'as', 'subject']) {
        if (typeof args[key] === 'string' && args[key] !== '') payload[key] = args[key] as string;
      }
      if (payload['candidate'] === undefined && payload['employer'] === undefined) {
        return toolError('Name who this is to: candidate, employer, or thread.');
      }
      const response = await caller.call('POST', '/api/v1/inbox', payload);
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 201 && response.status !== 200) {
        return toolError(message(response.body, 'Not sent.'));
      }
      const started = response.body as { threadId?: string; created?: boolean; url?: string };
      return text(
        `${started.created === false ? 'Added to the conversation you already have' : 'Sent'}. Thread ${started.threadId ?? ''}: ${started.url ?? ''}`,
        response.body,
      );
    }

    case 'send_invoice': {
      const thread = String(args['thread'] ?? '').trim();
      const response = await caller.call('POST', `/api/v1/inbox/${encodeURIComponent(thread)}/invoices`, {
        amount: String(args['amount'] ?? ''),
        ...(typeof args['currency'] === 'string' && args['currency'] !== '' ? { currency: args['currency'] } : {}),
        ...(typeof args['description'] === 'string' ? { description: args['description'] } : {}),
      });
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 201) return toolError(message(response.body, 'The invoice was not sent.'));
      const sent = response.body as { invoice?: { amountUsd?: string; currency?: string } };
      return text(
        `Invoice sent for $${sent.invoice?.amountUsd ?? ''} in ${sent.invoice?.currency ?? ''}. The other side sees Pay in the conversation.`,
        response.body,
      );
    }

    case 'pay_invoice': {
      const invoice = typeof args['invoice'] === 'string' ? args['invoice'].trim() : '';
      if (invoice === '') {
        const response = await caller.call('GET', '/api/v1/invoices');
        if (response.status === 401) return toolError(signInFirst(caller));
        if (response.status !== 200) return toolError(message(response.body, 'Could not list invoices.'));
        return text(JSON.stringify(response.body, null, 2), response.body);
      }
      const response = await caller.call('POST', `/api/v1/invoices/${encodeURIComponent(invoice)}/pay`);
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 200) return toolError(message(response.body, 'No quote.'));
      const result = response.body as {
        invoice?: { status?: string; payment?: { url?: string; address?: string; amountCrypto?: string } | null; currency?: string };
      };
      const inv = result.invoice;
      if (inv?.status === 'paid') return text('That invoice is already paid.', response.body);
      if (inv?.payment === null || inv?.payment === undefined) {
        return text('No quote came back. Try again in a moment.', response.body);
      }
      return text(
        `Pay at ${inv.payment.url ?? ''}${inv.payment.amountCrypto !== undefined && inv.payment.amountCrypto !== null ? ` (${inv.payment.amountCrypto} ${inv.currency ?? ''} to ${inv.payment.address ?? ''})` : ''}. The quote lasts a few minutes.`,
        response.body,
      );
    }

    case 'check_billing': {
      const response = await caller.call('GET', '/api/v1/coinpay');
      if (response.status === 401) return toolError(signInFirst(caller));
      if (response.status !== 200) return toolError(message(response.body, 'Could not read billing.'));
      const state = response.body as {
        configured?: boolean;
        account?: { usable?: boolean; wallets?: { chain: string; address: string }[] } | null;
        connectUrl?: string;
      };
      if (state.configured !== true) return text('This board has no billing configured.', response.body);
      if (state.account === null || state.account === undefined) {
        return text(`No CoinPay account connected. Connect one in a browser: ${state.connectUrl ?? ''}`, response.body);
      }
      if (state.account.usable !== true) {
        return text(`The CoinPay connection has lapsed. Reconnect in a browser: ${state.connectUrl ?? ''}`, response.body);
      }
      const wallets = state.account.wallets ?? [];
      return text(
        wallets.length === 0
          ? 'Connected, but the CoinPay account has no wallet yet. Add one on CoinPay and refresh on /me.'
          : `Connected. Can be paid in: ${wallets.map((w) => w.chain).join(', ')}.`,
        response.body,
      );
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
  salary?: { min?: number | null; max?: number | null; currency?: string; period?: string };
  pay?: Pay | null;
}

function summarise(items: unknown[], total: number, server: string): string {
  const lines = items.map((item) => {
    const job = item as JobLike;
    const stated = formatPayShort(
      payOfJob({
        pay: job.pay ?? null,
        salary:
          job.salary === undefined
            ? null
            : {
                min: job.salary.min ?? null,
                max: job.salary.max ?? null,
                currency: job.salary.currency ?? 'USD',
                period: job.salary.period ?? 'year',
              },
      }),
    );
    const pay = stated === null ? '' : ` - ${stated}`;
    return `- ${job.title ?? 'Untitled'} at ${job.org?.name ?? 'unknown'} (${job.workplace ?? '?'}${job.location ? `, ${job.location}` : ''})${pay} [${job.agentPolicy ?? '?'}] ${server}/jobs/${job.slug ?? ''}`;
  });
  return `${total} match on ${server}, showing ${items.length}:\n\n${lines.join('\n')}`;
}

function describeJob(body: unknown): string {
  const job = (body as { job?: JobLike }).job;
  if (job === undefined) return JSON.stringify(body, null, 2);
  return JSON.stringify(job, null, 2);
}
