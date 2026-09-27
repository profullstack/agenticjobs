import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalisePay } from '../dist/schema/pay.js';

test('pay amounts reject JSON arrays rather than coercing them into prices', () => {
  for (const input of [
    { pay: [{ type: 'fixed', amount: [25] }] },
    { pay: [{ type: 'hourly', min: ['20'], max: 30 }] },
    { pay: [{ type: 'hourly', min: 20, max: [30] }] },
    { salaryMin: [1000], salaryMax: 2000 },
    { salaryMin: 1000, salaryMax: ['2000'] },
  ]) {
    assert.equal(typeof normalisePay(input), 'string', JSON.stringify(input));
  }
});

test('number and formatted string amounts remain accepted', () => {
  for (const amount of [0, 25, '25', '$1,250.50']) {
    const result = normalisePay({ pay: [{ type: 'fixed', amount }] });
    assert.notEqual(typeof result, 'string');
    if (typeof result !== 'string') {
      assert.equal(result.lines[0]?.min, amount === '$1,250.50' ? 1250.5 : Number(amount));
    }
  }
});
