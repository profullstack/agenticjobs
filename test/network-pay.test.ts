import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetworkSearchPage } from '../dist/views/network.js';
import { EMPTY_QUERY } from '../dist/schema/query.js';
import { normalisePay } from '../dist/schema/pay.js';

const emptySalary = { min: null, max: null, currency: 'USD', period: 'year', equity: null };

function render(payInput?: Record<string, unknown>, salary = emptySalary): string {
  const pay = payInput === undefined ? undefined : normalisePay(payInput);
  if (typeof pay === 'string') throw new Error(pay);
  const job = {
    id: 'job', slug: 'paid-task', title: 'Data formatting task', description: '',
    org: { slug: 'buyer', name: 'Buyer' },
    employmentType: 'contract', workplace: 'remote', seniority: null,
    location: null, remoteRegions: [], salary, pay,
    tags: [], stack: [], requirements: [], responsibilities: [],
    agentPolicy: 'welcome', apply: { via: 'board', schema: { fields: [] } },
    status: 'published', publishedAt: null, expiresAt: null, createdAt: '', updatedAt: '',
  };
  return String(NetworkSearchPage({
    query: EMPTY_QUERY,
    result: {
      jobs: [{ job, instance: 'https://board.example', instanceName: 'Board',
        url: 'https://board.example/jobs/paid-task' }],
      sources: [], total: 1,
    },
  }));
}

for (const [description, pay, expected] of [
  ['per-task payment', ['$0.25 per task'], '$0.25 per task'],
  ['custom-unit payment', ['$0.25 per PR'], '$0.25 per PR'],
  ['multiple payment lines', ['$5 fixed', '$1 per task'], '$5 fixed +1'],
  ['fractional coin rate', ['0.00000001 BTC an hour'], '0.00000001 BTC an hour'],
] as const) {
  test(`network search displays ${description} from the full pay field`, () => {
    assert.ok(render({ pay: [...pay] }).includes(`<span class="job-salary">${expected}</span>`));
  });
}

test('an explicit unpaid pay field overrides an obsolete salary range', () => {
  const html = render({ pay: { unpaid: true, lines: [] } },
    { ...emptySalary, min: 120_000, max: 160_000 });
  assert.match(html, /<span class="job-salary">Unpaid<\/span>/);
  assert.doesNotMatch(html, /\$120k/);
});

test('old boards without pay lines keep their stated salary bound', () => {
  const html = render(undefined, { ...emptySalary, max: 120_000 });
  assert.match(html, /<span class="job-salary">Up to \$120k a year<\/span>/);
});

test('a genuinely unstated payment does not gain a salary badge', () => {
  assert.doesNotMatch(render({}), /class="job-salary"/);
});
