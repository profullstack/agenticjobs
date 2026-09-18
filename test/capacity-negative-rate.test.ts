import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRate, parseCapacity, formatCapacity } from '../dist/core/capacity.js';

test('negative hourly prices do not become positive advertised rates', () => {
  for (const value of [
    '-100/hour', '$-100/hr', '-$100/hr', 'USD -100/hour', '-USD 100/hour',
    'EUR - 100/hour', '- €100/hour', '−£100/hour', '$−.50/hr', '-$.50/hr',
    'CAD -$1,000/hour/agent',
  ]) {
    assert.equal(parseRate(value), null, value);
    const capacity = parseCapacity([{ key: 'Agents', value: '3' }, { key: 'Rate', value }]);
    assert.equal(capacity?.agents, 3);
    assert.equal(capacity?.ratePerAgent, null, value);
    assert.equal(capacity?.totalPerHour, null, value);
    assert.match(formatCapacity(capacity!), /rate on request/);
  }
});

test('positive prices and explicit plus signs keep their amount and currency', () => {
  for (const [value, amount, currency] of [
    ['$100/hr', 100, 'USD'], ['+USD 100/hour', 100, 'USD'],
    ['EUR + 100/hour', 100, 'EUR'], ['+$1,000/hr', 1000, 'USD'],
    ['£+.50/hr', 0.5, 'GBP'], ['flat-rate $100/hr', 100, 'USD'],
  ] as const) {
    assert.deepEqual(parseRate(value), { amount, currency, perAgent: false }, value);
  }
});
