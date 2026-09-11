/**
 * The federation contract.
 *
 * These are mostly security tests. A directory fetches URLs that strangers
 * supplied, and a client merges documents those strangers wrote, so the rules
 * about what is accepted matter more here than anywhere else in the codebase.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDescriptor, publishable, PROTOCOL_VERSION } from '../dist/schema/instance.js';
import { parseQuery, queryToParams } from '../dist/schema/query.js';
import { jobPostingJsonLd } from '../dist/schema/jsonld.js';

test('loopback and private addresses are never listed', () => {
  for (const url of [
    'http://localhost:8787',
    'http://127.0.0.1',
    'http://[::1]',
    'http://[::]',
    'http://[fe80::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:10.0.0.5]',
    'http://[::ffff:169.254.169.254]',
    'http://[::127.0.0.1]',
    'http://10.0.0.5',
    'http://192.168.1.4',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://169.254.169.254',
    'http://board.local',
    'http://fd00::1',
    'ftp://example.com',
    'not a url',
  ]) {
    assert.equal(publishable(url), null, url);
  }
});

test('172.32 is public, which is the edge of that range people get wrong', () => {
  assert.notEqual(publishable('http://172.32.0.1'), null);
  assert.notEqual(publishable('https://example.com'), null);
  assert.notEqual(publishable('http://[::ffff:172.32.0.1]'), null);
});

test('only the origin survives, so credentials and paths cannot ride along', () => {
  const url = publishable('https://user:pass@example.com/some/path?q=1#x');
  assert.equal(url?.toString(), 'https://example.com/');
  assert.equal(url?.username, '');
});

const DESCRIPTOR = {
  protocol: PROTOCOL_VERSION,
  url: 'https://evil.example',
  name: 'Nice Board',
  tagline: 'Hello',
  topics: ['AI', 'ai', 'Engineering'],
  software: { name: 'agenticjobs', version: '0.1.0' },
  jobs: { open: 4, total: 9 },
  endpoints: {
    search: 'https://evil.example/steal',
    openapi: '/api/v1/openapi.json',
    mcp: '/api/mcp',
    feed: '/jobs.json',
  },
  directory: false,
  contact: null,
};

test('the url comes from where we fetched it, not from what it claims', () => {
  const parsed = parseDescriptor(DESCRIPTOR, 'https://good.example');
  assert.equal(parsed?.url, 'https://good.example');
});

test('an endpoint pointing off the origin falls back to the default path', () => {
  const parsed = parseDescriptor(DESCRIPTOR, 'https://good.example');
  // Otherwise every federated client in the network queries evil.example on
  // this instance's behalf, with the directory's blessing.
  assert.equal(parsed?.endpoints.search, 'https://good.example/api/v1/jobs');
  assert.equal(parsed?.endpoints.mcp, 'https://good.example/api/mcp');
});

test('topics are lowercased and capped', () => {
  const parsed = parseDescriptor(DESCRIPTOR, 'https://good.example');
  assert.deepEqual(parsed?.topics, ['ai', 'ai', 'engineering']);
});

test('a descriptor fetched from an unlistable address is refused', () => {
  assert.equal(parseDescriptor(DESCRIPTOR, 'http://127.0.0.1'), null);
  assert.equal(parseDescriptor(null, 'https://good.example'), null);
  assert.equal(parseDescriptor({}, 'https://good.example'), null);
});

test('control characters in a name cannot reach a terminal', () => {
  const parsed = parseDescriptor(
    { ...DESCRIPTOR, name: `Board${String.fromCharCode(27)}[31mRED` },
    'https://good.example',
  );
  assert.ok(!parsed?.name.includes(String.fromCharCode(27)), parsed?.name);
});

test('an unknown filter is dropped rather than failing the whole query', () => {
  // One node erroring where the rest return results is a shorter list with no
  // explanation, which is the failure mode this rule exists to prevent.
  const query = parseQuery(new URLSearchParams('q=rust&workplace=moon&seniority=wizard'));
  assert.equal(query.q, 'rust');
  assert.equal(query.workplace, null);
  assert.equal(query.seniority, null);
});

test('a query round-trips through its own params', () => {
  const original = parseQuery(
    new URLSearchParams('q=rust&workplace=remote&tag=a&tag=b&salaryMin=100000&sort=salary&limit=50'),
  );
  const round = parseQuery(queryToParams(original));
  assert.deepEqual(round, original);
});

test('limit and offset are clamped', () => {
  assert.equal(parseQuery(new URLSearchParams('limit=9999')).limit, 100);
  assert.equal(parseQuery(new URLSearchParams('limit=0')).limit, 1);
  assert.equal(parseQuery(new URLSearchParams('offset=-5')).offset, 0);
});

const JOB = {
  id: 'x',
  slug: 'staff-engineer',
  org: { id: 'o', slug: 'acme', name: 'Acme', website: 'https://acme.example', logoUrl: null, description: null, createdAt: '2026-01-01T00:00:00.000Z' },
  title: 'Staff Engineer',
  description: 'Body',
  employmentType: 'full-time',
  workplace: 'remote',
  seniority: 'staff',
  location: null,
  remoteRegions: ['DE', 'NL'],
  salary: { min: 100, max: 200, currency: 'usd', period: 'hour', equity: null },
  tags: ['a'],
  stack: ['typescript'],
  requirements: [],
  responsibilities: [],
  agentPolicy: 'welcome',
  apply: { via: 'board', schema: { fields: [] } },
  status: 'published',
  publishedAt: '2026-02-01T00:00:00.000Z',
  expiresAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('a remote job carries both TELECOMMUTE and a location requirement', () => {
  // Google validates a remote posting only if both are present, and a posting
  // with neither looks entirely correct until it silently fails to index.
  const jsonld = jobPostingJsonLd(JOB as never, 'https://board.example');
  assert.equal(jsonld['jobLocationType'], 'TELECOMMUTE');
  assert.deepEqual(jsonld['applicantLocationRequirements'], [
    { '@type': 'Country', name: 'DE' },
    { '@type': 'Country', name: 'NL' },
  ]);
});

test('an hourly rate is annualised for comparison, and the original is kept', () => {
  const jsonld = jobPostingJsonLd(JOB as never, 'https://board.example');
  const base = jsonld['baseSalary'] as { value: { minValue: number; unitText: string } };
  const estimated = jsonld['estimatedSalary'] as { value: { minValue: number; unitText: string } };
  assert.equal(base.value.minValue, 100);
  assert.equal(base.value.unitText, 'HOUR');
  assert.equal(estimated.value.minValue, 208_000);
  assert.equal(estimated.value.unitText, 'YEAR');
});

test('the agent policy travels where a validator will accept it', () => {
  const jsonld = jobPostingJsonLd(JOB as never, 'https://board.example');
  const extra = jsonld['additionalProperty'] as { name: string; value: string }[];
  const policy = extra.find((entry) => entry.name === 'agentPolicy');
  assert.equal(policy?.value, 'welcome');
  assert.ok(extra.some((entry) => entry.name === 'applySchemaUrl'));
  assert.equal(jsonld['directApply'], true);
});

for (const [label, min, max, expected] of [
  ['floor', 100, null, { minValue: 100 }],
  ['ceiling', null, 200, { maxValue: 200 }],
  ['range', 100, 200, { minValue: 100, maxValue: 200 }],
  ['fixed', 100, 100, { minValue: 100, maxValue: 100 }],
  ['zero floor', 0, null, { minValue: 0 }],
] as const) {
  test(`structured salary preserves the stated ${label}`, () => {
    const job = { ...JOB, salary: { ...JOB.salary, min, max } };
    const jsonld = jobPostingJsonLd(job as never, 'https://board.example');
    const base = jsonld['baseSalary'] as { value: Record<string, unknown> };
    const annual = jsonld['estimatedSalary'] as { value: Record<string, unknown> };
    assert.deepEqual(base.value, {
      '@type': 'QuantitativeValue', ...expected, unitText: 'HOUR',
    });
    assert.deepEqual(annual.value, {
      '@type': 'QuantitativeValue',
      ...Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value * 2080])),
      unitText: 'YEAR',
    });
  });
}

test('an unspecified structured salary does not become a zero salary', () => {
  const job = { ...JOB, salary: { ...JOB.salary, min: null, max: null } };
  const jsonld = jobPostingJsonLd(job as never, 'https://board.example');
  assert.equal(Object.hasOwn(jsonld, 'baseSalary'), false);
  assert.equal(Object.hasOwn(jsonld, 'estimatedSalary'), false);
});
