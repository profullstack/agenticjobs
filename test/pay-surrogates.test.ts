import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalisePay, parsePayLine } from '../dist/schema/pay.js';

/**
 * Pay fields land in the jobs row as jsonb (pay_lines) and text
 * (pay_method, salary_equity). A lone surrogate in any of them is invalid
 * UTF-8 and Postgres refuses the whole insert, so a listing cannot post.
 * JSON clients can send one straight in as an escaped surrogate, and the
 * field caps count UTF-16 units, so a cap can also sever a real pair.
 */

const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);

test('a per-unit rate parsed from text cannot carry a lone surrogate into pay_lines', () => {
  const read = parsePayLine(`$5 per wid${LONE_HIGH}get`);
  assert.notEqual(typeof read, 'string');
  if (typeof read === 'string') return;
  assert.equal(read.unit, 'widget');
});

test('an object unit capped mid-pair does not leave a dangling surrogate', () => {
  const pay = normalisePay({
    pay: { lines: [{ type: 'per_unit', min: 5, max: 5, currency: 'USD', unit: `${'x'.repeat(59)}🚀` }] },
  });
  assert.notEqual(typeof pay, 'string');
  if (typeof pay === 'string') return;
  assert.equal(pay.lines[0]?.unit, 'x'.repeat(59));
});

test('free-text equity drops smuggled surrogates and a cap-severed pair', () => {
  const smuggled = normalisePay({ payEquity: `0.1% ${LONE_LOW} cliff` });
  assert.notEqual(typeof smuggled, 'string');
  if (typeof smuggled === 'string') return;
  assert.equal(smuggled.equity, '0.1%  cliff');

  const severed = normalisePay({ payEquity: `${'a'.repeat(59)}🚀` });
  assert.notEqual(typeof severed, 'string');
  if (typeof severed === 'string') return;
  assert.equal(severed.equity, 'a'.repeat(59));
});

test('a method capped mid-pair does not leave a dangling surrogate', () => {
  const pay = normalisePay({ payMethod: `${'m'.repeat(39)}🚀` });
  assert.notEqual(typeof pay, 'string');
  if (typeof pay === 'string') return;
  assert.equal(pay.method, 'm'.repeat(39));
});

test('real emoji inside the cap still survive cleaning', () => {
  const pay = normalisePay({ payEquity: '0.1% + 🚀 upside' });
  assert.notEqual(typeof pay, 'string');
  if (typeof pay === 'string') return;
  assert.equal(pay.equity, '0.1% + 🚀 upside');
});
