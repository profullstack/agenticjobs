/**
 * The Your listings tab's bottom bar has always promised `enter:
 * applications`, because reading what came back is the employer half of the
 * TUI. What enter actually opened was the job detail - same as the find tab -
 * complete with "a: apply" and "d: prepare draft" hints, against the
 * employer's own listing. These tests pin the real behavior: enter on your
 * own listing reads its applications, and nothing in the TUI invites you to
 * apply to yourself.
 *
 * State and views are pure, so hqtui's renderToText exercises the real
 * layout without a terminal.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToText } from '@profullstack/hqtui';
import {
  initialState,
  keyHints,
  nextTab,
  type ApplicationRow,
  type TuiState,
} from '../dist/tui/state.js';
import { render } from '../dist/tui/views.js';
import type { Job } from '../dist/schema/index.js';

const listing: Job = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'platform-engineer',
  org: {
    id: '00000000-0000-4000-8000-000000000002',
    slug: 'example-works',
    name: 'Example Works',
    website: null,
    logoUrl: null,
    description: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  title: 'Platform Engineer',
  description: 'Keep the deploys boring.',
  employmentType: 'full-time',
  workplace: 'remote',
  seniority: null,
  location: null,
  remoteRegions: [],
  pay: { lines: [], method: null, equity: null, unpaid: false },
  salary: {
    min: null,
    max: null,
    currency: 'USD',
    period: 'year',
    equity: null,
    unpaid: false,
  },
  tags: [],
  stack: ['postgres'],
  requirements: [],
  responsibilities: [],
  agentPolicy: 'welcome',
  apply: { via: 'board', schema: { fields: [] } },
  status: 'published',
  publishedAt: '2026-09-19T00:00:00.000Z',
  expiresAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
};

const application: ApplicationRow = {
  id: '00000000-0000-4000-8000-000000000003',
  answers: { name: 'Ada Example', email: 'ada@example.com', cover: 'I keep deploys boring.' },
  agent: { name: 'herder-7', supervised: true },
  status: 'new',
  createdAt: '2026-09-20T00:00:00.000Z',
};

function listingsTab(over: Partial<TuiState> = {}): TuiState {
  return {
    ...initialState('https://board.example'),
    tab: 'listings',
    canPost: true,
    signedIn: true,
    listings: [listing],
    ...over,
  };
}

function text(state: TuiState): string {
  return renderToText(({ ui, theme }) => render(ui, theme, state), {
    width: 120,
    height: 40,
  });
}

test('an open listing shows what came back, with the applicant named', () => {
  const opened = listingsTab({ detail: listing, applications: [application] });
  const frame = text(opened);
  assert.ok(frame.includes('Applications (1)'), frame);
  assert.ok(frame.includes('Ada Example'), frame);
  assert.ok(frame.includes('ada@example.com'), frame);
  assert.ok(frame.includes('agent: herder-7 (supervised)'), frame);
});

test('reading applications offers no apply or draft keys against your own listing', () => {
  const opened = listingsTab({ detail: listing, applications: [application] });
  const labels = keyHints(opened).map((hint) => hint.label);
  assert.ok(!labels.includes('apply'), labels.join(','));
  assert.ok(!labels.includes('prepare draft'), labels.join(','));
  const frame = text(opened);
  assert.ok(!/\bapply\b/i.test(frame), frame);
  assert.ok(!frame.includes('prepare draft'), frame);
});

test('a listing nobody answered says so instead of showing an apply form', () => {
  const opened = listingsTab({ detail: listing, applications: [] });
  assert.ok(text(opened).includes('Nobody yet.'));
});

test('the find tab detail is unchanged: it is the one place apply belongs', () => {
  const opened = {
    ...initialState('https://board.example'),
    jobs: [listing],
    detail: listing,
    applications: null,
  };
  const labels = keyHints(opened).map((hint) => hint.label);
  assert.ok(labels.includes('apply'), labels.join(','));
  assert.ok(labels.includes('prepare draft'), labels.join(','));
});

test('changing tabs drops an open listing and its applications together', () => {
  const opened = listingsTab({ detail: listing, applications: [application] });
  const moved = nextTab(opened, 1);
  assert.equal(moved.detail, null);
  assert.equal(moved.applications, null);
});
