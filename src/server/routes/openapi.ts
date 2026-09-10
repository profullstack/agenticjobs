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
      {
        name: 'inbox',
        description: 'Private conversations. The only way to reach somebody here; there is no public commenting.',
      },
      {
        name: 'billing',
        description: "Invoices sent through the inbox, settled on CoinPay to the payee's own wallet.",
      },
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
            param(
              'salaryMin',
              'Minimum annualised salary, compared against the top of each range.',
              'integer',
            ),
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
          description:
            'Pay is required to publish. Send `pay` as an array of lines written the way a person says them ("$120k - $150k a year", "$0.25 per task", "$5000 fixed", "10% revenue share", "0.01 SOL per task"), or as objects with type, min, max, currency and unit; `payMethod` says how it is settled (SOL, USDC, bank transfer, PayPal); `unpaid: true` says the role pays nothing. With `publish: true` and no pay the request is refused with `pay_required` and nothing is created.',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['org', 'title', 'description'],
                  properties: {
                    org: { type: 'string' },
                    title: { type: 'string' },
                    description: { type: 'string', description: 'Markdown.' },
                    pay: {
                      type: 'array',
                      items: { oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/PayLine' }] },
                    },
                    payMethod: { type: 'string' },
                    payEquity: { type: 'string' },
                    unpaid: { type: 'boolean' },
                    agentPolicy: { type: 'string', enum: ['welcome', 'disclose', 'human-only'] },
                    publish: { type: 'boolean' },
                  },
                },
              },
            },
          },
          responses: { 201: ok('The job as stored.'), 400: err(), 401: err(), 403: err() },
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
      '/api/v1/applications/{id}/decision': {
        post: {
          tags: ['apply'],
          summary: 'Move an application to reviewing, rejected or hired.',
          description:
            'The employer side of an application. Members of the employer only; a caller who is not one gets the same 404 as a caller who named an application that does not exist, so the endpoint cannot be used to discover ids. Setting a decision does not notify the candidate - the board records what you decided and leaves telling them to you.',
          security: [{ bearer: [] }],
          parameters: [pathParam('id')],
          responses: {
            200: ok('The application, with its new status.'),
            400: err(),
            401: err(),
            404: err(),
          },
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
        patch: {
          tags: ['employers'],
          summary: 'Change an employer. Only the fields you send move.',
          description:
            'An absent field is left alone and an explicit null clears it, so a caller that knows about a name cannot blank a website it never read. Renaming never moves the slug: that slug is the URL every listing already points at.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('The employer.'), 400: err(), 401: err(), 403: err(), 404: err() },
        },
        delete: {
          tags: ['employers'],
          summary: 'Delete an employer that never published a listing.',
          description:
            'Listings and the applications sent to them cascade, so this is refused with 409 once anything has gone live. Drafts do not count: nobody has seen one.',
          security: [{ bearer: [] }],
          parameters: [pathParam('slug')],
          responses: { 200: ok('Deleted.'), 401: err(), 403: err(), 404: err(), 409: err() },
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
            'Serves a link-shared resume as well as a listed one. The Markdown is canonical. ' +
            'Called without a session or token, the contact block comes back with every ' +
            'channel withheld and contactRedacted set to true; the rest of the document is ' +
            'whole, and facts that are not channels, such as location, stay. Send a token to ' +
            'read the addresses.',
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
      '/api/v1/updates/{id}': {
        delete: {
          tags: ['updates'],
          summary: 'Delete an update you posted.',
          description:
            'Yours, or any update by the employer you post for. Anything else is a 404 rather than a 403, because the two are the same fact to a caller who should not be able to tell them apart.',
          security: [{ bearer: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: ok('Gone.'), 401: err(), 404: err() },
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
      '/api/v1/inbox': {
        get: {
          tags: ['inbox'],
          summary: 'Your conversations, newest activity first, with unread counts.',
          security: [{ bearer: [] }],
          responses: { 200: ok('Threads.'), 401: err() },
        },
        post: {
          tags: ['inbox'],
          summary: 'Write to a candidate or an employer. Continues the conversation you already have with them.',
          description:
            'Send {"candidate": slug} or {"employer": slug}, a "body", and optionally a "subject", a "job" slug the message is about, and "as": an employer slug to write on behalf of (you must belong to it). The same two parties about the same job is one conversation, so a second POST lands as a new message in it and answers 200 rather than 201. Twenty new conversations a day per account. The other side is emailed that there is a message, never the message itself. There is no public commenting on this board: this is how people are reached.',
          security: [{ bearer: [] }],
          responses: {
            200: ok('Added to the existing conversation: threadId, messageId, url.'),
            201: ok('A new conversation: threadId, messageId, url.'),
            400: err(),
            401: err(),
            404: err(),
            429: err(),
          },
        },
      },
      '/api/v1/inbox/{id}': {
        get: {
          tags: ['inbox'],
          summary: 'One conversation: its messages and the invoices in it. Opening it marks it read.',
          security: [{ bearer: [] }],
          parameters: [pathParam('id')],
          responses: { 200: ok('The thread and its invoices.'), 401: err(), 404: err() },
        },
      },
      '/api/v1/inbox/{id}/messages': {
        post: {
          tags: ['inbox'],
          summary: 'Reply in a conversation you are in.',
          security: [{ bearer: [] }],
          parameters: [pathParam('id')],
          responses: { 201: ok('The message.'), 400: err(), 401: err(), 404: err() },
        },
      },
      '/api/v1/inbox/{id}/invoices': {
        post: {
          tags: ['billing'],
          summary: 'Send an invoice into a conversation. You are the payee.',
          description:
            'Send "amount" in US dollars, "description", and "currency": a chain you hold a wallet for on your connected CoinPay account (BTC, ETH, SOL, USDC_POL ...). Omit currency when you have exactly one wallet. The payment settles on CoinPay straight to that wallet; this board never holds it. Needs a connected CoinPay account with wallet:read, which is done in a browser at /me/coinpay/connect.',
          security: [{ bearer: [] }],
          parameters: [pathParam('id')],
          responses: { 201: ok('The invoice.'), 400: err(), 401: err(), 404: err() },
        },
      },
      '/api/v1/invoices': {
        get: {
          tags: ['billing'],
          summary: 'Every invoice you sent or can pay, newest first.',
          security: [{ bearer: [] }],
          responses: { 200: ok('Invoices.'), 401: err() },
        },
      },
      '/api/v1/invoices/{id}': {
        get: {
          tags: ['billing'],
          summary: 'One invoice, with its payment state checked against CoinPay.',
          security: [{ bearer: [] }],
          parameters: [pathParam('id')],
          responses: { 200: ok('The invoice.'), 401: err(), 404: err() },
        },
      },
      '/api/v1/invoices/{id}/pay': {
        post: {
          tags: ['billing'],
          summary: 'Get a live quote to pay an invoice you were sent.',
          description:
            'Returns the invoice with "payment" filled in: "url" is the CoinPay page to pay on, "address" and "amountCrypto" let a wallet pay directly. A quote lasts a few minutes; call again for a fresh one. Paid is reported by the webhook and by reading the invoice.',
          security: [{ bearer: [] }],
          parameters: [pathParam('id')],
          responses: { 200: ok('The invoice with a payment to make.'), 400: err(), 401: err(), 404: err() },
        },
      },
      '/api/v1/invoices/{id}/cancel': {
        post: {
          tags: ['billing'],
          summary: 'Take back an unpaid invoice you sent.',
          security: [{ bearer: [] }],
          parameters: [pathParam('id')],
          responses: { 200: ok('Cancelled.'), 401: err(), 404: err(), 409: err() },
        },
      },
      '/api/v1/coinpay': {
        get: {
          tags: ['billing'],
          summary: 'Whether this board has billing, and whether your CoinPay account is connected.',
          description:
            '"configured" is the board; "account" is you, with "usable" saying whether the connection can read your wallets (a connection without the wallet:read scope shows here as not usable and has to be reconnected). Connecting is a browser step at "connectUrl".',
          security: [{ bearer: [] }],
          responses: { 200: ok('Connection state.'), 401: err() },
        },
        delete: {
          tags: ['billing'],
          summary: 'Disconnect your CoinPay account. Invoices already sent keep their wallet.',
          security: [{ bearer: [] }],
          responses: { 200: ok('Disconnected.'), 401: err() },
        },
      },
      '/api/v1/coinpay/callback': {
        get: {
          tags: ['billing'],
          summary: 'Where CoinPay sends a browser back after consent. Not for calling directly.',
          parameters: [param('code', 'From CoinPay.'), param('state', 'From CoinPay.')],
          responses: { 303: { description: 'Back to the board.' }, 400: err(), 404: err() },
        },
      },
      '/api/v1/coinpay/webhook': {
        post: {
          tags: ['billing'],
          summary: 'CoinPay reporting a settled payment. Signed with the business webhook secret.',
          responses: { 200: ok('Received.'), 401: err(), 404: err() },
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
          description:
            'Publishing requires the listing to say what it pays: at least one pay line with an amount, or unpaid. Otherwise 400 with code pay_required, and the listing stays as it was.',
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
          responses: { 200: ok('The listing.'), 400: err(), 401: err(), 403: err(), 404: err() },
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
            pay: { $ref: '#/components/schemas/Pay' },
            salary: {
              type: 'object',
              description:
                'The first time-based pay line, flattened: min, max, currency, period, equity, unpaid. Kept for readers written before `pay` existed and for the salary filter and sort. A listing that pays per task has a null range here.',
            },
            tags: { type: 'array', items: { type: 'string' } },
            stack: { type: 'array', items: { type: 'string' } },
          },
        },
        Pay: {
          type: 'object',
          description:
            'What a listing pays, in full. Required to publish: at least one line with an amount, or unpaid.',
          properties: {
            lines: { type: 'array', items: { $ref: '#/components/schemas/PayLine' } },
            method: {
              type: 'string',
              nullable: true,
              description: 'How it is settled: a coin (SOL, USDC, ETH, USDT, POL) or a rail (bank transfer, PayPal, payroll).',
            },
            equity: { type: 'string', nullable: true },
            unpaid: { type: 'boolean' },
          },
        },
        PayLine: {
          type: 'object',
          description:
            'One price. The same vocabulary as a ugig.net gig budget: a type, a range, what it is denominated in, and for per_task and per_unit what one unit is.',
          required: ['type', 'currency'],
          properties: {
            type: {
              type: 'string',
              enum: ['hourly', 'daily', 'weekly', 'monthly', 'yearly', 'fixed', 'per_task', 'per_unit', 'revenue_share', 'bounty'],
            },
            min: { type: 'number', nullable: true },
            max: { type: 'number', nullable: true },
            currency: { type: 'string', description: 'USD, EUR, or a ticker such as SOL. "%" for a revenue share.' },
            unit: { type: 'string', nullable: true, description: 'For per_task and per_unit: "task", "PR that fixes a bug you find".' },
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
