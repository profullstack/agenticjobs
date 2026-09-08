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
        get: { tags: ['jobs'], summary: 'Employers with open listings.', responses: { 200: ok('Employers.') } },
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
      },
      '/api/v1/resumes/import': {
        post: {
          tags: ['resumes'],
          summary: 'Upload a PDF, DOCX, TXT or MD and get Markdown back.',
          security: [{ bearer: [] }],
          responses: { 201: ok('The converted resume.'), 400: err(), 413: err() },
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
