import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentCount, parseCapacity } from '../dist/core/capacity.js';

test('negative and fractional agent counts are not turned into positive whole counts', () => {
  for (const value of ['-2', '-2 agents', '2.5 agents', '.5 agents', 'capacity: -10']) {
    assert.equal(parseAgentCount(value), null, value);
    assert.equal(
      parseCapacity([
        { key: 'Agents', value },
        { key: 'Rate', value: '$100/hr/agent' },
      ]),
      null,
      value,
    );
  }
});

test('whole counts and supported prose continue to parse', () => {
  for (const [value, expected] of [
    ['up to 10', 10],
    ['10 agents', 10],
    ['1,000', 1000],
    ['2.0 agents', 2],
    ['single', 1],
  ] as const) {
    assert.equal(parseAgentCount(value), expected, value);
  }
});
