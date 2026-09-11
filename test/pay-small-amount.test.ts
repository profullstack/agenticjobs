import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPayLine, parsePayLine, payToText, normalisePay } from '../dist/schema/pay.js';

test('small crypto rates survive display and editing without rounding to zero', () => {
  for (const [amount, currency] of [[1e-9, 'SOL'], [1e-18, 'ETH'], [0.123456789, 'SOL']] as const) {
    const line = { type: 'per_task' as const, min: amount, max: amount, currency, unit: 'task' };
    assert.deepEqual(parsePayLine(formatPayLine(line)), line);
    const pay = { lines: [line], method: null, equity: null, unpaid: false };
    assert.deepEqual(normalisePay({ pay: payToText(pay) }), pay);
  }
});
