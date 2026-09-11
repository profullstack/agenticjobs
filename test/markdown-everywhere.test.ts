/**
 * Every box a person can type prose into takes plain text or Markdown, and
 * every page that shows what they typed renders it the same way.
 *
 * The listing description and the resume were Markdown from the first day.
 * Messages, updates, recommendations, invoice descriptions, employer profiles
 * and cover letters were shown as text with their line breaks kept, so a
 * pasted bullet list arrived as asterisks. These assert one rule for all of
 * them: Markdown marks up, plain text reads as written, and nothing typed
 * becomes a tag.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadPage, InvoiceCard } from '../dist/views/inbox.js';
import { UpdateItem, UpdateComposer } from '../dist/views/updates.js';
import { RecommendationItem } from '../dist/views/recommendations.js';
import { EmployerDetail, EmployerList, JobDetail } from '../dist/views/jobs.js';
import { ManageJobPage } from '../dist/views/post.js';
import { EMPTY_QUERY } from '../dist/schema/query.js';
import type { Job, Organisation } from '../src/schema/job.ts';

const MARKDOWN =
  'Two things:\n\n- **paid** on time\n- a link to [the brief](https://example.com/brief)\n\n<script>alert(1)</script>';
const PLAIN = 'First line\nsecond line';

/** What every body has to satisfy, whatever page it is on. */
function assertRendered(html: string, where: string): void {
  assert.match(
    html,
    /<ul><li><strong>paid<\/strong> on time<\/li>/,
    `${where}: a list and emphasis`,
  );
  assert.match(
    html,
    /<a href="https:\/\/example\.com\/brief" rel="nofollow ugc noopener noreferrer">the brief<\/a>/,
    `${where}: a link, marked as somebody else's`,
  );
  assert.ok(!html.includes('<script>'), `${where}: a typed tag must never reach the page`);
  assert.match(html, /&lt;script&gt;/, `${where}: the tag is shown as the text it was`);
}

/** Plain text keeps the author's line breaks and gains nothing else. */
function assertPlain(html: string, where: string): void {
  assert.match(html, /First line<br \/>second line/, `${where}: a single newline is a line break`);
}

const org: Organisation = {
  id: 'org',
  slug: 'acme',
  name: 'Acme',
  website: null,
  logoUrl: null,
  description: `# About us\n\n${MARKDOWN}`,
  createdAt: '2026-01-01T00:00:00Z',
};

const job: Job = {
  id: 'job',
  slug: 'go-engineer',
  title: 'Go engineer',
  description: 'A listing.',
  org,
  employmentType: 'full-time',
  workplace: 'remote',
  seniority: null,
  location: null,
  remoteRegions: [],
  tags: [],
  stack: [],
  requirements: [],
  responsibilities: [],
  salary: { min: null, max: null, currency: 'USD', period: 'year', equity: null, unpaid: false },
  agentPolicy: 'welcome',
  apply: {
    via: 'board',
    schema: {
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 100 },
        { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 200 },
        { name: 'cover', label: 'Why you', type: 'textarea', required: true, maxLength: 5000 },
        { name: 'phone', label: 'Phone', type: 'text', required: false, maxLength: 40 },
      ],
    },
  },
  status: 'published',
  publishedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
};

const sender = {
  id: 'them',
  name: 'Ada',
  party: { kind: 'candidate' as const, name: 'Ada', slug: 'ada' },
};

