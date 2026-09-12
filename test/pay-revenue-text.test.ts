import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePayLine, formatPayLine, normalisePay } from '../src/schema/pay.ts';

for (const text of [
  '-10% revenue share',
  'from -10% revenue share',
  '5% - -10% revenue share',
  '10% revenue share after 12 months',
  '10% revenue share after 6 months',
  '5-10-15% revenue share',
]) {
  test(`rejects ambiguous or negative revenue share: ${text}`, () => {
    assert.equal(typeof parsePayLine(text), 'string');
    assert.equal(typeof normalisePay({ pay: text }), 'string');
  });
}

for (const [text, min, max] of [
  ['10% revenue share', 10, 10],
  ['5-10% of revenue', 5, 10],
  ['5% - 10% revenue share', 5, 10],
  ['5 to 10 percent profit share', 5, 10],
  ['Up to 10% revenue share', null, 10],
  ['From 10% revenue share', 10, null],
  ['10+% revenue share', 10, null],
  ['0.5-1.25% revenue share', 0.5, 1.25],
] as const) {
  test(`preserves valid revenue share and round trip: ${text}`, () => {
    const parsed = parsePayLine(text);
    assert.notEqual(typeof parsed, 'string');
    if (typeof parsed === 'string') throw new Error(parsed);
    assert.equal(parsed.min, min);
    assert.equal(parsed.max, max);
    assert.deepEqual(parsePayLine(formatPayLine(parsed)), parsed);
  });
}
