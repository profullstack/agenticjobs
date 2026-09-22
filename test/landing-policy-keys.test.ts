import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFilterWord, pathForQuery, queryFromPath } from '../src/core/landing.ts';
import { EMPTY_QUERY } from '../src/schema/query.ts';

test('constructor is an ordinary tag, including in canonical workplace paths', () => {
  assert.equal(isFilterWord('constructor'), false);
  const query = queryFromPath('/constructor/remote');
  assert.deepEqual(query, { ...EMPTY_QUERY, tags: ['constructor'], workplace: 'remote' });
  assert.equal(pathForQuery(query!), '/constructor/remote');
});

test('an inherited key cannot make an otherwise invalid path segment a policy', () => {
  assert.equal(isFilterWord('__proto__'), false);
  assert.equal(queryFromPath('/__proto__/remote'), null);
});

test('declared agent policies still round-trip beside an ordinary constructor tag', () => {
  for (const [slug, policy] of [
    ['agents-welcome', 'welcome'],
    ['agents-disclose', 'disclose'],
    ['human-only', 'human-only'],
  ] as const) {
    assert.equal(isFilterWord(slug), true);
    const query = queryFromPath(`/constructor/${slug}`);
    assert.equal(query?.agentPolicy, policy);
    assert.deepEqual(query?.tags, ['constructor']);
    assert.equal(pathForQuery(query!), `/constructor/${slug}`);
  }
});
