import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalisePay, parsePayLine } from '../src/schema/pay.ts';

test('uppercase pay-period words are not mistaken for currency tickers', () => {
  for (const text of [
    '$100 per task', '$100 per hour', '$100 for each task', '$100 each task',
    '$100 every week', '$100 fixed', '$100 flat', '$100 total',
    '$100 one-off', '$100 lump sum', '100 daily', '$100 - $200 per task',
  ]) {
    const expected = parsePayLine(text);
    assert.equal(typeof expected, 'object', text);
    assert.deepEqual(parsePayLine(text.toUpperCase()), expected, text);
    assert.deepEqual(normalisePay({ pay: text.toUpperCase() }), normalisePay({ pay: text }), text);
  }
});

test('uppercase periods retain real currencies and reject contradictory currencies', () => {
  for (const text of ['100 EUR PER TASK', '0.01 SOL PER TASK', '100 XYZ PER TASK']) {
    const parsed = parsePayLine(text);
    assert.equal(typeof parsed, 'object', text);
    if (typeof parsed === 'string') throw new Error(parsed);
    assert.equal(parsed.currency, text.split(' ')[1]);
  }
  for (const text of ['$100 EUR PER TASK', 'USD 100 EUR FIXED']) {
    assert.equal(typeof parsePayLine(text), 'string', text);
  }
});


test('currency tickers that overlap prose retain their successful interpretation', () => {
  for (const currency of ['PER', 'FOR', 'EACH', 'EVERY', 'FIXED', 'FLAT', 'TOTAL', 'ONE', 'LUMP', 'DAILY']) {
    const parsed = parsePayLine(`100 ${currency} per task`);
    assert.equal(typeof parsed, 'object', currency);
    if (typeof parsed === 'string') throw new Error(parsed);
    assert.equal(parsed.currency, currency);
    assert.equal(parsed.type, 'per_task');
  }
});

test('incomplete suffixes are not accepted as pay periods', () => {
  for (const suffix of ['PER', 'FOR', 'EACH', 'EVERY', 'ONE', 'LUMP', 'FOR EACH', 'FOR EVERY']) {
    assert.equal(typeof parsePayLine(`$100 ${suffix}`), 'string', suffix);
  }
});


test('existing ambiguous ticker parses and ticker ranges keep their denomination', () => {
  for (const [text, currency] of [
    ['100 FOR EACH TASK', 'FOR'],
    ['100 PER PER TASK', 'PER'],
    ['100 ONE - 200 ONE per task', 'ONE'],
    ['ONE 100 per task', 'ONE'],
  ]) {
    const parsed = parsePayLine(text);
    assert.equal(typeof parsed, 'object', text);
    if (typeof parsed === 'string') throw new Error(parsed);
    assert.equal(parsed.currency, currency, text);
    assert.equal(parsed.type, 'per_task', text);
  }
});
