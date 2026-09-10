/**
 * Pay, in the words people use.
 *
 * The parser is the feature: a person, an agent and a job file all write
 * "$0.25 per task", and the structured form is derived from it. So the tests
 * are mostly sentences in and sentences out, with the JSON checked where the
 * two have to agree.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatPay,
  formatPayLine,
  formatPayShort,
  normalisePay,
  parsePayLine,
  payOfJob,
  payStated,
  payToText,
  readPayLine,
  salaryFromPay,
} from '../dist/schema/pay.js';

function line(text: string) {
  const parsed = parsePayLine(text);
  assert.equal(typeof parsed, 'object', `${JSON.stringify(text)}: ${String(parsed)}`);
  return parsed as Exclude<typeof parsed, string>;
}

test('the lines from a real listing parse, and print back the same way', () => {
  // The first job on the live board says, in prose: "$0.25 per task, settled
  // in SOL. $0.25 for a PR that fixes a bug you find. $0.25 for each social
  // post linking to your job or profile page." That is three lines and a
  // method, and it is the whole reason the vocabulary grew.
  const task = line('$0.25 per task');
  assert.equal(task.type, 'per_task');
  assert.equal(task.min, 0.25);
  assert.equal(task.currency, 'USD');
  assert.equal(formatPayLine(task), '$0.25 per task');

  const pr = line('$0.25 per PR that fixes a bug you find');
  assert.equal(pr.type, 'per_unit');
  assert.equal(pr.unit, 'PR that fixes a bug you find');
  assert.equal(formatPayLine(pr), '$0.25 per PR that fixes a bug you find');

  const post = line('$0.25 for each social post linking to your job or profile page');
  assert.equal(post.type, 'per_unit');
  assert.equal(post.unit, 'social post linking to your job or profile page');
});

test('a settlement rail on the end of a line is the method, not the unit', () => {
  const read = readPayLine('$0.25 per task, settled in SOL');
  assert.equal(typeof read, 'object', String(read));
  if (typeof read === 'string') return;
  assert.equal(read.line.unit, 'task');
  assert.equal(read.method, 'SOL');

  const rail = readPayLine('$100 an hour via bank transfer');
  if (typeof rail === 'string') throw new Error(rail);
  assert.equal(rail.method, 'bank transfer');
  assert.equal(rail.line.type, 'hourly');

  // A place is not a rail, and stays part of the line for a person to see.
  const place = readPayLine('$100 per hour in London');
  if (typeof place === 'string') throw new Error(place);
  assert.equal(place.method, null);
});

test('every shape a person writes a salary in', () => {
  for (const [text, printed] of [
    ['$120k - $150k a year', '$120k - $150k a year'],
    ['$120k-$150k/year', '$120k - $150k a year'],
    ['120000 to 150000 USD per year', '$120k - $150k a year'],
    ['$100 an hour', '$100 an hour'],
    ['$100/hr', '$100 an hour'],
    ['40 usd hourly', '$40 an hour'],
    ['€50 per hour', '€50 an hour'],
    ['$800 a day', '$800 a day'],
    ['$10k a month', '$10k a month'],
    ['from $100 an hour', 'From $100 an hour'],
    ['$100+ an hour', 'From $100 an hour'],
    ['up to $150k a year', 'Up to $150k a year'],
  ] as const) {
    assert.equal(formatPayLine(line(text)), printed, text);
  }
});

test('scale suffixes do not consume currency codes or monthly periods', () => {
  for (const currency of ['MATIC', 'MXN', 'KWD']) {
    const parsed = line(`100 ${currency} per task`);
    assert.equal(parsed.currency, currency);
    assert.equal(parsed.min, 100);
    assert.equal(parsed.max, 100);
    assert.equal(parsed.type, 'per_task');
  }

  const monthly = line('$100 monthly');
  assert.equal(monthly.type, 'monthly');
  assert.equal(monthly.min, 100);
  assert.equal(monthly.currency, 'USD');

  for (const [text, amount] of [
    ['$10k monthly', 10_000],
    ['2 M USD per year', 2_000_000],
    ['1.5m MATIC per task', 1_500_000],
  ] as const) {
    assert.equal(line(text).min, amount, text);
  }
});

test('flat fees, bounties, revenue shares and coins', () => {
  assert.equal(line('$5000 fixed').type, 'fixed');
  assert.equal(line('$5,000 flat').type, 'fixed');
  assert.equal(line('$5000 for the project').type, 'fixed');
  assert.equal(formatPayLine(line('$5000 per project')), '$5k fixed');
  assert.equal(line('$250 bounty').type, 'bounty');

  const share = line('5-10% of revenue');
  assert.equal(share.type, 'revenue_share');
  assert.equal(share.min, 5);
  assert.equal(share.max, 10);
  assert.equal(formatPayLine(share), '5% - 10% revenue share');
  assert.equal(formatPayLine(line('10% revenue share')), '10% revenue share');

  const sol = line('0.01 SOL per task');
  assert.equal(sol.currency, 'SOL');
  assert.equal(sol.type, 'per_task');
  assert.equal(formatPayLine(sol), '0.01 SOL per task');
  assert.equal(formatPayLine(line('1.5 SOL a month')), '1.5 SOL a month');
});

test('a line that says how much but not what for is refused with the fix', () => {
  const problem = parsePayLine('$60k');
  assert.equal(typeof problem, 'string');
  assert.match(String(problem), /a year|an hour|fixed|per task/);

  assert.match(String(parsePayLine('competitive')), /Could not find an amount/);
  assert.match(String(parsePayLine('$150k - $120k a year')), /below the bottom/);
  assert.match(String(parsePayLine('$100 - €200 an hour')), /two currencies/);
  assert.match(String(parsePayLine('')), /empty/i);
});

test('normalisePay takes strings, arrays, objects and the old flat fields', () => {
  const fromText = normalisePay({
    pay: '$0.25 per task, settled in SOL\n$0.25 per PR that fixes a bug you find',
  });
  if (typeof fromText === 'string') throw new Error(fromText);
  assert.equal(fromText.lines.length, 2);
  assert.equal(fromText.method, 'SOL', 'the rail named on a line becomes the method');
  assert.equal(formatPay(fromText), '$0.25 per task, $0.25 per PR that fixes a bug you find');

  const fromArray = normalisePay({ pay: ['$100 an hour'], payMethod: 'usdc' });
  if (typeof fromArray === 'string') throw new Error(fromArray);
  assert.equal(fromArray.method, 'USDC', 'a ticker typed in lowercase comes out in capitals');

  const fromObjects = normalisePay({
    pay: [{ type: 'per_unit', amount: 0.25, currency: 'usd', unit: 'social post' }],
    payMethod: 'Bank transfer',
  });
  if (typeof fromObjects === 'string') throw new Error(fromObjects);
  assert.equal(formatPay(fromObjects), '$0.25 per social post');
  assert.equal(fromObjects.method, 'Bank transfer', 'a rail stays as typed');

  const legacy = normalisePay({
    salaryMin: '120000',
    salaryMax: '150000',
    salaryPeriod: 'year',
    salaryCurrency: 'usd',
    salaryEquity: '0.1%',
  });
  if (typeof legacy === 'string') throw new Error(legacy);
  assert.equal(formatPay(legacy), '$120k - $150k a year');
  assert.equal(legacy.equity, '0.1%');

  const bad = normalisePay({ pay: ['$100 an hour', 'whatever we agree'] });
  assert.equal(typeof bad, 'string', 'one unreadable line refuses the lot, and says which');
  assert.match(String(bad), /whatever we agree/);
});

test('unpaid is a statement, and beats any line that came with it', () => {
  const unpaid = normalisePay({ salaryUnpaid: 'on', pay: '$40k a year' });
  if (typeof unpaid === 'string') throw new Error(unpaid);
  assert.equal(unpaid.unpaid, true);
  assert.deepEqual(unpaid.lines, []);
  assert.equal(formatPay(unpaid), 'Unpaid');
  assert.equal(payStated(unpaid), true, 'unpaid answers the question');

  const nothing = normalisePay({});
  if (typeof nothing === 'string') throw new Error(nothing);
  assert.equal(payStated(nothing), false);
  assert.equal(formatPay(nothing), null);

  const asLine = normalisePay({ pay: 'unpaid' });
  if (typeof asLine === 'string') throw new Error(asLine);
  assert.equal(asLine.unpaid, true, '"unpaid" typed as a line means the same thing');
});

test('the salary columns carry the first time-based line and nothing else', () => {
  const pay = normalisePay({ pay: ['$0.25 per task', '$120k - $150k a year', '$100 an hour'] });
  if (typeof pay === 'string') throw new Error(pay);
  const salary = salaryFromPay(pay);
  assert.equal(salary.period, 'year', 'per-task pay has no annual figure; the yearly line is first');
  assert.equal(salary.min, 120_000);
  assert.equal(salary.max, 150_000);

  const perTask = normalisePay({ pay: ['$0.25 per task'] });
  if (typeof perTask === 'string') throw new Error(perTask);
  assert.equal(salaryFromPay(perTask).min, null, 'a price per task is not a salary floor');
  assert.equal(formatPayShort(perTask), '$0.25 per task');
});

test('a listing from an older board still reads, from its salary', () => {
  const old = payOfJob({
    salary: { min: 100, max: 200, currency: 'usd', period: 'hour', equity: null, unpaid: false },
  });
  assert.equal(formatPay(old), '$100 - $200 an hour');
  assert.equal(formatPay(payOfJob({})), null);
});

test('the text form round-trips, so a form can be re-shown from stored pay', () => {
  const pay = normalisePay({ pay: ['$0.25 per task', 'From $100 an hour', '$5k fixed'] });
  if (typeof pay === 'string') throw new Error(pay);
  const again = normalisePay({ pay: payToText(pay) });
  if (typeof again === 'string') throw new Error(again);
  assert.deepEqual(again.lines, pay.lines);
});
