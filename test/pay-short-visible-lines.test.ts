import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPayShort, normalisePay } from '../dist/schema/pay.js';

function short(payLines: unknown[]): string | null {
  const pay = normalisePay({ pay: payLines });
  assert.notEqual(typeof pay, 'string', String(pay));
  if (typeof pay === 'string') throw new Error(pay);
  return formatPayShort(pay);
}

const blank = { type: 'per_unit', unit: 'hour' };
const firstPrice = { type: 'fixed', amount: 100 };
const secondPrice = { type: 'bounty', amount: 250 };

test('short pay counts only priced lines, regardless of blank-row position', () => {
  assert.equal(short([blank, firstPrice]), '$100 fixed');
  assert.equal(short([firstPrice, blank]), '$100 fixed');
  assert.equal(short([firstPrice, blank, secondPrice]), '$100 fixed +1');
});

test('short pay treats zero as a stated amount and hides all blank rows', () => {
  assert.equal(short([blank, { type: 'fixed', amount: 0 }, secondPrice]), '$0 fixed +1');
  assert.equal(short([blank]), null);
});