test('a message in a thread renders Markdown, and plain text as it was typed', () => {
  const thread = {
    id: 't1',
    subject: 'The brief',
    job: null,
    with: sender.party,
    participants: [{ userId: 'me', name: 'Me', orgId: null }],
    messages: [
      {
        id: 'm1',
        kind: 'text' as const,
        body: MARKDOWN,
        invoiceId: null,
        createdAt: '2026-01-01T00:00:00Z',
        sender,
        mine: false,
      },
      {
        id: 'm2',
        kind: 'text' as const,
        body: `# Shouting\n${PLAIN}`,
        invoiceId: null,
        createdAt: '2026-01-01T00:00:00Z',
        sender,
        mine: true,
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
  };
  const html = String(
    ThreadPage({
      thread,
      invoices: [],
      viewerId: 'me',
      billing: { enabled: false, account: null },
    }),
  );
  assertRendered(html, 'message');
  assertPlain(html, 'message');
  // A "# heading" in a message must not outrank the page's own title.
  assert.match(html, /<h3>Shouting<\/h3>/, 'a message heading is pushed under the page');
  assert.match(html, /Plain text or Markdown\./, 'the reply box says what it takes');
});

test('an invoice description is prose too', () => {
  const invoice = {
    id: 'i1',
    threadId: 't1',
    amountUsd: '100.00',
    currency: 'USDC',
    description: MARKDOWN,
    status: 'sent' as const,
    payee: { id: 'them', name: 'Ada' },
    walletAddress: '0xabc',
    payment: null,
    paidAt: null,
    txHash: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
  const html = String(InvoiceCard({ invoice: invoice as never, threadId: 't1', viewerId: 'me' }));
  assertRendered(html, 'invoice');
});

test('an update renders Markdown and the composer says so', () => {
  const update = {
    id: 'u1',
    body: MARKDOWN,
    link: null,
    createdAt: '2026-01-01T00:00:00Z',
    author: { kind: 'employer' as const, name: 'Acme', slug: 'acme' },
  };
  assertRendered(String(UpdateItem({ update, showAuthor: true })), 'update');
  assertPlain(String(UpdateItem({ update: { ...update, body: PLAIN } })), 'update');
  assert.match(
    String(UpdateComposer({ action: '/updates', as: 'Acme', max: 600 } as never)),
    /Plain text or Markdown\./,
  );
});

test('a recommendation renders Markdown', () => {
  const item = {
    id: 'r1',
    body: MARKDOWN,
    relationship: null,
    status: 'approved' as const,
    author: { kind: 'employer' as const, name: 'Acme', slug: 'acme' },
    subject: { kind: 'candidate' as const, name: 'Ada', slug: 'ada' },
    createdAt: '2026-01-01T00:00:00Z',
    decidedAt: null,
  };
  assertRendered(String(RecommendationItem({ item })), 'recommendation');
  assertPlain(String(RecommendationItem({ item: { ...item, body: PLAIN } })), 'recommendation');
});

test('an employer profile is prose on its page and beside a listing, and text in the list', () => {
  const page = { items: [], total: 0, page: 1, perPage: 20, pages: 0 };
  const detail = String(EmployerDetail({ org, page: page as never, query: EMPTY_QUERY }));
  assertRendered(detail, 'employer page');
  // The page's h1 is the employer's name; the profile's own heading sits under it.
  assert.match(detail, /<h2>About us<\/h2>/);

  const beside = String(
    JobDetail({ job, html: '<p>A listing.</p>', publicUrl: 'https://x.test' } as never),
  );
  assertRendered(beside, 'employer beside a listing');

  const list = String(EmployerList({ orgs: [org] }));
  assert.ok(!list.includes('<ul><li>'), 'a card summary is one line of text, not a document');
  assert.match(list, /About us Two things: - paid on time/, 'the summary is the words');
  assert.ok(!list.includes('<script>'));
});

test('a cover letter renders Markdown; a one-line answer stays a line', () => {
  const application = {
    id: 'a1',
    jobId: 'job',
    answers: { name: 'Ada', email: 'ada@example.com', cover: MARKDOWN, phone: '**not bold**' },
    agent: null,
    status: 'submitted' as const,
    submittedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    resume: null,
    resumeTitle: null,
  };
  const html = String(
    ManageJobPage({
      job,
      html: '<p>A listing.</p>',
      applications: [application as never],
      publicUrl: 'https://x.test',
    }),
  );
  assertRendered(html, 'cover letter');
  assert.match(html, /<strong>phone:<\/strong> \*\*not bold\*\*/, 'a text field is not parsed');
});
