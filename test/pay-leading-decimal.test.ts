import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPayLine, normalisePay, parsePayLine } from '../src/schema/pay.ts';

test('fractional revenue shares keep their decimal point when the leading zero is omitted', () => {
  for (const [text, min, max] of [
    ['.5% revenue share', 0.5, 0.5],
    ['Up to .25% revenue share', null, 0.25],
    ['From .125 percent profit share', 0.125, null],
    ['.5-.75% of revenue', 0.5, 0.75],
    ['.5% to 1.25% revenue share', 0.5, 1.25],
  ] as const) {
    const expected = { type: 'revenue_share', min, max, currency: '%', unit: null };
    const parsed = parsePayLine(text);
    assert.deepEqual(parsed, expected, text);
    if (typeof parsed === 'string') throw new Error(parsed);
    assert.deepEqual(parsePayLine(formatPayLine(parsed)), expected, text);
    assert.deepEqual(
      normalisePay({ pay: text }),
      {
        lines: [expected],
        method: null,
        equity: null,
        unpaid: false,
      },
      text,
    );
  }
});

test('negative fractional revenue shares are refused instead of becoming positive', () => {
  for (const text of [
    '-.5% revenue share',
    'From -.25% revenue share',
    '\u2212.125 percent profit share',
    '.5% - -.75% revenue share',
  ]) {
    assert.equal(typeof parsePayLine(text), 'string', text);
    assert.equal(typeof normalisePay({ pay: text }), 'string', text);
  }
});
