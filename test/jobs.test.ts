/**
 * Job input and the way pay is described.
 *
 * The governing rule under test: "unpaid" and "not stated" are different
 * answers, and a reader is owed the difference. Everything here is pure, so
 * it runs with no database.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSalary } from '../dist/schema/text.js';
import { normaliseInput } from '../dist/core/jobs.js';

const BASE = {
  title: 'Research Intern',
  description: 'A real description, long enough to pass the minimum length check.',
  employmentType: 'internship',
};

test('an unspecified salary and an unpaid one read differently', () => {
  assert.equal(
    formatSalary({ min: null, max: null, currency: 'USD', period: 'year' }),
    null,
    'nobody filled it in, so the page says nothing',
  );
  assert.equal(
    formatSalary({ min: null, max: null, currency: 'USD', period: 'year', unpaid: true }),
    'Unpaid',
    'the employer said there is no pay, so the page says so',
  );
  assert.equal(
    formatSalary({ min: 120_000, max: 160_000, currency: 'USD', period: 'year', unpaid: false }),
    '$120k - $160k a year',
    'and a paid role is unchanged',
  );
});

test('one-sided salary ranges are labelled as bounds, not fixed pay', () => {
  assert.equal(
    formatSalary({ min: null, max: 120_000, currency: 'USD', period: 'year' }),
    'Up to $120k a year',
  );
  assert.equal(
    formatSalary({ min: 120_000, max: null, currency: 'EUR', period: 'year' }),
    'From €120k a year',
  );
  assert.equal(
    formatSalary({ min: 120_000, max: 120_000, currency: 'USD', period: 'year' }),
    '$120k a year',
    'equal endpoints still describe fixed pay',
  );
  assert.equal(
    formatSalary({ min: 120_000, max: null, currency: 'USD', period: 'year', unpaid: true }),
    'Unpaid',
    'an explicit unpaid flag still wins over a stale bound',
  );
});

test('unpaid beats any range that came with it', () => {
  // A form can post a stale range alongside a ticked box. "Unpaid, $40k a
  // year" is not a listing anybody can act on.
  const input = normaliseInput(
    { ...BASE, salaryUnpaid: 'on', salaryMin: '40000', salaryMax: '60000' },
    'org-1',
  );
  assert.equal(typeof input, 'object', String(input));
  assert.equal(input.pay.unpaid, true);
  assert.deepEqual(input.pay.lines, [], 'the range is cleared, not kept alongside');
});

test('a checkbox and an API boolean mean the same thing', () => {
  // An HTML checkbox posts "on"; the API sends a real boolean. Both have to
  // land in the same column.
  for (const value of ['on', 'true', '1', 'yes', true]) {
    const input = normaliseInput({ ...BASE, salaryUnpaid: value }, 'org-1');
    assert.equal(input.pay.unpaid, true, `${String(value)} should mean unpaid`);
  }
});

test('an absent checkbox clears it, rather than leaving it unchanged', () => {
  // A cleared checkbox posts nothing at all. Reading that as "unchanged"
  // would make an unpaid listing impossible to correct.
  const input = normaliseInput({ ...BASE, salaryMin: '1000' }, 'org-1');
  assert.equal(input.pay.unpaid, false);
  assert.equal(input.pay.lines[0]?.min, 1000, 'and a paid range still comes through');

  for (const value of ['off', 'false', '0', '', undefined]) {
    const cleared = normaliseInput({ ...BASE, salaryUnpaid: value }, 'org-1');
    assert.equal(cleared.pay.unpaid, false, `${String(value)} should not mean unpaid`);
  }
});

test('publishing is refused until the listing says what it pays', async () => {
  const { publishProblem } = await import('../dist/core/jobs.js');
  const silent = normaliseInput({ ...BASE }, 'org-1');
  assert.equal(typeof silent, 'object', String(silent));
  assert.match(String(publishProblem(silent)), /what it pays/);

  const perTask = normaliseInput({ ...BASE, pay: ['$0.25 per task'], payMethod: 'SOL' }, 'org-1');
  assert.equal(typeof perTask, 'object', String(perTask));
  assert.equal(publishProblem(perTask), null, 'a price per task is pay');
  assert.equal(perTask.pay.method, 'SOL');

  const unpaid = normaliseInput({ ...BASE, salaryUnpaid: true }, 'org-1');
  assert.equal(typeof unpaid, 'object', String(unpaid));
  assert.equal(publishProblem(unpaid), null, 'unpaid is an answer to the question');
});
