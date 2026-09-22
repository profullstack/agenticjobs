/**
 * Landing pages: a search as a path, and back.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isFilterWord,
  pathForQuery,
  queryFromPath,
  titleForQuery,
  workplaceLinks,
} from '../src/core/landing.ts';
import { EMPTY_QUERY, parseQuery } from '../src/schema/query.ts';

test('every segment is a value: filters are recognised, the rest are tags', () => {
  const query = queryFromPath('/rust/remote/contract/senior/agents-welcome/100k+');
  assert.ok(query);
  assert.deepEqual(query.tags, ['rust']);
  assert.equal(query.workplace, 'remote');
  assert.equal(query.employmentType, 'contract');
  assert.equal(query.seniority, 'senior');
  assert.equal(query.agentPolicy, 'welcome');
  assert.equal(query.salaryMin, 100_000);
});

test('order does not matter on the way in, and the canonical path puts tags first', () => {
  const a = queryFromPath('/remote/rust');
  const b = queryFromPath('/rust/remote');
  assert.ok(a && b);
  assert.deepEqual({ ...a }, { ...b });
  assert.equal(pathForQuery(a), '/rust/remote');
  assert.equal(
    pathForQuery({ ...EMPTY_QUERY, tags: ['typescript', 'go'], workplace: 'hybrid' }),
    '/go/typescript/hybrid',
  );
});

test('a filter given twice, a repeated tag or a file-looking segment is not a page', () => {
  assert.equal(queryFromPath('/rust/remote/onsite'), null);
  assert.equal(queryFromPath('/rust/rust'), null);
  assert.equal(queryFromPath('/rust/app.js'), null);
  assert.equal(queryFromPath('/rust/remote/../etc'), null);
  assert.equal(queryFromPath('/'), null);
  assert.equal(queryFromPath('/a/b/c/d'), null, 'more than three tags is the querystring form');
});

test('free text and an employer stay on the querystring', () => {
  assert.equal(pathForQuery({ ...EMPTY_QUERY, q: 'rust', workplace: 'remote' }), null);
  assert.equal(pathForQuery({ ...EMPTY_QUERY, org: 'acme', tags: ['rust'] }), null);
  assert.equal(pathForQuery(EMPTY_QUERY), null);
});

test('a tag that is also a filter word cannot be a path, so the two never collide', () => {
  assert.ok(isFilterWord('remote'));
  assert.ok(isFilterWord('120k+'));
  assert.ok(!isFilterWord('rust'));
  assert.equal(pathForQuery({ ...EMPTY_QUERY, tags: ['remote'] }), null);
});

test('salary floors round-trip only when they are whole thousands', () => {
  assert.equal(pathForQuery({ ...EMPTY_QUERY, salaryMin: 120_000 }), '/120k+');
  assert.equal(pathForQuery({ ...EMPTY_QUERY, salaryMin: 120_500 }), null);
  assert.equal(queryFromPath('/120k+')?.salaryMin, 120_000);
});

test('the title reads like a heading, not a query', () => {
  assert.equal(
    titleForQuery(queryFromPath('/rust/remote/senior/contract') ?? EMPTY_QUERY),
    'Remote senior Rust contract jobs',
  );
  assert.equal(
    titleForQuery(queryFromPath('/go/agents-welcome') ?? EMPTY_QUERY),
    'GO jobs, agents welcome',
  );
  assert.equal(
    titleForQuery(queryFromPath('/python/human-only/100k+') ?? EMPTY_QUERY),
    'Python jobs for people only paying 100,000+',
  );
});

test('every tag has three workplace pages', () => {
  assert.deepEqual(
    workplaceLinks('rust').map((link) => link.href),
    ['/rust/remote', '/rust/hybrid', '/rust/onsite'],
  );
});

test('workplace links keep the workplace filter when a tag needs a querystring', () => {
  for (const tag of ['node.js', 'c#']) {
    const links = workplaceLinks(tag);
    assert.deepEqual(
      links.map((link) => link.workplace),
      ['remote', 'hybrid', 'onsite'],
    );
    for (const link of links) {
      const url = new URL(link.href, 'https://board.example');
      assert.equal(url.pathname, '/');
      assert.equal(url.hash, '');
      assert.deepEqual(parseQuery(url.searchParams), {
        ...EMPTY_QUERY,
        tags: [tag],
        workplace: link.workplace,
      });
    }
  }
});
