import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_QUERY, parseQuery, queryToParams } from '../src/schema/query.ts';

for (const value of ['25oops', '10.5', '50000usd', '2e3', '0x20', '7 8', '9_000', '--4']) {
  test(`malformed numeric query value ${JSON.stringify(value)} uses each field's fallback`, () => {
    const query = parseQuery(new URLSearchParams({ limit: value, offset: value, salaryMin: value }));
    assert.equal(query.limit, 25);
    assert.equal(query.offset, 0);
    assert.equal(query.salaryMin, null);
  });
}

test('absent, empty, whitespace-only and non-finite values keep existing defaults', () => {
  assert.deepEqual(parseQuery(new URLSearchParams()), EMPTY_QUERY);
  for (const value of ['', '  ', 'NaN', 'Infinity', '+', '-', '9'.repeat(400)]) {
    const query = parseQuery(new URLSearchParams({ limit: value, offset: value, salaryMin: value }));
    assert.equal(query.limit, 25, value);
    assert.equal(query.offset, 0, value);
    assert.equal(query.salaryMin, null, value);
  }
});

test('whole decimal values preserve signs, leading zeroes, surrounding whitespace and bounds', () => {
  const cases = [
    { value: '  +00042  ', limit: 42, offset: 42, salaryMin: 42 },
    { value: '-42', limit: 1, offset: 0, salaryMin: null },
    { value: '0', limit: 1, offset: 0, salaryMin: null },
    { value: '100', limit: 100, offset: 100, salaryMin: 100 },
    { value: '1000000001', limit: 100, offset: 100_000, salaryMin: 100_000_000 },
    { value: '9'.repeat(100), limit: 100, offset: 100_000, salaryMin: 100_000_000 },
  ];
  for (const { value, limit, offset, salaryMin } of cases) {
    const query = parseQuery(new URLSearchParams({ limit: value, offset: value, salaryMin: value }));
    assert.deepEqual({ limit: query.limit, offset: query.offset, salaryMin: query.salaryMin },
      { limit, offset, salaryMin }, value);
  }
});

test('malformed numbers do not discard other filters and canonical links round-trip', () => {
  const query = parseQuery(new URLSearchParams(
    'q=parser&limit=25oops&offset=10.5&salaryMin=50000usd&tag=API&tags=remote,typescript&sort=salary',
  ));
  assert.equal(query.q, 'parser');
  assert.equal(query.sort, 'salary');
  assert.deepEqual(query.tags, ['api', 'remote', 'typescript']);
  const params = queryToParams(query);
  assert.equal(params.has('limit'), false);
  assert.equal(params.has('offset'), false);
  assert.equal(params.has('salaryMin'), false);
  assert.deepEqual(parseQuery(params), query);
});
