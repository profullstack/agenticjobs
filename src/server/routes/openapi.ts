/**
 * The OpenAPI document, written by hand.
 *
 * Hand-written because it is read by people and by models deciding what this
 * board can do, and a generated one describes the router rather than the
 * board. test/api.test.ts walks every documented GET against the real routes,
 * so a path that drifts out of this file fails the suite rather than quietly
 * lying to whoever reads it.
 */

import type { Config } from '../../config.ts';

export function openApiDocument(config: Config): Record<string, unknown> {
  const job = { $ref: '#/components/schemas/Job' };

  return {
    openapi: '3.1.0',
    info: {
      title: `${config.boardName} API`,
      version: config.version,
      summary: 'An agent-friendly job board. Its own listings, never scraped.',
      description: [
        'Every listing on this board was posted to it. Nothing here is scraped',
        'from anywhere else, so a job you find has an employer behind it who',
        'chose to be here.',
        '',
        'Reads need no credentials. To apply, GET the apply-schema for a job and',
        'POST the answers back; the schema tells you the exact fields and whether',
        'the employer wants agent-written applications disclosed.',
        '',
        'Resumes are Markdown, in the OpenResume.md convention. Send one inline as',
        '`resume`, or reference one you have saved.',
      ].join('\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: config.publicUrl }],
    tags: [
      { name: 'jobs', description: 'Search, read and post listings.' },
      { name: 'apply', description: 'The application flow an agent can complete.' },
      { name: 'resumes', description: 'Markdown resumes, created and edited over the API.' },
      { name: 'candidates', description: 'People who published a resume here.' },
      { name: 'employers', description: 'The organisations a listing belongs to.' },
      { name: 'updates', description: 'Short posts from employers and candidates, and following them.' },
      { name: 'auth', description: 'Device flow for terminals, magic links for browsers.' },
      { name: 'federation', description: 'The directory of instances, and search across them.' },
    ],
    paths: {
      '/api/v1/jobs': {
        get: {
          tags: ['jobs'],
          summary: 'Search this board.',
          parameters: [
            param('q', 'Full text over title, description, tags and stack.'),
            param('employmentType', 'full-time, part-time, contract, internship, temporary'),
            param('workplace', 'remote, hybrid, onsite'),
            param('seniority', 'intern, junior, mid, senior, staff, principal, lead'),
            param('agentPolicy', 'welcome, disclose, human-only'),
            param('tag', 'Repeatable. Matches tags and stack.'),
            param('salaryMin', 'Minimum, compared against the top of each range.', 'integer'),
            param('org', 'Employer slug.'),
            param('sort', 'recent, relevant, salary'),
            param('limit', '1-100, default 25', 'integer'),
            param('offset', 'default 0', 'integer'),
          ],
          responses: {
            200: page('A page of jobs.', job),
          },
        },
        post: {
          tags: ['jobs'],
          summary: 'Post a job. Creates a draft unless publish is true.',
          security: [{ bearer: [] }],
          responses: { 201: ok('The job as stored.'), 401: err(), 403: err() },
        },
      },
      '/api/v1/jobs/{slug}': {
        get: {
          tags: ['jobs'],
          summary: 'One job, with its description rendered and its JSON-LD.',
          parameters: [pathParam('slug')],
          responses: { 200: ok('The job.'), 404: err() },
        },
        patch: {
          tags: ['jobs'],
          summary: 'Edit a listing, keeping its URL.',
          description:
            'Only the fields sent are touched. The slug never changes, because the slug is the listing everybody already has a link to.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('The listing.'), 400: err(), 401: err(), 403: err(), 404: err() },
        },
      },
      '/api/v1/jobs/{slug}/apply-schema': {
        get: {
          tags: ['apply'],
          summary: 'The fields to fill in, and where to send them.',
          description:
            'Start here. The response says whether this employer takes applications on the board at all, what the fields are, and whether an agent-written application has to say so.',
          parameters: [pathParam('slug')],
          responses: { 200: ok('The application schema.'), 404: err() },
        },
      },
      '/api/v1/jobs/{slug}/apply': {
        post: {
          tags: ['apply'],
          summary: 'Apply.',
          parameters: [pathParam('slug')],
          responses: { 201: ok('Accepted.'), 400: err(), 404: err(), 429: err() },
        },
      },
      '/api/v1/jobs/{slug}/applications': {
        get: {
          tags: ['apply'],
          summary: 'Applications to a job. Members of the employer only.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('The applications.'), 401: err(), 403: err() },
        },
      },
      '/api/v1/applications/drafts': {
        get: {
          tags: ['apply'],
          summary: 'Applications you have prepared but not sent.',
          description:
            'An agent can prepare an application and leave it here; a person releases it. The mirror of a job posting starting as a draft.',
          security: [{ bearer: [] }],
          responses: { 200: ok('Your drafts.'), 401: err() },
        },
      },
      '/api/v1/applications/{id}/submit': {
        post: {
          tags: ['apply'],
          summary: 'Send a draft application.',
          security: [{ bearer: [] }],
          parameters: [pathParam('id')],
          responses: { 200: ok('Sent.'), 401: err(), 404: err() },
        },
      },
      '/api/v1/orgs': {
        get: { tags: ['employers'], summary: 'Employers with open listings.', responses: { 200: ok('Employers.') } },
        post: {
          tags: ['employers'],
          // Worth saying out loud: you cannot post a job until you have one of
          // these, and nothing else in the API tells you that.
          summary: 'Add an employer. A job belongs to one, so this comes first.',
          security: [{ bearer: [] }],
          responses: { 201: ok('The employer.'), 400: err(), 401: err() },
        },
      },
      '/api/v1/orgs/{slug}': {
        get: {
          tags: ['jobs'],
          summary: 'One employer and its open listings.',
          parameters: [pathParam('slug')],
          responses: { 200: ok('The employer.'), 404: err() },
        },
      },
      '/api/v1/me': {
        get: {
          tags: ['auth'],
          summary: 'Who this token belongs to, with their employers and resumes.',
          security: [{ bearer: [] }],
          responses: { 200: ok('The caller.'), 401: err() },
        },
      },
      '/api/v1/candidates': {
        get: {
          tags: ['candidates'],
          summary: 'Everyone who published a resume. Public.',
          description:
            'Add ?tags=javascript,react to narrow: several tags mean a candidate who lists all of them.',
          parameters: [
            {
              name: 'tags',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Comma separated. Matched whole and case-insensitively.',
            },
          ],
          responses: { 200: ok('Candidates.') },
        },
      },
      '/api/v1/candidates/{slug}': {
        get: {
          tags: ['candidates'],
          summary: 'One candidate, with their resume as Markdown. Public.',
          description:
            'Serves a link-shared resume as well as a listed one. The Markdown is canonical.',
          parameters: [pathParam('slug')],
          responses: { 200: ok('The candidate.'), 404: err() },
        },
      },
      '/api/v1/updates': {
        get: {
          tags: ['updates'],
          summary: 'Updates from employers and candidates. Public.',
          description:
            'Add ?org=slug or ?candidate=slug for one author. ?following=true is your own feed and is the only form that needs a credential. The same parameters read as Markdown at /updates.md and as RSS at /updates/feed.',
          parameters: [
            {
              name: 'org',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: "An employer's slug.",
            },
            {
              name: 'candidate',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: "A candidate's slug.",
            },
            {
              name: 'following',
              in: 'query',
              required: false,
              schema: { type: 'boolean' },
              description: 'Only from who you follow. Needs a credential.',
            },
          ],
          responses: { 200: ok('Updates.'), 401: err(), 404: err() },
        },
        post: {
          tags: ['updates'],
          summary: 'Post an update.',
          description:
            'With "org", as that employer, and only if you post for them. Without it, as yourself, which requires a published resume so the update has a page behind it. At most 600 characters and one link, five a day per author, and no two the same.',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['body'],
                  properties: {
                    body: { type: 'string', maxLength: 600 },
                    link: { type: 'string', format: 'uri' },
                    org: { type: 'string', description: "Post as this employer instead of as yourself." },
                  },
                },
              },
            },
          },
          responses: { 201: ok('The update.'), 400: err(), 401: err(), 403: err(), 404: err(), 429: err() },
        },
      },
      '/api/v1/orgs/{slug}/follow': {
        post: {
          tags: ['updates'],
          summary: 'Follow an employer.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('Whether you follow them, and how many do.'), 401: err(), 404: err() },
        },
        delete: {
          tags: ['updates'],
          summary: 'Stop following an employer.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('Whether you follow them, and how many do.'), 401: err(), 404: err() },
        },
      },
      '/api/v1/candidates/{slug}/follow': {
        post: {
          tags: ['updates'],
          summary: 'Follow a candidate.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('Whether you follow them, and how many do.'), 401: err(), 404: err() },
        },
        delete: {
          tags: ['updates'],
          summary: 'Stop following a candidate.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('Whether you follow them, and how many do.'), 401: err(), 404: err() },
        },
      },
      '/api/v1/me/following': {
        get: {
          tags: ['updates'],
          summary: 'Who you follow.',
          security: [{ bearer: [] }],
          responses: { 200: ok('Employers and candidates you follow.'), 401: err() },
        },
      },
      '/api/v1/jobs/import': {
        post: {
          tags: ['jobs'],
          summary: 'Import a job from a URL, as a draft.',
          description:
            'Reads schema.org JobPosting when the page publishes it and the readable page when it does not, and says which. Importing the same URL again refreshes that listing rather than making a second one; pass "slug" to adopt a listing written by hand.',
          security: [{ bearer: [] }],
          responses: {
            200: ok('The refreshed listing.'),
            201: ok('The imported draft.'),
            400: err(),
            401: err(),
            403: err(),
            404: err(),
          },
        },
      },
      '/api/v1/resumes': {
        get: {
          tags: ['resumes'],
          summary: 'Your resumes.',
          security: [{ bearer: [] }],
          responses: { 200: ok('Resumes.'), 401: err() },
        },
        post: {
          tags: ['resumes'],
          summary: 'Create one from Markdown.',
          security: [{ bearer: [] }],
          responses: { 201: ok('The resume.'), 400: err(), 401: err() },
        },
      },
      '/api/v1/resumes/{slug}': {
        get: {
          tags: ['resumes'],
          summary: 'One resume, as Markdown and as HTML.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('The resume.'), 401: err(), 404: err() },
        },
        patch: {
          tags: ['resumes'],
          summary: 'Edit it. Sharing it is what mints its public address.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('The resume.'), 401: err(), 404: err() },
        },
        delete: {
          tags: ['resumes'],
          summary: 'Delete it.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('Deleted.'), 401: err(), 404: err() },
        },
      },
      '/api/v1/resumes/import': {
        post: {
          tags: ['resumes'],
          summary: 'Upload a PDF, DOCX, TXT or MD and get Markdown back.',
          security: [{ bearer: [] }],
          responses: { 201: ok('The converted resume.'), 400: err(), 413: err() },
        },
      },
      '/api/v1/jobs/{slug}/{action}': {
        post: {
          tags: ['jobs'],
          summary: 'publish, close or reopen a listing.',
          security: [{ bearer: [] }],
          parameters: [
            pathParam('slug'),
            {
              name: 'action',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['publish', 'close', 'reopen'] },
            },
          ],
          responses: { 200: ok('The listing.'), 401: err(), 403: err(), 404: err() },
        },
      },
      '/api/v1/auth/magic-link': {
        post: {
          tags: ['auth'],
          summary: 'Email a sign-in link.',
          description:
            'The link is emailed and never returned here. `delivered` reports a send that happened; false means it went to the server log instead.',
          responses: { 200: ok('Whether it was delivered.'), 400: err() },
        },
      },
      '/api/v1/auth/device/approve': {
        post: {
          tags: ['auth'],
          summary: 'Approve a terminal, from a signed-in session.',
          security: [{ bearer: [] }],
          responses: { 200: ok('Approved.'), 400: err(), 401: err() },
        },
      },
      '/api/v1/directory/topics': {
        get: {
          tags: ['federation'],
          summary: 'What the listed boards are about. Directories only.',
          responses: { 200: ok('Topics.'), 404: err() },
        },
      },
      '/api/v1/descriptor': {
        get: {
          tags: ['federation'],
          summary: 'This instance, as it describes itself.',
          responses: { 200: ok('The descriptor.') },
        },
      },
      '/api/v1/openapi.json': {
        get: {
          tags: ['federation'],
          summary: 'This document.',
          responses: { 200: ok('The document you are reading.') },
        },
      },
      '/api/v1/auth/device': {
        post: {
          tags: ['auth'],
          summary: 'Start the device flow. Returns a code a human approves in a browser.',
          responses: { 200: ok('The grant.') },
        },
      },
      '/api/v1/auth/device/poll': {
        post: {
          tags: ['auth'],
          summary: 'Poll until approved. The token is handed over exactly once.',
          responses: { 200: ok('pending, approved or expired.') },
        },
      },
      '/api/v1/directory/instances': {
        get: {
          tags: ['federation'],
          summary: 'Instances this directory knows about. Directories only.',
          responses: { 200: ok('Instances.'), 404: err() },
        },
      },
      '/api/v1/directory/search': {
        get: {
          tags: ['federation'],
          summary: 'One search, every listed instance. Directories only.',
          description:
            'Results carry the instance they came from. An instance that fails to answer is reported in `sources` rather than silently omitted.',
          responses: { 200: ok('Merged results.'), 404: err() },
        },
      },
      '/api/v1/directory/announce': {
        post: {
          tags: ['federation'],
          summary: 'Announce an instance. Send only its URL; the directory reads the rest itself.',
          responses: { 200: ok('The listing.'), 400: err(), 403: err(), 404: err() },
        },
      },
      '/api/v1/stats': {
        get: { tags: ['jobs'], summary: 'Open and total counts for this board.', responses: { 200: ok('Counts.') } },
      },
      '/.well-known/agenticjobs': {
        get: {
          tags: ['federation'],
          summary: 'This instance, described. The federation contract.',
          responses: { 200: ok('The descriptor.') },
        },
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'A token from the device flow.' },
      },
      schemas: {
        Job: {
          type: 'object',
          required: ['id', 'slug', 'title', 'org', 'agentPolicy', 'apply'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            slug: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string', description: 'Markdown.' },
            employmentType: { type: 'string' },
            workplace: { type: 'string', enum: ['remote', 'hybrid', 'onsite'] },
            seniority: { type: 'string', nullable: true },
            agentPolicy: {
              type: 'string',
              enum: ['welcome', 'disclose', 'human-only'],
              description:
                'Where the employer stands on applications written with an agent. Required on every listing, because the alternative is finding out by silent rejection.',
            },
            apply: { type: 'object' },
            tags: { type: 'array', items: { type: 'string' } },
            stack: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
}

function param(name: string, description: string, type = 'string'): Record<string, unknown> {
  return { name, in: 'query', required: false, description, schema: { type } };
}

function pathParam(name: string): Record<string, unknown> {
  return { name, in: 'path', required: true, schema: { type: 'string' } };
}

function ok(description: string): Record<string, unknown> {
  return { description, content: { 'application/json': { schema: { type: 'object' } } } };
}

function page(description: string, items: unknown): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items },
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
        },
      },
    },
  };
}

function err(): Record<string, unknown> {
  return {
    description: 'An error with a message you can act on.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                code: { type: 'string' },
                fields: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
    },
  };
}
