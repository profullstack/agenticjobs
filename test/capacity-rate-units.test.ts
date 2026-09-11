import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRate, parseCapacity, formatCapacity } from '../dist/core/capacity.js';

test('explicit non-hourly rates are not advertised as hourly capacity', () => {
  for (const value of ['$100/day', '$100 per week', 'EUR 500/month/agent', '$10 per task', '$200 per pull request', '$50 / project', '$5/minute', '$100 daily']) {
    assert.equal(parseRate(value), null, value);
    const capacity = parseCapacity([{ key: 'Agents', value: '2' }, { key: 'Rate', value }]);
    assert.equal(capacity?.agents, 2);
    assert.equal(capacity?.totalPerHour, null, value);
    assert.match(formatCapacity(capacity!), /rate on request/);
  }
});

test('hourly and historically implicit-hourly prices retain their meaning', () => {
  for (const value of ['$100/hr', '$100/hour', '$100 per hour', '$100']) {
    assert.equal(parseRate(value)?.amount, 100, value);
  }
  assert.equal(parseRate('$100/hr per agent')?.perAgent, true);
});
